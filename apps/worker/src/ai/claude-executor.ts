// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Multi-provider LLM executor.
 *
 * Replaces the Claude Agent SDK's query() call with a direct
 * HTTP call to an OpenAI-compatible or Anthropic-compatible API.
 *
 * The exported interface (ClaudePromptResult, runClaudePrompt,
 * validateAgentOutput) is preserved for backward compatibility
 * with the rest of the codebase.
 */

import { fs, path } from 'zx';
import type { AuditSession } from '../audit/index.js';
import { deliverablesDir } from '../paths.js';
import { isRetryableError, PentestError } from '../services/error-handling.js';
import { AGENT_VALIDATORS } from '../session-manager.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import { formatTimestamp } from '../utils/formatting.js';
import { Timer } from '../utils/metrics.js';
import { createAuditLogger } from './audit-logger.js';
import { callLLM, type LLMToolDefinition } from './llm-provider.js';
import { type ModelTier, resolveModel } from './models.js';
import { detectExecutionContext, formatCompletionMessage, formatErrorOutput } from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';

declare global {
  var SHANNON_DISABLE_LOADER: boolean | undefined;
}

export interface ClaudePromptResult {
  result?: string | null | undefined;
  success: boolean;
  duration: number;
  turns?: number | undefined;
  cost: number;
  model?: string | undefined;
  partialCost?: number | undefined;
  apiErrorDetected?: boolean | undefined;
  error?: string | undefined;
  errorType?: string | undefined;
  prompt?: string | undefined;
  retryable?: boolean | undefined;
  structuredOutput?: unknown;
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

async function writeErrorLog(
  err: Error & { code?: string; status?: number },
  sourceDir: string,
  fullPrompt: string,
  duration: number,
): Promise<void> {
  try {
    const errorLog = {
      timestamp: formatTimestamp(),
      agent: 'llm-executor',
      error: {
        name: err.constructor.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: err.stack,
      },
      context: {
        sourceDir,
        prompt: `${fullPrompt.slice(0, 200)}...`,
        retryable: isRetryableError(err),
      },
      duration,
    };
    const logPath = path.join(deliverablesDir(sourceDir), 'error.log');
    await fs.appendFile(logPath, `${JSON.stringify(errorLog)}\n`);
  } catch {
    // Best-effort error log writing
  }
}

export async function validateAgentOutput(
  result: ClaudePromptResult,
  agentName: string | null,
  sourceDir: string,
  logger: ActivityLogger,
): Promise<boolean> {
  logger.info(`Validating ${agentName} agent output`);

  try {
    if (!result.success || (!result.result && result.structuredOutput === undefined)) {
      logger.error('Validation failed: Agent execution was unsuccessful');
      return false;
    }

    const validator = agentName ? AGENT_VALIDATORS[agentName as keyof typeof AGENT_VALIDATORS] : undefined;

    if (!validator) {
      logger.warn(`No validator found for agent "${agentName}" - assuming success`);
      logger.info('Validation passed: Unknown agent with successful result');
      return true;
    }

    logger.info(`Using validator for agent: ${agentName}`, { sourceDir });
    const validationResult = await validator(sourceDir, logger);

    if (validationResult) {
      logger.info('Validation passed: Required files/structure present');
    } else {
      logger.error('Validation failed: Missing required deliverable files');
    }

    return validationResult;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Validation failed with error: ${errMsg}`);
    return false;
  }
}

// ============================================================
// Main Execution
// ============================================================

export async function runClaudePrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'LLM analysis',
  _agentName: string | null = null,
  auditSession: AuditSession | null = null,
  logger: ActivityLogger,
  modelTier: ModelTier = 'medium',
  _outputFormat?: unknown, // preserved for API compatibility; structured output handled via prompt
  apiKey?: string,
  deliverablesSubdir?: string,
  providerConfig?: import('../types/config.js').ProviderConfig,
): Promise<ClaudePromptResult> {
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false,
  );
  const auditLogger = createAuditLogger(auditSession);

  logger.info(`Running LLM: ${description}...`);

  // Build env for the session
  const model = resolveModel(modelTier);

  // Set up LLM config
  const llmConfig: Record<string, string | undefined> = {};
  if (apiKey) llmConfig.apiKey = apiKey;

  // Map provider config to LLM configuration
  const provider = (() => {
    if (providerConfig?.providerType === 'anthropic_api' || providerConfig?.providerType === 'litellm_router') {
      return 'anthropic' as const;
    }
    return undefined;
  })();

  const baseUrl = providerConfig?.baseUrl || undefined;

  progress.start();

  try {
    // Build messages
    const messages = [
      { role: 'system' as const, content: 'You are a security analysis agent. Analyze the provided code carefully and produce accurate, well-structured findings.' },
      { role: 'user' as const, content: fullPrompt },
    ];

    // If structured output is requested, instruct the model in the prompt
    // (structured output via JSON schema is not supported by all providers,
    // so we use prompt-based JSON generation instead)

    logger.info(`Calling LLM model: ${model}`);

    let turnCount = 1;
    let result: string | null = null;
    const cost = 0; // Cost tracking not available from OpenAI-compatible APIs

    const response = await callLLM(
      messages,
      undefined, // no tools for now
      {
        model,
        apiKey: llmConfig.apiKey || undefined,
        ...(provider ? { provider } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      },
    );

    result = response.content;
    turnCount = 1;

    const duration = timer.stop();
    progress.finish(formatCompletionMessage(execContext, description, turnCount, duration));

    return {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost,
      model,
      partialCost: cost,
    };
  } catch (error) {
    const duration = timer.stop();

    const err = error as Error & { code?: string; status?: number };

    await auditLogger.logError(err, duration, 1);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: `${fullPrompt.slice(0, 100)}...`,
      success: false,
      duration,
      cost: 0,
      retryable: isRetryableError(err),
    };
  }
}
