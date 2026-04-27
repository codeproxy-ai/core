/**
 * Local HTTP proxy that exposes the Responses API and forwards translated
 * requests to the configured upstream API format.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  /** Optional callback to receive cache statistics after each request completes. */
  onCacheStats?: (stats: { cachedTokens: number; cacheCreationTokens: number; inputTokens: number; outputTokens: number; totalTokens: number; method?: string; url?: string; durationMs?: number }) => void;
}

export interface RunningProxy {
  host: string;
  port: number;
  url: string;
  server: Server;
  close: () => Promise<void>;
}

export async function startProxy(options: StartProxyOptions): Promise<RunningProxy> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const cors = options.cors ?? true;
  const logger = options.logger === null ? null : (options.logger ?? console);

  const requestInfo = { method: '', url: '', startTime: 0 };

  const upstreamCapture: {
    request?: { url: string; method: string; headers: Record<string, string>; body: unknown };
    response?: { status: number; statusText: string; headers: Record<string, string>; body: unknown };
  } = {};

  const baseFetch = options.fetch ?? globalThis.fetch;
  const capturingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();
    const reqHeaders = headersInitToObject(init?.headers);
    let reqBody: unknown = undefined;
    if (init?.body != null) {
      if (typeof init.body === 'string') reqBody = tryParseJson(init.body);
      else if (init.body instanceof ArrayBuffer) reqBody = tryParseJson(new TextDecoder().decode(init.body));
      else if (ArrayBuffer.isView(init.body)) reqBody = tryParseJson(new TextDecoder().decode(init.body as Uint8Array));
      else reqBody = String(init.body);
    }
    upstreamCapture.request = { url, method, headers: reqHeaders, body: reqBody };

    const resp = await baseFetch(input as RequestInfo, init);

    if (!resp.ok) {
      const clone = resp.clone();
      const text = await clone.text().catch(() => '');
      upstreamCapture.response = {
        status: resp.status,
        statusText: resp.statusText,
        headers: headersToObject(resp.headers),
        body: tryParseJson(text),
      };
    } else {
      upstreamCapture.response = undefined;
    }
    return resp;
  };

  const apiFetch = createResponsesFetch({
    upstreamFormat: options.upstreamFormat,
    baseUrl: options.baseUrl,
    apiVersion: options.apiVersion,
    model: options.model,
    defaultHeaders: options.defaultHeaders,
    dropImages: options.dropImages,
    fetch: capturingFetch,
    passthroughFetch: async () =>
      new Response(JSON.stringify({ error: { message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    onCacheStats: (stats) => {
      const durationMs = requestInfo.startTime ? Date.now() - requestInfo.startTime : 0;
      const billedTokens = stats.inputTokens + stats.outputTokens - stats.cachedTokens;
      const parts = [
        `total=${stats.totalTokens}`,
        `input=${stats.inputTokens}`,
        `output=${stats.outputTokens}`,
        `cached=${stats.cachedTokens}`,
        `billed=${billedTokens}`,
      ];
      if (stats.cacheCreationTokens > 0) parts.push(`cache_creation=${stats.cacheCreationTokens}`);
      const logMsg = `[${new Date().toISOString()}] ${requestInfo.method || 'POST'} ${requestInfo.url || '/v1/responses'} -> 200 (${durationMs}ms) [${parts.join(', ')}]`;
      if (stats.cachedTokens === 0 && billedTokens > 0) {
        logger?.warn(`⚠️ NO CACHE -- ${logMsg}`);
      } else {
        logger?.log(logMsg);
      }

      if (options.onCacheStats) {
        options.onCacheStats({
          ...stats,
          method: requestInfo.method || undefined,
          url: requestInfo.url || undefined,
          durationMs: durationMs || undefined,
        });
      }
    },
  });

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    requestInfo.method = req.method ?? 'POST';
    requestInfo.url = req.url ?? '/v1/responses';
    requestInfo.startTime = start;

    try {
      await handleRequest(req, res, {
        apiFetch,
        cors,
        logger,
        method: req.method ?? 'POST',
        url: req.url ?? '/',
        upstreamCapture,
      });
    } catch (err) {
      logger?.error('[proxy-error]', err);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
        }
      } catch {
        // ignore
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const actualPort = (server.address() as { port: number }).port;
      const url = `http://${host}:${actualPort}`;
      logger?.log(`Proxy listening on ${url}`);
      logger?.log(`Upstream format: ${options.upstreamFormat}`);
      logger?.log(`Upstream URL: ${options.baseUrl}`);
      resolve({
        host,
        port: actualPort,
        url,
        server,
        close: () =>
          new Promise((res) => {
            server.close((err) => {
              if (err) logger?.warn('Error closing server:', err);
              res();
            });
          }),
      });
    });
    server.once('error', reject);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    apiFetch: typeof fetch;
    cors: boolean;
    logger: Pick<Console, 'log' | 'warn' | 'error'> | null;
    method: string;
    url: string;
    upstreamCapture: {
      request?: { url: string; method: string; headers: Record<string, string>; body: unknown };
      response?: { status: number; statusText: string; headers: Record<string, string>; body: unknown };
    };
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

  if (!/^\/v1\/responses\/?(?:\?|$)/.test(urlPath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${method} ${urlPath}` } }));
    return;
  }

  const requestBodyText = body ? body.toString('utf8') : undefined;
  const response = await opts.apiFetch(`http://local${urlPath}`, {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });

  const responseBodyText = response.body ? await response.clone().text() : '';
  if (response.status >= 400) {
    try {
      const filePath = saveErrorDump({
        method: opts.method,
        url: opts.url,
        clientRequest: {
          headers,
          body: tryParseJson(requestBodyText ?? ''),
        },
        upstreamRequest: opts.upstreamCapture.request,
        upstreamResponse: opts.upstreamCapture.response,
        proxyResponse: {
          status: response.status,
          headers: headersToObject(response.headers),
          body: tryParseJson(responseBodyText),
        },
      });
      opts.logger?.error(`[proxy-failure] full exchange saved to ${filePath}`);
    } catch (dumpErr) {
      opts.logger?.error('[proxy-failure] failed to persist error dump', dumpErr);
    }
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

function tryParseJson(s: string | undefined | null): unknown {
  if (!s) return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function headersInitToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

function saveErrorDump(dump: {
  method: string;
  url: string;
  clientRequest: { headers: Record<string, string>; body: unknown };
  upstreamRequest?: { url: string; method: string; headers: Record<string, string>; body: unknown };
  upstreamResponse?: { status: number; statusText: string; headers: Record<string, string>; body: unknown };
  proxyResponse: { status: number; headers: Record<string, string>; body: unknown };
}): string {
  const dir = resolve(process.cwd(), 'logs');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const status = dump.upstreamResponse?.status ?? dump.proxyResponse.status;
  const filename = `proxy-error-${ts}-${status}.json`;
  const filePath = join(dir, filename);
  const payload = {
    timestamp: new Date().toISOString(),
    ...dump,
  };
  redactAuth(payload.clientRequest?.headers);
  redactAuth(payload.upstreamRequest?.headers);
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function redactAuth(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    const k = key.toLowerCase();
    if (k === 'authorization' || k === 'x-api-key' || k === 'api-key' || k === 'cookie') {
      headers[key] = '[REDACTED]';
    }
  }
}
