import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';

describe('fetch - streaming SSE, cache stats, and error edge cases', () => {
  it('handles streaming response with cache stats collection', async () => {
    const encoder = new TextEncoder();
    let capturedStats: unknown = null;

    const upstream: typeof fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          const events = [
            { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
            { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
          ];
          for (const e of events) {
            c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
          }
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      onCacheStats: (stats) => { capturedStats = stats; },
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi', stream: true }),
    });

    const reader = res.body?.getReader();
    if (reader) {
      while (true) { const { done } = await reader.read(); if (done) break; }
    }

    expect(capturedStats).not.toBeNull();
  });

  it('handles streaming response without upstream body (502)', async () => {
    const upstream: typeof fetch = async () => {
      return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi', stream: true }),
    });

    expect(res.status).toBe(502);
  });

  it('handles format inference from baseUrl with openai-chat path', async () => {
    let capturedUrl = '';
    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
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
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      fetch: upstream,
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi' }),
    });

    expect(capturedUrl).toContain('chat/completions');
  });

  it('handles unsupported upstream format throws error', () => {
    expect(() => createResponsesFetch({
      upstreamFormat: 'unknown' as never,
      baseUrl: 'https://test.com',
    })).toThrow('Unsupported upstream format');
  });

  it('handles missing baseUrl throws error', () => {
    expect(() => createResponsesFetch({
      baseUrl: '',
    })).toThrow('baseUrl is required');
  });

  it('handles non-array input with null/undefined items in lastUserMessageHasImage', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://primary.com/v1',
      fetch: upstream,
      dropImages: true,
      fallbackUpstream: { baseUrl: 'https://fallback.com/v1' },
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        input: [
          null,
          { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'skip' }] },
        ],
      }),
    });

    const parsedBody = JSON.parse(capturedBody);
    expect(parsedBody.model).toBe('claude');
  });

  it('handles input with non-array input in lastUserMessageHasImage', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://primary.com/v1',
      fetch: upstream,
      dropImages: true,
      fallbackUpstream: { baseUrl: 'https://fallback.com/v1' },
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'plain text' }),
    });

    const parsedBody = JSON.parse(capturedBody);
    expect(parsedBody.model).toBe('claude');
  });

  it('handles openai-chat streaming response with usage', async () => {
    const encoder = new TextEncoder();
    const upstream: typeof fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8,"prompt_tokens_details":{"cached_tokens":2}}}\n\n'));
          c.enqueue(encoder.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi', stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('handles anthropic non-streaming response with cache stats', async () => {
    let capturedStats: unknown = null;

    const upstream: typeof fetch = async () => {
      return new Response(JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      onCacheStats: (stats) => { capturedStats = stats; },
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    expect(capturedStats).not.toBeNull();
  });

  it('handles openai-chat non-streaming response with cache stats', async () => {
    let capturedStats: unknown = null;

    const upstream: typeof fetch = async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      fetch: upstream,
      onCacheStats: (stats) => { capturedStats = stats; },
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi' }),
    });

    expect(capturedStats).not.toBeNull();
  });
});
