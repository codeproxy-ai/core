// Body-size guard + clone-free body reads.
//
// Memory context: the translation pipeline (parse → translate → re-serialize)
// holds several times the request body at peak. On memory-capped runtimes
// (128 MB Cloudflare Workers isolates) one runaway body OOMs the whole isolate
// and kills every concurrent request — so `maxBodyChars` must reject BEFORE
// parse/translate, and the Request-input path must read the body exactly once
// without clone() (a clone buffers a second full copy).

import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';

function jsonUpstream(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch: impl, calls: () => calls };
}

function requestBody(padding: number): string {
  return JSON.stringify({ model: 'claude-sonnet-4-5', input: 'x'.repeat(padding) });
}

describe('maxBodyChars guard', () => {
  it('rejects an oversized body with a 413 envelope before calling upstream', async () => {
    const upstream = jsonUpstream();
    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream.fetch,
      maxBodyChars: 1024,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: requestBody(2048),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('exceeding the configured');
    expect(upstream.calls()).toBe(0);
  });

  it('allows a body at the limit and translates as usual', async () => {
    const upstream = jsonUpstream();
    const body = requestBody(64);
    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream.fetch,
      maxBodyChars: body.length,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      body,
    });

    expect(res.status).toBe(200);
    expect(upstream.calls()).toBe(1);
  });

  it('is unlimited by default', async () => {
    const upstream = jsonUpstream();
    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream.fetch,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: requestBody(512 * 1024),
    });

    expect(res.status).toBe(200);
    expect(upstream.calls()).toBe(1);
  });
});

describe('clone-free Request body reads', () => {
  it('translates a Request-input POST /responses (body read once, no clone)', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    const res = await fetchImpl(
      new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'Hello' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedBody).toContain('Hello');
  });

  it('forwards a non-/responses Request untouched with its body still readable', async () => {
    let passthroughBody = '';
    const passthroughFetch: typeof fetch = async (input) => {
      // The wrapper must not have consumed the body before passthrough.
      passthroughBody = input instanceof Request ? await input.text() : '';
      return new Response('ok', { status: 200 });
    };
    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: async () => new Response('unused'),
      passthroughFetch,
    });

    const res = await fetchImpl(
      new Request('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        body: JSON.stringify({ input: 'embed me' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(passthroughBody).toContain('embed me');
  });

  it('forwards a non-POST /responses Request untouched', async () => {
    let sawPassthrough = false;
    const passthroughFetch: typeof fetch = async () => {
      sawPassthrough = true;
      return new Response('ok', { status: 200 });
    };
    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: async () => new Response('unused'),
      passthroughFetch,
    });

    const res = await fetchImpl(
      new Request('https://api.openai.com/v1/responses', { method: 'GET' }),
    );

    expect(res.status).toBe(200);
    expect(sawPassthrough).toBe(true);
  });
});
