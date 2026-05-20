// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Preflight Validation Service
 *
 * Runs cheap, fast checks before any agent execution begins.
 * Catches configuration and credential problems early, saving
 * time and API costs compared to failing mid-pipeline.
 *
 * Checks run sequentially, cheapest first:
 * 1. Repository path exists and contains .git
 * 2. Config file parses and validates (if provided)
 * 3. code_path rules match real entries in the repo (filesystem only)
 * 4. Credentials validate via HTTP API ping
 * 5. Target URL is reachable from the container (DNS + HTTP)
 */

import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { glob } from 'zx';
import { validateLLMConnection } from '../ai/llm-provider.js';
import { parseConfig } from '../config-parser.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { Config, Rule } from '../types/config.js';
import { ErrorCode } from '../types/errors.js';
import { err, ok, type Result } from '../types/result.js';
import { PentestError } from './error-handling.js';

const TARGET_URL_TIMEOUT_MS = 10_000;

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '0.0.0.0';
}

// === Repository Validation ===

async function validateRepo(repoPath: string, logger: ActivityLogger, skipGitCheck?: boolean): Promise<Result<void, PentestError>> {
  logger.info('Checking repository path...', { repoPath });

  // 1. Check repo directory exists
  try {
    const stats = await fs.stat(repoPath);
    if (!stats.isDirectory()) {
      return err(
        new PentestError(
          `Repository path is not a directory: ${repoPath}`,
          'config',
          false,
          { repoPath },
          ErrorCode.REPO_NOT_FOUND,
        ),
      );
    }
  } catch {
    return err(
      new PentestError(
        `Repository path does not exist: ${repoPath}`,
        'config',
        false,
        { repoPath },
        ErrorCode.REPO_NOT_FOUND,
      ),
    );
  }

  // 2. Check .git directory exists (skipped when consumer removes .git after clone)
  if (!skipGitCheck) {
    try {
      const gitStats = await fs.stat(`${repoPath}/.git`);
      if (!gitStats.isDirectory()) {
        return err(
          new PentestError(
            `Not a git repository (no .git directory): ${repoPath}`,
            'config',
            false,
            { repoPath },
            ErrorCode.REPO_NOT_FOUND,
          ),
        );
      }
    } catch {
      return err(
        new PentestError(
          `Not a git repository (no .git directory): ${repoPath}`,
          'config',
          false,
          { repoPath },
          ErrorCode.REPO_NOT_FOUND,
        ),
      );
    }
  } else {
    logger.info('Skipping .git check (skipGitCheck enabled)');
  }

  logger.info('Repository path OK');
  return ok(undefined);
}

// === Config Validation ===

async function validateConfig(configPath: string, logger: ActivityLogger): Promise<Result<Config, PentestError>> {
  logger.info('Validating configuration file...', { configPath });

  try {
    const config = await parseConfig(configPath);
    logger.info('Configuration file OK');
    return ok(config);
  } catch (error) {
    if (error instanceof PentestError) {
      return err(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new PentestError(
        `Configuration validation failed: ${message}`,
        'config',
        false,
        { configPath },
        ErrorCode.CONFIG_VALIDATION_FAILED,
      ),
    );
  }
}

// === code_path Existence Validation ===

const CODE_PATH_IGNORE = ['.git/**', '.shannon/**'];

async function patternMatchesAny(repoPath: string, pattern: string): Promise<boolean> {
  const stream = glob.globbyStream(pattern, {
    cwd: repoPath,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    ignore: CODE_PATH_IGNORE,
  });
  for await (const _ of stream) {
    return true;
  }
  return false;
}

type RuleKind = 'avoid' | 'focus';
interface MissingCodePath {
  kind: RuleKind;
  value: string;
  description: string;
}

async function validateCodePathsExist(
  config: Config,
  repoPath: string,
  logger: ActivityLogger,
): Promise<Result<void, PentestError>> {
  const tagged: Array<{ kind: RuleKind; rule: Rule }> = [
    ...(config.rules?.avoid ?? []).map((rule) => ({ kind: 'avoid' as const, rule })),
    ...(config.rules?.focus ?? []).map((rule) => ({ kind: 'focus' as const, rule })),
  ].filter(({ rule }) => rule.type === 'code_path');

  if (tagged.length === 0) {
    return ok(undefined);
  }

  logger.info(`Validating ${tagged.length} code_path rule(s) against repo...`);

  // ≥1 match is the only property enforced — malformed globs simply match nothing.
  const missing: MissingCodePath[] = [];
  for (const { kind, rule } of tagged) {
    if (!(await patternMatchesAny(repoPath, rule.value))) {
      missing.push({ kind, value: rule.value, description: rule.description });
    }
  }

  if (missing.length > 0) {
    const lines = missing.map((m) => `[${m.kind}] '${m.value}' — ${m.description}`);
    return err(
      new PentestError(
        `code_path rules don't match any file or directory in the repo:\n  - ${lines.join('\n  - ')}\n` +
          `Fix the patterns or remove the rules.`,
        'config',
        false,
        { missing },
        ErrorCode.CONFIG_VALIDATION_FAILED,
      ),
    );
  }

  logger.info('All code_path rules matched');
  return ok(undefined);
}

// === Credential Validation ===

/** Validate credentials via an HTTP API ping instead of the Claude Agent SDK query. */
async function validateCredentials(logger: ActivityLogger, apiKey?: string, providerConfig?: import('../types/config.js').ProviderConfig): Promise<Result<void, PentestError>> {
  // 0. If providerConfig is present, skip env-based validation
  if (providerConfig) {
    logger.info(`Provider config present (type: ${providerConfig.providerType || 'anthropic_api'}) — skipping env-based credential validation`);
    return ok(undefined);
  }

  // 1. Build LLM config from env
  const llmConfig: Record<string, string | undefined> = {};
  if (apiKey) llmConfig.apiKey = apiKey;

  const provider = (() => {
    if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) return 'anthropic' as const;
    if (process.env.LLM_PROVIDER === 'anthropic') return 'anthropic' as const;
    return undefined;
  })();

  const baseUrl =
    process.env.ANTHROPIC_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    undefined;

  // 2. Check that at least one credential is present
  const hasApiKey = !!(apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
  const hasBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === '1';
  const hasVertex = process.env.CLAUDE_CODE_USE_VERTEX === '1';

  if (!hasApiKey && !hasBedrock && !hasVertex) {
    return err(
      new PentestError(
        'No API credentials found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env (or use CLAUDE_CODE_USE_BEDROCK=1 for AWS Bedrock, or CLAUDE_CODE_USE_VERTEX=1 for Google Vertex AI). For DeepSeek, use OPENAI_API_KEY=sk-... or LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY.',
        'config',
        false,
        {},
        ErrorCode.AUTH_FAILED,
      ),
    );
  }

  // 3. Bedrock mode
  if (hasBedrock) {
    const required = ['AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK'];
    const missing = required.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      return err(
        new PentestError(
          `Bedrock mode requires: ${missing.join(', ')}`,
          'config',
          false,
          { missing },
          ErrorCode.AUTH_FAILED,
        ),
      );
    }
    // Also need model overrides
    for (const tier of ['ANTHROPIC_SMALL_MODEL', 'ANTHROPIC_MEDIUM_MODEL', 'ANTHROPIC_LARGE_MODEL']) {
      if (!process.env[tier]) {
        return err(
          new PentestError(
            `Bedrock model not set: set ${tier} in .env`,
            'config',
            false,
            { missing: [tier] },
            ErrorCode.AUTH_FAILED,
          ),
        );
      }
    }
    logger.info('Bedrock credentials OK');
    return ok(undefined);
  }

  // 4. Vertex AI mode
  if (hasVertex) {
    const required = ['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_APPLICATION_CREDENTIALS'];
    const missing = required.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      return err(
        new PentestError(
          `Vertex AI mode requires: ${missing.join(', ')}`,
          'config',
          false,
          { missing },
          ErrorCode.AUTH_FAILED,
        ),
      );
    }
    try {
      const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
      await fs.access(credPath);
    } catch {
      return err(
        new PentestError(
          `Service account key file not found: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`,
          'config',
          false,
          {},
          ErrorCode.AUTH_FAILED,
        ),
      );
    }
    // Model overrides required for Vertex
    for (const tier of ['ANTHROPIC_SMALL_MODEL', 'ANTHROPIC_MEDIUM_MODEL', 'ANTHROPIC_LARGE_MODEL']) {
      if (!process.env[tier]) {
        return err(
          new PentestError(
            `Vertex AI model not set: set ${tier} in .env`,
            'config',
            false,
            { missing: [tier] },
            ErrorCode.AUTH_FAILED,
          ),
        );
      }
    }
    logger.info('Vertex AI credentials OK');
    return ok(undefined);
  }

  // 5. API key-based validation via HTTP ping
  const authType = apiKey ? 'Config API key' : 'OpenAI/Anthropic API key';
  logger.info(`Validating ${authType}...`);

  try {
    const result = await validateLLMConnection({
      ...(llmConfig.apiKey ? { apiKey: llmConfig.apiKey } : {}),
      ...(provider ? { provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    if (result.ok) {
      logger.info(`${authType} OK`);
      return ok(undefined);
    }

    return err(
      new PentestError(
        `${authType} validation failed: ${result.error}. Check your credentials in .env.`,
        'config',
        false,
        {},
        ErrorCode.AUTH_FAILED,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new PentestError(
        `Credential validation failed: ${message}`,
        'network',
        false,
        {},
        ErrorCode.AUTH_FAILED,
      ),
    );
  }
}

// === Target URL Validation ===

/** HTTP HEAD with TLS verification disabled — we check reachability, not certificate validity. */
function httpHead(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      url,
      {
        method: 'HEAD',
        timeout: timeoutMs,
        ...(isHttps && { rejectUnauthorized: false }),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Connection timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Check that the target URL is reachable from inside the container. */
async function validateTargetUrl(targetUrl: string, logger: ActivityLogger): Promise<Result<void, PentestError>> {
  logger.info('Checking target URL reachability...');

  // 1. Parse URL
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return err(
      new PentestError(
        `Invalid target URL: ${targetUrl}`,
        'config',
        false,
        { targetUrl },
        ErrorCode.TARGET_UNREACHABLE,
      ),
    );
  }

  // 2. DNS lookup — detect loopback addresses early for a better hint
  const hostname = parsed.hostname;
  let resolvedAddress: string | undefined;
  try {
    const result = await lookup(hostname);
    resolvedAddress = result.address;
  } catch {
    return err(
      new PentestError(
        `Target URL ${targetUrl} is not reachable. Verify the URL is correct and the site is up.`,
        'network',
        false,
        { targetUrl, hostname },
        ErrorCode.TARGET_UNREACHABLE,
      ),
    );
  }

  // 3. HTTP reachability check
  try {
    await httpHead(targetUrl, TARGET_URL_TIMEOUT_MS);

    logger.info('Target URL OK');
    return ok(undefined);
  } catch (error) {
    const isLoopback = isLoopbackAddress(resolvedAddress);
    const hint = isLoopback
      ? `\n  Hint: The target resolves to a loopback address (${resolvedAddress}). When running in Docker, 'localhost' refers to the container, not your host.\n  Use 'host.docker.internal' or the host machine's IP to reach services running on the host.`
      : '';

    const _message = error instanceof Error ? error.message : String(error);
    void _message; // suppress unused warning
    return err(
      new PentestError(
        `Unable to connect to target URL: ${targetUrl}${hint}`,
        'network',
        false,
        { targetUrl, hostname, resolvedAddress },
        ErrorCode.TARGET_UNREACHABLE,
      ),
    );
  }
}

// === Main Preflight Entry Point ===

export interface PreflightOptions {
  repoPath?: string;
  configPath?: string;
  targetUrl?: string;
  skipGitCheck?: boolean;
  apiKey?: string;
  providerConfig?: import('../types/config.js').ProviderConfig;
}

export async function runPreflight(
  options: PreflightOptions,
  logger: ActivityLogger,
): Promise<Result<void, PentestError>> {
  // 1. Validate repository
  if (options.repoPath) {
    const repoResult = await validateRepo(options.repoPath, logger, options.skipGitCheck);
    if (!repoResult.ok) return repoResult;
  }

  // 2. Validate config
  let config: Config | undefined;
  if (options.configPath) {
    const configResult = await validateConfig(options.configPath, logger);
    if (!configResult.ok) return configResult;
    config = configResult.value;
  }

  // 3. Validate code_path rules (requires repo + config)
  if (options.repoPath && config) {
    const codePathResult = await validateCodePathsExist(config, options.repoPath, logger);
    if (!codePathResult.ok) return codePathResult;
  }

  // 4. Validate credentials
  const credResult = await validateCredentials(logger, options.apiKey, options.providerConfig);
  if (!credResult.ok) return credResult;

  // 5. Validate target URL (skip if exploit is disabled in config)
  const exploitDisabled = config?.exploit === 'false';
  if (options.targetUrl && !exploitDisabled) {
    const targetResult = await validateTargetUrl(options.targetUrl, logger);
    if (!targetResult.ok) return targetResult;
  }

  logger.info('All preflight checks passed');
  return ok(undefined);
}
