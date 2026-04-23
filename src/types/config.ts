/**
 * Configuration file format for responses-api-translator.
 */

export type UpstreamFormat = 'anthropic' | 'openai-chat';

export interface UpstreamConfig {
  /** Upstream API format. If omitted, inferred from `baseUrl`. */
  format?: UpstreamFormat;
  /** Upstream endpoint URL. Required. */
  baseUrl: string;
  /** Host to bind to (optional, defaults to 127.0.0.1). */
  host?: string;
  /** Port to listen on (optional, defaults to 8787). */
  port?: string | number;
  /** API version header (for anthropic format). */
  apiVersion?: string;
  /** Default API key (optional, can be overridden by request headers). */
  apiKey?: string;
  /** Default model to use (optional, can be overridden by requests). */
  model?: string;
  /** Additional default headers. */
  headers?: Record<string, string>;
}

export interface ConfigFile {
  /** Version of the config file format. */
  version: string;
  /** Current upstream config to use. */
  currentUpstream: string;
  /** List of available upstream configs. */
  upstreams: Record<string, UpstreamConfig>;
}

/** Default config file names to search for. */
export const CONFIG_FILE_NAMES = [
  'responses-api-translator.config.json',
  'responses-api-translator.config.js',
  'responses-api-translator.config.mjs',
  'responses-api-translator.config.ts',
  '.responses-api-translator.json',
  '.responses-api-translator.js',
];
