import { describe, expect, it } from 'vitest';
import { translateStream } from '../src/translate/anthropic/translateStream.js';
import { encodeSseEvent } from '../src/utils/sse.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

function makeByteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// Deep-clone every event as it is yielded. The translator emits `output_item.added`
// carrying the SAME item object reference that `finalize()` later mutates, so a
// post-drain read of `added.item.arguments` would show the mutated value, not the
// value at emission time. Cloning snapshots each event so assertions reflect what
// the client actually observed on the wire (design D1: coercion is finalize-only).
async function collectClones(
  gen: AsyncGenerator<ResponsesStreamEvent>,
): Promise<ResponsesStreamEvent[]> {
  const out: ResponsesStreamEvent[] = [];
  for await (const item of gen) {
    out.push(JSON.parse(JSON.stringify(item)) as ResponsesStreamEvent);
  }
  return out;
}

interface NoArgStreamOptions {
  toolName?: string;
  // undefined => omit the input_json_delta event entirely
  partialJson?: string;
  // undefined => omit the message_delta event entirely (terminal stop reason absent)
  stopReason?: string;
}

// Builds an Anthropic SSE body for a single tool_use block whose content_block_start
// carries `input: {}` — the wire-verified no-argument shape.
function buildToolUseStream(opts: NoArgStreamOptions): string {
  const parts: string[] = [
    encodeSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_noarg',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
    encodeSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call_1',
        name: opts.toolName ?? 'get_status',
        input: {},
      },
    }),
  ];
  if (opts.partialJson !== undefined) {
    parts.push(
      encodeSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: opts.partialJson },
      }),
    );
  }
  parts.push(encodeSseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
  if (opts.stopReason !== undefined) {
    parts.push(
      encodeSseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: opts.stopReason },
        usage: { output_tokens: 1 },
      }),
    );
  }
  parts.push(encodeSseEvent('message_stop', { type: 'message_stop' }));
  return parts.join('');
}

function functionCallDoneArgs(events: ResponsesStreamEvent[]): string {
  const done = events.find(
    (evt) =>
      evt.type === 'response.output_item.done' &&
      (evt as { item?: { type?: string } }).item?.type === 'function_call',
  ) as unknown as { item: { arguments: string } } | undefined;
  if (!done) {
    throw new Error('no function_call response.output_item.done event found');
  }
  return done.item.arguments;
}

function functionCallAddedArgs(events: ResponsesStreamEvent[]): string {
  const added = events.find(
    (evt) =>
      evt.type === 'response.output_item.added' &&
      (evt as { item?: { type?: string } }).item?.type === 'function_call',
  ) as unknown as { item: { arguments: string } } | undefined;
  if (!added) {
    throw new Error('no function_call response.output_item.added event found');
  }
  return added.item.arguments;
}

function completedOutputArgs(events: ResponsesStreamEvent[], index: number): string {
  const completed = events[events.length - 1] as unknown as {
    type: string;
    response: { output: { arguments: string }[] };
  };
  if (completed.type !== 'response.completed') {
    throw new Error(`last event is ${completed.type}, expected response.completed`);
  }
  return completed.response.output[index].arguments;
}

describe('anthropic no-argument tool_use arguments coercion', () => {
  // 2.1 discriminating: empty arg delta + normal terminal -> "{}"
  it('coerces empty arguments to "{}" on stop_reason tool_use (done + completed)', async () => {
    const body = buildToolUseStream({ partialJson: '', stopReason: 'tool_use' });
    const events = await collectClones(
      translateStream(makeByteStream([body]), { model: 'claude-sonnet-4-5' }),
    );

    expect(functionCallDoneArgs(events)).toBe('{}');
    expect(completedOutputArgs(events, 0)).toBe('{}');

    // Streaming surface is untouched (spec req 4): the empty input_json_delta is
    // dropped upstream, so no function_call_arguments.delta is emitted, and the
    // output_item.added item was emitted with empty arguments before finalize.
    expect(functionCallAddedArgs(events)).toBe('');
    const argDeltas = events.filter((evt) => evt.type === 'response.function_call_arguments.delta');
    expect(argDeltas.length).toBe(0);
  });

  // 2.2 discriminating: no arg delta at all + normal terminal -> "{}"
  it('coerces to "{}" when no argument delta arrives and stop_reason end_turn', async () => {
    const body = buildToolUseStream({ stopReason: 'end_turn' });
    const events = await collectClones(translateStream(makeByteStream([body])));
    expect(functionCallDoneArgs(events)).toBe('{}');
    expect(completedOutputArgs(events, 0)).toBe('{}');
  });

  // 2.3 contract lock (green on both builds): truncated -> left ""
  it('leaves empty arguments as "" on stop_reason max_tokens (truncated)', async () => {
    const body = buildToolUseStream({ partialJson: '', stopReason: 'max_tokens' });
    const events = await collectClones(translateStream(makeByteStream([body])));
    expect(functionCallDoneArgs(events)).toBe('');
    expect(completedOutputArgs(events, 0)).toBe('');
  });

  // 2.4 contract lock (green on both builds): stop reason absent -> left ""
  it('leaves empty arguments as "" when no message_delta (stop reason absent)', async () => {
    const body = buildToolUseStream({ partialJson: '' });
    const events = await collectClones(translateStream(makeByteStream([body])));
    expect(functionCallDoneArgs(events)).toBe('');
    expect(completedOutputArgs(events, 0)).toBe('');
  });

  // 2.5 regression lock (green on both builds): real args preserved verbatim
  it('preserves real streamed arguments unchanged', async () => {
    const body = [
      encodeSseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_real',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      encodeSseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'search', input: {} },
      }),
      encodeSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":"' },
      }),
      encodeSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'hi"}' },
      }),
      encodeSseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
      encodeSseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 2 },
      }),
      encodeSseEvent('message_stop', { type: 'message_stop' }),
    ].join('');
    const events = await collectClones(translateStream(makeByteStream([body])));
    expect(functionCallDoneArgs(events)).toBe('{"q":"hi"}');
    expect(completedOutputArgs(events, 0)).toBe('{"q":"hi"}');
  });

  // 2.6 discriminating: whitespace-only arguments -> "{}"
  it('coerces whitespace-only arguments to "{}" on stop_reason stop_sequence', async () => {
    const body = buildToolUseStream({ partialJson: '  ', stopReason: 'stop_sequence' });
    const events = await collectClones(translateStream(makeByteStream([body])));
    expect(functionCallDoneArgs(events)).toBe('{}');
    expect(completedOutputArgs(events, 0)).toBe('{}');
  });
});
