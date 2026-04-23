/**
 * Configuration file loader and validator.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ConfigFile, UpstreamConfig } from '../types/config.js';

const CONFIG_FILE_NAMES = [
  'responses-api-translator.config.json',
  'responses-api-translator.config.js',
  'responses-api-translator.config.mjs',
  'responses-api-translator.config.ts',
  '.responses-api-translator.json',
  '.responses-api-translator.js',
] as const;

/**
 * Find and load a config file.
 */
export async function loadConfigFile(
  searchFrom: string = process.cwd(),
): Promise<ConfigFile | null> {
  const configPath = findConfigPath(searchFrom);
  if (!configPath) return null;

  try {
    if (configPath.endsWith('.json')) {
      const content = readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as ConfigFile;
    } else if (configPath.endsWith('.js') || configPath.endsWith('.mjs')) {
      const module = await import(`file://${configPath}`);
      return module.default as ConfigFile;
    } else if (configPath.endsWith('.ts')) {
      const module = await import(`file://${configPath}`);
      return module.default as ConfigFile;
    }
    return null;
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    return null;
  }
}

function findConfigPath(searchFrom: string): string | null {
  let currentDir = searchFrom;
  const root = parseRoot(searchFrom);

  while (currentDir !== root && currentDir !== dirname(currentDir)) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolve(currentDir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    currentDir = dirname(currentDir);
  }

  return null;
}

function parseRoot(path: string): string {
  const parsed = resolve(path);
  const root = parsed.split(/[\\/]/)[0];
  return resolve(root);
}

/**
 * Validate the config file structure.
 */
export function validateConfig(config: unknown): { valid: boolean; error?: string } {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, error: 'Config must be an object' };
  }

  const cfg = config as Record<string, unknown>;

  if (typeof cfg.version !== 'string') {
    return { valid: false, error: 'Config must have a version string' };
  }

  if (typeof cfg.currentUpstream !== 'string') {
    return { valid: false, error: 'Config must have a currentUpstream string' };
  }

  if (typeof cfg.upstreams !== 'object' || cfg.upstreams === null) {
    return { valid: false, error: 'Config must have an upstreams object' };
  }

  const upstreams = cfg.upstreams as Record<string, unknown>;

  if (!(cfg.currentUpstream in upstreams)) {
    return {
      valid: false,
      error: `currentUpstream "${cfg.currentUpstream}" not found in upstreams`,
    };
  }

  for (const [name, upstream] of Object.entries(upstreams)) {
    const result = validateUpstreamConfig(upstream);
    if (!result.valid) {
      return {
        valid: false,
        error: `Upstream "${name}" is invalid: ${result.error}`,
      };
    }
  }

  return { valid: true };
}

export function validateUpstreamConfig(upstream: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof upstream !== 'object' || upstream === null) {
    return { valid: false, error: 'Upstream config must be an object' };
  }

  const cfg = upstream as Record<string, unknown>;

  if (cfg.format !== undefined) {
    if (typeof cfg.format !== 'string') {
      return { valid: false, error: 'format must be a string if provided' };
    }
    const validFormats = ['anthropic', 'openai-chat'];
    if (!validFormats.includes(cfg.format)) {
      return {
        valid: false,
        error: `Invalid format: ${cfg.format}. Must be one of: ${validFormats.join(', ')}`,
      };
    }
  }

  if (typeof cfg.baseUrl !== 'string') {
    return { valid: false, error: 'baseUrl is required and must be a string' };
  }

  if (cfg.apiVersion !== undefined && typeof cfg.apiVersion !== 'string') {
    return { valid: false, error: 'apiVersion must be a string if provided' };
  }

  if (cfg.apiKey !== undefined && typeof cfg.apiKey !== 'string') {
    return { valid: false, error: 'apiKey must be a string if provided' };
  }

  if (cfg.model !== undefined && typeof cfg.model !== 'string') {
    return { valid: false, error: 'model must be a string if provided' };
  }

  if (cfg.headers !== undefined && (typeof cfg.headers !== 'object' || cfg.headers === null)) {
    return { valid: false, error: 'headers must be an object if provided' };
  }

  return { valid: true };
}

/**
 * Get the current upstream config from a validated config file.
 */
export function getCurrentUpstreamConfig(config: ConfigFile): UpstreamConfig | null {
  const upstream = config.upstreams[config.currentUpstream];
  if (!upstream) return null;
  return upstream;
}

// Re-export types
export type { ConfigFile, UpstreamConfig } from '../types/config.js';
