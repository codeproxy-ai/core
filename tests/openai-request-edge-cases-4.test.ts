import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('openai translateRequest - repairToolMessageOrder edge', () => {
  it('handles empty messages in repairToolMessageOrder', () => {
    // Input with empty string means no items, hits early return
    const { request } = translateRequest({
      model: 'gpt-4',
      input: '',
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles processInputItem with function_call and thought', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"test"}', thought: 'I should search' },
        { type: 'function_call_output', call_id: 'call_1', output: 'results' },
      ],
    });
    const assistantMsg = request.messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  it('handles function_call_output with array output and text parts', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'text', text: 'result' }] },
      ],
    });
    const toolMsg = request.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });

  it('handles instructions as non-array, non-string value', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      instructions: true as never,
      input: 'hi',
    });
    expect(request.messages[0].role).toBe('user');
  });
});
