/**
 * Drop-in `fetch` wrapper that translates OpenAI Responses API traffic
 * to a third-party upstream API format (Anthropic Messages or OpenAI Chat).
 *
 * This wrapper is **auth-agnostic**: it does not know or manage your API key.
 * You supply headers on the outbound call just like you would for the OpenAI
 * Responses API (e.g. `Authorization: Bearer <key>`), and the wrapper forwards
 * them upstream. Format-specific header rewrites (e.g. Anthropic's `x-api-key`)
 * are applied automatically.
 */

import * as anthropic from './translate/anthropic/index.js';
import * as openai from './translate/openai/index.js';
import { encodeSseEvent } from './utils/sse.js';
import type { ResponsesRequest, ResponsesStreamEvent, ResponsesResponse } from './types/responses.js';
import type { AnthropicRequest, AnthropicResponse } from './types/anthropic.js';
import type { OpenAiChatResponse } from './types/openai_chat.js';

/** Supported upstream API formats. */
export type UpstreamFormat = 'anthropic' | 'openai-chat';

export interface CacheStats {
  cachedTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CreateResponsesFetchOptions {
  /**
   * Upstream API format to translate to.
   * - `'anthropic'` → Anthropic Messages API
   * - `'openai-chat'` → OpenAI-compatible Chat Completions API
   *
   * If omitted, inferred from `baseUrl`:
   * - path ends with `/messages` or host matches `anthropic` → `anthropic`
   * - path ends with `/chat/completions` → `openai-chat`
   */
  upstreamFormat?: UpstreamFormat;
  /** Upstream endpoint URL. Required — no default. */
  baseUrl: string;
  /** Override the upstream API version header (Anthropic only). */
  apiVersion?: string;
  /** Replace the caller-provided `model` field before translation. */
  model?: string;
  /** Extra headers merged into every upstream call. */
  defaultHeaders?: Record<string, string>;
  /** Underlying fetch used to issue upstream requests. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * If the caller hits a non-`/responses` endpoint, forward to this fetch.
   * Defaults to `options.fetch` or `globalThis.fetch`.
   */
  passthroughFetch?: typeof fetch;
  /** Optional callback to receive cache statistics after request completes. */
  onCacheStats?: (stats: CacheStats) => void;
}

/**
 * Build a `fetch`-compatible function whose only job is to translate
 * OpenAI-Responses-API traffic to the selected upstream format.
 *
 * - Matches any `POST` to a URL whose pathname ends in `/v1/responses`.
 * - Non-matching URLs pass through to `passthroughFetch` unchanged.
 */
export function createResponsesFetch(
  options: CreateResponsesFetchOptions,
): typeof fetch {
  if (!options.baseUrl) {
    throw new Error('baseUrl is required');
  }

  const format = options.upstreamFormat
    ? normalizeFormat(options.upstreamFormat)
    : inferFormatFromUrl(options.baseUrl);
  if (!format) {
    throw new Error(
      options.upstreamFormat
        ? `Unsupported upstream format: ${String(options.upstreamFormat)}. Use 'anthropic' or 'openai-chat'`
        : `Could not infer upstreamFormat from baseUrl: ${options.baseUrl}. Pass upstreamFormat explicitly ('anthropic' or 'openai-chat').`,
    );
  }

  const baseFetch = options.fetch ?? globalThis.fetch;
  if (!baseFetch) {
    throw new Error('fetch is not available in this environment; pass options.fetch');
  }
  const passthrough = options.passthroughFetch ?? baseFetch;

  const wrapped: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    if (!isResponsesEndpoint(url)) {
      return passthrough(input as RequestInfo, init);
    }

    const { body, signal, method, headers } = await extractRequest(input, init);
    if (method !== 'POST') {
      return passthrough(input as RequestInfo, init);
    }

    let parsed: ResponsesRequest | undefined;
    try {
      parsed = body ? (JSON.parse(body) as ResponsesRequest) : undefined;
    } catch {
      return jsonErrorResponse(400, 'Invalid JSON body for /responses');
    }
    if (!parsed) return jsonErrorResponse(400, 'Missing body for /responses');

    if (options.model) parsed.model = options.model;

    return handleResponses(parsed, format, options, baseFetch, headers, signal);
  };

  return wrapped;
}

function normalizeFormat(value: string): UpstreamFormat | null {
  return value === 'anthropic' || value === 'openai-chat' ? value : null;
}

function inferFormatFromUrl(baseUrl: string): UpstreamFormat | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, '');
  const host = u.hostname.toLowerCase();
  if (/\/messages$/.test(path) || host.includes('anthropic')) return 'anthropic';
  if (/\/chat\/completions$/.test(path)) return 'openai-chat';
  return null;
}

function isResponsesEndpoint(url: string): boolean {
  try {
    const u = new URL(url, 'http://_internal_');
    return /\/v1\/responses\/?$/.test(u.pathname);
  } catch {
    return /\/v1\/responses(?:\?|$)/.test(url);
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

async function extractRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  body: string | undefined;
  signal: AbortSignal | undefined;
  method: string;
  headers: Record<string, string>;
}> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const text = await input.clone().text();
    const headers: Record<string, string> = {};
    input.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return {
      body: text || undefined,
      signal: input.signal,
      method: input.method,
      headers,
    };
  }

  const url = urlOf(input);
  const method = init?.method?.toUpperCase() ?? 'GET';
  const body =
    init?.body != null
      ? typeof init.body === 'string'
        ? init.body
        : await readBody(init.body)
      : undefined;

  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
    } else {
      for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = String(v);
    }
  }

  return { body, signal: init?.signal, method, headers };
}

async function readBody(body: BodyInit): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.text();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return '[FormData]';
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  return String(body);
}

async function handleResponses(
  request: ResponsesRequest,
  format: UpstreamFormat,
  options: CreateResponsesFetchOptions,
  baseFetch: typeof fetch,
  incomingHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const streaming = request.stream ?? false;

  const { upstreamBody, requestMetadata } = buildUpstreamBody(request, format, options);
  const upstreamHeaders = buildUpstreamHeaders(format, options, incomingHeaders);

  const upstream = await baseFetch(options.baseUrl, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
    signal,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!streaming) {
    const body = (await upstream.json()) as AnthropicResponse | OpenAiChatResponse;
    const translated =
      format === 'anthropic'
        ? anthropic.translateResponse(body as AnthropicResponse, {
            model: request.model,
          })
        : openai.translateResponse(body as OpenAiChatResponse, {
            model: request.model,
          });

    const cacheStats = extractCacheStatsFromResponse(translated);
    options.onCacheStats?.(cacheStats);

    return new Response(JSON.stringify(translated), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!upstream.body) {
    return jsonErrorResponse(502, 'Upstream streaming response has no body');
  }

  const events =
    format === 'anthropic'
      ? anthropic.translateStream(upstream.body, {
          model: request.model,
          requestMetadata,
        })
      : openai.translateStream(upstream.body, {
          model: request.model,
          requestMetadata,
        });

  const wrappedEvents = collectCacheStatsFromStream(events, options.onCacheStats);
  const stream = responsesEventsToSseStream(wrappedEvents);

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

interface UpstreamBodyResult {
  upstreamBody: unknown;
  requestMetadata: {
    temperature: number | undefined;
    top_p: number | undefined;
    tools: unknown[];
    tool_choice: unknown;
    store: boolean;
    metadata: Record<string, unknown>;
  };
}

function buildUpstreamBody(
  request: ResponsesRequest,
  format: UpstreamFormat,
  _options: CreateResponsesFetchOptions,
): UpstreamBodyResult {
  if (format === 'anthropic') {
    const { request: anthropicRequest } = anthropic.translateRequest(request);
    anthropicRequest.stream = request.stream ?? true;
    return {
      upstreamBody: anthropicRequest,
      requestMetadata: {
        temperature: anthropicRequest.temperature,
        top_p: anthropicRequest.top_p,
        tools: (request.tools as unknown[]) ?? [],
        tool_choice: request.tool_choice,
        store: request.store ?? true,
        metadata: (request.metadata as Record<string, unknown>) ?? {},
      },
    };
  }

  const { request: chatRequest } = openai.translateRequest(request);
  chatRequest.stream = request.stream ?? true;
  return {
    upstreamBody: chatRequest,
    requestMetadata: {
      temperature: chatRequest.temperature,
      top_p: chatRequest.top_p,
      tools: (request.tools as unknown[]) ?? [],
      tool_choice: request.tool_choice,
      store: request.store ?? true,
      metadata: (request.metadata as Record<string, unknown>) ?? {},
    },
  };
}

function buildUpstreamHeaders(
  format: UpstreamFormat,
  options: CreateResponsesFetchOptions,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (DROPPED_REQUEST_HEADERS.has(key)) continue;
    if (isClientSpecificHeader(key)) continue;
    out[key] = value;
  }

  if (options.defaultHeaders) {
    for (const [key, value] of Object.entries(options.defaultHeaders)) {
      out[key.toLowerCase()] = value;
    }
  }

  out['content-type'] = 'application/json';

  if (format === 'anthropic') {
    if (!out['anthropic-version']) {
      out['anthropic-version'] = options.apiVersion ?? '2023-06-01';
    }
    if (typeof out['authorization'] === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(out['authorization']);
      if (match) out['x-api-key'] = match[1].trim();
    }
    delete out['authorization'];
  }

  return out;
}

const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'accept',
  'user-agent',
]);

function isClientSpecificHeader(key: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith('openai-')) return true;
  if (k.startsWith('x-stainless')) return true;
  if (k.startsWith('x-codex-')) return true;
  if (k === 'originator') return true;
  if (k === 'session_id') return true;
  if (k === 'x-client-request-id') return true;
  return false;
}

function responsesEventsToSseStream(
  events: AsyncGenerator<ResponsesStreamEvent, void, void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encodeSseEvent(value && value.type, value)));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      try {
        await events.return?.();
      } catch {
        /* noop */
      }
    },
  });
}

function jsonErrorResponse(status: number, message: string): Response {
  return new Response(buildOpenAIErrorJson(status, message), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildOpenAIErrorJson(status: number, message: string): string {
  return JSON.stringify({
    error: { message, type: 'upstream_error', code: String(status) },
  });
}

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

async function* collectCacheStatsFromStream(
  events: AsyncGenerator<ResponsesStreamEvent, void, void>,
  onCacheStats?: (stats: CacheStats) => void,
): AsyncGenerator<ResponsesStreamEvent, void, void> {
  let lastStats: CacheStats | undefined;
  for await (const event of events) {
    if (
      event.type === 'response.completed' &&
      (event as unknown as { response?: ResponsesResponse }).response?.usage
    ) {
      lastStats = extractCacheStatsFromResponse(
        (event as unknown as { response: ResponsesResponse }).response,
      );
    }
    yield event;
  }
  if (lastStats && onCacheStats) {
    onCacheStats(lastStats);
  }
}

export type { AnthropicRequest };
