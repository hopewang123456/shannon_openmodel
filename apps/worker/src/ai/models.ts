// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Model tier definitions and resolution.
 *
 * Three tiers mapped to capability levels:
 * - "small"  (Haiku / Flash — summarization, structured extraction)
 * - "medium" (Sonnet / Pro — tool use, general analysis)
 * - "large"  (Opus / Pro — deep reasoning, complex analysis)
 *
 * Users override via env vars.
 * Supports both OpenAI-compatible and Anthropic provider models.
 */

export type ModelTier = 'small' | 'medium' | 'large';

const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  small: 'deepseek-chat',
  medium: 'deepseek-chat',
  large: 'deepseek-chat',
};

/** Resolve a model tier to a concrete model ID. */
export function resolveModel(tier: ModelTier = 'medium'): string {
  const envKey = `LLM_${tier.toUpperCase()}_MODEL`;
  const envVal = process.env[envKey];
  if (envVal) return envVal;

  // Fallback: try ANTHROPIC_*_MODEL for backward compat
  const anthropicKey = `ANTHROPIC_${tier.toUpperCase()}_MODEL`;
  const anthropicVal = process.env[anthropicKey];
  if (anthropicVal) return anthropicVal;

  // Fallback: LLM_MODEL for all tiers
  const fallback = process.env.LLM_MODEL;
  if (fallback) return fallback;

  return DEFAULT_MODELS[tier];
}

/** Whether a model supports adaptive thinking. Legacy — kept for backward compat. */
export function supportsAdaptiveThinking(_model: string): boolean {
  return false; // Not supported in our multi-provider setup
}
