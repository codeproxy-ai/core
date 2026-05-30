import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('translateRequest (Responses -> Zai)', () => {
  it('maps simple string input + instructions', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        instructions: 'You are helpful.',
        input: 'Hello',
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.model).toBe('zai-gpt-4');
    expect(request.messages[0]).toMatchObject({ role: 'system', content: 'You are helpful.' });
    expect(request.messages[1]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(request.max_tokens).toBe(4096);
  });

  it('handles structured input items with tool calls and outputs', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list' }] },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'sure' }],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'shell',
            arguments: '{"command":["ls"]}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'file.txt',
          },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'shell', description: 'run', parameters: { type: 'object' } },
          },
        ],
      },
      { defaultMaxTokens: 4096 },
    );

    expect(request.messages.length).toBeGreaterThanOrEqual(3);
    expect(request.messages[0]).toMatchObject({ role: 'user' });
    expect(request.messages[1]).toMatchObject({ role: 'assistant', content: 'sure' });
    expect(request.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'file.txt',
    });
  });

  it('backfills empty reasoning_content on assistant tool-call messages without prior reasoning', () => {
    const { request } = translateRequest({
      model: 'glm-4.6',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
    });
    const assistant = request.messages.find(
      (msg) => msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length,
    );
    expect(assistant).toBeDefined();
    expect(assistant!.reasoning_content).toBe('.');
  });

  it('backfills reasoning_content on plain assistant text messages (GLM thinking mode)', () => {
    const { request } = translateRequest({
      model: 'glm-4.6',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] },
      ],
    });
    const assistant = request.messages.find((msg) => msg.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.tool_calls).toBeUndefined();
    expect(assistant!.reasoning_content).toBe('.');
  });

  it('preserves existing reasoning_content on assistant tool-call messages', () => {
    const { request } = translateRequest({
      model: 'glm-4.6',
      input: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking...' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
      ],
    });
    const assistant = request.messages.find(
      (msg) => msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length,
    );
    expect(assistant!.reasoning_content).toBe('thinking...');
  });

  it('places thought_signature on Gemini OpenAI tool call extra_content', () => {
    const { request } = translateRequest({
      model: 'google/gemini-3.5-flash',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{}',
          thought_signature: 'sig_1',
        },
      ],
    });
    const assistant = request.messages.find((msg) => msg.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: 'sig_1' },
    });
  });

  it('can add a fallback Gemini thought signature for migrated histories', () => {
    const { request } = translateRequest(
      {
        model: 'google/gemini-3.5-flash',
        input: [{ type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' }],
      },
      { fallbackThoughtSignature: 'skip_thought_signature_validator' },
    );
    const assistant = request.messages.find((msg) => msg.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: 'skip_thought_signature_validator' },
    });
  });

  it('omits historical tool calls whose name is not in the current tool list', () => {
    const { request } = translateRequest({
      model: 'gemini-2.5-pro',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        {
          type: 'function_call',
          call_id: 'bad_call',
          name: 'spawn_agentspawn_agentspawn_agent',
          arguments: '{"task_name":"a"}{"task_name":"b"}',
        },
        {
          type: 'function_call_output',
          call_id: 'bad_call',
          output: 'unsupported call: spawn_agentspawn_agentspawn_agent',
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'spawn_agent', description: 'spawn', parameters: { type: 'object' } },
        },
      ],
    });

    const functionToolNames = request.tools?.map((tool) =>
      'function' in tool ? (tool.function as { name?: string } | undefined)?.name : undefined,
    );
    expect(functionToolNames).toEqual(['spawn_agent']);
    expect(request.messages.some((msg) => msg.role === 'tool')).toBe(false);
    expect(
      request.messages.some((msg) =>
        msg.tool_calls?.some((call) => call.function?.name === 'spawn_agentspawn_agentspawn_agent'),
      ),
    ).toBe(false);
    expect(
      request.messages.some(
        (msg) => msg.content === 'Unsupported tool call omitted: spawn_agentspawn_agentspawn_agent',
      ),
    ).toBe(true);
    expect(
      request.messages.some(
        (msg) =>
          msg.role === 'user' &&
          msg.content ===
            'Output for omitted unsupported tool call: unsupported call: spawn_agentspawn_agentspawn_agent',
      ),
    ).toBe(true);
  });

  it('sanitizes unsupported JSON schema keywords in tools', () => {
    const { request } = translateRequest({
      model: 'gemini-2.5-pro',
      input: 'go',
      tools: [
        {
          type: 'function',
          function: {
            name: 'plan',
            parameters: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              $defs: { hidden: { type: 'string' } },
              type: 'object',
              properties: {
                title: { $ref: '#/$defs/hidden', description: 'title text' },
              },
              additionalProperties: { type: 'string' },
              items: { type: 'object', additionalProperties: false },
              anyOf: [{ type: 'object', additionalProperties: false }],
            },
          },
        },
      ],
    });

    const params =
      request.tools && 'function' in request.tools[0] ? request.tools[0].function.parameters : {};
    expect(params).toEqual({
      type: 'object',
      properties: {
        title: { description: 'title text' },
      },
      additionalProperties: { type: 'string' },
      items: { type: 'object' },
      anyOf: [{ type: 'object' }],
    });
  });

  it('maps temperature and top_p', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: 'test',
        temperature: 0.7,
        top_p: 0.9,
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.temperature).toBe(0.7);
    expect(request.top_p).toBe(0.9);
  });

  it('maps max_output_tokens and max_tokens', () => {
    const { request } = translateRequest({
      model: 'zai-gpt-4',
      input: 'test',
      max_output_tokens: 1000,
    });
    expect(request.max_tokens).toBe(1000);
  });

  // ==============================================================================
  // basic parameter mapping
  // ==============================================================================

  it('handles tool_choice auto', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: 'test',
        tools: [
          {
            type: 'function',
            function: { name: 'shell', description: 'run', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'auto',
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.tools).toBeDefined();
    expect(request.tool_choice).toBe('auto');
  });

  it('handles tool_choice required', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: 'test',
        tools: [
          {
            type: 'function',
            function: { name: 'shell', description: 'run', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'required',
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.tool_choice).toBe('required');
  });

  it('handles tool_choice none', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: 'test',
        tools: [
          {
            type: 'function',
            function: { name: 'shell', description: 'run', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'none',
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.tool_choice).toBe('none');
  });

  it('handles tool_choice with specific function', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: 'test',
        tools: [
          {
            type: 'function',
            function: { name: 'shell', description: 'run', parameters: { type: 'object' } },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'shell' } },
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'shell' } });
  });

  it('uses default max_tokens when not provided', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: 'test',
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.max_tokens).toBe(4096);
  });

  it('handles array of strings as input', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: ['hello', 'world'],
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.messages.length).toBe(2);
    expect(request.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(request.messages[1]).toMatchObject({ role: 'user', content: 'world' });
  });

  it('translates input_image with image_url string (Responses API format)', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'what is this?' },
              { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
            ],
          },
        ],
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ]);
  });

  // ==============================================================================
  // image & file type translation
  // ==============================================================================

  it('translates input_image with image_url object {url}', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: { url: 'https://example.com/a.png' } }],
          },
        ],
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]);
  });

  it('translates input_image with data+mime_type fallback', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', data: 'BBB', mime_type: 'image/jpeg' }],
          },
        ],
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
    ]);
  });

  it('translates input_file to image_url data URL', () => {
    const { request } = translateRequest(
      {
        model: 'zai-gpt-4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_file', file_data: 'CCC', mime_type: 'application/pdf' }],
          },
        ],
      },
      { defaultMaxTokens: 4096 },
    );
    expect(request.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:application/pdf;base64,CCC' } },
    ]);
  });

  it('reorders tool messages when user message is injected between function_call and function_call_output', () => {
    const { request } = translateRequest({
      model: 'glm-4.6',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"ls"}',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Warning: something' }],
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
      ],
    });

    // The assistant message with tool_calls must be immediately followed by the tool response
    const assistantIdx = request.messages.findIndex(
      (msg) => msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length,
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const nextMsg = request.messages[assistantIdx + 1];
    expect(nextMsg.role).toBe('tool');
    expect(nextMsg.tool_call_id).toBe('call_1');
    expect(nextMsg.content).toBe('file.txt');
  });

  it('does not inject response_format (incompatible with most upstreams)', () => {
    const { request } = translateRequest({
      model: 'gpt-5',
      input: 'go',
      text: {
        format: { type: 'json_schema', name: 'test', strict: true, schema: { type: 'object' } },
      },
    });
    expect(request.response_format).toBeUndefined();
  });
});

it('maps reasoning.effort to reasoning_effort in request body', () => {
  const { request } = translateRequest({
    model: 'deepseek-v4-pro',
    input: 'hello',
    reasoning: { effort: 'high' },
  });
  const reqRecord: Record<string, unknown> = request;
  expect(reqRecord.reasoning_effort).toBe('high');
});

it('omits reasoning_effort when reasoning.effort is not provided', () => {
  const { request } = translateRequest({
    model: 'deepseek-v4-pro',
    input: 'hello',
  });
  const reqRecord: Record<string, unknown> = request;
  expect(reqRecord.reasoning_effort).toBeUndefined();
});
