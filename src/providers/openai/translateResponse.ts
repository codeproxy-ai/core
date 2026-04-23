import type { OpenAiChatResponse, OpenAiChatMessage } from '../../types/openai_chat.js';
import type {
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesOutputFunctionCall,
} from '../../types/responses.js';
import { jsonStringifySafe } from '../../utils/json.js';

export interface TranslateResponseOptions {
  /** Id used for the resulting Responses object. Defaults to OpenAI id or generated. */
  responseId?: string;
  /** Created timestamp (seconds). Defaults to `Date.now() / 1000`. */
  createdAt?: number;
  /** Original Responses-API model that callers want surfaced. */
  model?: string;
}

/** Convert an OpenAI Chat response into a Responses-API response. */
export function translateResponse(
  body: OpenAiChatResponse,
  options: TranslateResponseOptions = {},
): ResponsesResponse {
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const id = options.responseId ?? body.id ?? '';
  const model = options.model ?? body.model ?? '';

  const usage = body.usage ?? { prompt_tokens: 0, completion_tokens: 0 };

  const output = mapOutputItems(body.choices?.[0]?.message);

  return {
    id,
    object: 'response',
    created_at: createdAt,
    model,
    status: 'completed',
    output,
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

function mapOutputItems(message: any): ResponsesOutputItem[] {
  const out: ResponsesOutputItem[] = [];

  if (!message) return out;

  // Add text content
  if (message.content) {
    const textContent = typeof message.content === 'string' 
      ? message.content 
      : Array.isArray(message.content)
        ? message.content.map((part: any) => part.text || '').join('')
        : '';
    
    if (textContent) {
      out.push({
        id: `msg_${Math.random().toString(36).substring(7)}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: textContent }],
      });
    }
  }

  // Add tool calls
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      out.push({
        id: toolCall.id,
        type: 'function_call',
        status: 'completed',
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        call_id: toolCall.id,
      });
    }
  }

  return out;
}
