// ==============================================================================
// URL & Format Helpers
// ==============================================================================

// === Config & Types ===
/**
 * Drop-in `fetch` wrapper that translates OpenAI Responses API traffic
 * to an upstream API format (Anthropic Messages or OpenAI Chat).
 */

import * as anthropic from './translate/anthropic/index.js';
import * as openai from './translate/openai/index.js';
import { encodeSseEvent } from './utils/sse.js';
import type {
  ResponsesRequest,
  ResponsesStreamEvent,
  ResponsesResponse,
  ResponsesTool,
} from './types/responses.js';
import type { AnthropicResponse, AnthropicThinkingConfig } from './types/anthropic.js';
import type { OpenAiChatResponse } from './types/openai_chat.js';
import {
  sanitizeUpstreamToolNames,
  restoreToolNamesInChatResponse,
  createToolNameRestoreStream,
} from './tool-name-sanitizer.js';
import {
  extractRequestBody,
  extractRequestMeta,
  isResponsesEndpoint,
  urlOf,
} from './utils/request.js';

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
  /** Drop image/file parts from user messages (e.g. DeepSeek text-only models). */
  dropImages?: boolean;
  /** Drop tools from the request before translation. Return true to drop a tool.
   *  Use to reduce payload size when the upstream has a limit (e.g. DeepSeek ECONNRESET
   *  on 252 KB requests with 143 tools). Applied before namespace flattening. */
  dropTools?: (tool: ResponsesTool) => boolean;
  /** Reject /responses bodies longer than this many characters (≈ bytes for the
   *  ASCII-dominant JSON these APIs exchange) with a 413 error envelope BEFORE
   *  parse/translate. The translation pipeline (parse → translate → re-serialize)
   *  holds several times the body size at peak, so on memory-capped runtimes
   *  (e.g. 128 MB Cloudflare Workers isolates) one runaway request can OOM the
   *  whole isolate and kill every concurrent request. Off by default. */
  maxBodyChars?: number;
  /** Fallback thought signature for Gemini OpenAI-compatible tool histories. */
  fallbackThoughtSignature?: string;
  /** Tunnel the Gemini thought signature through the function_call `call_id` so
   *  it survives clients that drop the dedicated `thought_signature` field (e.g.
   *  codex-ts, whose protocol mirrors codex-rs). Encoded on the response and
   *  stripped back off on the next request. Off by default. */
  tunnelThoughtSignatureInCallId?: boolean;
  /** Optional callback to receive cache statistics. */
  onCacheStats?: (stats: CacheStats) => void;
  /** Override reasoning_effort sent to the upstream model (OpenAI Chat / Anthropic). */
  // ==============================================================================
  // Request Building
  // ==============================================================================

  reasoning_effort?: string;
  /** Override thinking configuration sent to the upstream model. */
  thinking?: unknown;
  /** Timeout in milliseconds for upstream requests. Defaults to no timeout. */
  timeoutMs?: number;
  /** Fallback upstream for requests where the last user message contains images. */
  fallbackUpstream?: {
    baseUrl: string;
    upstreamFormat?: UpstreamFormat;
    model?: string;
    defaultHeaders?: Record<string, string>;
    apiVersion?: string;
    reasoning_effort?: string;
    thinking?: unknown;
  };
}

export function createResponsesFetch(options: CreateResponsesFetchOptions): typeof fetch {
  if (!options.baseUrl) {
    throw new Error('baseUrl is required');
  }

  const rawFormat = options.upstreamFormat;
  const format = rawFormat
    ? normalizeFormat(rawFormat)
    : (inferFormatFromUrl(options.baseUrl) ?? inferFormatFromModel(options.model) ?? 'openai-chat');
  if (!format) {
    throw new Error(
      `Unsupported upstream format: ${options.upstreamFormat}. Use 'anthropic' or 'openai-chat'`,
    );
  }

  const baseFetch = options.fetch ?? globalThis.fetch;
  if (!baseFetch) {
    throw new Error('fetch is not available; pass options.fetch');
  }
  const passthrough = options.passthroughFetch ?? baseFetch;

  return async (input, init) => {
    const url = urlOf(input);
    if (!isResponsesEndpoint(url)) {
      return passthrough(input, init);
    }

    // Decide the route from metadata alone (method/headers/signal) BEFORE touching
    // the body: the non-POST passthrough must forward the original Request with its
    // body unread, and the POST path reads the body exactly once without clone()
    // (cloning forces the runtime to buffer a second copy of the whole body — a
    // real cost for multi-MB agent contexts on memory-capped edge runtimes).
    const { signal, method, headers } = extractRequestMeta(input, init);
    if (method !== 'POST') {
      return passthrough(input, init);
    }
    const body = await extractRequestBody(input, init);

    if (
      options.maxBodyChars !== undefined &&
      body !== undefined &&
      body.length > options.maxBodyChars
    ) {
      return jsonErrorResponse(
        413,
        `Request body is ${(body.length / 1024 / 1024).toFixed(1)}MB, exceeding the configured ` +
          `${(options.maxBodyChars / 1024 / 1024).toFixed(1)}MB limit. The conversation context ` +
          `(including inline media) has grown too large for this deployment — compact the ` +
          `conversation or avoid inlining large media.`,
        'invalid_request_error',
      );
    }

    let parsed: ResponsesRequest | undefined;
    // eslint-disable-next-line no-restricted-syntax -- try/catch needed for server-side HTTP error handling
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      return jsonErrorResponse(400, 'Invalid JSON body for /responses');
    }
    if (!parsed) {
      return jsonErrorResponse(400, 'Missing body for /responses');
    }

    if (options.model) {
      parsed.model = options.model;
    }
    return handleResponses(parsed, format, options, baseFetch, headers, signal, options.dropImages);
  };
}

// ── format helpers ──

function normalizeBaseUrl(url: string, format: UpstreamFormat): string {
  // eslint-disable-next-line no-restricted-syntax -- try/catch needed for server-side HTTP error handling
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.replace(/\/+$/, '');
    const endpoint = format === 'anthropic' ? '/messages' : '/chat/completions';
    if (!path.endsWith(endpoint)) {
      // Keep the caller's path prefix (e.g. /v2, /openai); default to /v1 only
      // for a bare origin.
      parsedUrl.pathname = (path || '/v1') + endpoint;
    }
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

function normalizeFormat(format: string): UpstreamFormat | null {
  const fmt: UpstreamFormat | null =
    format === 'anthropic' || format === 'openai-chat' ? format : null;
  return fmt;
}

function inferFormatFromUrl(baseUrl: string): UpstreamFormat | null {
  // eslint-disable-next-line no-restricted-syntax -- try/catch needed for server-side HTTP error handling
  try {
    const parsedUrl = new URL(baseUrl);
    const path = parsedUrl.pathname.replace(/\/+$/, '');
    if (/\/messages$/.test(path) || parsedUrl.hostname.toLowerCase().includes('anthropic')) {
      return 'anthropic';
    }
    if (/\/chat\/completions$/.test(path)) {
      return 'openai-chat';
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Infer upstream format from model name. */
function inferFormatFromModel(model: string | undefined): UpstreamFormat | null {
  if (!model) {
    return null;
  }
  if (/^claude/i.test(model)) {
    return 'anthropic';
  }
  return null;
}

// ==============================================================================
// Main Handler
// ==============================================================================

async function handleResponses(
  request: ResponsesRequest,
  format: UpstreamFormat,
  options: CreateResponsesFetchOptions,
  baseFetch: typeof fetch,
  incomingHeaders: Record<string, string>,
  // ==============================================================================
  // HTTP Client
  // ==============================================================================

  signal: AbortSignal | undefined,
  dropImages?: boolean,
): Promise<Response> {
  // Auto-fallback: if this upstream drops images but the last user message has them,
  // transparently switch to the fallback upstream.
  if (dropImages && options.fallbackUpstream && lastUserMessageHasImage(request)) {
    dropImages = false;
    const fb = options.fallbackUpstream;
    options = { ...options, ...fb, fallbackUpstream: undefined };
    format =
      fb.upstreamFormat ??
      inferFormatFromUrl(fb.baseUrl) ??
      inferFormatFromModel(fb.model) ??
      format;
    if (options.model) {
      request.model = options.model;
    }
    const fbModel = fb.model ? `, model: ${fb.model}` : '';
    console.warn(`[fallback] last user message has image, routing to ${fb.baseUrl}${fbModel}`);
  }

  if (options.dropTools && request.tools) {
    const { dropTools } = options;
    request = { ...request, tools: request.tools.filter((tool) => !dropTools(tool)) };
  }

  const streaming = request.stream ?? false;
  const resolvedUrl = normalizeBaseUrl(options.baseUrl, format);
  const { upstreamBody, requestMetadata } = buildUpstreamBody(
    request,
    format,
    streaming,
    options.baseUrl,
    dropImages,
    options.reasoning_effort,
    options.thinking,
    options.fallbackThoughtSignature,
    options.tunnelThoughtSignatureInCallId,
  );
  const upstreamHeaders = buildUpstreamHeaders(format, options, incomingHeaders);

  // Sanitize tool names: replace chars outside [a-zA-Z0-9_-] (e.g. dots) with '_'
  // and restore originals in the response so callers see the original names.
  const toolNameMap =
    format === 'openai-chat'
      ? // eslint-disable-next-line no-restricted-syntax -- upstreamBody is unknown; cast to Record for tool mutation
        sanitizeUpstreamToolNames(upstreamBody as Record<string, unknown>)
      : new Map<string, string>();

  const upstream = await baseFetch(resolvedUrl, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
    signal,
  });

  if (!upstream.ok) {
    return new Response(await upstream.text().catch(() => ''), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!streaming) {
    const rawBody = await upstream.json();
    // A 2xx whose body is an Anthropic error envelope: the upstream failed and
    // the status did not survive the hop (observed from gateways that swallow
    // the upstream's own 4xx/5xx). Translating it would fabricate a completed
    // response with empty output and zero usage — surface the failure instead,
    // passing the original payload through so the caller keeps the upstream's
    // wording (error classifiers key off it).
    if (format === 'anthropic' && anthropic.isAnthropicErrorEnvelope(rawBody)) {
      const { message } = anthropic.anthropicErrorInfo(rawBody);
      console.warn(`[upstream] 2xx carrying an Anthropic error envelope: ${message}`);
      return new Response(JSON.stringify(rawBody), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
    const restoredBody = restoreToolNamesInChatResponse(
      // eslint-disable-next-line no-restricted-syntax -- upstream json() returns unknown; cast to Record for tool name restoration
      rawBody as Record<string, unknown>,
      toolNameMap,
    );
    const translated =
      format === 'anthropic'
        ? // eslint-disable-next-line no-restricted-syntax -- union type narrowing requires type assertion
          anthropic.translateResponse(restoredBody as unknown as AnthropicResponse, {
            model: request.model,
          })
        : // eslint-disable-next-line no-restricted-syntax -- union type narrowing requires type assertion
          openai.translateResponse(restoredBody as unknown as OpenAiChatResponse, {
            model: request.model,
            requestTools: request.tools ?? [],
            tunnelThoughtSignatureInCallId: options.tunnelThoughtSignatureInCallId,
          });
    options.onCacheStats?.(extractCacheStatsFromResponse(translated));
    return new Response(JSON.stringify(translated), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!upstream.body) {
    return jsonErrorResponse(502, 'Upstream streaming response has no body');
  }

  const upstreamBodyStream = createToolNameRestoreStream(upstream.body, toolNameMap);

  const events =
    format === 'anthropic'
      ? anthropic.translateStream(upstreamBodyStream, { model: request.model, requestMetadata })
      : openai.translateStream(upstreamBodyStream, {
          model: request.model,
          requestMetadata,
          tunnelThoughtSignatureInCallId: options.tunnelThoughtSignatureInCallId,
        });

  return new Response(
    responsesEventsToSseStream(collectCacheStatsFromStream(events, options.onCacheStats)),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    },
  );
}

// ── upstream body ──

function buildRequestMetadata(request: ResponsesRequest, temperature?: number, top_p?: number) {
  return {
    temperature,
    top_p,
    tools: request.tools ?? [],
    tool_choice: request.tool_choice,
    store: request.store ?? true,
    metadata: request.metadata ?? {},
  };
}

function buildUpstreamBody(
  request: ResponsesRequest,
  format: UpstreamFormat,
  streaming: boolean,
  baseUrl: string,
  dropImages?: boolean,
  reasoning_effort?: string,
  thinking?: unknown,
  fallbackThoughtSignature?: string,
  tunnelThoughtSignatureInCallId?: boolean,
): { upstreamBody: unknown; requestMetadata: ReturnType<typeof buildRequestMetadata> } {
  if (format === 'anthropic') {
    const { request: ar } = anthropic.translateRequest(request);
    ar.stream = streaming;
    if (thinking !== undefined) {
      // eslint-disable-next-line no-restricted-syntax -- thinking comes from config.json, runtime-checked
      ar.thinking = thinking as AnthropicThinkingConfig;
    } else if (reasoning_effort) {
      const effort = reasoning_effort.toLowerCase();
      if (anthropic.isAdaptiveThinkingModel(ar.model)) {
        // Adaptive-generation models reject budget_tokens. minimal → leave
        // thinking unset (off / model default); otherwise adaptive + effort.
        if (effort === 'minimal') {
          delete ar.thinking;
          delete ar.output_config;
        } else {
          ar.thinking = { type: 'adaptive' };
          const normalized = anthropic.normalizeAnthropicEffort(effort);
          if (normalized) {
            ar.output_config = { ...(ar.output_config ?? {}), effort: normalized };
          }
        }
      } else if (effort === 'minimal') {
        ar.thinking = { type: 'disabled' };
      } else if (effort === 'low') {
        ar.thinking = { type: 'enabled', budget_tokens: 4096 };
      } else if (effort === 'medium') {
        ar.thinking = { type: 'enabled', budget_tokens: 16384 };
      } else if (effort === 'high') {
        ar.thinking = { type: 'enabled', budget_tokens: 32768 };
      } else if (effort === 'xhigh') {
        ar.thinking = { type: 'enabled', budget_tokens: 65536 };
      }
    }
    // Ensure max_tokens > thinking.budget_tokens (Anthropic requirement)
    if (ar.thinking && typeof ar.thinking === 'object' && 'budget_tokens' in ar.thinking) {
      // eslint-disable-next-line no-restricted-syntax -- runtime-checked budget_tokens from thinking config
      const budget = Number((ar.thinking as unknown as Record<string, unknown>).budget_tokens);
      if (budget > 0 && ar.max_tokens <= budget) {
        ar.max_tokens = budget + 1024;
      }
    }
    return {
      upstreamBody: ar,
      requestMetadata: buildRequestMetadata(request, ar.temperature, ar.top_p),
    };
  }
  const { request: cr } = openai.translateRequest(request, {
    dropImages: dropImages,
    fallbackThoughtSignature,
    tunnelThoughtSignatureInCallId,
  });
  cr.stream = streaming;
  if (streaming) {
    cr.stream_options = { include_usage: true };
  }
  if (reasoning_effort !== undefined) {
    cr.reasoning_effort = reasoning_effort;
  }
  if (thinking !== undefined) {
    cr.thinking = thinking;
  }
  return {
    upstreamBody: cr,
    requestMetadata: buildRequestMetadata(request, cr.temperature, cr.top_p),
  };
}

// ── upstream headers ──

function buildUpstreamHeaders(
  format: UpstreamFormat,
  options: CreateResponsesFetchOptions,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (DROPPED_HEADERS.has(key) || isClientSpecificHeader(key)) {
      continue;
    }
    out[key] = value;
  }
  if (options.defaultHeaders) {
    for (const [k, v] of Object.entries(options.defaultHeaders)) {
      out[k.toLowerCase()] = v;
    }
  }
  out['content-type'] = 'application/json';
  if (format === 'anthropic') {
    if (!out['anthropic-version']) {
      out['anthropic-version'] = options.apiVersion ?? '2023-06-01';
    }
    if (typeof out['authorization'] === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(out['authorization']);
      if (match) {
        out['x-api-key'] = match[1].trim();
      }
    }
    delete out['authorization'];
  }
  return out;
}

const DROPPED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'accept',
  'user-agent',
]);

function isClientSpecificHeader(key: string): boolean {
  const keyLower = key.toLowerCase();
  return (
    keyLower.startsWith('openai-') ||
    keyLower.startsWith('x-stainless') ||
    keyLower.startsWith('x-codex-') ||
    keyLower === 'originator' ||
    keyLower === 'session_id' ||
    keyLower === 'x-client-request-id'
  );
}

// ── SSE stream ──

function responsesEventsToSseStream(
  events: AsyncGenerator<ResponsesStreamEvent, void, void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // eslint-disable-next-line no-restricted-syntax -- try/catch needed for server-side HTTP error handling
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
      // eslint-disable-next-line no-restricted-syntax -- try/catch needed for server-side HTTP error handling
      try {
        await events.return?.();
      } catch {
        /* noop */
      }
    },
  });
}

// ── cache stats ──

function extractCacheStatsFromResponse(response: ResponsesResponse): CacheStats {
  const usage = response.usage;
  return {
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: usage?.input_tokens_details?.cache_creation_tokens ?? 0,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

async function* collectCacheStatsFromStream(
  events: AsyncGenerator<ResponsesStreamEvent, void, void>,
  onCacheStats?: (stats: CacheStats) => void,
): AsyncGenerator<ResponsesStreamEvent, void, void> {
  let lastStats: CacheStats | undefined;
  for await (const event of events) {
    if (event.type === 'response.completed') {
      // eslint-disable-next-line no-restricted-syntax -- upstream event carries runtime property not in type
      const eventResp = event as unknown as { response?: ResponsesResponse };
      const resp = eventResp.response;
      if (resp?.usage) {
        lastStats = extractCacheStatsFromResponse(resp);
      }
    }
    yield event;
  }
  if (lastStats && onCacheStats) {
    onCacheStats(lastStats);
  }
}

/**
 * Check if the last user message in the input contains image content.
 * Assistant messages and tool results are skipped — only the most recent
 * `role: 'user'` item is inspected.
 */
function lastUserMessageHasImage(request: ResponsesRequest): boolean {
  const input = request.input;
  if (!input || !Array.isArray(input)) {
    return false;
  }
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item || typeof item !== 'object') {
      continue;
    }
    const itemRecord: Record<string, unknown> = item;
    if (itemRecord.role !== 'user') {
      continue;
    }
    // Found the last user message
    const content = itemRecord.content;
    if (!Array.isArray(content)) {
      return false;
    }
    for (const part of content) {
      if (part && typeof part === 'object') {
        const partItem: Record<string, unknown> = part;
        const type = partItem.type;
        if (type === 'input_image' || type === 'image' || type === 'image_url') {
          return true;
        }
      }
    }
    return false;
  }
  return false;
}

// ── error helpers ──

function jsonErrorResponse(status: number, message: string, type = 'upstream_error'): Response {
  return new Response(JSON.stringify({ error: { message, type, code: String(status) } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
