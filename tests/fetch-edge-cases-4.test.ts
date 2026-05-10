import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';

describe('fetch - remaining branch coverage', () => {
  it('handles inference from baseUrl with openai/v1 path', async () => {
    let capturedUrl = '';
    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetch = createResponsesFetch({
      baseUrl: 'https://api.openai.com/v1',
      fetch: upstream,
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi' }),
    });

    expect(capturedUrl).toContain('/v1/chat/completions');
  });

  it('handles baseUrl ending without /v1 path', async () => {
    let capturedUrl = '';
    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetch = createResponsesFetch({
      baseUrl: 'https://api.anthropic.com',
      fetch: upstream,
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    expect(capturedUrl).toContain('/v1/messages');
  });

  it('handles baseUrl already ending with /v1 for anthropic', async () => {
    let capturedUrl = '';
    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      fetch: upstream,
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    expect(capturedUrl).toContain('/v1/messages');
  });
});
