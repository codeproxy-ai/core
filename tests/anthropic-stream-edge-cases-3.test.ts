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
});
