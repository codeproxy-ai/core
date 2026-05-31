/**
 * Tests for namespace tool support:
 *
 * 1. translateRequest: `type:"namespace"` tools are flattened as
 *    "namespace.toolname" function tools in the Chat Completions request.
 *
 * 2. translateResponse / translateStream: the namespace is restored in the
 *    Responses API output so codex can route the call correctly.
 *    Two sub-cases:
 *    a. Upstream preserved the prefix  → split "multi_agent_v1.spawn_agent"
 *    b. Upstream stripped the prefix   → fall back to requestTools map
 */

import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';
import { translateResponse } from '../src/translate/openai/translateResponse.js';
import { translateStream } from '../src/translate/openai/translateStream.js';
import { encodeSseEvent } from '../src/utils/sse.js';
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

async function collectStream(
  gen: AsyncGenerator<ResponsesStreamEvent>,
): Promise<ResponsesStreamEvent[]> {
  const out: ResponsesStreamEvent[] = [];
  for await (const e of gen) {
    out.push(e);
  }
  return out;
}

function doneItem(events: ResponsesStreamEvent[]) {
  const found = events.find((e) => e.type === 'response.output_item.done');
  return found as unknown as { type: string; item: Record<string, unknown> } | undefined;
}

// Minimal namespace tool definition (Responses API format)
const MULTI_AGENT_NS_TOOL = {
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
    {
      type: 'function',
      name: 'wait_agent',
      description: 'Wait for agents.',
      parameters: {
        type: 'object',
        properties: { targets: { type: 'array', items: { type: 'string' } } },
        required: ['targets'],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. translateRequest — namespace flattening
// ---------------------------------------------------------------------------

describe('translateRequest: namespace tool flattening', () => {
  it('flattens namespace sub-tools as "namespace.toolname" function tools', () => {
    const { request } = translateRequest({
      model: 'deepseek-v3',
      input: 'Hello',
      tools: [MULTI_AGENT_NS_TOOL as never],
    });

    const tools = request.tools ?? [];
    const names = tools.map((t: Record<string, unknown>) => {
      const fn = t.function as Record<string, unknown> | undefined;
      return fn?.name ?? t.name;
    });

    expect(names).toContain('multi_agent_v1.spawn_agent');
    expect(names).toContain('multi_agent_v1.wait_agent');
  });

  it('does not include the original namespace wrapper as a function tool', () => {
    const { request } = translateRequest({
      model: 'deepseek-v3',
      input: 'Hello',
      tools: [MULTI_AGENT_NS_TOOL as never],
    });

    const tools = request.tools ?? [];
    const names = tools.map((t: Record<string, unknown>) => {
      const fn = t.function as Record<string, unknown> | undefined;
      return fn?.name ?? t.name;
    });

    expect(names).not.toContain('multi_agent_v1');
  });

  it('preserves plain function tools alongside flattened namespace tools', () => {
    const { request } = translateRequest({
      model: 'deepseek-v3',
      input: 'Hello',
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          description: 'run',
          parameters: { type: 'object' },
        },
        MULTI_AGENT_NS_TOOL as never,
      ],
    });

    const names = (request.tools ?? []).map((t: Record<string, unknown>) => {
      const fn = t.function as Record<string, unknown> | undefined;
      return fn?.name ?? t.name;
    });

    expect(names).toContain('exec_command');
    expect(names).toContain('multi_agent_v1.spawn_agent');
    expect(names).toContain('multi_agent_v1.wait_agent');
  });
});

// ---------------------------------------------------------------------------
// 2. translateResponse — namespace restoration
// ---------------------------------------------------------------------------

describe('translateResponse: namespace restoration', () => {
  it('splits "namespace.toolname" into separate name + namespace fields', () => {
    const res = translateResponse({
      id: 'chatcmpl-1',
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
                  name: 'multi_agent_v1.spawn_agent',
                  arguments: '{"message":"hello"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    const item = res.output[0] as Record<string, unknown>;
    expect(item.type).toBe('function_call');
    expect(item.name).toBe('spawn_agent');
    expect(item.namespace).toBe('multi_agent_v1');
  });

  it('falls back to requestTools map when upstream omits the namespace prefix', () => {
    const res = translateResponse(
      {
        id: 'chatcmpl-2',
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
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'wait_agent', arguments: '{"targets":["id1"]}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { requestTools: [MULTI_AGENT_NS_TOOL as never] },
    );

    const item = res.output[0] as Record<string, unknown>;
    expect(item.type).toBe('function_call');
    expect(item.name).toBe('wait_agent');
    expect(item.namespace).toBe('multi_agent_v1');
  });

  it('leaves name unchanged and no namespace when tool is not in any namespace', () => {
    const res = translateResponse({
      id: 'chatcmpl-3',
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
                id: 'call_3',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd":"ls"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    const item = res.output[0] as Record<string, unknown>;
    expect(item.name).toBe('exec_command');
    expect(item.namespace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. translateStream — namespace restoration in SSE output
// ---------------------------------------------------------------------------

function makeToolCallChunks(callId: string, name: string, args: string): string {
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

describe('translateStream: namespace restoration in output_item.done', () => {
  it('splits "namespace.toolname" into name + namespace in stream done event', async () => {
    const body = makeToolCallChunks('call_a', 'multi_agent_v1.spawn_agent', '{"message":"hi"}');
    const events = await collectStream(
      translateStream(makeByteStream(body), { model: 'deepseek-v3' }),
    );

    const done = doneItem(events);
    expect(done).toBeDefined();
    expect(done!.item.name).toBe('spawn_agent');
    expect(done!.item.namespace).toBe('multi_agent_v1');
  });

  it('falls back to requestTools namespace map when upstream omits prefix', async () => {
    // DeepSeek calls "wait_agent" without the namespace prefix
    const body = makeToolCallChunks('call_b', 'wait_agent', '{"targets":["agent-1"]}');
    const events = await collectStream(
      translateStream(makeByteStream(body), {
        model: 'deepseek-v3',
        requestMetadata: { tools: [MULTI_AGENT_NS_TOOL as never] },
      }),
    );

    const done = doneItem(events);
    expect(done).toBeDefined();
    expect(done!.item.name).toBe('wait_agent');
    expect(done!.item.namespace).toBe('multi_agent_v1');
  });

  it('leaves namespace undefined for plain (non-namespaced) tool calls', async () => {
    const body = makeToolCallChunks('call_c', 'exec_command', '{"cmd":"ls"}');
    const events = await collectStream(
      translateStream(makeByteStream(body), {
        model: 'deepseek-v3',
        requestMetadata: { tools: [MULTI_AGENT_NS_TOOL as never] },
      }),
    );

    const done = doneItem(events);
    expect(done).toBeDefined();
    expect(done!.item.name).toBe('exec_command');
    expect(done!.item.namespace).toBeUndefined();
  });

  it('falls back using flattened Chat Completions tool names in requestMetadata', async () => {
    // requestMetadata.tools contains already-flattened tools (Chat Completions format)
    const flatTool = {
      type: 'function',
      function: { name: 'multi_agent_v1.close_agent', description: 'Close an agent.' },
    };
    const body = makeToolCallChunks('call_d', 'close_agent', '{"target":"id1"}');
    const events = await collectStream(
      translateStream(makeByteStream(body), {
        model: 'deepseek-v3',
        requestMetadata: { tools: [flatTool as never] },
      }),
    );

    const done = doneItem(events);
    expect(done).toBeDefined();
    expect(done!.item.name).toBe('close_agent');
    expect(done!.item.namespace).toBe('multi_agent_v1');
  });

  it('does not split container.exec (known shell tool with dot in name)', async () => {
    const body = makeToolCallChunks('call_e', 'container.exec', '{"command":["ls"]}');
    const events = await collectStream(
      translateStream(makeByteStream(body), {
        model: 'deepseek-v3',
        requestMetadata: { tools: [MULTI_AGENT_NS_TOOL as never] },
      }),
    );

    const done = doneItem(events);
    expect(done).toBeDefined();
    expect(done!.item.type).toBe('local_shell_call');
    expect(done!.item.name).toBe('container.exec');
    expect(done!.item.namespace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases for buildShortNameToNamespace
// ---------------------------------------------------------------------------

describe('buildShortNameToNamespace: edge cases', () => {
  it('translateResponse: ignores null/non-object entries in requestTools', () => {
    const res = translateResponse(
      {
        id: 'chatcmpl-edge',
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
                  id: 'call_e',
                  type: 'function',
                  function: { name: 'spawn_agent', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      // Pass a mix of valid and invalid entries — should not throw
      { requestTools: [null, 42, 'string', MULTI_AGENT_NS_TOOL as never] as never[] },
    );

    const item = res.output[0] as Record<string, unknown>;
    expect(item.name).toBe('spawn_agent');
    expect(item.namespace).toBe('multi_agent_v1');
  });

  it('translateResponse: handles namespace tool with non-object sub-tool entries', () => {
    const nsToolWithBadSub = {
      type: 'namespace',
      name: 'my_ns',
      tools: [null, { type: 'function', name: 'good_tool' }],
    };
    const res = translateResponse(
      {
        id: 'chatcmpl-bad-sub',
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
                  id: 'call_f',
                  type: 'function',
                  function: { name: 'good_tool', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { requestTools: [nsToolWithBadSub as never] },
    );

    const item = res.output[0] as Record<string, unknown>;
    expect(item.name).toBe('good_tool');
    expect(item.namespace).toBe('my_ns');
  });
});
