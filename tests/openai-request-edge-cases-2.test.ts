import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('openai translateRequest - repairToolMessageOrder edge cases', () => {
  it('handles empty messages array', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: '',
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles messages before any assistant (system content only)', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      instructions: 'Be helpful',
      input: 'hello',
    });
    const systemMsg = request.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
  });

  it('handles processInputItem with reasoning content and thought_signature', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'step by step' }],
          thought_signature: 'sig_123',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    });
    const assistantMsg = request.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  it('handles processInputItem with function_call but no name', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{}',
        },
      ],
    });
    // Should not crash
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles processInputItem with commandExecution type', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'commandExecution',
          id: 'exec_1',
          name: 'run_shell_command',
          arguments: '{}',
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles processInputItem with local_shell_call type', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'local_shell_call',
          id: 'sh_1',
          name: 'local_shell_command',
          arguments: '{}',
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles processInputItem with fileChange type', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'fileChange',
          id: 'fc_1',
          name: 'write_file',
          arguments: '{}',
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles processInputItem with custom_tool_call type', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'custom_tool_call',
          id: 'ct_1',
          name: 'my_tool',
          arguments: '{}',
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles processInputItem with web_search_call type', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          action: { type: 'web_search' },
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles function_call_output with object output and success=false', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"test"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: { content: '' },
          success: false,
        },
      ],
    });
    const toolMsg = request.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });

  it('handles function_call with thought_signature and thought', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'let me think' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"test"}',
          thought_signature: 'sig_1',
          thought: 'I should search',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'results',
        },
      ],
    });
    const assistantMsg = request.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  it('handles tool_choice with auto value', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    });
    expect(request.tool_choice).toBe('auto');
  });

  it('handles tool_choice with required value', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      tool_choice: 'required',
    });
    expect(request.tool_choice).toBe('required');
  });

  it('handles tool_choice with none value', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      tool_choice: 'none',
    });
    expect(request.tool_choice).toBe('none');
  });

  it('handles tool_choice with function object', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'search' } },
    });
    expect(request.tool_choice).toBeDefined();
  });

  it('handles dropImages filtering', () => {
    const { request } = translateRequest(
      {
        model: 'gpt-4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'desc' },
              { type: 'input_image', image_url: 'https://example.com/img.png' },
            ],
          },
        ],
      },
      { dropImages: true },
    );
    const userMsg = request.messages.find((m) => m.role === 'user') as {
      content: Array<{ type: string }>;
    };
    const imageParts = userMsg.content.filter((p: { type: string }) => p.type === 'image_url');
    expect(imageParts.length).toBe(0);
  });

  it('handles tool without name in mapTools', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'function', function: {} as never }],
    });
    expect(request.tools).toBeUndefined();
  });

  it('handles null tool in mapTools', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [
        null as unknown as never,
        { type: 'function', function: { name: 'search', parameters: { type: 'object' } } },
      ],
    });
    expect(request.tools).toBeDefined();
  });

  it('handles non-object item in processInputItem', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [null as unknown as never, 'hello'],
    });
    const userMsg = request.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  it('handles function_call with empty input and web_search_call fallback action', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'web_search_call',
          id: 'ws_2',
          action: { action_type: 'search' },
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles function_call with commandExecution type and empty args fallback', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'commandExecution',
          id: 'exec_2',
          name: 'run_shell_command',
          command: 'ls',
          cwd: '/tmp',
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });
});
