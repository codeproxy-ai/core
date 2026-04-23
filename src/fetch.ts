/**
 * Drop-in `fetch` wrapper that makes any Responses-API client talk to a
 * third-party provider (e.g. Anthropic Claude) instead of the OpenAI API.
 *
 * This wrapper is **auth-agnostic**: it does not know or manage your API key.
 * You supply headers on the outbound call just like you would for the OpenAI
 * Responses API (e.g. `Authorization: Bearer <key>`), and the wrapper forwards
 * them to the upstream provider. For providers that use a different header
 * name (Anthropic's `x-api-key`), `Authorization: Bearer X` is rewritten to
 * `x-api-key: X` automatically.  Callers that already send the provider's
 * native header are untouched.
 */

import {
  translateRequest as claudeTranslateRequest,
  type TranslateRequestOptions,
} from './providers/claude/translateRequest.js';
import { translateResponse as claudeTranslateResponse } from './providers/claude/translateResponse.js';
import { translateStream as claudeTranslateStream } from './providers/claude/translateStream.js';
import { translateRequest as zaiTranslateRequest } from './providers/zai/translateRequest.js';
import { translateResponse as zaiTranslateResponse } from './providers/zai/translateResponse.js';
import { translateStream as zaiTranslateStream } from './providers/zai/translateStream.js';
import { encodeSseEvent } from './utils/sse.js';
import type { ResponsesRequest, ResponsesStreamEvent } from './types/responses.js';
import type { AnthropicRequest, AnthropicResponse } from './types/anthropic.js';
import type { OpenAiChatResponse } from './types/openai_chat.js';

export type ProviderName = 'claude' | 'anthropic' | 'zai';

export interface CreateResponsesFetchOptions {
  /** Provider to route `/responses` calls to. */
  provider: ProviderName;
  /** Override the upstream endpoint. Defaults to the provider's public URL. */
  baseUrl?: string;
  /** Override the upstream API version header (Anthropic only). */
  apiVersion?: string;
  /**
   * Replace the caller-provided `model` field before translation.
   * Useful when the client hard-codes an OpenAI model id but the upstream
   * provider needs its own (e.g. forcing `glm-4.6` regardless of input).
   */
  model?: string;
  /** Extra headers merged into every upstream call. */
  defaultHeaders?: Record<string, string>;
  /** Underlying fetch used to issue upstream requests. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Options passed to {@link translateRequest}. */
  translate?: TranslateRequestOptions;
  /**
   * If the caller hits a non-`/responses` endpoint, forward to this fetch.
   * Defaults to `options.fetch` or `globalThis.fetch`.
   */
  passthroughFetch?: typeof fetch;
}

const DEFAULT_URLS: Record<ProviderName, string> = {
  claude: 'https://api.anthropic.com/v1/messages',
  anthropic: 'https://api.anthropic.com/v1/messages',
  zai: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
};

/**
 * Build a `fetch`-compatible function whose only job is to translate
 * OpenAI-Responses-API traffic to the selected provider's wire format.
 *
 * - Matches any `POST` to a URL whose pathname ends in `/v1/responses`.
 * - Non-matching URLs pass through to `passthroughFetch` unchanged.
 */
export function createResponsesFetch(
  options: CreateResponsesFetchOptions,
): typeof fetch {
  if (!isSupportedProvider(options.provider)) {
    throw new Error(`Unsupported provider: ${String(options.provider)}`);
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

    return handleResponses(parsed, options, baseFetch, headers, signal);
  };

  return wrapped;
}

function isSupportedProvider(name: string): boolean {
  return name === 'claude' || name === 'anthropic' || name === 'zai';
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function isResponsesEndpoint(url: string): boolean {
  try {
    const u = new URL(url, 'http://_internal_');
    return /\/v1\/responses\/?$/.test(u.pathname);
  } catch {
    return /\/v1\/responses\/?(?:\?|$)/.test(url);
  }
}

interface ExtractedRequest {
  method: string;
  body: string | undefined;
  signal: AbortSignal | undefined;
  headers: Record<string, string>;
}

async function extractRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<ExtractedRequest> {
  const headers: Record<string, string> = {};
  const absorb = (h: HeadersInit | undefined) => {
    if (!h) return;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return;
    }
    if (Array.isArray(h)) {
      for (const [k, v] of h) headers[String(k).toLowerCase()] = String(v);
      return;
    }
    for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
  };

  if (typeof Request !== 'undefined' && input instanceof Request && !init?.body) {
    absorb(input.headers);
    absorb(init?.headers);
    const method = (init?.method ?? input.method ?? 'GET').toUpperCase();
    const body =
      method === 'GET' || method === 'HEAD' ? undefined : await input.clone().text();
    return {
      method,
      body,
      signal: init?.signal ?? input.signal ?? undefined,
      headers,
    };
  }

  absorb(init?.headers);
  const method = (init?.method ?? 'GET').toUpperCase();
  let body: string | undefined;
  if (init?.body != null) {
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof ArrayBuffer) body = new TextDecoder().decode(init.body);
    else if (ArrayBuffer.isView(init.body)) body = new TextDecoder().decode(init.body as Uint8Array);
    else if (typeof (init.body as Blob).text === 'function') body = await (init.body as Blob).text();
    else if (typeof (init.body as URLSearchParams).toString === 'function') body = (init.body as URLSearchParams).toString();
    else body = String(init.body);
  }
  return { method, body, signal: init?.signal ?? undefined, headers };
}

async function handleResponses(
  request: ResponsesRequest,
  options: CreateResponsesFetchOptions,
  baseFetch: typeof fetch,
  incomingHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const streaming = request.stream === true;

  const upstreamUrl = options.baseUrl ?? DEFAULT_URLS[options.provider];
  const headers = buildUpstreamHeaders(options, incomingHeaders);

  const upstreamBody = buildUpstreamBody(request, options, streaming);

  let upstream: Response;
  try {
    upstream = await baseFetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody.body),
      signal,
    });
  } catch (err) {
    return jsonErrorResponse(502, `Upstream fetch failed: ${(err as Error).message}`);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return new Response(buildOpenAIErrorJson(upstream.status, text), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!streaming) {
    if (options.provider === 'zai') {
      let body: OpenAiChatResponse;
      try {
        body = (await upstream.json()) as OpenAiChatResponse;
      } catch (err) {
        return jsonErrorResponse(502, `Failed to parse upstream JSON: ${(err as Error).message}`);
      }
      const translated = zaiTranslateResponse(body, { model: request.model });
      return new Response(JSON.stringify(translated), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    let body: AnthropicResponse;
    try {
      body = (await upstream.json()) as AnthropicResponse;
    } catch (err) {
      return jsonErrorResponse(502, `Failed to parse upstream JSON: ${(err as Error).message}`);
    }
    const translated = claudeTranslateResponse(body, { model: request.model });
    return new Response(JSON.stringify(translated), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!upstream.body) {
    return jsonErrorResponse(502, 'Upstream streaming response has no body');
  }

  const events =
    options.provider === 'zai'
      ? zaiTranslateStream(upstream.body, {
          model: request.model,
          requestMetadata: {
            temperature: upstreamBody.temperature,
            top_p: upstreamBody.top_p,
            tools: (request.tools as unknown[]) ?? [],
            tool_choice: request.tool_choice,
            store: request.store ?? true,
            metadata: (request.metadata as Record<string, unknown>) ?? {},
          },
        })
      : claudeTranslateStream(upstream.body, {
          model: request.model,
          requestMetadata: {
            temperature: upstreamBody.temperature,
            top_p: upstreamBody.top_p,
            tools: (request.tools as unknown[]) ?? [],
            tool_choice: request.tool_choice,
            store: request.store ?? true,
            metadata: (request.metadata as Record<string, unknown>) ?? {},
          },
        });

  const stream = responsesEventsToSseStream(events);

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

interface UpstreamBody {
  body: unknown;
  temperature: number | undefined;
  top_p: number | undefined;
}

function buildUpstreamBody(
  request: ResponsesRequest,
  options: CreateResponsesFetchOptions,
  streaming: boolean,
): UpstreamBody {
  if (options.provider === 'zai') {
    const { request: zaiRequest } = zaiTranslateRequest(request, options.translate);
    zaiRequest.stream = streaming;
    return { body: zaiRequest, temperature: zaiRequest.temperature, top_p: zaiRequest.top_p };
  }
  const { request: anthropicRequest } = claudeTranslateRequest(request, options.translate);
  anthropicRequest.stream = streaming;
  return {
    body: anthropicRequest,
    temperature: anthropicRequest.temperature,
    top_p: anthropicRequest.top_p,
  };
}

/**
 * Forward caller-supplied headers to the upstream provider.  Strips hop-by-hop
 * or OpenAI-only metadata, rewrites `Authorization: Bearer X` into the
 * provider's native auth header when appropriate, and merges `defaultHeaders`.
 */
function buildUpstreamHeaders(
  options: CreateResponsesFetchOptions,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (DROPPED_REQUEST_HEADERS.has(key)) continue;
    if (isClientSpecificHeader(key)) continue;
    out[key] = value;
  }

  // Apply defaultHeaders BEFORE provider-specific auth conversion so that
  // overrides (e.g. `--apikey`, which arrives as `authorization: Bearer X`)
  // also feed into the Anthropic `x-api-key` rewrite below.
  if (options.defaultHeaders) {
    for (const [key, value] of Object.entries(options.defaultHeaders)) {
      out[key.toLowerCase()] = value;
    }
  }

  out['content-type'] = 'application/json';

  if (options.provider === 'claude' || options.provider === 'anthropic') {
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
  if (key.startsWith('openai-')) return true;
  if (key.startsWith('x-stainless')) return true;
  if (key.startsWith('x-codex-')) return true;
  if (key === 'originator') return true;
  if (key === 'session_id') return true;
  if (key === 'x-client-request-id') return true;
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
        controller.enqueue(encoder.encode(encodeSseEvent(value.type, value)));
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

export type { AnthropicRequest };
