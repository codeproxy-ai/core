import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';

describe('fetch - last branches', () => {
  it('handles empty content-type by acting as JSON', async () => {
    const upstream: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: {} },
      );
    };

    const fetch = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', input: 'hi' }),
    });
    expect(res.status).toBe(200);
  });
});
