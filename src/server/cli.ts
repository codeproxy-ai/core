/**
 * `responses-api-translator` CLI.
 *
 * Usage:
 *   npx responses-api-translator --provider claude
 *   npx responses-api-translator --config responses-api-translator.config.json
 *   npx responses-api-translator --provider claude --port 9000 --host 0.0.0.0
 */

import { readFileSync, existsSync } from 'node:fs';
import { startProxy, type StartProxyOptions } from './proxy.js';
import type { ProviderName } from '../fetch.js';
import { validateConfig, getCurrentProviderConfig, type ConfigFile } from '../utils/config.js';

interface CliArgs {
  provider?: ProviderName;
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
      case '--provider':
        out.provider = take() as ProviderName;
        break;
      case '--config':
        out.config = take();
        break;
      case '--base-url':
        out.baseUrl = take();
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
        if (arg.startsWith('--provider=')) out.provider = arg.slice('--provider='.length) as ProviderName;
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
  responses-api-translator --provider <name> [options]
  responses-api-translator --config <file> [options]

Options:
  --provider <name>       Provider to use (claude, anthropic, zai)
  --config <file>         Use a config file instead of --provider
  --host <host>           Bind host (default: 127.0.0.1)
  -p, --port <port>       Bind port (default: 8787; 0 = random)
  --base-url <url>        Override provider upstream URL
  --api-version <ver>     Override anthropic-version header (anthropic only)
  --apikey <key>          Override upstream Authorization: Bearer <key>
  --model <name>          Override the model field in incoming requests
  --no-cors               Disable CORS headers
  -h, --help              Show help

Config File Mode:
  When using --config, the provider is loaded from the config file.
  Command-line options can override config values.
  
  Config file format (JSON):
  {
    "version": "1.0",
    "currentProvider": "my-claude",
    "providers": {
      "my-claude": {
        "provider": "claude",
        "baseUrl": "https://api.anthropic.com/v1/messages",
        "apiKey": "your-api-key",
        "model": "claude-sonnet-4-5"
      },
      "my-zai": {
        "provider": "zai",
        "baseUrl": "https://api.z.ai/api/coding/paas/v4/chat/completions",
        "apiKey": "your-zai-key"
      }
    }
  }

Auth is caller-driven: send Authorization: Bearer <key> (or the provider's
native header) when calling the proxy. Nothing is stored server-side.

Examples:
  responses-api-translator --provider claude
  responses-api-translator --config my-config.json
  responses-api-translator --provider zai --apikey <zai-key>
  responses-api-translator --provider claude --host 0.0.0.0 --port 9000
`);
}

async function loadConfigFile(configPath: string): Promise<ConfigFile> {
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error('Run with --help for more information.');
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

  const providerConfig = getCurrentProviderConfig(config);
  if (!providerConfig) {
    console.error(`Current provider "${config.currentProvider}" not found in config`);
    process.exit(1);
  }

  console.log(`Loaded config from: ${configPath}`);
  console.log(`Current provider: ${config.currentProvider} (${providerConfig.provider})`);

  // Build options from config, with CLI overrides
  const options: StartProxyOptions = {
    provider: providerConfig.provider as ProviderName,
    baseUrl: overrides.baseUrl || providerConfig.baseUrl,
    apiVersion: overrides.apiVersion || providerConfig.apiVersion,
    model: overrides.model || providerConfig.model,
    host: overrides.host,
    port: overrides.port,
    cors: overrides.cors,
  };

  // Merge headers from config and CLI
  const defaultHeaders: Record<string, string> = {};
  if (providerConfig.headers) {
    Object.assign(defaultHeaders, providerConfig.headers);
  }
  if (providerConfig.apiKey) {
    defaultHeaders.authorization = `Bearer ${providerConfig.apiKey}`;
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
    // Config file mode
    options = await loadConfigAndApplyOverrides(args.config, args);
  } else if (args.provider) {
    // Direct provider mode
    options = {
      provider: args.provider!,
      host: args.host,
      port: args.port,
      baseUrl: args.baseUrl,
      apiVersion: args.apiVersion,
      model: args.model,
      defaultHeaders: args.apikey ? { authorization: `Bearer ${args.apikey}` } : undefined,
      cors: args.cors,
    };
  } else {
    // No provider or config specified
    console.error('Error: --provider or --config is required');
    console.error('');
    printHelp();
    process.exit(1);
  }

  const proxy = await startProxy(options);
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down…`);
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
