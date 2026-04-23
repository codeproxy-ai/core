/**
 * Configuration file loader and validator.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigFile, ProviderConfig } from '../types/config.js';

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
 * Searches in the current directory and parent directories up to the project root.
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
      // Dynamic import for JS/MJS config files
      const module = await import(`file://${configPath}`);
      return module.default as ConfigFile;
    } else if (configPath.endsWith('.ts')) {
      // For TS files, we need to compile them first or use tsx
      // For simplicity, we'll require tsx to be available
      const module = await import(`file://${configPath}`);
      return module.default as ConfigFile;
    }
    return null;
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    return null;
  }
}

/**
 * Find the nearest config file by searching upward from the given directory.
 */
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

/**
 * Parse the filesystem root from a given path.
 */
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

  if (typeof cfg.currentProvider !== 'string') {
    return { valid: false, error: 'Config must have a currentProvider string' };
  }

  if (typeof cfg.providers !== 'object' || cfg.providers === null) {
    return { valid: false, error: 'Config must have a providers object' };
  }

  const providers = cfg.providers as Record<string, unknown>;

  if (!(cfg.currentProvider in providers)) {
    return {
      valid: false,
      error: `currentProvider "${cfg.currentProvider}" not found in providers`,
    };
  }

  // Validate each provider
  for (const [name, provider] of Object.entries(providers)) {
    const result = validateProviderConfig(provider);
    if (!result.valid) {
      return {
        valid: false,
        error: `Provider "${name}" is invalid: ${result.error}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate a single provider configuration.
 */
export function validateProviderConfig(provider: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof provider !== 'object' || provider === null) {
    return { valid: false, error: 'Provider config must be an object' };
  }

  const cfg = provider as Record<string, unknown>;

  if (typeof cfg.provider !== 'string') {
    return { valid: false, error: 'Provider must have a provider name (claude, anthropic, zai)' };
  }

  const validProviders = ['claude', 'anthropic', 'zai', 'openai'];
  if (!validProviders.includes(cfg.provider)) {
    return {
      valid: false,
      error: `Invalid provider name: ${cfg.provider}. Must be one of: ${validProviders.join(', ')}`,
    };
  }

  // Optional fields validation
  if (cfg.baseUrl !== undefined && typeof cfg.baseUrl !== 'string') {
    return { valid: false, error: 'baseUrl must be a string if provided' };
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
 * Get the current provider config from a validated config file.
 */
export function getCurrentProviderConfig(config: ConfigFile): ProviderConfig | null {
  const provider = config.providers[config.currentProvider];
  if (!provider) {
    return null;
  }
  return provider;
}

// Re-export types for convenience
export type { ConfigFile, ProviderConfig } from '../types/config.js';
