// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * LLM Provider Abstraction — supports OpenAI-compatible and Anthropic APIs.
 *
 * Design:
 * - Single `promptLLM()` function that works with any OpenAI-compatible endpoint
 * - Configurable via env vars: LLM_PROVIDER, OPENAI_API_KEY, OPENAI_BASE_URL, etc.
 * - An Anthropic-compatible path is also supported for providers like DeepSeek
 *   that expose a native /v1/messages endpoint.
 *
 * Provider detection (by priority):
 *   1. LLM_PROVIDER env var: "openai" | "anthropic" | "auto"
 *   2. AUTO mode: if ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL -> anthropic, else openai
 *   3. Default: "openai" (most flexible, works with OpenAI, DeepSeek, OpenRouter, etc.)
 */

import { env } from 'node:process';

// ============================================================
// Types
// ============================================================

export type LLMProviderType = 'openai' | 'anthropic';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LLMResponse {
  content: string;
  tool_calls: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  stop_reason: string | null;
  /** Raw response for debugging */
  raw: unknown;
}

export interface LLMConfig {
  provider: LLMProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}

// ============================================================
// Configuration Resolution
// ============================================================

interface ResolvedConfig {
  provider: LLMProviderType;
  apiKey: string;
  baseUrl: string;
}

function resolveProviderConfig(apiKeyOverride?: string): ResolvedConfig {
  const providerEnv = env.LLM_PROVIDER?.toLowerCase() || 'openai';

  if (providerEnv === 'anthropic') {
    return {
      provider: 'anthropic',
      apiKey: apiKeyOverride || env.ANTHROPIC_API_KEY || '',
      baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    };
  }

  // OpenAI-compatible (default)
  return {
    provider: 'openai',
    apiKey: apiKeyOverride || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || '',
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  };
}

// ============================================================
// Anthropic Format → Internal Format Converter
// ============================================================

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function parseAnthropicResponse(data: AnthropicResponse): LLMResponse {
  const toolCalls: LLMToolCall[] = [];
  let textContent = '';

  for (const block of data.content || []) {
    if (block.type === 'text' && block.text) {
      textContent += block.text;
    } else if (block.type === 'tool_use' && block.name && block.input) {
      toolCalls.push({
        id: block.id || `toolu_${Date.now()}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return {
    content: textContent,
    tool_calls: toolCalls,
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
    model: data.model,
    stop_reason: data.stop_reason,
    raw: data,
  };
}

// ============================================================
// OpenAI Format Response Parser
// ============================================================

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChoice {
  message: {
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function parseOpenAIResponse(data: OpenAIResponse): LLMResponse {
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || '',
    tool_calls: (choice?.message?.tool_calls || []) as LLMToolCall[],
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model: data.model,
    stop_reason: choice?.finish_reason || null,
    raw: data,
  };
}

// ============================================================
// Core LLM Call
// ============================================================

export async function callLLM(
  messages: LLMMessage[],
  tools?: LLMToolDefinition[],
  config?: Partial<LLMConfig>,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const resolved = resolveProviderConfig(config?.apiKey);
  const provider = config?.provider || resolved.provider;
  const apiKey = config?.apiKey || resolved.apiKey;
  let baseUrl = config?.baseUrl || resolved.baseUrl;
  const model = config?.model || env.LLM_MODEL || 'deepseek-chat';
  const maxTokens = config?.maxTokens || parseInt(env.LLM_MAX_TOKENS || '64000', 10);

  if (!apiKey) {
    throw new Error('No API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env, or pass apiKey to callLLM().');
  }

  if (provider === 'anthropic') {
    return callAnthropicAPI(messages, tools, { apiKey, baseUrl, model, maxTokens, provider }, signal);
  }

  // Default: OpenAI-compatible
  return callOpenAICompatibleAPI(messages, tools, { apiKey, baseUrl, model, maxTokens, provider }, signal);
}

async function callOpenAICompatibleAPI(
  messages: LLMMessage[],
  tools: LLMToolDefinition[] | undefined,
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const url = `${config.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    stream: false,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  return parseOpenAIResponse(data);
}

async function callAnthropicAPI(
  messages: LLMMessage[],
  tools: LLMToolDefinition[] | undefined,
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const baseUrl = config.baseUrl.replace(/\/v1$/, '');
  const url = `${baseUrl}/v1/messages`;

  // Convert OpenAI-style messages to Anthropic format
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const anthropicMessages = nonSystemMessages.map((m) => {
    if (m.role === 'user') {
      return {
        role: 'user' as const,
        content: m.content,
      };
    }
    if (m.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
      }
      return {
        role: 'assistant' as const,
        content,
      };
    }
    // tool_result
    return {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content,
        } as AnthropicContentBlock,
      ],
    };
  });

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: anthropicMessages,
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map((m) => ({ type: 'text', text: m.content }));
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(`Anthropic API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  const data = (await response.json()) as AnthropicResponse;
  return parseAnthropicResponse(data);
}

// ============================================================
// Preflight Ping — Simple credential validation
// ============================================================

export async function validateLLMConnection(config?: Partial<LLMConfig>): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await callLLM(
      [{ role: 'user', content: 'Reply with just the word "ok".' }],
      undefined,
      { ...config, maxTokens: 10 },
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
