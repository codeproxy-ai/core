import { describe, expect, it } from 'vitest';
import { translateResponse } from '../src/translate/anthropic/translateResponse.js';
import { translateStream } from '../src/translate/anthropic/translateStream.js';
import { encodeSseEvent } from '../src/utils/sse.js';
import type { AnthropicResponse, AnthropicUsage } from '../src/types/anthropic.js';
import type { ResponsesStreamEvent, ResponsesUsage } from '../src/types/responses.js';

// Anthropic-native `input_tokens` is the UNCACHED REMAINDER only; the two cache
// counters are disjoint from it. The Responses contract wants `input_tokens` to
// be the full prompt with `input_tokens_details.cached_tokens` as a subset of it.
// Every case below asserts exact token values on both translation paths, because
// a downstream context meter and the auto-compaction trigger read these numbers.

function makeAnthropicBody(usage: AnthropicUsage): AnthropicResponse {
  return {
    id: 'msg_cached',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'Hi' }],
    usage,
  };
}

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

/** Drive the streaming translator with a message_start usage + a message_delta
 * carrying output_tokens, and return the terminal response.completed usage. */
async function streamUsage(
  messageStartUsage: AnthropicUsage,
  deltaOutputTokens: number,
): Promise<ResponsesUsage> {
  const body = [
    encodeSseEvent('message_start', {
      type: 'message_start',
      message: makeAnthropicBody(messageStartUsage),
    }),
    encodeSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    encodeSseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi' },
    }),
    encodeSseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    encodeSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: deltaOutputTokens },
    }),
    encodeSseEvent('message_stop', { type: 'message_stop' }),
  ];

  const events: ResponsesStreamEvent[] = [];
  for await (const event of translateStream(makeByteStream(body), { model: 'claude-sonnet-4-5' })) {
    events.push(event);
  }

  const completed = events.find((event) => event.type === 'response.completed');
  expect(completed).toBeDefined();
  const typed = completed as unknown as { response: { usage: ResponsesUsage } };
  expect(typed.response.usage).toBeDefined();
  return typed.response.usage;
}

describe('anthropic cached token accounting', () => {
  it('non-streaming: a warm-cached turn reports the full prompt, not the uncached remainder', () => {
    const response = translateResponse(
      makeAnthropicBody({
        input_tokens: 4000,
        output_tokens: 1200,
        cache_read_input_tokens: 476000,
        cache_creation_input_tokens: 0,
      }),
    );

    const usage = response.usage!;
    expect(usage.input_tokens).toBe(480000);
    expect(usage.output_tokens).toBe(1200);
    expect(usage.total_tokens).toBe(481200);
    expect(usage.input_tokens_details!.cached_tokens).toBe(476000);
    expect(usage.input_tokens_details!.cache_creation_tokens).toBe(0);
  });

  it('streaming: a warm-cached turn reports the same numbers as the non-streaming path', async () => {
    const usage = await streamUsage(
      {
        input_tokens: 4000,
        output_tokens: 0,
        cache_read_input_tokens: 476000,
        cache_creation_input_tokens: 0,
      },
      1200,
    );

    expect(usage.input_tokens).toBe(480000);
    expect(usage.output_tokens).toBe(1200);
    expect(usage.total_tokens).toBe(481200);
    expect(usage.input_tokens_details!.cached_tokens).toBe(476000);
    expect(usage.input_tokens_details!.cache_creation_tokens).toBe(0);
  });

  it('cache creation tokens count toward the prompt (cold write)', () => {
    const response = translateResponse(
      makeAnthropicBody({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 60000,
      }),
    );

    const usage = response.usage!;
    expect(usage.input_tokens).toBe(61000);
    expect(usage.output_tokens).toBe(500);
    expect(usage.total_tokens).toBe(61500);
    expect(usage.input_tokens_details!.cache_creation_tokens).toBe(60000);
    expect(usage.input_tokens_details!.cached_tokens).toBe(0);
  });

  it('cache creation tokens count toward the prompt on the streaming path too', async () => {
    const usage = await streamUsage(
      { input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 60000 },
      500,
    );

    expect(usage.input_tokens).toBe(61000);
    expect(usage.total_tokens).toBe(61500);
    expect(usage.input_tokens_details!.cache_creation_tokens).toBe(60000);
  });

  it('regression guard: an uncached turn is unchanged, with zeroed details', () => {
    const response = translateResponse(makeAnthropicBody({ input_tokens: 3, output_tokens: 2 }));

    const usage = response.usage!;
    expect(usage.input_tokens).toBe(3);
    expect(usage.output_tokens).toBe(2);
    expect(usage.total_tokens).toBe(5);
    expect(usage.input_tokens_details!.cached_tokens).toBe(0);
    expect(usage.input_tokens_details!.cache_creation_tokens).toBe(0);
  });

  it('regression guard: an uncached streamed turn is unchanged', async () => {
    const usage = await streamUsage({ input_tokens: 3, output_tokens: 0 }, 2);

    expect(usage.input_tokens).toBe(3);
    expect(usage.output_tokens).toBe(2);
    expect(usage.total_tokens).toBe(5);
    expect(usage.input_tokens_details!.cached_tokens).toBe(0);
    expect(usage.input_tokens_details!.cache_creation_tokens).toBe(0);
  });

  it('invariant: total equals input plus output, and the details are a subset of input', () => {
    const response = translateResponse(
      makeAnthropicBody({
        input_tokens: 4000,
        output_tokens: 1200,
        cache_read_input_tokens: 300000,
        cache_creation_input_tokens: 176000,
      }),
    );

    const usage = response.usage!;
    const cached = usage.input_tokens_details!.cached_tokens!;
    const created = usage.input_tokens_details!.cache_creation_tokens!;
    expect(usage.input_tokens).toBe(480000);
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
    expect(usage.total_tokens).toBe(481200);
    expect(cached + created).toBe(476000);
    expect(cached + created <= usage.input_tokens).toBe(true);
  });

  it('invariant holds on the streaming path with both cache counters set', async () => {
    const usage = await streamUsage(
      {
        input_tokens: 4000,
        output_tokens: 0,
        cache_read_input_tokens: 300000,
        cache_creation_input_tokens: 176000,
      },
      1200,
    );

    const cached = usage.input_tokens_details!.cached_tokens!;
    const created = usage.input_tokens_details!.cache_creation_tokens!;
    expect(usage.input_tokens).toBe(480000);
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
    expect(usage.total_tokens).toBe(481200);
    expect(cached + created <= usage.input_tokens).toBe(true);
  });
});
