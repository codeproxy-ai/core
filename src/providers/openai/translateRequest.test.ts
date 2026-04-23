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
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: { name: 'my_tool', arguments: '{}' },
        },
      ],
    });
  });
});
