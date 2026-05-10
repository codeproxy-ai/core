import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/anthropic/translateRequest.js';

describe('anthropic translateRequest - node filtering and empty content', () => {
  it('handles non-object filter in sanitizeMessages', () => {
    // This hits the !block || typeof block !== 'object' check returning false
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }, null as never],
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles block with type text and empty text in sanitizeMessages', () => {
    // This hits the block.type === 'text' && !block.text check returning false
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: '' }],
        },
      ],
    });
    // The empty text block should be filtered, but the user message with no valid
    // content and no text string fallback means ensureEndsWithUser adds default
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles string content without text in sanitizeMessages', () => {
    // This hits the typeof msg.content === 'string' && msg.content branch
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });
});
