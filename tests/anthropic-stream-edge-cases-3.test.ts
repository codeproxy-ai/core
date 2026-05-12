import { describe, expect, it } from 'vitest';
import { translateAnthropicEvents } from '../src/translate/anthropic/translateStream.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';
import type { AnthropicStreamEvent } from '../src/types/anthropic.js';

describe('anthropic translateStream - finalize with duplicate output', () => {
  it('handles finalize with textItem and block with same index', async () => {
    // Blocks with same output index - one should be skipped in finalize
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
      { type: 'content_block_start' as const, index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta' as const,
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      { type: 'content_block_stop' as const, index: 0 },
      {
        type: 'message_delta' as const,
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' as const },
    ];
    const result: ResponsesStreamEvent[] = [];
    for await (const evt of translateAnthropicEvents(events)) {
      result.push(evt);
    }
    const completed = result.find((e) => e.type === 'response.completed');
    expect(completed).toBeDefined();
  });

  it('writes accumulated textBuffer to textItem content in finalize', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start' as const,
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: 'content_block_start' as const, index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta' as const,
        index: 0,
        delta: { type: 'text_delta', text: 'Hi! How can I help?' },
      },
      { type: 'content_block_stop' as const, index: 0 },
      {
        type: 'message_delta' as const,
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 6 },
      },
      { type: 'message_stop' as const },
    ];
    const result: ResponsesStreamEvent[] = [];
    for await (const evt of translateAnthropicEvents(events)) {
      result.push(evt);
    }

    // response.output_item.done should have completed status and full text
    const doneEvent = result.find((e) => e.type === 'response.output_item.done');
    expect(doneEvent).toBeDefined();
    const doneItem = (doneEvent as Record<string, unknown>)?.item as Record<string, unknown>;
    expect(doneItem.status).toBe('completed');
    const content = doneItem.content as Array<{ text: string }>;
    expect(content[0].text).toBe('Hi! How can I help?');
  });

  it('finalizes textItem status to completed', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start' as const,
        message: {
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: 'content_block_start' as const, index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta' as const,
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      },
      { type: 'content_block_stop' as const, index: 0 },
      {
        type: 'message_delta' as const,
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' as const },
    ];
    const result: ResponsesStreamEvent[] = [];
    for await (const evt of translateAnthropicEvents(events)) {
      result.push(evt);
    }

    // response.completed output item should have completed status and text
    const completed = result.find((e) => e.type === 'response.completed');
    expect(completed).toBeDefined();
    const resp = (completed as Record<string, unknown>)?.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output[0].status).toBe('completed');
    const content = output[0].content as Array<{ text: string }>;
    expect(content[0].text).toBe('ok');
  });
});
