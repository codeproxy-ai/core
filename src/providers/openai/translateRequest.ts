import type {
  ResponsesRequest,
} from '../../types/responses.js';
import type {
  OpenAiChatRequest,
} from '../../types/openai_chat.js';

export interface TranslateRequestOptions {
  /** Default max tokens when not provided. */
  defaultMaxTokens?: number;
}

export interface TranslateRequestResult {
  request: OpenAiChatRequest;
}

/**
 * Convert a Responses API request into an OpenAI Chat API request.
 * Since OpenAI Responses API is similar to Chat Completions, this is a minimal transformation.
 */
export function translateRequest(
  data: ResponsesRequest,
  _options: TranslateRequestOptions = {},
): TranslateRequestResult {
  // For direct OpenAI connection, we pass through most of the request
  // The Responses API format is compatible with OpenAI Chat Completions
  const request: OpenAiChatRequest = {
    model: data.model,
    messages: data.input as any || [],
  };

  if (typeof data.temperature === 'number') request.temperature = data.temperature;
  if (typeof data.top_p === 'number') request.top_p = data.top_p;

  const maxTokens =
    (typeof data.max_output_tokens === 'number' && data.max_output_tokens) ||
    (typeof data.max_tokens === 'number' && data.max_tokens) ||
    _options.defaultMaxTokens;
  if (typeof maxTokens === 'number') request.max_tokens = maxTokens;

  if (data.tools) request.tools = data.tools as any;
  if (data.tool_choice) request.tool_choice = data.tool_choice as any;
  if (data.parallel_tool_calls) request.parallel_tool_calls = data.parallel_tool_calls;

  return { request };
}
