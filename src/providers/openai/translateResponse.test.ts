import { describe, it, expect } from 'vitest';
import { translateResponse } from './translateResponse.js';

describe('OpenAI translateResponse', () => {
  it('should translate simple text response', () => {
    const result = translateResponse({
      id: 'chat-123',
      model: 'gpt-4',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hello, world!',
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
      },
    });

    expect(result).toMatchObject({
      id: 'chat-123',
      object: 'response',
      model: 'gpt-4',
      status: 'completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    });

    expect(result.output).toHaveLength(1);
    expect(result.output?.[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello, world!' }],
    });
  });

  it('should translate response with tool calls', () => {
    const result = translateResponse({
      id: 'chat-123',
      model: 'gpt-4',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"NYC"}',
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.output).toHaveLength(1);
    expect(result.output?.[0]).toMatchObject({
      id: 'call_123',
      type: 'function_call',
      status: 'completed',
      name: 'get_weather',
      arguments: '{"location":"NYC"}',
      call_id: 'call_123',
    });
  });

  it('should translate response with both text and tool calls', () => {
    const result = translateResponse({
      id: 'chat-123',
      model: 'gpt-4',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will help you',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{}',
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.output).toHaveLength(2);
    expect(result.output?.[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'I will help you' }],
    });
    expect(result.output?.[1]).toMatchObject({
      type: 'function_call',
      name: 'get_weather',
    });
  });

  it('should handle empty usage', () => {
    const result = translateResponse({
      id: 'chat-123',
      model: 'gpt-4',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Test',
          },
        },
      ],
    });

    expect(result.usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });
});
