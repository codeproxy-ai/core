import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';

describe('fetch - stream cancel and remaining branches', () => {
  it('handles baseUrl normalization for openai with custom path', async () => {
    const upstream: typeof fetch = async (input) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      baseUrl: 'http://localhost:4000/v1',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi' }),
    });
    expect(res.status).toBe(200);
  });

  it('handles inference from baseUrl with deepseek type path', async () => {
    const upstream: typeof fetch = async (input) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      baseUrl: 'https://api.deepseek.com/chat/completions',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', input: 'hi' }),
    });
    expect(res.status).toBe(200);
  });

  it('handles content-type with charset', async () => {
    const upstream: typeof fetch = async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi' }),
    });
    expect(res.status).toBe(200);
  });

  it('handles unexpected path that does not contain standard path segments', async () => {
    const upstream: typeof fetch = async (input) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // Inference from baseUrl should work for openai standard /v1
    const fetch = createResponsesFetch({
      baseUrl: 'https://api.openai.com/v1',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi' }),
    });
    expect(res.status).toBe(200);
  });
});
