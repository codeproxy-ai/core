/**
 * `responses-api-translator` CLI.
 *
 * Usage:
 *   npx responses-api-translator --upstream-format anthropic --base-url https://api.anthropic.com/v1/messages
 *   npx responses-api-translator --config config.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { startProxy, type StartProxyOptions } from './proxy.js';
import type { UpstreamFormat } from '../fetch.js';
import { validateConfig, getCurrentUpstreamConfig, type ConfigFile } from '../utils/config.js';

interface CliArgs {
  upstreamFormat?: UpstreamFormat | string;
  config?: string;
  host?: string;
  port?: number;
  baseUrl?: string;
  apiVersion?: string;
  apikey?: string;
  model?: string;
  cors?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-p':
      case '--port':
        out.port = Number(take());
        break;
      case '--host':
        out.host = take();
        break;
      case '--upstream-format':
        out.upstreamFormat = take();
        break;
      case '--base-url':
        out.baseUrl = take();
        break;
      case '--config':
        out.config = take();
        break;
      case '--api-version':
        out.apiVersion = take();
        break;
      case '--apikey':
        out.apikey = take();
        break;
      case '--model':
        out.model = take();
        break;
      case '--no-cors':
        out.cors = false;
        break;
      default:
        if (arg.startsWith('--upstream-format=')) out.upstreamFormat = arg.slice('--upstream-format='.length);
        else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length));
        else if (arg.startsWith('--host=')) out.host = arg.slice('--host='.length);
        else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
        else if (arg.startsWith('--api-version=')) out.apiVersion = arg.slice('--api-version='.length);
        else if (arg.startsWith('--apikey=')) out.apikey = arg.slice('--apikey='.length);
        else if (arg.startsWith('--model=')) out.model = arg.slice('--model='.length);
        else if (arg.startsWith('--config=')) out.config = arg.slice('--config='.length);
        else {
          console.error(`Unknown argument: ${arg}`);
          out.help = true;
        }
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`responses-api-translator - local Responses API proxy

Usage:
  responses-api-translator --base-url <url> [options]
  responses-api-translator --config <file> [options]

Options:
  --base-url <url>         Upstream endpoint URL (required when not using --config)
  --upstream-format <fmt>  Upstream API format: anthropic | openai-chat
                           (optional; inferred from --base-url when omitted:
                            */messages or *anthropic* → anthropic,
                            */chat/completions → openai-chat)
  --config <file>          Use a config file instead of CLI flags
  --host <host>            Bind host (default: 127.0.0.1)
  -p, --port <port>        Bind port (default: 8787; 0 = random)
  --api-version <ver>      Override anthropic-version header (anthropic only)
  --apikey <key>           Override upstream Authorization: Bearer <key>
  --model <name>           Override the model field in incoming requests
  --no-cors                Disable CORS headers
  -h, --help               Show help

Config File Mode:
  When using --config, upstream settings are loaded from the config file.
  Command-line options can override config values.

  Config file format (JSON):
  {
    "version": "1.0",
    "currentUpstream": "my-claude",
    "upstreams": {
      "my-claude": {
        "baseUrl": "https://api.anthropic.com/v1/messages",
        "apiKey": "your-api-key",
        "model": "claude-sonnet-4-5"
      },
      "my-openai": {
        "baseUrl": "https://api.openai.com/v1/chat/completions",
        "apiKey": "your-openai-key"
      }
    }
  }

  "format" is optional; inferred from baseUrl when omitted.

Auth is caller-driven: send Authorization: Bearer <key> (or the upstream's
native header) when calling the proxy. Nothing is stored server-side.

Examples:
  responses-api-translator --upstream-format anthropic --base-url https://api.anthropic.com/v1/messages
  responses-api-translator --upstream-format openai-chat --base-url https://api.openai.com/v1/chat/completions
  responses-api-translator --config my-config.json
  responses-api-translator --upstream-format anthropic --base-url https://api.anthropic.com/v1/messages --apikey <key>
`);
}

async function loadConfigFile(configPath: string): Promise<ConfigFile> {
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ConfigFile;
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    process.exit(1);
  }
}

async function loadConfigAndApplyOverrides(
  configPath: string,
  overrides: CliArgs,
): Promise<StartProxyOptions> {
  const config = await loadConfigFile(configPath);

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error(`Invalid config file: ${validation.error}`);
    process.exit(1);
  }

  const upstreamConfig = getCurrentUpstreamConfig(config);
  if (!upstreamConfig) {
    console.error(`Current upstream "${config.currentUpstream}" not found in config`);
    process.exit(1);
  }

  console.log(`Loaded config from: ${configPath}`);
  console.log(`Current upstream: ${config.currentUpstream}${upstreamConfig.format ? ` (${upstreamConfig.format})` : ''}`);
  console.log(`Model: ${upstreamConfig.model || "(not set)"}`);

  const options: StartProxyOptions = {
    upstreamFormat: upstreamConfig.format,
    baseUrl: overrides.baseUrl || upstreamConfig.baseUrl,
    apiVersion: overrides.apiVersion || upstreamConfig.apiVersion,
    model: overrides.model || upstreamConfig.model,
    host: overrides.host || upstreamConfig.host,
    port: overrides.port !== undefined ? overrides.port : ((config as any).port ? Number((config as any).port) : upstreamConfig.port ? Number(upstreamConfig.port) : undefined),
    cors: overrides.cors,
  };

  const defaultHeaders: Record<string, string> = {};
  if (upstreamConfig.headers) {
    Object.assign(defaultHeaders, upstreamConfig.headers);
  }
  if (upstreamConfig.apiKey) {
    defaultHeaders.authorization = `Bearer ${upstreamConfig.apiKey}`;
  }
  if (overrides.apikey) {
    defaultHeaders.authorization = `Bearer ${overrides.apikey}`;
  }

  if (Object.keys(defaultHeaders).length > 0) {
    options.defaultHeaders = defaultHeaders;
  }

  return options;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let options: StartProxyOptions;

  if (args.config) {
    options = await loadConfigAndApplyOverrides(args.config, args);
  } else if (args.baseUrl) {
    options = {
      upstreamFormat: args.upstreamFormat as UpstreamFormat | undefined,
      baseUrl: args.baseUrl,
      host: args.host,
      port: args.port,
      apiVersion: args.apiVersion,
      model: args.model,
      defaultHeaders: args.apikey ? { authorization: `Bearer ${args.apikey}` } : undefined,
      cors: args.cors,
    };
  } else {
    console.error('Error: Either --config <file> or --base-url <url> is required');
    console.error('');
    printHelp();
    process.exit(1);
  }

  const proxy = await startProxy(options);
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      await proxy.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
