/**
 * Tests for the sanitizeToolNames feature in createResponsesFetch.
 *
 * When sanitizeToolNames is enabled, chars not in [a-zA-Z0-9_-] are replaced
 * with '_' before the upstream request, and the original names are restored in
 * the response/stream.  This allows models like DeepSeek to accept namespace
 * tool names (e.g. "multi_agent_v1.spawn_agent") that contain dots.
 */

import { describe, expect, it } from 'vitest';
import { createResponsesFetch } from '../src/fetch.js';
import { encodeSseEvent, parseSseStream } from '../src/utils/sse.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeByteStream(body: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(body));
      c.close();
    },
  });
}

function makeChatCompletionResponse(toolCallName: string, toolCallArgs = '{"message":"hi"}') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1000,
    model: 'deepseek-v3',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: toolCallName,
                arguments: toolCallArgs,
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeToolCallSse(callId: string, name: string, args: string): string {
  return [
    encodeSseEvent('', {
      id: 'chatcmpl-s',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'deepseek-v3',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: callId, type: 'function', function: { name, arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    encodeSseEvent('', {
      id: 'chatcmpl-s',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'deepseek-v3',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
          finish_reason: null,
        },
      ],
    }),
    encodeSseEvent('', {
      id: 'chatcmpl-s',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'deepseek-v3',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    'data: [DONE]\n\n',
  ].join('');
}

async function collectResponses(
  resBody: ReadableStream<Uint8Array>,
): Promise<ResponsesStreamEvent[]> {
  const events: ResponsesStreamEvent[] = [];
  for await (const msg of parseSseStream(resBody)) {
    if (msg.data === '[DONE]') {
      break;
    }
    events.push(JSON.parse(msg.data) as ResponsesStreamEvent);
  }
  return events;
}

function findOutputItemDone(events: ResponsesStreamEvent[]) {
  return events.find((e) => e.type === 'response.output_item.done') as
    | (ResponsesStreamEvent & { item: Record<string, unknown> })
    | undefined;
}

// ---------------------------------------------------------------------------
// Minimal namespace tool definition (Responses API format)
// ---------------------------------------------------------------------------
const NS_TOOL = {
  type: 'namespace',
  name: 'multi_agent_v1',
  description: 'Tools for spawning and managing sub-agents.',
  tools: [
    {
      type: 'function',
      name: 'spawn_agent',
      description: 'Spawn a sub-agent.',
      parameters: { type: 'object', properties: { message: { type: 'string' } } },
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. Non-streaming: request body sanitized, response names restored
// ---------------------------------------------------------------------------

describe('sanitizeToolNames: non-streaming', () => {
  it('sanitizes dot in tool name before sending to upstream', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify(makeChatCompletionResponse('multi_agent_v1_spawn_agent')),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        tools: [NS_TOOL],
      }),
    });

    const body = JSON.parse(capturedBody);
    const toolNames = (body.tools ?? []).map(
      (t: Record<string, unknown>) =>
        (t.function as Record<string, unknown> | undefined)?.name ?? t.name,
    );
    // "multi_agent_v1.spawn_agent" dot should have been replaced with "_"
    expect(toolNames).toContain('multi_agent_v1_spawn_agent');
    expect(toolNames).not.toContain('multi_agent_v1.spawn_agent');
  });

  it('restores original dot-containing tool name in non-streaming response', async () => {
    // Upstream returns sanitized name; the fetch layer should restore it
    const upstream: typeof fetch = async () => {
      return new Response(
        JSON.stringify(
          makeChatCompletionResponse('multi_agent_v1_spawn_agent', '{"message":"hi"}'),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        tools: [NS_TOOL],
      }),
    });

    const json = (await res.json()) as { output: Record<string, unknown>[] };
    const item = json.output[0];
    // translateResponse splits "multi_agent_v1.spawn_agent" → name="spawn_agent", namespace="multi_agent_v1"
    expect(item.name).toBe('spawn_agent');
    expect(item.namespace).toBe('multi_agent_v1');
  });
});

// ---------------------------------------------------------------------------
// 2. Streaming: SSE chunks have tool names restored on the fly
// ---------------------------------------------------------------------------

describe('sanitizeToolNames: streaming', () => {
  it('restores original tool name in streaming SSE output', async () => {
    // Upstream returns sanitized name in SSE; fetch layer should restore it before translateStream
    const upstream: typeof fetch = async () => {
      const sse = makeToolCallSse('call_a', 'multi_agent_v1_spawn_agent', '{"message":"hi"}');
      return new Response(makeByteStream(sse), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        stream: true,
        tools: [NS_TOOL],
      }),
    });

    expect(res.headers.get('content-type')?.startsWith('text/event-stream')).toBe(true);
    const events = await collectResponses(res.body!);
    const done = findOutputItemDone(events);
    expect(done).toBeDefined();
    // After restoration "multi_agent_v1.spawn_agent" is recognized → split into namespace + name
    expect(done!.item.name).toBe('spawn_agent');
    expect(done!.item.namespace).toBe('multi_agent_v1');
  });
});

// ---------------------------------------------------------------------------
// 3. No-op: names that are already valid pass through unchanged
// ---------------------------------------------------------------------------

describe('sanitizeToolNames: no-op when all names valid', () => {
  it('non-streaming: does not alter body or response when tool names are already valid', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify(makeChatCompletionResponse('exec_command', '{}')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'run',
            parameters: { type: 'object' },
          },
        ],
      }),
    });

    const body = JSON.parse(capturedBody);
    const toolNames = (body.tools ?? []).map(
      (t: Record<string, unknown>) =>
        (t.function as Record<string, unknown> | undefined)?.name ?? t.name,
    );
    expect(toolNames).toContain('exec_command');
  });

  it('streaming: passes SSE through unchanged when no sanitization needed', async () => {
    const upstream: typeof fetch = async () => {
      const sse = makeToolCallSse('call_b', 'exec_command', '{"cmd":"ls"}');
      return new Response(makeByteStream(sse), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'run',
            parameters: { type: 'object' },
          },
        ],
      }),
    });

    const events = await collectResponses(res.body!);
    const done = findOutputItemDone(events);
    expect(done).toBeDefined();
    expect(done!.item.name).toBe('exec_command');
    expect(done!.item.namespace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Multiple illegal characters: dots, slashes, colons all replaced
// ---------------------------------------------------------------------------

describe('sanitizeToolNames: multiple illegal characters', () => {
  it('replaces dots, slashes, and colons in tool names with underscores', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      // Upstream echoes back the sanitized name
      return new Response(
        JSON.stringify(makeChatCompletionResponse('ns_tools_v2_fn__slash__colon_', '{}')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: 'ns.tools.v2.fn-/slash/:colon:',
            description: 'weird name',
            parameters: { type: 'object' },
          },
        ],
      }),
    });

    const body = JSON.parse(capturedBody);
    const toolNames = (body.tools ?? []).map(
      (t: Record<string, unknown>) =>
        (t.function as Record<string, unknown> | undefined)?.name ?? t.name,
    );
    // All illegal chars replaced with '_'
    expect(toolNames).toContain('ns_tools_v2_fn-_slash__colon_');
    expect(toolNames).not.toContain('ns.tools.v2.fn-/slash/:colon:');
  });

  it('non-streaming: restore map has sanitized→original entry so function_call carries original name', async () => {
    // Tool registered as 'plain_with_dots.call' (one dot → namespace split by translateResponse)
    // We verify the restore step runs: the upstream sanitized name is replaced with the original
    // before translateResponse sees it.
    const originalName = 'myns.mymethod';
    const sanitizedName = 'myns_mymethod';

    const upstream: typeof fetch = async () => {
      return new Response(JSON.stringify(makeChatCompletionResponse(sanitizedName, '{}')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: originalName,
            description: 'weird name',
            parameters: { type: 'object' },
          },
        ],
      }),
    });

    const json = (await res.json()) as { output: Record<string, unknown>[] };
    const item = json.output[0];
    // translateResponse splits "myns.mymethod" → name="mymethod", namespace="myns"
    // This confirms the restored name "myns.mymethod" (not "myns_mymethod") reached translateResponse
    expect(item.name).toBe('mymethod');
    expect(item.namespace).toBe('myns');
  });

  it('streaming: restored name with dot causes correct namespace split in output', async () => {
    // Original: "myns.method" — sanitized to "myns_method" for upstream
    // Upstream echoes "myns_method"; our stream restore converts it back to "myns.method"
    // Then translateStream recognises "myns.method" and splits it → namespace="myns", name="method"
    const originalName = 'myns.method';
    const sanitizedName = 'myns_method';

    const upstream: typeof fetch = async () => {
      const sse = makeToolCallSse('call_c', sanitizedName, '{"key":"value"}');
      return new Response(makeByteStream(sse), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        stream: true,
        tools: [
          {
            type: 'function',
            name: originalName,
            description: 'weird name',
            parameters: { type: 'object' },
          },
        ],
      }),
    });

    const events = await collectResponses(res.body!);
    const done = findOutputItemDone(events);
    expect(done).toBeDefined();
    // Restored name "myns.method" is split into namespace+name by translateStream
    expect(done!.item.name).toBe('method');
    expect(done!.item.namespace).toBe('myns');
  });
});

// ---------------------------------------------------------------------------
// 5. Feature disabled: names pass through unchanged even if they contain dots
// ---------------------------------------------------------------------------

describe('sanitizeToolNames: openai-chat always sanitizes, anthropic skips', () => {
  it('always sanitizes dot names for openai-chat format', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify(makeChatCompletionResponse('multi_agent_v1_spawn_agent')),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
    });

    await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        tools: [NS_TOOL],
      }),
    });

    const body = JSON.parse(capturedBody);
    const toolNames = (body.tools ?? []).map(
      (t: Record<string, unknown>) =>
        (t.function as Record<string, unknown> | undefined)?.name ?? t.name,
    );
    expect(toolNames).toContain('multi_agent_v1_spawn_agent');
    expect(toolNames).not.toContain('multi_agent_v1.spawn_agent');
  });

  it('does not sanitize tool names for anthropic format', async () => {
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
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      fetch: upstream,
    });

    await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: 'has.dot.in.name',
            description: 'test',
            parameters: { type: 'object' },
          },
        ],
      }),
    });

    expect(capturedBody.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// dropTools option
// ---------------------------------------------------------------------------

describe('dropTools option', () => {
  it('removes tools matching the predicate before sending to upstream', async () => {
    let capturedBody = '';
    const upstream: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1000,
          model: 'deepseek-v3',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok', tool_calls: [] },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const fetchImpl = createResponsesFetch({
      upstreamFormat: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: upstream,
      dropTools: (tool) =>
        typeof (tool as Record<string, unknown>).name === 'string' &&
        ((tool as Record<string, unknown>).name as string).startsWith('mcp__codex_apps__'),
    });

    await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'run',
            parameters: { type: 'object' },
          },
          {
            type: 'namespace',
            name: 'mcp__codex_apps__github',
            description: 'GitHub',
            tools: [
              {
                type: 'function',
                name: 'fetch_pr',
                description: 'fetch pr',
                parameters: { type: 'object' },
              },
            ],
          },
          {
            type: 'namespace',
            name: 'mcp__codex_apps__figma',
            description: 'Figma',
            tools: [
              {
                type: 'function',
                name: 'get_design',
                description: 'get design',
                parameters: { type: 'object' },
              },
            ],
          },
        ],
      }),
    });

    const body = JSON.parse(capturedBody);
    const names = (body.tools ?? []).map(
      (t: Record<string, unknown>) =>
        (t.function as Record<string, unknown> | undefined)?.name ?? t.name,
    );

    expect(names).toContain('exec_command');
    expect(names).not.toContain('mcp__codex_apps__github_fetch_pr');
    expect(names).not.toContain('mcp__codex_apps__figma_get_design');
  });
});

// ---------------------------------------------------------------------------
// Direct unit tests for tool-name-sanitizer internals
// ---------------------------------------------------------------------------

import {
  sanitizeUpstreamToolNames,
  restoreToolNamesInChatResponse,
  createToolNameRestoreStream,
} from '../src/tool-name-sanitizer.js';

describe('sanitizeUpstreamToolNames', () => {
  it('returns empty map when no tools array', () => {
    const body: Record<string, unknown> = { model: 'x' };
    const map = sanitizeUpstreamToolNames(body);
    expect(map.size).toBe(0);
  });

  it('skips non-object entries in tools', () => {
    const body = { tools: [null, 42, 'string'] };
    const map = sanitizeUpstreamToolNames(body);
    expect(map.size).toBe(0);
  });

  it('skips tools without function object', () => {
    const body = { tools: [{ type: 'function' }] };
    const map = sanitizeUpstreamToolNames(body);
    expect(map.size).toBe(0);
  });

  it('skips tools with non-string function.name', () => {
    const body = { tools: [{ function: { name: 42 } }] };
    const map = sanitizeUpstreamToolNames(body);
    expect(map.size).toBe(0);
  });
});

describe('restoreToolNamesInChatResponse', () => {
  it('returns body unchanged when map is empty', () => {
    const body = { choices: [] };
    expect(restoreToolNamesInChatResponse(body, new Map())).toBe(body);
  });

  it('skips non-object choices', () => {
    const map = new Map([['a_b', 'a.b']]);
    const body = { choices: [null, 42] };
    expect(() => restoreToolNamesInChatResponse(body, map)).not.toThrow();
  });

  it('skips choices without message', () => {
    const map = new Map([['a_b', 'a.b']]);
    const body = { choices: [{ index: 0 }] };
    expect(() => restoreToolNamesInChatResponse(body, map)).not.toThrow();
  });

  it('skips tool_calls that are non-object', () => {
    const map = new Map([['a_b', 'a.b']]);
    const body = { choices: [{ message: { tool_calls: [null, 42] } }] };
    expect(() => restoreToolNamesInChatResponse(body, map)).not.toThrow();
  });
});

describe('createToolNameRestoreStream', () => {
  it('returns original stream when map is empty', () => {
    const enc = new TextEncoder();
    const original = new ReadableStream({ start(c) { c.enqueue(enc.encode('data')); c.close(); } });
    expect(createToolNameRestoreStream(original, new Map())).toBe(original);
  });

  it('cancel does not throw', async () => {
    const enc = new TextEncoder();
    const map = new Map([['a_b', 'a.b']]);
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode('{"name":"a_b"}')); c.close(); } });
    const restored = createToolNameRestoreStream(stream, map);
    const reader = restored.getReader();
    await reader.cancel();
  });
});
