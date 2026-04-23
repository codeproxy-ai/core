import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';
import { encodeSseEvent, parseSseStream } from '../src/utils/sse.js';

function mockAnthropicStream(events: Array<{ type: string; data: unknown }>): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(encoder.encode(encodeSseEvent(e.type, e.data)));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

describe('createResponsesFetch', () => {
  it('translates /responses JSON + forwards Bearer auth as x-api-key', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};

    const upstream: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedBody = String(init?.body ?? '');
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Hi there!' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const fetchImpl = createResponsesFetch({ provider: 'claude', fetch: upstream });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-ant-test',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'Hello' }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { output: unknown[]; usage: { total_tokens: number } };
    expect(json.usage.total_tokens).toBe(5);

    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');
    expect(capturedHeaders['authorization']).toBeUndefined();
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');

    const upstreamBody = JSON.parse(capturedBody);
    expect(upstreamBody.messages[0].content[0].text).toBe('Hello');
  });

  it('passes an existing x-api-key header through untouched', async () => {
    let captured: Record<string, string> = {};
    const upstream: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = Object.fromEntries(
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
    }) as unknown as typeof fetch;

    const fetchImpl = createResponsesFetch({ provider: 'claude', fetch: upstream });
    await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'x-api-key': 'explicit-key' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'hi' }),
    });
    expect(captured['x-api-key']).toBe('explicit-key');
  });

  it('re-emits a streaming /responses request as SSE', async () => {
    const upstream = mockAnthropicStream([
      {
        type: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'claude',
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      },
      {
        type: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        },
      },
      { type: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        type: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        },
      },
      { type: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const fetchImpl = createResponsesFetch({ provider: 'claude', fetch: upstream });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-ant-test',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'Hi', stream: true }),
    });

    expect(res.headers.get('content-type')?.startsWith('text/event-stream')).toBe(true);
    const parsedEvents: string[] = [];
    let textDelta = '';
    for await (const msg of parseSseStream(res.body!)) {
      if (msg.data === '[DONE]') {
        parsedEvents.push('DONE');
        break;
      }
      const payload = JSON.parse(msg.data) as { type: string; delta?: string };
      parsedEvents.push(payload.type);
      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        textDelta += payload.delta;
      }
    }
    expect(parsedEvents[0]).toBe('response.created');
    expect(parsedEvents[parsedEvents.length - 1]).toBe('DONE');
    expect(textDelta).toBe('Hi');
  });

  it('forwards non-/responses paths to passthrough fetch', async () => {
    let passthroughCalled = false;
    const passthrough: typeof fetch = (async () => {
      passthroughCalled = true;
      return new Response('ok');
    }) as unknown as typeof fetch;

    const fetchImpl = createResponsesFetch({
      provider: 'claude',
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
      passthroughFetch: passthrough,
    });

    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    });
    expect(passthroughCalled).toBe(true);
    expect(await res.text()).toBe('ok');
  });

  it('translates upstream errors to OpenAI-style error JSON', async () => {
    const upstream: typeof fetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'bad key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const fetchImpl = createResponsesFetch({ provider: 'claude', fetch: upstream });
    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer x' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'x' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('bad key');
  });
});
