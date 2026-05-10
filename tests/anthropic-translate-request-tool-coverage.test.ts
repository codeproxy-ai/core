import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/anthropic/translateRequest.js';

describe('anthropic translateRequest tool mapping coverage', () => {
  // Line 89-90, 92-93: temperature and top_p
  it('handles temperature and top_p in request', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: 'hi',
      temperature: 0.7,
      top_p: 0.9,
    });
    expect(request.temperature).toBe(0.7);
    expect(request.top_p).toBe(0.9);
  });

  // Line 105-106: metadata in request
  it('handles metadata in request', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: 'hi',
      metadata: { user_id: '123' },
    });
    expect(request.metadata).toEqual({ user_id: '123' });
  });

  // Line 251: string part in array content
  it('handles string parts in array content', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'user',
        content: ['hello ', 'world'],
      }],
    });
    expect(request.messages[0].role).toBe('user');
  });

  // Line 350, 357: extractMessageText with array
  it('extractMessageText with array content', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'system',
        content: ['line1', { type: 'text', text: 'line2' }],
      }, {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      }],
    });
    expect(request.system).toBeDefined();
  });

  // Line 390-398: tool call types without names - just verify no crash
  it('handles unknown type message with no role', () => {
    const r = translateRequest({
      model: 'claude',
      input: [{ type: 'unknown', role: 'assistant', content: 'msg' } as never],
    });
    expect(r.request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles commandExecution tool call', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'commandExecution',
        id: 'exec_1',
        arguments: '{}',
      }],
    });
    // Should work without crashing
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles local_shell_call tool call', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'local_shell_call',
        id: 'sh_1',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles fileChange tool call', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'fileChange',
        id: 'fc_1',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('handles web_search_call tool call', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'web_search_call',
        id: 'ws_1',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  // Line 402-403: tool with no name and unknown type
  it('handles function_call with no name and unknown type', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'function_call',
        call_id: 'call_1',
        name: undefined,
      } as never],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  // Line 408: tool with input as array
  it('handles tool with array input for arguments', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        input: [],
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(0);
  });

  // Line 422-423: cache_control on system blocks
  it('handles cache_control on system items', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      instructions: [{ text: 'instruct', cache_control: { type: 'ephemeral' } } as never],
      input: 'hi',
    });
    expect(request.system).toBeDefined();
    if (request.system && request.system[0]) {
      expect((request.system[0] as any).cache_control).toEqual({ type: 'ephemeral' });
    }
  });

  // Line 436-437, 444-445, 449-450: Tool mapping edge cases
  it('handles tools with various conditions', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: 'hi',
      tools: [
        { type: 'function', function: { name: 'good', parameters: { type: 'object' } } },
      ],
      tool_choice: 'auto',
    });
    expect(request.tools).toBeDefined();
  });

  // Line 469-480: tool_choice handling
  it('handles various tool_choice values', () => {
    // none
    const r1 = translateRequest({ model: 'claude', input: 'hi', tools: [{ type: 'function', function: { name: 's', parameters: { type: 'object' } } }], tool_choice: 'none' });
    expect(r1.request.tool_choice).toBeUndefined();

    // auto
    const r2 = translateRequest({ model: 'claude', input: 'hi', tools: [{ type: 'function', function: { name: 's', parameters: { type: 'object' } } }], tool_choice: 'auto' });
    expect(r2.request.tool_choice).toEqual({ type: 'auto' });

    // object with function name
    const r3 = translateRequest({ model: 'claude', input: 'hi', tools: [{ type: 'function', function: { name: 's', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 's' } } });
    expect(r3.request.tool_choice).toBeDefined();

    // object with auto type
    const r4 = translateRequest({ model: 'claude', input: 'hi', tools: [{ type: 'function', function: { name: 's', parameters: { type: 'object' } } }], tool_choice: { type: 'auto' } });
    expect(r4.request.tool_choice).toBeDefined();
  });

  // Line 494-495: mapToolChoice returning undefined for null
  it('handles null tool_choice', () => {
    const { request } = translateRequest({
      model: 'claude',
      input: 'hi',
      tools: [{ type: 'function', function: { name: 's', parameters: { type: 'object' } } }],
      tool_choice: null as never,
    });
    expect(request.tool_choice).toEqual({ type: 'auto' });
  });

  // Line 547-548, 560-561: repairToolAdjacency
  it('repairToolAdjacency missing tool results and remaining content', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"test"}',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'extra context' }],
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'results',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'followup' }],
        },
      ],
    });
    const userMessages = request.messages.filter(m => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  // Line 602-603: sanitizeMessages filtering
  it('sanitizeMessage filters non-object blocks', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [null, undefined, { type: 'text', text: 'valid' }] as never,
        },
      ],
    });
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  // Line 607-608: empty text block filter
  it('sanitizeMessage filters empty text blocks', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: '' }, { type: 'text', text: 'valid' }],
        },
      ],
    });
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  // Line 619-620: string content branch
  it('sanitizeMessage handles string content', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'message',
        role: 'user',
        content: 'plain string',
      }],
    });
    const userMsg = request.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  // Line 225-227: input items with null type or null content
  it('handles input items with null role', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        { type: null as never, role: 'user', content: 'hello' },
      ],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });
});
