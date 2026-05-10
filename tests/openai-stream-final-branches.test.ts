import { describe, expect, it } from 'vitest';
import { translateStream } from '../src/translate/openai/translateStream.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

describe('openai translateStream - fn name in second chunk', () => {
  it('handles tool call with fn name coming in second chunk', async () => {
    // Branch where state already exists (tc.function.name is set but state already has it)
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n'));
        // Second chunk for same tool call: has a fn.name again
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const argEvents = events.filter(e => e.type === 'response.function_call_arguments.delta');
    expect(argEvents.length).toBe(1);
  });

  it('handles tool call with arguments as object type', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":{"q":"test"}}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const argEvents = events.filter(e => e.type === 'response.function_call_arguments.delta');
    expect(argEvents.length).toBe(1);
  });
});
