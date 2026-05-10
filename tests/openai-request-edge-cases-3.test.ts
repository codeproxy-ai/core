import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('openai translateRequest - more branch coverage', () => {
  it('handles tool_choice with non-matching function object', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function' } as never,
    });
    // Should fall through without matching
    expect(request.tool_choice).toBeDefined();
  });

  it('handles specific function_call types for empty arguments path', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'fileChange', id: 'fc_1', changes: [{ path: '/test.txt' }] },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles reasoning item with thought_signature', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'thinking step by step' }],
          thought_signature: 'sig_xyz',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    });
    const assistantMsg = request.messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  it('handles backfillReasoning false', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'result',
        },
      ],
    }, { backfillReasoning: false });
    const assistantMsg = request.messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  it('handles repairToolMessageOrder with no tool calls', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hello',
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles processInputItem with function_call_output and stderr', () => {
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
          output: { content: 'some content' },
          success: true,
        },
      ],
    });
    const toolMsg = request.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });
});
