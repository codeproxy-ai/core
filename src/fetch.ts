/**
 * Drop-in `fetch` wrapper that translates OpenAI Responses API traffic
 * to an upstream API format (Anthropic Messages or OpenAI Chat).
 */

import * as anthropic from './translate/anthropic/index.js';
import * as openai from './translate/openai/index.js';
import { encodeSseEvent } from './utils/sse.js';
import type { ResponsesRequest, ResponsesStreamEvent, ResponsesResponse } from './types/responses.js';
import type { AnthropicResponse } from './types/anthropic.js';
import type { OpenAiChatResponse } from './types/openai_chat.js';

export type UpstreamFormat = 'anthropic' | 'openai-chat';

export interface CacheStats {
  cachedTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CreateResponsesFetchOptions {
  /** Upstream API format. If omitted, inferred from `baseUrl`. */
  upstreamFormat?: UpstreamFormat;
  /** Upstream endpoint URL. Required. */
  baseUrl: string;
  /** Override upstream API version header (Anthropic only). */
  apiVersion?: string;
  /** Replace the caller-provided `model` field before translation. */
  model?: string;
  /** Extra headers merged into every upstream call. */
  defaultHeaders?: Record<string, string>;
  /** Underlying fetch. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Non-/responses traffic forward target. Defaults to `options.fetch`. */
  passthroughFetch?: typeof fetch;
  /** Optional callback to receive cache statistics. */
  onCacheStats?: (stats: CacheStats) => void;
}

export function createResponsesFetch(options: CreateResponsesFetchOptions): typeof fetch {
  if (!options.baseUrl) throw new Error('baseUrl is required');

  const format = options.upstreamFormat
    ? normalizeFormat(options.upstreamFormat)
    : inferFormatFromUrl(options.baseUrl);
  if (!format) {
    throw new Error(
      options.upstreamFormat
        ? `Unsupported upstream format: ${options.upstreamFormat}. Use 'anthropic' or 'openai-chat'`
        : `Could not infer upstreamFormat from baseUrl: ${options.baseUrl}. Pass upstreamFormat explicitly.`,
    );
  }

  const baseFetch = options.fetch ?? globalThis.fetch;
  if (!baseFetch) throw new Error('fetch is not available; pass options.fetch');
  const passthrough = options.passthroughFetch ?? baseFetch;

  return async (input, init) => {
    const url = urlOf(input);
    if (!isResponsesEndpoint(url)) return passthrough(input as RequestInfo, init);

    const { body, signal, method, headers } = await extractRequest(input, init);
    if (method !== 'POST') return passthrough(input as RequestInfo, init);

    let parsed: ResponsesRequest | undefined;
    try { parsed = body ? (JSON.parse(body) as ResponsesRequest) : undefined; }
    catch { return jsonErrorResponse(400, 'Invalid JSON body for /responses'); }
    if (!parsed) return jsonErrorResponse(400, 'Missing body for /responses');

    if (options.model) parsed.model = options.model;
    return handleResponses(parsed, format, options, baseFetch, headers, signal);
  };
}

// ── format helpers ──

function normalizeFormat(v: string): UpstreamFormat | null {
  return v === 'anthropic' || v === 'openai-chat' ? (v as UpstreamFormat) : null;
}

function isDeepseekBaseUrl(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes('deepseek');
  } catch {
    return baseUrl.toLowerCase().includes('deepseek');
  }
}

function inferFormatFromUrl(baseUrl: string): UpstreamFormat | null {
  try {
    const u = new URL(baseUrl);
    const path = u.pathname.replace(/\/+$/, '');
    if (/\/messages$/.test(path) || u.hostname.toLowerCase().includes('anthropic')) return 'anthropic';
    if (/\/chat\/completions$/.test(path)) return 'openai-chat';
  } catch { /* ignore */ }
  return null;
}

// ── request extraction ──

function isResponsesEndpoint(url: string): boolean {
  try { return /\/v1\/responses\/?$/.test(new URL(url, 'http://_internal_').pathname); }
  catch { return /\/v1\/responses(?:\?|$)/.test(url); }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function parseHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (typeof Headers !== 'undefined' && raw instanceof Headers) {
    raw.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

async function extractRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ body: string | undefined; signal: AbortSignal | undefined; method: string; headers: Record<string, string> }> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const text = await input.clone().text();
    const headers = parseHeaders(input.headers as unknown as HeadersInit);
    return { body: text || undefined, signal: input.signal, method: input.method, headers };
  }
  const method = init?.method?.toUpperCase() ?? 'GET';
  const body = init?.body != null ? (typeof init.body === 'string' ? init.body : await readBody(init.body)) : undefined;
  return { body, signal: init?.signal, method, headers: parseHeaders(init?.headers) };
}

async function readBody(body: BodyInit): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return String(body);
}

// ── main handler ──

async function handleResponses(
  request: ResponsesRequest,
  format: UpstreamFormat,
  options: CreateResponsesFetchOptions,
  baseFetch: typeof fetch,
  incomingHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const streaming = request.stream ?? false;
  const { upstreamBody, requestMetadata } = buildUpstreamBody(request, format, streaming, options.baseUrl);
  const upstreamHeaders = buildUpstreamHeaders(format, options, incomingHeaders);

  const upstream = await baseFetch(options.baseUrl, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
    signal,
  });

  if (!upstream.ok) {
    return new Response(await upstream.text().catch(() => ''), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }

  if (!streaming) {
    const body = (await upstream.json()) as AnthropicResponse | OpenAiChatResponse;
    const translated = format === 'anthropic'
      ? anthropic.translateResponse(body as AnthropicResponse, { model: request.model })
      : openai.translateResponse(body as OpenAiChatResponse, { model: request.model });
    options.onCacheStats?.(extractCacheStatsFromResponse(translated));
    return new Response(JSON.stringify(translated), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (!upstream.body) return jsonErrorResponse(502, 'Upstream streaming response has no body');

  const events = format === 'anthropic'
    ? anthropic.translateStream(upstream.body, { model: request.model, requestMetadata })
    : openai.translateStream(upstream.body, { model: request.model, requestMetadata });

  return new Response(responsesEventsToSseStream(collectCacheStatsFromStream(events, options.onCacheStats)), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}

// ── upstream body ──

function buildRequestMetadata(request: ResponsesRequest, temperature?: number, top_p?: number) {
  return { temperature, top_p, tools: (request.tools as unknown[]) ?? [], tool_choice: request.tool_choice, store: request.store ?? true, metadata: (request.metadata as Record<string, unknown>) ?? {} };
}

function buildUpstreamBody(request: ResponsesRequest, format: UpstreamFormat, streaming: boolean, baseUrl: string): { upstreamBody: unknown; requestMetadata: ReturnType<typeof buildRequestMetadata> } {
  if (format === 'anthropic') {
    const { request: ar } = anthropic.translateRequest(request);
    ar.stream = streaming;
    return { upstreamBody: ar, requestMetadata: buildRequestMetadata(request, ar.temperature, ar.top_p) };
  }
  const { request: cr } = openai.translateRequest(request, { dropImages: isDeepseekBaseUrl(baseUrl) });
  cr.stream = streaming;
  if (streaming) (cr as Record<string, unknown>).stream_options = { include_usage: true };
  return { upstreamBody: cr, requestMetadata: buildRequestMetadata(request, cr.temperature, cr.top_p) };
}

// ── upstream headers ──

function buildUpstreamHeaders(format: UpstreamFormat, options: CreateResponsesFetchOptions, incoming: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (DROPPED_HEADERS.has(key) || isClientSpecificHeader(key)) continue;
    out[key] = value;
  }
  if (options.defaultHeaders) for (const [k, v] of Object.entries(options.defaultHeaders)) out[k.toLowerCase()] = v;
  out['content-type'] = 'application/json';
  if (format === 'anthropic') {
    if (!out['anthropic-version']) out['anthropic-version'] = options.apiVersion ?? '2023-06-01';
    if (typeof out['authorization'] === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(out['authorization']);
      if (m) out['x-api-key'] = m[1].trim();
    }
    delete out['authorization'];
  }
  return out;
}

const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'accept', 'user-agent']);

function isClientSpecificHeader(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith('openai-') || k.startsWith('x-stainless') || k.startsWith('x-codex-') || k === 'originator' || k === 'session_id' || k === 'x-client-request-id';
}

// ── SSE stream ──

function responsesEventsToSseStream(events: AsyncGenerator<ResponsesStreamEvent, void, void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return; }
        controller.enqueue(encoder.encode(encodeSseEvent(value && value.type, value)));
      } catch (err) { controller.error(err); }
    },
    async cancel() { try { await events.return?.(); } catch { /* noop */ } },
  });
}

// ── cache stats ──

function extractCacheStatsFromResponse(response: ResponsesResponse): CacheStats {
  const u = response.usage;
  return {
    cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: u?.input_tokens_details?.cache_creation_tokens ?? 0,
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
  };
}

async function* collectCacheStatsFromStream(events: AsyncGenerator<ResponsesStreamEvent, void, void>, onCacheStats?: (stats: CacheStats) => void): AsyncGenerator<ResponsesStreamEvent, void, void> {
  let lastStats: CacheStats | undefined;
  for await (const event of events) {
    if (event.type === 'response.completed') {
      const resp = (event as unknown as { response?: ResponsesResponse }).response;
      if (resp?.usage) lastStats = extractCacheStatsFromResponse(resp);
    }
    yield event;
  }
  if (lastStats && onCacheStats) onCacheStats(lastStats);
}

// ── error helpers ──

function jsonErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'upstream_error', code: String(status) } }), { status, headers: { 'content-type': 'application/json' } });
}
