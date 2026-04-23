import { describe, it, expect } from 'vitest';
import { translateStream } from './translateStream.js';
import type { ResponsesStreamEvent } from '../../types/responses.js';

function toReadable(sse: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ResponsesStreamEvent[]> {
  const out: ResponsesStreamEvent[] = [];
  for await (const evt of translateStream(stream, { model: 'm' })) out.push(evt);
  return out;
}

describe('OpenAI translateStream', () => {
  it('emits response.created, text deltas, and response.completed for a text stream', async () => {
    const sse = `data: {"id":"chat-123","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n` +
      `data: {"id":"chat-123","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n` +
      `data: {"id":"chat-123","choices":[{"index":0,"delta":{}}],"finish_reason":"stop"}\n\n` +
      `data: [DONE]\n\n`;

    const events = await collect(toReadable(sse));

    expect(events[0].type).toBe('response.created');
    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.length).toBe(2);
    expect(deltas.map((d) => (d as { delta?: string }).delta)).toEqual(['Hello', ' world']);

    const last = events[events.length - 1];
    expect(last.type).toBe('response.completed');
  });

  it('terminates on [DONE] marker', async () => {
    const sse = `data: {"id":"chat-123","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n` +
      `data: [DONE]\n\n`;

    const events = await collect(toReadable(sse));

    expect(events[0].type).toBe('response.created');
    expect(events[events.length - 1].type).toBe('response.completed');
  });

  it('ignores empty SSE lines', async () => {
    const sse = `\n\ndata: {"id":"chat-123","choices":[{"index":0,"delta":{"content":"Test"}}]}\n\n\n`;
    const events = await collect(toReadable(sse));
    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.length).toBe(1);
  });
});
