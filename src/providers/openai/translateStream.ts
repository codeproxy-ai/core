import type { OpenAiChatResponse } from '../../types/openai_chat.js';
import type {
  ResponsesResponse,
} from '../../types/responses.js';

export interface TranslateStreamOptions {
  /** Id used for the resulting Responses object. Defaults to OpenAI id or generated. */
  responseId?: string;
  /** Created timestamp (seconds). Defaults to `Date.now() / 1000`. */
  createdAt?: number;
  /** Original Responses-API model that callers want surfaced. */
  model?: string;
}

/**
 * Convert an OpenAI Chat stream into a Responses-API stream.
 * Since OpenAI Responses API is similar to Chat Completions, this is a minimal transformation.
 */
export async function* translateStream(
  upstream: ReadableStream<Uint8Array>,
  options: TranslateStreamOptions = {},
): AsyncGenerator<ResponsesResponse, void, unknown> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();

  const responseId = options.responseId ?? '';
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const model = options.model ?? '';

  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data) as any;
          
          // Transform to Responses API format
          const transformed: ResponsesResponse = {
            id: responseId || chunk.id || '',
            object: 'response',
            created_at: createdAt,
            model,
            status: 'in_progress',
            output: chunk.choices?.[0]?.delta?.content ? [{
              id: chunk.id || '',
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: Array.isArray(chunk.choices[0].delta.content)
                ? chunk.choices[0].delta.content
                : [{ type: 'output_text', text: String(chunk.choices[0].delta.content) }],
            }] : [],
          };

          yield transformed;
        } catch (e) {
          // Skip invalid JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
