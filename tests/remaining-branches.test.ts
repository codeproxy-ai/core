import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';

describe('remaining branches', () => {
  it('handles cache stats from streaming anthropic response with onCacheStats', async () => {
    const encoder = new TextEncoder();
    let capturedStats: unknown = null;

    const upstream: typeof fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":3,"cache_read_input_tokens":2,"output_tokens":0}}}\n\n',
            ),
          );
          c.enqueue(
            encoder.encode(
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            ),
          );
          c.enqueue(
            encoder.encode(
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
            ),
          );
          c.enqueue(
            encoder.encode(
              'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n',
            ),
          );
          c.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      onCacheStats: (stats) => {
        capturedStats = stats;
      },
    });

    const res = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi', stream: true }),
    });

    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) {
          break;
        }
      }
    }

    expect(capturedStats).not.toBeNull();
  });

  it('handles anthropic thinking effort minimal', async () => {
    const upstream: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: 'msg_m',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      reasoning_effort: 'minimal',
    });

    const res = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });
    expect(res.status).toBe(200);
  });

  it('handles anthropic thinking effort xhigh', async () => {
    const upstream: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      reasoning_effort: 'xhigh',
    });

    await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });
  });

  it('handles anthropic thinking override', async () => {
    const upstream: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: 'msg_t',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });
  });

  it('handles baseUrl with various path patterns for normalization', async () => {
    let capturedUrl = '';
    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    // anthropic with /v1/messages already
    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
  });
});
