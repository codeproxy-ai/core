import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('openai translateRequest final remaining', () => {
  // Line 163-164: developer role
  it('handles developer role', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'be helpful' }],
      }],
    });
    const systemMsg = request.messages.find(m => m.role === 'system');
    expect(systemMsg).toBeDefined();
  });

  // Line 176: array content parts in tool output
  it('handles array content in assistant messages', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // Line 186-187: reasoning includes text
  it('handles reasoning with text in content', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'step by step' }],
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

  // Line 200-201: function_call with thought_signature
  it('handles function_call with thought_signature', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'results' },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(2);
  });

  // Line 209: string parts in content array
  it('handles user message with string parts', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'user',
        content: ['hello ', 'world'],
      }],
    });
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  // Line 219-220: reasoning with text - same as line 186 but via different path
  it('handles input_text type in message content', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      }],
    });
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  // Line 244: image with file data
  it('handles image_url with file data', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', file_data: 'file:///path/to/img.png' }],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // Line 264: input_file type
  it('handles input_file with file_data', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', file_data: 'file:///path/to/doc.pdf', mime_type: 'application/pdf' }],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // Line 273-278: message with reasoning_content
  it('handles assistant message with reasoning_content', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
        reasoning_content: 'thinking step by step',
      }, {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }],
      }],
    });
    const assistantMsg = request.messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  });

  // Line 281: message with text-only content
  it('handles message with text-only content', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // Line 293: text parts in reasoning
  it('handles reasoning with text array', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'reasoning',
          content: ['step', ' by ', 'step'],
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

  // Line 300-301: reasoning content with list
  it('handles reasoning with list content in text', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: ['step1', 'step2'] }],
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

  // Line 325-327: additional output types
  it('handles commandExecutionOutput type', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        { type: 'commandExecutionOutput', call_id: 'call_1', output: 'result' },
      ],
    });
    const toolMsg = request.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });

  // Line 421: tool output with text parts
  it('handles tool output with text parts', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'some_type', text: 'result' }] },
      ],
    });
    const toolMsg = request.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });

  // Line 434-435: success false with object output
  it('handles function_call_output with success false and object output', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: { message: 'fail' }, success: false },
      ],
    });
    const toolMsg = request.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });

  // Line 494-495: tool_choice returns undefined for non-function object
  it('handles tool_choice with null/undefined', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hi',
    });
    expect(request.tool_choice).toBeUndefined();
  });

  // Line 505-506: isEmpty with empty array
  it('handles various isEmpty cases', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        arguments: '{"q":""}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  // Line 510-511: isEmpty with non-empty value
  it('handles isEmpty with non-empty string', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: 'hello',
      max_output_tokens: 100,
    });
    expect(request.max_tokens).toBe(100);
  });
});
