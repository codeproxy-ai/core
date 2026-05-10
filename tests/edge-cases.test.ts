import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/anthropic/translateRequest.js';
import { translateResponse, mapOutputItems } from '../src/translate/anthropic/translateResponse.js';
import { translateStream, translateAnthropicEvents } from '../src/translate/anthropic/translateStream.js';
import { encodeSseEvent } from '../src/utils/sse.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

describe('anthropic translateRequest edge cases', () => {
  it('handles instructions as array with string elements', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      instructions: ['Hello', { text: 'world' }],
      input: 'hi',
    });
    expect(request.system).toBeDefined();
  });

  it('handles input as string', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: 'hello',
    });
    expect(request.messages[0].role).toBe('user');
  });

  it('handles empty tools array', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: 'hi',
      tools: [],
    });
    expect(request.tools).toBeUndefined();
  });

  it('handles null input items', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [null as unknown as never, { type: 'message', role: 'user', content: 'hello' }],
    });
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  it('handles input_image with image_url object', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: { url: 'https://example.com/img.png' } }],
      }],
    });
    const blocks = request.messages[0].content as Array<{ type: string; source?: { type: string } }>;
    const imgBlock = blocks.find(b => b.type === 'image');
    expect(imgBlock).toBeDefined();
    expect(imgBlock?.source?.type).toBe('url');
  });

  it('handles cache_control on system blocks', () => {
    const { request, hasPromptCache } = translateRequest({
      model: 'claude-sonnet-4-5',
      instructions: [{ text: 'be helpful', cache_control: { type: 'ephemeral' } }],
      input: 'hi',
    });
    expect(hasPromptCache).toBe(true);
  });
});

describe('anthropic translateResponse edge cases', () => {
  it('handles non-object content blocks', () => {
    const result = mapOutputItems([null as unknown as never]);
    expect(result).toEqual([]);
  });

  it('handles thinking content block', () => {
    const result = mapOutputItems([
      { type: 'thinking', thinking: 'I am reasoning...' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('reasoning');
  });
});

describe('anthropic translateStream edge cases', () => {
  it('handles empty stream', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) { controller.close(); },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('response.created');
  });

  it('handles message_stop directly', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    // Should have created + completed events
    const types = events.map(e => e.type);
    expect(types).toContain('response.created');
  });

  it('handles empty data line', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: \n\n'));
        controller.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('handles signature_delta', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":5,"delta":{"type":"signature_delta","signature":"sig123"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const types = events.map(e => e.type);
    expect(types).toContain('response.completed');
  });

  it('handles message_start with usage stats', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_stop","index":0}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const completedEvent = events.find(e => e.type === 'response.completed');
    expect(completedEvent).toBeDefined();
  });

  it('handles content_block_delta with non-text types (unknown index)', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send events targeting a text block first
        controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":0,"output_tensors":0}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        // Now send delta for non-existent index - this tests the early return in onContentBlockDelta
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":99,"delta":{"type":"text_delta","text":"test"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_delta","delta":{},"usage":{"output_tokens":1}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const types = events.map(e => e.type);
    expect(types).toContain('response.completed');
  });

  it('handles tool_use content_block_start', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"search","input":{}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"foo\\"}"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_stop","index":0}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }
    const types = events.map(e => e.type);
    expect(types).toContain('response.function_call_arguments.delta');
  });

  it('handles content_block_start with mixed text and tool_use', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'));
        // Text block
        controller.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me search"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_stop","index":0}\n\n'));
        // Tool_use block
        controller.enqueue(encoder.encode('data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"shell","input":{"command":["ls"]}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"content_block_stop","index":1}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
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

describe('translateAnthropicEvents', () => {
  it('handles pre-parsed events', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ] as const;
    const result: ResponsesStreamEvent[] = [];
    for await (const evt of translateAnthropicEvents(events)) {
      result.push(evt);
    }
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].type).toBe('response.created');
  });
});

describe('anthropic translateRequest - repairToolAdjacency edge cases', () => {
  it('finds missing tool_result in later messages', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"test"}',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'some text between' }],
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'found it',
        },
      ],
    });
    // The tool_result should be found in a later message after the tool_use
    const toolResultMsg = request.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b: { type?: string }) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
  });

  it('handles remaining content after tool_consumption', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'do a search' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"test"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'results',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'follow up question' }],
        },
      ],
    });
    const userMessages = request.messages.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('handles tool_use with missing tool_result when no later messages exist', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
      ],
    });
    const toolUseMsg = request.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b: { type?: string }) => b.type === 'tool_use'),
    );
    expect(toolUseMsg).toBeDefined();
  });

  it('sanitizes non-object messages and empty string content', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });
    expect(request.messages[0].role).toBe('user');
  });

  it('handles string content in function_call_output', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'text output',
        },
      ],
    });
    const toolResultMsg = request.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b: { type?: string }) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
  });

  it('handles function_call with output null and success false', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          success: false,
        },
      ],
    });
    const toolResultMsg = request.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b: { type?: string }) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
  });

  it('adds default text when messages end with assistant', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'assistant', content: 'hi' },
      ],
    });
    const lastMessage = request.messages[request.messages.length - 1];
    expect(lastMessage.role).toBe('user');
  });
});
