/**
 * `responses-api-translator` CLI.
 *
 * Usage:
 *   npx responses-api-translator --provider claude
 *   npx responses-api-translator --provider claude --port 9000 --host 0.0.0.0
 */

import { startProxy, type StartProxyOptions } from './proxy.js';
import type { ProviderName } from '../fetch.js';

interface CliArgs {
  provider?: ProviderName;
  host?: string;
  port?: number;
  baseUrl?: string;
  apiVersion?: string;
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
      case '--base-url':
        out.baseUrl = take();
        break;
      case '--api-version':
        out.apiVersion = take();
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

Options:
  --provider <name>       Required. One of: claude, anthropic
  --host <host>           Bind host (default: 127.0.0.1)
  -p, --port <port>       Bind port (default: 8787; 0 = random)
  --base-url <url>        Override provider upstream URL
  --api-version <ver>     Override anthropic-version header
  --no-cors               Disable CORS headers
  -h, --help              Show help

Auth is caller-driven: send Authorization: Bearer <key> (or the provider's
native header) when calling the proxy. Nothing is stored server-side.

Examples:
  responses-api-translator --provider claude
  responses-api-translator --provider claude --host 0.0.0.0 --port 9000
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.provider) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const options: StartProxyOptions = {
    provider: args.provider!,
    host: args.host,
    port: args.port,
    baseUrl: args.baseUrl,
    apiVersion: args.apiVersion,
    cors: args.cors,
  };

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
