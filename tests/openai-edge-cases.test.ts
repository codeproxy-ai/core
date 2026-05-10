import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';
import { translateResponse } from '../src/translate/openai/translateResponse.js';
import { translateStream } from '../src/translate/openai/translateStream.js';
import { encodeSseEvent } from '../src/utils/sse.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

describe('openai translateRequest edge cases', () => {
  it('handles input as string', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hello',
    });
    expect(request.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('handles empty instructions', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hello',
    });
    expect(request.messages[0].role).toBe('user');
  });

  it('handles instructions as string array', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      instructions: ['Be helpful.', { text: 'Be concise.' }],
      input: 'hello',
    });
    expect(request.messages[0]).toMatchObject({ role: 'system', content: 'Be helpful.Be concise.' });
  });

  it('handles null/undefined items in input array', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [null as unknown as never, 'hello', undefined as unknown as never],
    });
    expect(request.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('handles input_image with data URL', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        ],
      }],
    }, { dropImages: false });
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  it('handles assistant message with tool calls', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"test"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'result',
        },
      ],
    });
    const toolMsg = request.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });

  it('handles assistant message with reasoning', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'thinking...' }],
          reasoning_content: 'step by step',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      ],
    });
    const assistantMsg = request.messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  it('handles assistant message with stderr', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          stderr: 'error occurred',
        },
      ],
    });
    const toolMsg = request.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain('error occurred');
  });

  it('handles reasoning input item', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'step by step' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      ],
    });
    const assistantMsg = request.messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  it('handles custom tool call type', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'web_search_call',
        id: 'ws_1',
        action: { type: 'web_search' },
      }],
    });
    expect(request.messages.length).toBeGreaterThan(0);
  });



  it('handles tool_choice with function object', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'search' } },
    });
    expect(request.tool_choice).toBeDefined();
  });
});

describe('openai translateResponse edge cases', () => {
  it('handles response without tool_calls', () => {
    const res = translateResponse({
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    expect(res.status).toBe('completed');
    expect(res.output).toHaveLength(1);
    const msg = res.output[0] as { type: string; content: Array<{ text: string }> };
    expect(msg.type).toBe('message');
  });

  it('handles shell tool call in response', () => {
    const res = translateResponse({
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":["ls"]}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    const toolCall = res.output[0] as { type: string; action?: { type: string; command: string[] } };
    expect(toolCall.type).toBe('local_shell_call');
    expect(toolCall.action?.command).toEqual(['ls']);
  });

  it('handles empty usage in response', () => {
    const res = translateResponse({
      id: 'x',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hi' },
      }],
    });
    expect(res.usage.input_tokens).toBe(0);
    expect(res.usage.output_tokens).toBe(0);
  });

  it('handles arguments as object in tool call', () => {
    const res = translateResponse({
      id: 'chatcmpl-123',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: { q: 'test' } },
          }],
        },
      }],
    });
    const toolCall = res.output[0] as { arguments: string };
    expect(toolCall.arguments).toBe('{"q":"test"}');
  });

  it('handles tool call without name', () => {
    const res = translateResponse({
      id: 'x',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      }],
    });
    expect(res.output).toHaveLength(0);
  });
});

describe('openai translateStream edge cases', () => {
  it('handles empty stream', async () => {
    const stream = new ReadableStream({ start(c) { c.close(); } });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('handles stream with [DONE] signal', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const deltaEvent = events.find(e => e.type === 'response.output_text.delta');
    expect(deltaEvent).toBeDefined();
  });

  it('handles stream with tool calls', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: ${encodeSseEvent("done", "final")}\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const addEvent = events.find(e => e.type === 'response.output_item.added');
    expect(addEvent).toBeDefined();
  });

  it('handles stream with usage info', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":2}}}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const deltaEvent = events.find(e => e.type === 'response.output_text.delta');
    expect(deltaEvent).toBeDefined();
  });

  it('handles tool call with shell function', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"}}]}}]}\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const addEvent = events.find(e => e.type === 'response.output_item.added');
    expect(addEvent).toBeDefined();
  });
});
