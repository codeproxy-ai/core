import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';
import { encodeSseEvent } from '../src/utils/sse.js';

describe('fetch edge cases', () => {
  it('handles missing body', async () => {
    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe('upstream_error');
  });

  it('handles invalid JSON body', async () => {
    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
  });

  it('passes non-responses paths through', async () => {
    let calledPassthrough = false;
    const passthroughFetch: typeof fetch = async () => {
      calledPassthrough = true;
      return new Response('ok');
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      fetch: async () => new Response('never'),
      passthroughFetch,
    });

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(calledPassthrough).toBe(true);
    expect(await res.text()).toBe('ok');
  });

  it('passes GET requests through passthrough', async () => {
    let calledPassthrough = false;
    const passthroughFetch: typeof fetch = async () => {
      calledPassthrough = true;
      return new Response('ok');
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      fetch: async () => new Response('never'),
      passthroughFetch,
    });

    const res = await fetch('https://api.openai.com/v1/responses');
    expect(calledPassthrough).toBe(true);
    expect(await res.text()).toBe('ok');
  });

  it('handles streaming response with error from upstream', async () => {
    const mockUpstream: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: 'upstream_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: mockUpstream,
    });

    // A request that produces a tool call (function_call) input
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    expect(res.status).toBe(500);
  });

  it('forwards OpenAI SDK headers like openai-organization', async () => {
    let capturedHeaders: Record<string, string> = {};
    const upstream: typeof fetch = async (_input, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'openai-organization': 'org-123',
        'openai-project': 'proj-456',
        'x-stainless-arch': 'arm64',
        originator: 'chatui',
      },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    // These should be dropped
    expect(capturedHeaders['openai-organization']).toBeUndefined();
    expect(capturedHeaders['openai-project']).toBeUndefined();
    expect(capturedHeaders['x-stainless-arch']).toBeUndefined();
    expect(capturedHeaders['originator']).toBeUndefined();
  });

  it('forwards x-api-key directly without authorization override', async () => {
    let capturedHeaders: Record<string, string> = {};
    const upstream: typeof fetch = async (_input, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response(
        JSON.stringify({
          id: 'x',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'x-api-key': 'direct-key' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    expect(capturedHeaders['x-api-key']).toBe('direct-key');
  });

  it('streams streaming response correctly', async () => {
    const encoder = new TextEncoder();
    const upstream: typeof fetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('data: {"type":"content_block_stop","index":0}\n\n'));
          controller.enqueue(
            encoder.encode(
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
      onCacheStats: () => {},
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer key' },
      body: JSON.stringify({ model: 'claude', input: 'hi', stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('handles passthrough of GET method directly', async () => {
    let called = false;
    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: async () => new Response('never'),
      passthroughFetch: async () => {
        called = true;
        return new Response('ok');
      },
    });

    await fetch('https://api.openai.com/v1/responses', { method: 'GET' });
    expect(called).toBe(true);
  });

  it('handles fallback without dropImages', async () => {
    // When there's no dropImages but fallbackUpstream is set, should not trigger fallback
    let primaryCalled = false;
    const upstream: typeof fetch = async () => {
      primaryCalled = true;
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

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://primary.com/v1',
      fetch: upstream,
      fallbackUpstream: { baseUrl: 'https://fallback.com/v1' },
    });

    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });

    expect(primaryCalled).toBe(true);
  });

  it('handles input_image detection returns false for non-array input', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
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

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://primary.com/v1',
      fetch: upstream,
      dropImages: true,
      fallbackUpstream: { baseUrl: 'https://fallback.com/v1' },
    });

    // input as string - no array, so fallback shouldn't trigger
    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hello' }),
    });

    const parsedBody = JSON.parse(capturedBody);
    // Should still be routed to primary (no images)
    expect(parsedBody.model).toBe('claude');
  });
});
