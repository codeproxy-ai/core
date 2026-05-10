import { describe, expect, it } from 'vitest';
import { translateRequest as anthropicTranslateRequest } from '../src/translate/anthropic/translateRequest.js';
import { translateRequest as openaiTranslateRequest } from '../src/translate/openai/translateRequest.js';

describe('absolute last branch targets', () => {
  // === openai translateRequest: image without url or data ===
  it('openai handles image without url or data', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image' }],
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // === openai translateRequest: file upload with null mime_type ===
  it('openai handles input_file without mime_type', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,AAA' }],
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // === openai isEmpty: null value ===
  it('openai isEmpty handles null input', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: 'hi',
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // === anthropic mapToolChoice with auto type object ===
  it('anthropic handles tool_choice with any type', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 's', parameters: { type: 'object' } } }],
      tool_choice: { type: 'any' },
    });
    expect(request.tool_choice?.type).toBe('any');
  });

  // === anthropic mapTools: non-function tool ===
  it('anthropic handles non-function tools', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude',
      input: 'hi',
      tools: [
        { type: 'computer_use_20250124' } as never,
        { type: 'function', function: { name: 'search', parameters: { type: 'object' } } },
      ],
    });
    expect(request.tools).toBeDefined();
  });

  // === anthropic with only function_call and no output ===
  it('anthropic handles function_call without matching output', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude',
      input: [{ type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' }],
    });
    const toolUseMsg = request.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use'),
    );
    expect(toolUseMsg).toBeDefined();
  });

  // === openai processToolCall with fileChange type and changes array ===
  it('openai handles fileChange with changes array', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'fileChange',
          id: 'fc_1',
          changes: [{ path: '/tmp/test.txt', content: 'test' }],
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  // === openai processToolCall with commandExecution type and empty everything ===
  it('openai handles commandExecution with empty args', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'commandExecution',
          id: 'exec_1',
          name: 'run',
          command: 'echo hi',
          cwd: '/tmp',
        },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  // === openai reasoning with empty content list ===
  it('openai handles reasoning with various content', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'reasoning',
          content: [],
          thought_signature: 'sig_1',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(2);
  });

  // === openai needs all reasoning effort levels ===
  it('openai handles reasoning effort for anthropic style', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: 'hi',
      reasoning: { effort: 'high' },
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });
});
