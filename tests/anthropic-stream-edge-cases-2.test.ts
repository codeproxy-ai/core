import { describe, expect, it } from 'vitest';
import {
  translateStream,
  translateAnthropicEvents,
} from '../src/translate/anthropic/translateStream.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';
import type { AnthropicStreamEvent } from '../src/types/anthropic.js';

describe('anthropic translateStream - thinking_delta and input_json_delta edge cases', () => {
  it('handles thinking_delta with empty text', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'I am thinking' },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 10 },
          },
          { type: 'message_stop' },
        ];
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
    const results: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      results.push(evt);
    }
    const reasoningEvents = results.filter((e) => e.type === 'response.reasoning_text.delta');
    expect(reasoningEvents.length).toBe(1);
    const delta = reasoningEvents[0] as { delta?: string };
    expect(delta.delta).toBe('I am thinking');
  });

  it('handles input_json_delta with empty partial', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'search', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"q":"test"}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ];
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
    const results: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      results.push(evt);
    }
    const argEvents = results.filter((e) => e.type === 'response.function_call_arguments.delta');
    expect(argEvents.length).toBe(1);
  });

  it('handles tool_use with shell name', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_sh', name: 'shell', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"command":["ls"]}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ];
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
    const results: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      results.push(evt);
    }
    const doneEvents = results.filter((e) => e.type === 'response.output_item.done');
    expect(doneEvents.length).toBe(1);
  });

  it('handles unknown content block type', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'unknown_block', data: 'test' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ];
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
    const results: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      results.push(evt);
    }
    const completed = results.find((e) => e.type === 'response.completed');
    expect(completed).toBeDefined();
  });

  it('handles content_block_delta for unknown block index', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 2 },
          },
          { type: 'message_stop' },
        ];
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
    const results: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      results.push(evt);
    }
    const completed = results.find((e) => e.type === 'response.completed');
    expect(completed).toBeDefined();
  });

  it('handles empty text_delta (should be skipped)', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 2 },
          },
          { type: 'message_stop' },
        ];
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
    const results: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      results.push(evt);
    }
    const textEvents = results.filter((e) => e.type === 'response.output_text.delta');
    expect(textEvents.length).toBe(1);
  });

  it('handles translateAnthropicEvents with thinking_delta', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start' as const,
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start' as const,
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta' as const,
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'thinking...' },
      },
      { type: 'content_block_stop' as const, index: 0 },
      { type: 'content_block_start' as const, index: 1, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta' as const,
        index: 1,
        delta: { type: 'text_delta', text: 'answer' },
      },
      {
        type: 'message_delta' as const,
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' as const },
    ];
    const result: ResponsesStreamEvent[] = [];
    for await (const evt of translateAnthropicEvents(events)) {
      result.push(evt);
    }
    const reasoningDeltas = result.filter((e) => e.type === 'response.reasoning_text.delta');
    expect(reasoningDeltas.length).toBe(1);
  });
});
