import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('translateRequest (Responses -> Zai)', () => {
  it('maps simple string input + instructions', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      instructions: 'You are helpful.',
      input: 'Hello',
    }, { defaultMaxTokens: 4096 });
    expect(request.model).toBe('zai-gpt-4');
    expect(request.messages[0]).toMatchObject({ role: 'system', content: 'You are helpful.' });
    expect(request.messages[1]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(request.max_tokens).toBe(4096);
  });

  it('handles structured input items with tool calls and outputs', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'sure' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"command":["ls"]}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'file.txt',
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'shell', description: 'run', parameters: { type: 'object' } },
        },
      ],
    }, { defaultMaxTokens: 4096 });

    expect(request.messages.length).toBeGreaterThanOrEqual(3);
    expect(request.messages[0]).toMatchObject({ role: 'user' });
    expect(request.messages[1]).toMatchObject({ role: 'assistant', content: 'sure' });
    expect(request.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file.txt' });
  });

  it('backfills empty reasoning_content on assistant tool-call messages without prior reasoning', () => {
    const { request } = translateRequest({
      model: 'glm-4.6',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
    });
    const assistant = request.messages.find(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length,
    );
    expect(assistant).toBeDefined();
    expect(assistant!.reasoning_content).toBe('.');
  });

  it('preserves existing reasoning_content on assistant tool-call messages', () => {
    const { request } = translateRequest({
      model: 'glm-4.6',
      input: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking...' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
      ],
    });
    const assistant = request.messages.find(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length,
    );
    expect(assistant!.reasoning_content).toBe('thinking...');
  });

  it('maps temperature and top_p', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
      temperature: 0.7,
      top_p: 0.9,
    }, { defaultMaxTokens: 4096 });
    expect(request.temperature).toBe(0.7);
    expect(request.top_p).toBe(0.9);
  });

  it('maps max_output_tokens and max_tokens', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
      max_output_tokens: 1000,
    });
    expect(request.max_tokens).toBe(1000);
  });

  it('handles tool_choice auto', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }, { defaultMaxTokens: 4096 });
    expect(request.tools).toBeDefined();
    expect(request.tool_choice).toBe('auto');
  });

  it('handles tool_choice required', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
      tool_choice: 'required',
    }, { defaultMaxTokens: 4096 });
    expect(request.tool_choice).toBe('required');
  });

  it('handles tool_choice none', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
      tool_choice: 'none',
    }, { defaultMaxTokens: 4096 });
    expect(request.tool_choice).toBe('none');
  });

  it('handles tool_choice with specific function', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'shell' } },
    }, { defaultMaxTokens: 4096 });
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'shell' } });
  });

  it('uses default max_tokens when not provided', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
    }, { defaultMaxTokens: 4096 });
    expect(request.max_tokens).toBe(4096);
  });

  it('handles array of strings as input', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: ['hello', 'world'],
    }, { defaultMaxTokens: 4096 });
    expect(request.messages.length).toBe(2);
    expect(request.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(request.messages[1]).toMatchObject({ role: 'user', content: 'world' });
  });
});
