import type { OpenAiChatResponse } from '../../types/openai_chat.js';
import type {
  ResponsesResponse,
} from '../../types/responses.js';

export interface TranslateResponseOptions {
  /** Id used for the resulting Responses object. Defaults to OpenAI id or generated. */
  responseId?: string;
  /** Created timestamp (seconds). Defaults to `Date.now() / 1000`. */
  createdAt?: number;
  /** Original Responses-API model that callers want surfaced. */
  model?: string;
}

/**
 * Convert an OpenAI Chat response into a Responses-API response.
 * Since OpenAI Responses API is similar to Chat Completions, this is a minimal transformation.
 */
export function translateResponse(
  body: OpenAiChatResponse,
  options: TranslateResponseOptions = {},
): ResponsesResponse {
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const id = options.responseId ?? body.id ?? '';
  const model = options.model ?? body.model ?? '';

  const usage = body.usage ?? { prompt_tokens: 0, completion_tokens: 0 };

  return {
    id,
    object: 'response',
    created_at: createdAt,
    model,
    status: 'completed',
    output: body.choices?.[0]?.message?.content ? [{
      id: body.id || '',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: Array.isArray(body.choices[0].message.content) 
        ? body.choices[0].message.content 
        : [{ type: 'output_text', text: String(body.choices[0].message.content) }],
    }] : [],
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      input_tokens_details: {
        cached_tokens: 0,
        cache_creation_tokens: 0,
      },
    },
  };
}
