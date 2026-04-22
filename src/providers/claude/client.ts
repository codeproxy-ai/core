import type { ResponsesRequest, ResponsesResponse, ResponsesStreamEvent } from '../../types/responses.js';
import type { AnthropicResponse } from '../../types/anthropic.js';
import {
  translateRequest,
  type TranslateRequestOptions,
} from './translateRequest.js';
import { translateResponse } from './translateResponse.js';
import { translateStream } from './translateStream.js';

const DEFAULT_CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_CLAUDE_API_VERSION = '2023-06-01';

export interface ClaudeClientOptions {
  /** Anthropic API key. Used as `x-api-key`. */
  apiKey?: string;
  /** Override the Messages API endpoint. */
  baseUrl?: string;
  /** Override `anthropic-version` header. */
  apiVersion?: string;
  /** Additional headers merged on every request. */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch impl (useful for browser proxies or for tests). */
  fetch?: typeof fetch;
  /** Options forwarded to {@link translateRequest}. */
  translate?: TranslateRequestOptions;
  /**
   * When true, set `anthropic-dangerous-direct-browser-access: true` so that
   * Anthropic accepts direct browser calls.  Only enable this when you are
   * intentionally bypassing CORS in first-party usage.
   */
  dangerouslyAllowBrowser?: boolean;
}

/**
 * A browser-safe client that speaks the Responses API on the outside and the
 * Anthropic Messages API on the inside.
 *
 * Usage (browser):
 * ```ts
 * const client = new ClaudeResponsesClient({ apiKey: '...', dangerouslyAllowBrowser: true });
 * const res = await client.create({ model: 'claude-sonnet-4-5', input: 'Hi' });
 * ```
 */
export class ClaudeResponsesClient {
  private readonly options: ClaudeClientOptions;

  constructor(options: ClaudeClientOptions = {}) {
    this.options = options;
  }

  /** Non-streaming call. */
  async create(request: ResponsesRequest): Promise<ResponsesResponse> {
    const { request: anthropicRequest } = translateRequest(request, this.options.translate);
    anthropicRequest.stream = false;
    const resp = await this.fetchUpstream(anthropicRequest);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ClaudeRequestError(resp.status, text);
    }
    const body = (await resp.json()) as AnthropicResponse;
    return translateResponse(body, { model: request.model });
  }

  /** Streaming call. Yields Responses-API SSE events as JS objects. */
  async *stream(request: ResponsesRequest): AsyncGenerator<ResponsesStreamEvent, void, void> {
    const { request: anthropicRequest } = translateRequest(request, this.options.translate);
    anthropicRequest.stream = true;
    const resp = await this.fetchUpstream(anthropicRequest);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ClaudeRequestError(resp.status, text);
    }
    if (!resp.body) {
      throw new ClaudeRequestError(500, 'Upstream response has no body');
    }
    yield* translateStream(resp.body, {
      model: request.model,
      requestMetadata: {
        temperature: anthropicRequest.temperature,
        top_p: anthropicRequest.top_p,
        tools: (request.tools as unknown[]) ?? [],
        tool_choice: request.tool_choice,
        store: request.store ?? true,
        metadata: (request.metadata as Record<string, unknown>) ?? {},
      },
    });
  }

  private async fetchUpstream(body: unknown): Promise<Response> {
    const url = this.options.baseUrl ?? DEFAULT_CLAUDE_API_URL;
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('fetch is not available in this environment; pass options.fetch');
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': this.options.apiVersion ?? DEFAULT_CLAUDE_API_VERSION,
      ...(this.options.defaultHeaders ?? {}),
    };
    if (this.options.apiKey) headers['x-api-key'] = this.options.apiKey;
    if (this.options.dangerouslyAllowBrowser) {
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    return fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }
}

export class ClaudeRequestError extends Error {
  readonly status: number;
  readonly responseText: string;
  constructor(status: number, responseText: string) {
    super(`Claude request failed with status ${status}: ${responseText.slice(0, 500)}`);
    this.name = 'ClaudeRequestError';
    this.status = status;
    this.responseText = responseText;
  }
}
