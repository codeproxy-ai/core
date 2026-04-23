/**
 * Configuration file format for responses-api-translator.
 *
 * The config file allows you to define multiple providers and select the current one.
 */

import type { ProviderName } from '../fetch.js';

export interface ProviderConfig {
  /** Provider name (claude, anthropic, zai) */
  provider: ProviderName;
  /** Host to bind to (optional, defaults to 127.0.0.1) */
  host?: string;
  /** Port to listen on (optional, defaults to 8787) */
  port?: string | number;
  /** Base URL for this provider (optional, uses default if not specified) */
  baseUrl?: string;
  /** API version header (for anthropic/claude) */
  apiVersion?: string;
  /** Default API key for this provider (optional, can be overridden by request headers) */
  apiKey?: string;
  /** Default model to use (optional, can be overridden by requests) */
  model?: string;
  /** Additional default headers for this provider */
  headers?: Record<string, string>;
}

export interface ConfigFile {
  /** Version of the config file format */
  version: string;
  /** Current provider to use (must match one of the provider names) */
  currentProvider: string;
  /** List of available providers */
  providers: Record<string, ProviderConfig>;
}

/** Default config file names to search for */
export const CONFIG_FILE_NAMES = [
  'responses-api-translator.config.json',
  'responses-api-translator.config.js',
  'responses-api-translator.config.mjs',
  'responses-api-translator.config.ts',
  '.responses-api-translator.json',
  '.responses-api-translator.js',
];
