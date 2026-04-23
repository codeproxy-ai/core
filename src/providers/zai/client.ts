import type { ResponsesRequest, ResponsesResponse, ResponsesStreamEvent } from '../../types/responses.js';
import type { OpenAiChatResponse } from '../../types/openai_chat.js';
import {
  translateRequest,
  type TranslateRequestOptions,
} from './translateRequest.js';
import { translateResponse } from './translateResponse.js';
import { translateStream } from './translateStream.js';

const DEFAULT_ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

export interface ZaiClientOptions {
  /** ZAI API key. Sent as `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Override the chat/completions endpoint. */
  baseUrl?: string;
  /** Additional headers merged on every request. */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch impl (useful for browser proxies or for tests). */
  fetch?: typeof fetch;
  /** Options forwarded to {@link translateRequest}. */
  translate?: TranslateRequestOptions;
}

/**
 * A browser-safe client that speaks the Responses API on the outside and the
 * ZAI (OpenAI-chat-compatible) API on the inside.
 */
export class ZaiResponsesClient {
  private readonly options: ZaiClientOptions;

  constructor(options: ZaiClientOptions = {}) {
    this.options = options;
  }

  async create(request: ResponsesRequest): Promise<ResponsesResponse> {
    const { request: zaiRequest } = translateRequest(request, this.options.translate);
    zaiRequest.stream = false;
    const resp = await this.fetchUpstream(zaiRequest);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ZaiRequestError(resp.status, text);
    }
    const body = (await resp.json()) as OpenAiChatResponse;
    return translateResponse(body, { model: request.model });
  }

  async *stream(request: ResponsesRequest): AsyncGenerator<ResponsesStreamEvent, void, void> {
    const { request: zaiRequest } = translateRequest(request, this.options.translate);
    zaiRequest.stream = true;
    const resp = await this.fetchUpstream(zaiRequest);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ZaiRequestError(resp.status, text);
    }
    if (!resp.body) {
      throw new ZaiRequestError(500, 'Upstream response has no body');
    }
    yield* translateStream(resp.body, {
      model: request.model,
      requestMetadata: {
        temperature: zaiRequest.temperature,
        top_p: zaiRequest.top_p,
        tools: (request.tools as unknown[]) ?? [],
        tool_choice: request.tool_choice,
        store: request.store ?? true,
        metadata: (request.metadata as Record<string, unknown>) ?? {},
      },
    });
  }

  private async fetchUpstream(body: unknown): Promise<Response> {
    const url = this.options.baseUrl ?? DEFAULT_ZAI_API_URL;
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('fetch is not available in this environment; pass options.fetch');
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.options.defaultHeaders ?? {}),
    };
    if (this.options.apiKey) headers['authorization'] = `Bearer ${this.options.apiKey}`;
    return fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }
}

export class ZaiRequestError extends Error {
  readonly status: number;
  readonly responseText: string;
  constructor(status: number, responseText: string) {
    super(`ZAI request failed with status ${status}: ${responseText.slice(0, 500)}`);
    this.name = 'ZaiRequestError';
    this.status = status;
    this.responseText = responseText;
  }
}
