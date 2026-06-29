// ==============================================================================
// Stream Translator
// ==============================================================================

import type {
  OpenAiChatStreamChunk,
  OpenAiChatStreamDelta,
  OpenAiChatStreamDeltaToolCall,
} from '../../types/openai_chat.js';
import type {
  ResponsesOutputFunctionCall,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesOutputReasoning,
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

/** Build a shortName → namespace map so we can restore the namespace when an
 *  upstream (e.g. DeepSeek) omits the "namespace." prefix in a tool-call.
 *
 *  Handles two formats that may appear in the tools list:
 *  1. Flattened Chat Completions tools: { function: { name: "ns.tool" } }
 *  2. Original Responses API namespace tools: { type: "namespace", name: "ns", tools: [...] }
 */
function buildShortNameToNamespace(tools: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- Record extraction from unknown union
    const entry = tool as Record<string, unknown>;

    // Format 1: flattened Chat Completions tool with "namespace.name"
    // eslint-disable-next-line no-restricted-syntax -- nested Record extraction
    const fn = entry.function as Record<string, unknown> | undefined;
    const flatName =
      typeof fn?.name === 'string' ? fn.name : typeof entry.name === 'string' ? entry.name : '';
    const dotIdx = flatName.indexOf('.');
    if (dotIdx !== -1) {
      map.set(flatName.slice(dotIdx + 1), flatName.slice(0, dotIdx));
      continue;
    }

    // Format 2: Responses API namespace tool with nested sub-tools
    if (
      entry.type === 'namespace' &&
      typeof entry.name === 'string' &&
      Array.isArray(entry.tools)
    ) {
      const ns = entry.name;
      // eslint-disable-next-line no-restricted-syntax -- unknown[] iteration over nested tools
      for (const sub of entry.tools as unknown[]) {
        if (!sub || typeof sub !== 'object') {
          continue;
        }
        // eslint-disable-next-line no-restricted-syntax -- Record extraction from unknown
        const subEntry = sub as Record<string, unknown>;
        const subName = typeof subEntry.name === 'string' ? subEntry.name : '';
        if (subName) {
          map.set(subName, ns);
        }
      }
    }
  }
  return map;
}

/**
 * Consume an OpenAI-chat-style SSE stream and yield Responses-API SSE events.
 */
export async function* translateStream(
  stream: ReadableStream<Uint8Array>,
  options: TranslateStreamOptions = {},
): AsyncGenerator<ResponsesStreamEvent, void, void> {
  const translator = new StreamTranslator(options);
  yield translator.createInitialEvent();

  for await (const msg of parseSseStream(stream)) {
    if (isDoneMessage(msg)) {
      break;
    }
    const chunk = safeJsonParse<OpenAiChatStreamChunk>(msg.data);
    if (!chunk) {
      continue;
    }
    yield* translator.handleChunk(chunk);
  }

  yield* translator.finalize();
}

function isDoneMessage(msg: SseMessage): boolean {
  return msg.data.trim() === '[DONE]';
}

interface ToolCallState {
  outputIndex: number;
  item: ResponsesOutputFunctionCall;
}

function getToolCallKey(tc: OpenAiChatStreamDeltaToolCall, ordinal: number): string {
  if (typeof tc.index === 'number') {
    return `index:${tc.index}`;
  }
  if (tc.id) {
    return `id:${tc.id}`;
  }
  return `ordinal:${ordinal}`;
}

// ==============================================================================
// Stateful Event Translation
// ==============================================================================

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

  // Reasoning (thinking) item — upstreams that expose chain-of-thought (DeepSeek,
  // Gemini OpenAI-compat, …) stream it on delta.reasoning_content. Surface it as a
  // Responses reasoning item so codex sees response.reasoning_text.delta.
  private reasoningItem?: ResponsesOutputReasoning;
  private reasoningItemIndex = -1;
  private reasoningBuffer = '';

  private readonly toolCalls = new Map<string, ToolCallState>();
  // shortName → namespace reverse map built from flattened namespace tools in
  // the translated request.  Used to restore the namespace when an upstream
  // (e.g. DeepSeek) omits the "namespace." prefix in its tool-call response.
  private readonly shortNameToNamespace: Map<string, string>;

  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;

  constructor(options: TranslateStreamOptions) {
    this.model = options.model ?? '';
    this.responseId = options.responseId ?? makeId('resp');
    this.createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
    this.metadata = options.requestMetadata ?? {};
    this.shortNameToNamespace = buildShortNameToNamespace(this.metadata.tools ?? []);
  }

  createInitialEvent(): ResponsesStreamEvent {
    const toolsArr: unknown[] = this.metadata.tools ?? [];
    const response: Partial<ResponsesResponse> = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      model: this.model,
      status: 'in_progress',
      temperature: this.metadata.temperature,
      top_p: this.metadata.top_p,
      tool_choice: this.metadata.tool_choice,
      tools: toolsArr,
      parallel_tool_calls: true,
      store: this.metadata.store ?? true,
      metadata: this.metadata.metadata ?? {},
      output: [],
    };
    return this.makeEvent('response.created', { response });
  }

  *handleChunk(chunk: OpenAiChatStreamChunk): Generator<ResponsesStreamEvent, void, void> {
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === 'number') {
        this.inputTokens = chunk.usage.prompt_tokens;
      }
      if (typeof chunk.usage.completion_tokens === 'number') {
        this.outputTokens = chunk.usage.completion_tokens;
      }
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      if (typeof cached === 'number') {
        this.cachedTokens = cached;
      }
    }

    const choice = chunk.choices?.[0];
    const delta: OpenAiChatStreamDelta | undefined = choice?.delta;
    if (!delta) {
      return;
    }

    if (delta.tool_calls?.length) {
      for (const [ordinal, tc] of delta.tool_calls.entries()) {
        const key = getToolCallKey(tc, ordinal);
        let state = this.toolCalls.get(key);
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
          this.toolCalls.set(key, state);
          yield this.makeEvent('response.output_item.added', {
            response_id: this.responseId,
            output_index: outputIndex,
            item,
          });
        }

        const fn = tc.function;
        const thoughtSignature = getThoughtSignature(tc);
        if (thoughtSignature) {
          state.item.thought_signature = thoughtSignature;
        }
        if (fn?.name) {
          state.item.name = (state.item.name ?? '') + fn.name;
        }
        if (fn?.arguments != null) {
          const partial =
            typeof fn.arguments === 'string' ? fn.arguments : jsonStringifySafe(fn.arguments);
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

    if (
      typeof delta.reasoning_content === 'string' &&
      delta.reasoning_content
    ) {
      if (!this.reasoningItem) {
        const outputIndex = this.outputCounter++;
        this.reasoningItemIndex = outputIndex;
        this.reasoningItem = {
          id: makeId('rs'),
          type: 'reasoning',
          summary: [],
          content: [{ type: 'reasoning_text', text: '' }],
          status: 'in_progress',
        };
        yield this.makeEvent('response.output_item.added', {
          response_id: this.responseId,
          output_index: outputIndex,
          item: this.reasoningItem,
        });
      }
      this.reasoningBuffer += delta.reasoning_content;
      this.reasoningItem.content[0].text = this.reasoningBuffer;
      yield this.makeEvent('response.reasoning_text.delta', {
        response_id: this.responseId,
        item_id: this.reasoningItem.id,
        output_index: this.reasoningItemIndex,
        content_index: 0,
        delta: delta.reasoning_content,
      });
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
      // eslint-disable-next-line no-restricted-syntax -- Narrow union to text content
      const textContent = this.textItem.content[0] as { text: string };
      textContent.text = this.textBuffer;
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

    if (this.reasoningItem) {
      this.reasoningItem.status = 'completed';
      items.push({ index: this.reasoningItemIndex, item: this.reasoningItem });
    }

    if (this.textItem) {
      this.textItem.status = 'completed';
      items.push({ index: this.textItemIndex, item: this.textItem });
    }

    for (const state of this.toolCalls.values()) {
      const item = state.item;
      item.status = 'completed';
      // Restore namespace so codex can route the call to the correct handler.
      // Skip splitting if the full name is already a known shell tool (e.g. "container.exec").
      // Case 1: upstream preserved the prefix  → split on first dot.
      // Case 2: upstream stripped the prefix   → look up the reverse map.
      if (item.name && !SHELL_TOOL_NAMES.has(item.name)) {
        const dotIdx = item.name.indexOf('.');
        if (dotIdx !== -1) {
          item.namespace = item.name.slice(0, dotIdx);
          item.name = item.name.slice(dotIdx + 1);
        } else {
          const ns = this.shortNameToNamespace.get(item.name);
          if (ns) {
            item.namespace = ns;
          }
        }
      }
      if (item.name && SHELL_TOOL_NAMES.has(item.name)) {
        item.type = 'local_shell_call';
        const parsed = safeJsonParse<{ command?: string[] }>(item.arguments ?? '');
        item.action = { type: 'exec', command: parsed?.command ?? [] };
      }
      items.push({ index: state.outputIndex, item });
    }

    items.sort((alpha, beta) => alpha.index - beta.index);

    for (const { index, item } of items) {
      yield this.makeEvent('response.output_item.done', {
        response_id: this.responseId,
        output_index: index,
        item,
      });
    }

    const output = items.map((item) => item.item);
    const finalToolsArr: unknown[] = this.metadata.tools ?? [];
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
      tools: finalToolsArr,
      parallel_tool_calls: true,
      store: this.metadata.store ?? true,
      metadata: this.metadata.metadata ?? {},
      output,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        total_tokens: total,
        input_tokens_details: {
          cached_tokens: this.cachedTokens,
        },
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

function getThoughtSignature(tc: OpenAiChatStreamDeltaToolCall): string | undefined {
  const sig = tc.extra_content?.google?.thought_signature ?? tc.thought_signature;
  return typeof sig === 'string' && sig ? sig : undefined;
}
