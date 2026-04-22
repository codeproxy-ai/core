import { describe, expect, it } from 'vitest';
import { translateResponse } from '../src/providers/claude/translateResponse.js';

describe('translateResponse (Anthropic -> Responses)', () => {
  it('maps text + tool_use into output items', () => {
    const res = translateResponse({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'foo' } },
      ],
      usage: { input_tokens: 10, output_tokens: 3 },
    });

    expect(res.status).toBe('completed');
    expect(res.usage).toMatchObject({ input_tokens: 10, output_tokens: 3, total_tokens: 13 });

    const toolCall = res.output.find((o) => (o as { type: string }).type === 'function_call');
    expect(toolCall).toBeDefined();
    expect((toolCall as { name: string }).name).toBe('search');
    expect((toolCall as { arguments: string }).arguments).toBe('{"q":"foo"}');

    const message = res.output.find((o) => (o as { type: string }).type === 'message');
    expect(message).toBeDefined();
  });

  it('promotes shell tool_use to local_shell_call', () => {
    const res = translateResponse({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        { type: 'tool_use', id: 'c', name: 'shell', input: { command: ['ls', '-la'] } },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const item = res.output[0] as { type: string; action?: { command: string[] } };
    expect(item.type).toBe('local_shell_call');
    expect(item.action?.command).toEqual(['ls', '-la']);
  });
});
