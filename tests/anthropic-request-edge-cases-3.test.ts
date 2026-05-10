import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/anthropic/translateRequest.js';

describe('anthropic translateRequest - more branch coverage', () => {
  it('handles filter of non-object blocks in sanitizeMessages', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [null, { type: 'text', text: 'hello' }, undefined, { type: 'text', text: '' }],
        },
      ],
    });
    // null/undefined blocks should be filtered out, empty text blocks also filtered
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  it('handles string content in messages', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
    const firstMsg = request.messages[0];
    expect(firstMsg.role).toBe('user');
  });

  it('handles custom_tool_call output type with a fileChange tool', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'fileChange',
        id: 'fc_1',
        name: 'write_file',
        arguments: '{"file_path":"test.txt","content":"hello"}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles instructions as array of strings only', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      instructions: ['Be', 'helpful'],
      input: 'hi',
    });
    expect(request.system).toBeDefined();
    if (request.system) {
      const firstBlock = request.system[0];
      expect(typeof firstBlock === 'string' ? firstBlock : firstBlock.text).toBe('Be');
    }
  });

  it('handles instructions as non-array non-string (should be ignored)', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      instructions: 123 as never,
      input: 'hi',
    });
    expect(request.system).toBeUndefined();
  });
});
