import type {
  OpenAiChatResponse,
  OpenAiChatToolCall,
} from '../../types/openai_chat.js';
import type {
  ResponsesOutputFunctionCall,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesResponse,
} from '../../types/responses.js';
import { makeId } from '../../utils/id.js';
import { safeJsonParse, jsonStringifySafe } from '../../utils/json.js';

export interface TranslateResponseOptions {
  responseId?: string;
  createdAt?: number;
  model?: string;
}

const SHELL_TOOL_NAMES = new Set(['shell', 'container.exec', 'shell_command']);

/** Convert a non-streaming ZAI (OpenAI-chat) response into a Responses-API response. */
export function translateResponse(
  body: OpenAiChatResponse,
  options: TranslateResponseOptions = {},
): ResponsesResponse {
  const createdAt = options.createdAt ?? body.created ?? Math.floor(Date.now() / 1000);
  const id = options.responseId ?? (body.id ? `zai_${body.id}` : makeId('resp'));
  const model = options.model ?? body.model ?? '';

  const choice = body.choices?.[0];
  const message = choice?.message;
  const output: ResponsesOutputItem[] = [];

  if (message?.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      const item = mapToolCallToOutput(tc);
      if (item) output.push(item);
    }
  }

  if (typeof message?.content === 'string' && message.content) {
    const msgOut: ResponsesOutputMessage = {
      id: makeId('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content }],
    };
    output.push(msgOut);
  }

  const usage = body.usage ?? {};
  const input = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? input + completion;

  return {
    id,
    object: 'response',
    created_at: createdAt,
    model,
    status: 'completed',
    output,
    usage: {
      input_tokens: input,
      output_tokens: completion,
      total_tokens: total,
    },
  };
}

function mapToolCallToOutput(tc: OpenAiChatToolCall): ResponsesOutputFunctionCall | undefined {
  const name = tc.function?.name;
  if (!name) return undefined;
  const callId = tc.id ?? makeId('call');
  let args = tc.function?.arguments ?? '';
  if (typeof args !== 'string') args = jsonStringifySafe(args ?? {});

  const item: ResponsesOutputFunctionCall = {
    id: callId,
    type: 'function_call',
    status: 'completed',
    name,
    arguments: args,
    call_id: callId,
  };

  if (SHELL_TOOL_NAMES.has(name)) {
    item.type = 'local_shell_call';
    const parsed = safeJsonParse<{ command?: string[] }>(args);
    item.action = { type: 'exec', command: parsed?.command ?? [] };
  }

  return item;
}
