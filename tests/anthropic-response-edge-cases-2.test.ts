import { describe, expect, it } from 'vitest';
import { translateResponse } from '../src/translate/anthropic/translateResponse.js';

describe('anthropic translateResponse - edge cases', () => {
  it('handles content with only a _comment field', () => {
    const res = translateResponse({
      id: 'msg_comment',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: '_comment', text: 'skip me' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    // _comment blocks should be ignored
    expect(res.output.length).toBe(0);
  });

  it('handles missing id in body', () => {
    const res = translateResponse({
      id: undefined as unknown as string,
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(res.id).toBeTruthy();
  });

  it('handles tool_use with shell name', () => {
    const res = translateResponse({
      id: 'msg_sh',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'shell',
          input: { command: ['ls', '-la'] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const item = res.output[0] as { type: string; action?: { type: string; command: string[] } };
    expect(item.type).toBe('local_shell_call');
    expect(item.action?.command).toEqual(['ls', '-la']);
  });

  it('handles tool_use with container.exec name', () => {
    const res = translateResponse({
      id: 'msg_ce',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'container.exec',
          input: { command: ['pwd'] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const item = res.output[0] as { type: string };
    expect(item.type).toBe('local_shell_call');
  });

  it('handles tool_use with shell_command name', () => {
    const res = translateResponse({
      id: 'msg_sc',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        {
          type: 'tool_use',
          id: 'call_3',
          name: 'shell_command',
          input: { command: ['echo', 'hi'] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const item = res.output[0] as { type: string };
    expect(item.type).toBe('local_shell_call');
  });

  it('handles tool_use with non-shell name (function_call)', () => {
    const res = translateResponse({
      id: 'msg_fc',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        {
          type: 'tool_use',
          id: 'call_4',
          name: 'search',
          input: { q: 'test' },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const item = res.output[0] as { type: string };
    expect(item.type).toBe('function_call');
  });

  it('handles thinking block with empty thinking text', () => {
    const res = translateResponse({
      id: 'msg_th',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'thinking', thinking: '' }],
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const reasoningItem = res.output[0] as {
      type: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(reasoningItem.type).toBe('reasoning');
    expect(reasoningItem.content[0].text).toBe('');
  });

  it('combines multiple text chunks into one message', () => {
    const res = translateResponse({
      id: 'msg_mt',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const msg = res.output[0] as { type: string; content: Array<{ type: string; text: string }> };
    expect(msg.content[0].text).toBe('Hello world');
  });
});
