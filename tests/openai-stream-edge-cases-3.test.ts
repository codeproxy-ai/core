import { describe, expect, it } from 'vitest';
import { translateStream } from '../src/translate/openai/translateStream.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

describe('openai translateStream - remaining branch coverage', () => {
  it('handles stream with textItem and toolCalls together in finalize', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const doneEvents = events.filter(e => e.type === 'response.output_item.done');
    expect(doneEvents.length).toBe(2);
  });

  it('handles stream with shell tool call in finalize', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_sh","type":"function","function":{"name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const doneEvents = events.filter(e => e.type === 'response.output_item.done');
    expect(doneEvents.length).toBe(1);
    // eslint-disable-next-line no-restricted-syntax -- test needs wider type
    const doneEvent = doneEvents[0] as { item: { type: string; action: { command: string[] } } };
    expect(doneEvent.item.type).toBe('local_shell_call');
  });

  it('handles fn name being re-added in same tool call chunk', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]}}]}\n\n'));
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

  it('handles completion with cached tokens output', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":2}}}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const completed = events.find(e => e.type === 'response.completed');
    expect(completed).toBeDefined();
  });
});
