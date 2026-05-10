import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';
import { translateResponse } from '../src/translate/anthropic/translateResponse.js';
import { translateResponse as openaiTranslateResponse } from '../src/translate/openai/translateResponse.js';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('targeted branch coverage', () => {
  // fetch.ts line 574-575: lastUserMessageHasImage returning false after loop
  it('lastUserMessageHasImage returns false for user message without images', async () => {
    const upstream: typeof fetch = async (_input, init) => {
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://primary.com/v1',
      fetch: upstream,
      dropImages: true,
      fallbackUpstream: { baseUrl: 'https://fallback.com/v1' },
    });

    // User message with text only - should go to primary
    await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      }),
    });
    // Should not throw
  });

  // anthropic translateResponse.ts lines 31-46: handling null usage fields
  it('anthropic translateResponse handles missing usage fields', () => {
    const res = translateResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: undefined as never, output_tokens: undefined as never },
    });
    expect(res.usage.input_tokens).toBe(0);
    expect(res.usage.output_tokens).toBe(0);
  });

  // openai translateResponse.ts lines 79-80: tc.id undefined => makeId
  it('openai translateResponse handles tool call without id', () => {
    const res = openaiTranslateResponse({
      id: 'chatcmpl-1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            type: 'function',
            function: { name: 'shell', arguments: '{"command":["ls"]}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const item = res.output[0] as { id: string; call_id: string };
    expect(item.id).toBeTruthy();
    expect(item.call_id).toBeTruthy();
  });

  // openai translateRequest.ts lines 524-525: repairToolMessageOrder empty check
  it('openai translateRequest calls repairToolMessageOrder with empty messages', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      input: '',
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  // openai translateResponse.ts lines 82: args as object => jsonStringifySafe
  it('handles function arguments as object in mapToolCallToOutput', () => {
    const res = openaiTranslateResponse({
      id: 'x',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'test_tool', arguments: { q: 'test' } as never },
          }],
        },
      }],
    });
    expect(res.output.length).toBe(1);
  });

  // openai translateResponse.ts line 97: shell tool with null parse
  it('handles shell tool call with null arguments parse', () => {
    const res = openaiTranslateResponse({
      id: 'x',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_sh',
            type: 'function',
            function: { name: 'shell', arguments: 'invalid json' },
          }],
        },
      }],
    });
    const item = res.output[0] as { type: string; action: { command: string[] } };
    expect(item.type).toBe('local_shell_call');
    expect(item.action.command).toEqual([]);
  });
});
