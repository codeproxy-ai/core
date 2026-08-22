// An upstream failure must never be translated into a successful response.
//
// Field case behind these tests (production, 2026-08): a gateway answered an
// upstream rejection with HTTP 200 whose body was an Anthropic error envelope.
// The translator read `body.content ?? []` and `body.usage ?? {0,0}` and emitted
// `status: "completed"` with empty output and an all-zero usage report. The
// calling agent could not tell that apart from "the model said nothing", and the
// zero usage overwrote its context accounting: its auto-compaction meter reset to
// 0 while the real history was ~1.7M tokens, so it never compacted again and
// every later request was rejected for exceeding the context window.
//
// Every assertion below is a VALUE assertion — each one fails on the unpatched
// translator.

import { describe, expect, it } from 'vitest';
import { translateResponse } from '../src/translate/anthropic/translateResponse.js';
import {
  anthropicErrorInfo,
  isAnthropicErrorEnvelope,
} from '../src/translate/anthropic/errorEnvelope.js';
import { translateStream } from '../src/translate/anthropic/translateStream.js';
import type { AnthropicErrorEnvelope, AnthropicResponse } from '../src/types/anthropic.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

// Verbatim shape of the production payload.
const ERROR_ENVELOPE: AnthropicErrorEnvelope = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'prompt is too long: 1118004 tokens > 1000000 maximum',
  },
};

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ResponsesStreamEvent[]> {
  const events: ResponsesStreamEvent[] = [];
  for await (const event of translateStream(stream, { model: 'claude-sonnet-5' })) {
    events.push(event);
  }
  return events;
}

describe('isAnthropicErrorEnvelope', () => {
  it('detects the envelope', () => {
    expect(isAnthropicErrorEnvelope(ERROR_ENVELOPE)).toBe(true);
  });

  it('does not fire on a real message, or on junk', () => {
    expect(
      isAnthropicErrorEnvelope({ type: 'message', content: [], usage: { input_tokens: 5 } }),
    ).toBe(false);
    expect(isAnthropicErrorEnvelope({ type: 'error' })).toBe(false); // no error object
    expect(isAnthropicErrorEnvelope(null)).toBe(false);
    expect(isAnthropicErrorEnvelope('error')).toBe(false);
  });

  it('extracts type and message, with fallbacks', () => {
    expect(anthropicErrorInfo(ERROR_ENVELOPE)).toEqual({
      message: 'prompt is too long: 1118004 tokens > 1000000 maximum',
      type: 'invalid_request_error',
    });
    const bare: AnthropicErrorEnvelope = { type: 'error', error: {} };
    expect(anthropicErrorInfo(bare).type).toBe('upstream_error');
  });
});

describe('translateResponse — non-streaming', () => {
  it('reports an error envelope as failed, NOT as a completed empty turn', () => {
    const out = translateResponse(ERROR_ENVELOPE as unknown as AnthropicResponse, {
      model: 'claude-sonnet-5',
    });
    expect(out.status).toBe('failed');
    expect(out.output).toEqual([]);
    expect(out.error).toEqual({
      code: 'invalid_request_error',
      message: 'prompt is too long: 1118004 tokens > 1000000 maximum',
    });
  });

  it('does not attach a fabricated all-zero usage to the failure', () => {
    const out = translateResponse(ERROR_ENVELOPE as unknown as AnthropicResponse);
    // The old behavior reported usage {0,0,0} — the exact value that resets a
    // caller's context meter. A failed turn reports no usage at all.
    expect(out.usage).toBeUndefined();
  });

  it('still translates a real message normally (non-inversion)', () => {
    const out = translateResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90 },
    });
    expect(out.status).toBe('completed');
    expect(out.usage?.input_tokens).toBe(100);
    expect(out.usage?.total_tokens).toBe(103);
    expect(out.output).toHaveLength(1);
  });
});

describe('translateStream — mid-stream error frame', () => {
  it('emits response.failed and never response.completed', async () => {
    const events = await collect(
      sseStream([
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":12,"output_tokens":0}}}\n\n`,
        `event: error\ndata: ${JSON.stringify(ERROR_ENVELOPE)}\n\n`,
      ]),
    );
    const types = events.map((event) => event.type);
    expect(types).toContain('response.failed');
    expect(types).not.toContain('response.completed');

    const failed = events.find((event) => event.type === 'response.failed');

    const response = (failed as unknown as { response: Record<string, unknown> }).response;
    expect(response.status).toBe('failed');
    expect(response.error).toEqual({
      code: 'invalid_request_error',
      message: 'prompt is too long: 1118004 tokens > 1000000 maximum',
    });
  });

  it('an empty upstream stream is a failure, not a zero-usage success', async () => {
    const events = await collect(sseStream([]));
    const types = events.map((event) => event.type);
    expect(types).toEqual(['response.created', 'response.failed']);
    const failed = events[1];

    const response = (failed as unknown as { response: Record<string, unknown> }).response;
    expect(response.error).toMatchObject({ code: 'empty_upstream_stream' });
    expect(response.usage).toBeUndefined();
  });

  it('a real stream still completes with real usage (non-inversion)', async () => {
    const events = await collect(
      sseStream([
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":93}}}\n\n`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ]),
    );
    const types = events.map((event) => event.type);
    expect(types).toContain('response.completed');
    expect(types).not.toContain('response.failed');
    const completed = events[events.length - 1];

    const response = (completed as unknown as { response: Record<string, unknown> }).response;

    const usage = response.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(2);
  });

  it('a malformed-but-non-empty stream still completes (guard keys on "no events at all")', async () => {
    // Only a delta for a block that was never opened, then a stop. No
    // message_start — but the upstream DID speak, so this keeps today's
    // behavior. Locks the narrower reading of the empty-stream guard.
    const events = await collect(
      sseStream([
        `data: {"type":"content_block_delta","index":5,"delta":{"type":"signature_delta","signature":"sig123"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ]),
    );
    expect(events.map((event) => event.type)).toContain('response.completed');
  });

  it('a model turn that legitimately produces no content still completes', async () => {
    // message_start arrived, so the upstream DID answer — this must stay a
    // success even though there is no output item, or the guard would start
    // failing legitimate empty turns.
    const events = await collect(
      sseStream([
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":42,"output_tokens":0}}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ]),
    );
    const types = events.map((event) => event.type);
    expect(types).toContain('response.completed');
    expect(types).not.toContain('response.failed');
  });
});
