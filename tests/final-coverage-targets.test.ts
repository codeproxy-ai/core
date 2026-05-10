import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';
import { translateRequest as anthropicTranslateRequest } from '../src/translate/anthropic/translateRequest.js';
import { translateResponse as anthropicTranslateResponse } from '../src/translate/anthropic/translateResponse.js';
import { translateStream as anthropicTranslateStream, translateAnthropicEvents } from '../src/translate/anthropic/translateStream.js';
import { translateRequest as openaiTranslateRequest } from '../src/translate/openai/translateRequest.js';
import { translateResponse as openaiTranslateResponse } from '../src/translate/openai/translateResponse.js';
import { translateStream as openaiTranslateStream } from '../src/translate/openai/translateStream.js';
import type { AnthropicStreamEvent } from '../src/types/anthropic.js';

describe('final coverage targets', () => {

  // === anthropic translateRequest: system role, developer role ===
  it('handles developer role converted to system', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'be a system' }],
      }],
    });
    // Developer role content should be in system blocks
    expect(request.system).toBeDefined();
  });

  // === anthropic translateRequest: non-string content in system role ===
  it('handles system role with non-string content', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'system',
        content: '',
      }, {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // === anthropic translateRequest: message with string content ===
  it('handles user message with string content', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'user',
        content: 'just a string',
      }],
    });
    expect(request.messages[0].role).toBe('user');
  });

  // === anthropic translateRequest: input_file content type ===
  it('handles input_file content type', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', data: 'base64data', mime_type: 'application/pdf' }],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // === anthropic translateRequest: image with base64 data ===
  it('handles image with base64 data', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', data: 'base64imgdata' }],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  // === anthropic translateRequest: text_delta to content mapping ===
  it('handles message with function_call and output with array output content', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'text', text: 'result1' }, { type: 'text', text: 'result2' }],
        },
      ],
    });
    const toolResultMsg = request.messages.find(
      m => Array.isArray(m.content) && m.content.some(b => (b as any).type === 'tool_result')
    );
    expect(toolResultMsg).toBeDefined();
  });

  // === anthropic translateRequest: tool parameters mixing ===
  it('handles web_search_call tool and non-function tools', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: 'hi',
      tools: [
        { type: 'web_search_20250305' } as never,
        { type: 'function', function: { name: 'search', parameters: { type: 'object' } } },
      ],
    });
    expect(request.tools).toBeDefined();
  });

  // === anthropic translateRequest: message with output_text array content ===
  it('handles message with array content blocks', () => {
    const { request } = anthropicTranslateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      }],
    });
    expect(request.messages[0].role).toBe('user');
  });

  // === anthropic translateStream: default event handler ===
  it('grav default event in handleEvent', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"ping"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });
    const events: import('../src/types/responses.js').ResponsesStreamEvent[] = [];
    for await (const evt of anthropicTranslateStream(stream)) {
      events.push(evt);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  // === openai translateRequest: dropImages with image data ===
  it('openai translateRequest with dropImages and data URLs', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'desc' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        ],
      }],
    }, { dropImages: true });
    const userMsg = request.messages.find(m => m.role === 'user') as any;
    const imageParts = userMsg.content.filter((p: any) => p.type === 'image_url');
    expect(imageParts.length).toBe(0);
  });

  // === openai translateRequest: assistant with content and tool_calls ===
  it('handles assistant with mixed content and tool_calls', () => {
    const { request } = openaiTranslateRequest({
      model: 'gpt-4',
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Let me search' }],
        },
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'results' },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(2);
  });

  // === openai translateResponse: model override ===
  it('translateResponse with model override option', () => {
    const res = openaiTranslateResponse({
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }, { model: 'custom-model', responseId: 'resp_custom' });
    expect(res.model).toBe('custom-model');
    expect(res.id).toBe('resp_custom');
  });
});
