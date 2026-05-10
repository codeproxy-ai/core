import { describe, expect, it } from 'vitest';

// Test helper functions by importing them through the public API
import { createResponsesFetch } from '../src/fetch.js';

describe('fetch unreached branches', () => {

  // === fetch.ts: normalizeBaseUrl catch (line 151-152) ===
  // Invalid URL input for baseUrl
  it('handles URL with trailing slash and path normalization', async () => {
    // anthropic baseUrl with v1/messages already (normalize should keep it)
    let capturedUrl = '';
    const upstream: typeof fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // openai baseUrl starting with /v1/ should append /chat/completions
    const fetchFn = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });
    const res = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', input: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(capturedUrl).toContain('/v1/chat/completions');
  });

  // === fetch.ts: inferFormatFromUrl catch (line 174) ===
  it('infers format from baseUrl patterns', async () => {
    // Use a url with unknown pattern -> should default to 'openai-chat'
    const upstream: typeof fetch = async (input) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // clean unknown format -> infers openai-chat
    const fetchFn1 = createResponsesFetch({
      baseUrl: 'https://api.deepseek.com/chat/completions',
      fetch: upstream,
    });
    const res1 = await fetchFn1('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek', input: 'hi' }),
    });
    expect(res1.status).toBe(200);
  });

  // === fetch.ts: urlOf with various input types ===
  it('handles URL and Request inputs to urlOf', async () => {
    const upstream: typeof fetch = async (input) => {
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    // Passing GET request should go through passthrough
    const res = await fetchFn(new URL('https://api.openai.com/v1/models'), { method: 'GET' });
    expect(res.status).toBe(200);
  });

  // === fetch.ts: extractRequest with Request instance (line 238-241) ===
  it('handles Request object input to extractRequest', async () => {
    const upstream: typeof fetch = async (input) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      fetch: upstream,
    });

    // GET to non-responses endpoint uses passthrough
    const req = new Request('https://api.openai.com/v1/models', { method: 'GET' });
    const res = await fetchFn(req);
    expect(res.status).toBe(200);
  });

  // === fetch.ts: readBody with Uint8Array (line 254-255) ===
  it('handles streaming responses properly', async () => {
    const encoder = new TextEncoder();
    const upstream: typeof fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const fetchFn = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    const res = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi', stream: true }),
    });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (reader) {
      while (true) { const { done } = await reader.read(); if (done) break; }
    }
  });
});
