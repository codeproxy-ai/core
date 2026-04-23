import { describe, it, expect } from 'vitest';
import { translateRequest } from './translateRequest.js';

describe('OpenAI translateRequest', () => {
  it('should translate simple text request', () => {
    const result = translateRequest({
      model: 'gpt-4',
      input: 'Hello, world!',
    });

    expect(result.request).toEqual({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello, world!' }],
    });
  });

  it('should translate request with instructions', () => {
    const result = translateRequest({
      model: 'gpt-4',
      instructions: 'You are a helpful assistant.',
      input: 'Hello!',
    });

    expect(result.request.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ]);
  });

  it('should translate request with tools', () => {
    const result = translateRequest({
      model: 'gpt-4',
      input: 'What is the weather?',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather info',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' },
              },
            },
          },
        },
      ],
    });

    expect(result.request.tools).toHaveLength(1);
    expect(result.request.tools?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather info',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
        },
      },
    });
  });

  it('should translate request with temperature', () => {
    const result = translateRequest({
      model: 'gpt-4',
      input: 'Hello!',
      temperature: 0.7,
    });

    expect(result.request.temperature).toBe(0.7);
  });

  it('should translate request with max tokens', () => {
    const result = translateRequest({
      model: 'gpt-4',
      input: 'Hello!',
      max_output_tokens: 1000,
    });

    expect(result.request.max_tokens).toBe(1000);
  });

  it('should translate array input with messages', () => {
    const result = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'message', role: 'user', content: 'First' },
        { type: 'message', role: 'assistant', content: 'Response' },
        { type: 'message', role: 'user', content: 'Second' },
      ],
    });

    expect(result.request.messages).toHaveLength(3);
    expect(result.request.messages?.[0]).toEqual({ role: 'user', content: 'First' });
    expect(result.request.messages?.[1]).toEqual({ role: 'assistant', content: 'Response' });
    expect(result.request.messages?.[2]).toEqual({ role: 'user', content: 'Second' });
  });

  it('should handle tool calls in input', () => {
    const result = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'message', role: 'user', content: 'Use a tool' },
        { type: 'message', role: 'assistant', content: 'Thinking...' },
        {
          type: 'function_call',
          name: 'my_tool',
          arguments: '{"param": "value"}',
          call_id: 'call_123',
        },
      ],
    });

    expect(result.request.messages).toHaveLength(2);
    expect(result.request.messages?.[0]).toEqual({ role: 'user', content: 'Use a tool' });
    expect(result.request.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'Thinking...',
      reasoning_content: '.',
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: { name: 'my_tool', arguments: '{"param": "value"}' },
        },
      ],
    });
  });

  it('should create assistant message for function call without prior assistant', () => {
    const result = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'message', role: 'user', content: 'Use a tool' },
        {
          type: 'function_call',
          name: 'my_tool',
          arguments: '{}',
          call_id: 'call_123',
        },
      ],
    });

    expect(result.request.messages).toHaveLength(2);
    expect(result.request.messages?.[0]).toEqual({ role: 'user', content: 'Use a tool' });
    expect(result.request.messages?.[1]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: '.',
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: { name: 'my_tool', arguments: '{}' },
        },
      ],
    });
  });

  it('should backfill empty reasoning_content on assistant tool-call messages', () => {
    const result = translateRequest({
      model: 'kimi-k2.6',
      input: [
        { type: 'message', role: 'user', content: 'go' },
        { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c2' },
      ],
    });
    const assistants = result.request.messages.filter(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length,
    );
    expect(assistants.length).toBe(2);
    for (const a of assistants) expect(a.reasoning_content).toBe('.');
  });

  it('backfills reasoning_content with a non-empty placeholder so thinking-enabled upstreams accept it', () => {
    // Regression: aihubmix-routed glm-4.6 rejects assistant tool-call messages
    // when reasoning_content is missing OR an empty string. Codex clients with
    // store:false never echo reasoning items back, so we must supply a
    // non-empty placeholder — not just an empty string.
    const result = translateRequest({
      model: 'glm-4.6',
      input: [
        { type: 'message', role: 'user', content: 'go' },
        { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' },
      ],
    });
    const assistant = result.request.messages.find(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length,
    );
    expect(assistant).toBeDefined();
    expect(typeof assistant!.reasoning_content).toBe('string');
    expect(assistant!.reasoning_content).not.toBe('');
    expect((assistant!.reasoning_content as string).length).toBeGreaterThan(0);
  });
});
