import type {
  OpenAiChatStreamChunk,
  OpenAiChatStreamDelta,
} from '../../types/openai_chat.js';
import type {
  ResponsesOutputFunctionCall,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesResponse,
  ResponsesStreamEvent,
} from '../../types/responses.js';
import { parseSseStream, type SseMessage } from '../../utils/sse.js';
import { makeId } from '../../utils/id.js';
import { safeJsonParse, jsonStringifySafe } from '../../utils/json.js';

export interface ResponsesStreamMetadata {
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  store?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TranslateStreamOptions {
  model?: string;
  responseId?: string;
  createdAt?: number;
  requestMetadata?: ResponsesStreamMetadata;
}

const SHELL_TOOL_NAMES = new Set(['shell', 'container.exec', 'shell_command']);

/**
 * Consume a ZAI (OpenAI-chat-style) SSE stream and yield Responses-API SSE events.
 */
export async function* translateStream(
  stream: ReadableStream<Uint8Array>,
  options: TranslateStreamOptions = {},
): AsyncGenerator<ResponsesStreamEvent, void, void> {
  const t = new StreamTranslator(options);
  yield t.createInitialEvent();

  for await (const msg of parseSseStream(stream)) {
    if (isDoneMessage(msg)) break;
    const chunk = safeJsonParse<OpenAiChatStreamChunk>(msg.data);
    if (!chunk) continue;
    yield* t.handleChunk(chunk);
  }

  yield* t.finalize();
}

function isDoneMessage(msg: SseMessage): boolean {
  return msg.data.trim() === '[DONE]';
}

interface ToolCallState {
  outputIndex: number;
  item: ResponsesOutputFunctionCall;
}

class StreamTranslator {
  private readonly model: string;
  private readonly responseId: string;
  private readonly createdAt: number;
  private readonly metadata: ResponsesStreamMetadata;
  private seq = 0;
  private outputCounter = 0;

  private textItem?: ResponsesOutputMessage;
  private textItemIndex = -1;
  private textBuffer = '';

  private readonly toolCalls = new Map<number, ToolCallState>();

  private inputTokens = 0;
  private outputTokens = 0;

  constructor(options: TranslateStreamOptions) {
    this.model = options.model ?? '';
    this.responseId = options.responseId ?? makeId('resp');
    this.createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
    this.metadata = options.requestMetadata ?? {};
  }

  createInitialEvent(): ResponsesStreamEvent {
    const response: Partial<ResponsesResponse> = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      model: this.model,
      status: 'in_progress',
      temperature: this.metadata.temperature,
      top_p: this.metadata.top_p,
      tool_choice: this.metadata.tool_choice,
      tools: (this.metadata.tools as unknown[]) ?? [],
      parallel_tool_calls: true,
      store: this.metadata.store ?? true,
      metadata: this.metadata.metadata ?? {},
      output: [],
    };
    return this.makeEvent('response.created', { response });
  }

  *handleChunk(chunk: OpenAiChatStreamChunk): Generator<ResponsesStreamEvent, void, void> {
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === 'number') this.inputTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === 'number') this.outputTokens = chunk.usage.completion_tokens;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta as OpenAiChatStreamDelta | undefined;
    if (!delta) return;

    if (delta.tool_calls?.length) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let state = this.toolCalls.get(idx);
        if (!state) {
          const outputIndex = this.outputCounter++;
          const callId = tc.id ?? makeId('call');
          const item: ResponsesOutputFunctionCall = {
            id: callId,
            type: 'function_call',
            status: 'in_progress',
            name: '',
            arguments: '',
            call_id: callId,
          };
          state = { outputIndex, item };
          this.toolCalls.set(idx, state);
          yield this.makeEvent('response.output_item.added', {
            response_id: this.responseId,
            output_index: outputIndex,
            item,
          });
        }

        const fn = tc.function;
        if (fn?.name) {
          state.item.name = (state.item.name ?? '') + fn.name;
        }
        if (fn?.arguments != null) {
          const partial = typeof fn.arguments === 'string' ? fn.arguments : jsonStringifySafe(fn.arguments);
          if (partial) {
            state.item.arguments = (state.item.arguments ?? '') + partial;
            yield this.makeEvent('response.function_call_arguments.delta', {
              response_id: this.responseId,
              item_id: state.item.id,
              output_index: state.outputIndex,
              delta: partial,
            });
          }
        }
      }
    }

    if (typeof delta.content === 'string' && delta.content) {
      if (!this.textItem) {
        const outputIndex = this.outputCounter++;
        this.textItemIndex = outputIndex;
        this.textItem = {
          id: makeId('msg'),
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [{ type: 'output_text', text: '' }],
        };
        yield this.makeEvent('response.output_item.added', {
          response_id: this.responseId,
          output_index: outputIndex,
          item: this.textItem,
        });
      }
      this.textBuffer += delta.content;
      (this.textItem.content[0] as { text: string }).text = this.textBuffer;
      yield this.makeEvent('response.output_text.delta', {
        response_id: this.responseId,
        item_id: this.textItem.id,
        output_index: this.textItemIndex,
        content_index: 0,
        delta: delta.content,
      });
    }
  }

  *finalize(): Generator<ResponsesStreamEvent, void, void> {
    const items: { index: number; item: ResponsesOutputItem }[] = [];

    if (this.textItem) {
      this.textItem.status = 'completed';
      items.push({ index: this.textItemIndex, item: this.textItem });
    }

    for (const state of this.toolCalls.values()) {
      const item = state.item;
      item.status = 'completed';
      if (item.name && SHELL_TOOL_NAMES.has(item.name)) {
        item.type = 'local_shell_call';
        const parsed = safeJsonParse<{ command?: string[] }>(item.arguments ?? '');
        item.action = { type: 'exec', command: parsed?.command ?? [] };
      }
      items.push({ index: state.outputIndex, item });
    }

    items.sort((a, b) => a.index - b.index);

    for (const { index, item } of items) {
      yield this.makeEvent('response.output_item.done', {
        response_id: this.responseId,
        output_index: index,
        item,
      });
    }

    const output = items.map((e) => e.item);
    const total = this.inputTokens + this.outputTokens;

    const response: Partial<ResponsesResponse> = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      completed_at: Math.floor(Date.now() / 1000),
      model: this.model,
      status: 'completed',
      temperature: this.metadata.temperature,
      top_p: this.metadata.top_p,
      tool_choice: this.metadata.tool_choice,
      tools: (this.metadata.tools as unknown[]) ?? [],
      parallel_tool_calls: true,
      store: this.metadata.store ?? true,
      metadata: this.metadata.metadata ?? {},
      output,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        total_tokens: total,
      },
    };

    yield this.makeEvent('response.completed', { response });
  }

  private makeEvent(type: string, data: Record<string, unknown>): ResponsesStreamEvent {
    this.seq += 1;
    return {
      id: makeId('evt'),
      object: 'response.event',
      type,
      created_at: Math.floor(Date.now() / 1000),
      sequence_number: this.seq,
      ...data,
    };
  }
}
