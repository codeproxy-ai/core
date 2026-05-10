import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';

describe('fetch additional edge cases', () => {
  it('handles streaming response with cache stats via onCacheStats', async () => {
    const encoder = new TextEncoder();
    let capturedStats: unknown = null;

    const upstream: typeof fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
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

    // Consume the stream to trigger cache stats
    const reader = res.body?.getReader();
    if (reader) {
      while (true) { const { done } = await reader.read(); if (done) break; }
    }

    expect(capturedStats).not.toBeNull();
  });

  it('handles streaming response with fallback upstream', async () => {
    const encoder = new TextEncoder();
    const upstream: typeof fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://fallback.com/v1',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi', stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('handles upstream error response', async () => {
    const upstream: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit_error' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
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

    expect(res.status).toBe(429);
  });

  it('handles model with defaultHeaders containing authorization', async () => {
    let capturedAuth: string | undefined;

    const upstream: typeof fetch = async (_input, init) => {
      const hdrs = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      capturedAuth = hdrs['authorization'];
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      fetch: upstream,
      defaultHeaders: { authorization: 'Bearer default-key' },
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'hi' }),
    });

    expect(capturedAuth).toBe('Bearer default-key');
  });

  it('handles anthropic with overridden apiVersion', async () => {
    let capturedVersion: string | undefined;

    const upstream: typeof fetch = async (_input, init) => {
      const hdrs = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      capturedVersion = hdrs['anthropic-version'];
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      apiVersion: '2024-01-01',
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    expect(capturedVersion).toBe('2024-01-01');
  });

  it('detects images in input', async () => {
    let capturedUrl = '';

    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://primary.com/v1',
      fetch: upstream,
      dropImages: true,
      fallbackUpstream: { baseUrl: 'https://vision.com/v1', upstreamFormat: 'openai-chat' },
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'desc' },
            { type: 'input_image', image_url: 'https://example.com/img.png' },
          ],
        }],
      }),
    });

    expect(capturedUrl).toContain('vision.com');
  });

  it('handles content-type inference from anthropic baseUrl', async () => {
    let capturedUrl = '';

    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // No explicit upstreamFormat - should infer from baseUrl
    const fetch = createResponsesFetch({
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hello' }),
    });

    expect(capturedUrl).toContain('anthropic');
  });
});
