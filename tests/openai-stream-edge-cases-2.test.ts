import { describe, expect, it } from 'vitest';
import { translateStream } from '../src/translate/openai/translateStream.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

describe('openai translateStream - edge cases', () => {
  it('handles stream where same tool call index gets append', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          encoder.encode(
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n',
          ),
        );
        c.enqueue(
          encoder.encode(
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]}}]}\n\n',
          ),
        );
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const argEvents = events.filter((e) => e.type === 'response.function_call_arguments.delta');
    expect(argEvents.length).toBe(1);
  });

  it('handles stream with no choices', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed).toBeDefined();
  });

  it('handles stream with null delta', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":null}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed).toBeDefined();
  });
});
