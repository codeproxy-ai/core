/**
 * Local HTTP proxy that exposes the Responses API and forwards translated
 * requests to the chosen provider.  Built on top of `createResponsesFetch`
 * so the server and the in-process fetch wrapper share the exact same
 * translation logic.
 *
 * Runs on Node 18+ (uses the built-in `node:http` server and global
 * `fetch` / `ReadableStream`).  Not intended to run in the browser.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  createResponsesFetch,
  type CreateResponsesFetchOptions,
} from '../fetch.js';

export interface StartProxyOptions extends Omit<CreateResponsesFetchOptions, 'passthroughFetch'> {
  /** Host to bind to. Defaults to `127.0.0.1`. */
  host?: string;
  /** Port to listen on. Defaults to `8787`; pass `0` for a random free port. */
  port?: number;
  /** Enable permissive CORS (useful for local browser dev). Defaults to true. */
  cors?: boolean;
  /** Optional logger. Defaults to `console`. Pass `null` to silence. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'> | null;
}

export interface RunningProxy {
  /** The bound host. */
  host: string;
  /** The port the server is listening on (resolved when `port: 0`). */
  port: number;
  /** Human-friendly URL. */
  url: string;
  /** Underlying Node `http.Server`. */
  server: Server;
  /** Close the server. */
  close: () => Promise<void>;
}

/**
 * Start a local HTTP proxy.  Clients can POST to `http://<host>:<port>/v1/responses`
 * with OpenAI Responses API payloads and the proxy will translate to the
 * configured provider.  Any other path returns 404.
 */
export async function startProxy(options: StartProxyOptions): Promise<RunningProxy> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const cors = options.cors ?? true;
  const logger = options.logger === null ? null : (options.logger ?? console);

  const apiFetch = createResponsesFetch({
    provider: options.provider,
    baseUrl: options.baseUrl,
    apiVersion: options.apiVersion,
    defaultHeaders: options.defaultHeaders,
    fetch: options.fetch,
    translate: options.translate,
    // Non-/responses traffic: return 404 instead of proxying through.
    passthroughFetch: async () =>
      new Response(JSON.stringify({ error: { message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
  });

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    try {
      await handleRequest(req, res, apiFetch, { cors, logger, method: req.method ?? 'GET', url: req.url ?? '/' });
      logger?.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - start}ms)`);
    } catch (err) {
      logger?.error('proxy request failed', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: (err as Error).message } }));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  logger?.log(`responses-api-translator listening on ${url}/v1/responses`);

  return {
    host,
    port: boundPort,
    url,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiFetch: typeof fetch,
  opts: {
    cors: boolean;
    logger: Pick<Console, 'log' | 'warn' | 'error'> | null;
    method: string;
    url: string;
  },
): Promise<void> {
  if (opts.cors) setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const method = req.method ?? 'GET';
  const urlPath = req.url ?? '/';
  const headers = flattenIncomingHeaders(req.headers);

  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readIncomingBody(req);
  }

  // We only implement `/v1/responses`.  Everything else -> 404.
  if (!/^\/v1\/responses\/?(?:\?|$)/.test(urlPath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${method} ${urlPath}` } }));
    return;
  }

  const requestBodyText = body ? body.toString('utf8') : undefined;
  const response = await apiFetch(`http://local${urlPath}`, {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });

  const responseBodyText = response.body ? await response.clone().text() : '';
  if (response.status >= 400) {
    opts.logger?.error(
      `[proxy-failure] request=${JSON.stringify({ method: opts.method, url: opts.url, headers, body: requestBodyText })} response=${JSON.stringify({ status: response.status, headers: headersToObject(response.headers), body: responseBodyText })}`,
    );
  }

  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  if (opts.cors) Object.assign(outHeaders, corsHeaders());

  res.writeHead(response.status, outHeaders);

  if (!response.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
  nodeStream.pipe(res);
  await new Promise<void>((resolve, reject) => {
    nodeStream.once('end', resolve);
    nodeStream.once('error', reject);
    res.once('close', resolve);
  });
}

function readIncomingBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function flattenIncomingHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function setCorsHeaders(res: ServerResponse): void {
  const h = corsHeaders();
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers':
      'authorization,content-type,x-api-key,anthropic-version,anthropic-beta,anthropic-dangerous-direct-browser-access',
    'access-control-expose-headers': 'content-type',
  };
}
