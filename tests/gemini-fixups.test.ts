import { describe, expect, it } from 'vitest';

import { translateRequest } from '../src/translate/openai/translateRequest.js';

const call = (id: string, name = 'read') => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: '{}',
});
const output = (id: string, text = 'ok') => ({
  type: 'function_call_output',
  call_id: id,
  output: text,
});
const userMsg = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const sysMsg = (text: string) => ({
  type: 'message',
  role: 'system',
  content: [{ type: 'input_text', text }],
});

describe('repairToolMessageOrder (global, by tool_call_id)', () => {
  it('pulls a tool response back to follow its call across an interrupting user message', () => {
    const { request } = translateRequest({
      model: 'google/gemini-2.5-pro',
      input: [call('A'), userMsg('interrupt'), output('A')],
    });
    const assistantIdx = request.messages.findIndex(
      (m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0,
    );
    expect(request.messages[assistantIdx]?.tool_calls?.[0]?.id).toBe('A');
    expect(request.messages[assistantIdx + 1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'A',
    });
  });

  it('keeps a trailing tool_call that has no response yet', () => {
    const { request } = translateRequest({
      model: 'google/gemini-2.5-pro',
      input: [call('A'), output('A'), call('B')],
    });
    const allCallIds = request.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (m.tool_calls ?? []).map((t) => t.id));
    expect(allCallIds).toContain('B');
  });

  it('drops an orphan tool message with no matching call', () => {
    const { request } = translateRequest({
      model: 'google/gemini-2.5-pro',
      input: [output('ZOMBIE'), call('A'), output('A')],
    });
    const toolIds = request.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(toolIds).toEqual(['A']);
  });
});

describe('Gemini system-message merge (model-name gated)', () => {
  it('merges all system messages into one for a Gemini model', () => {
    const { request } = translateRequest({
      model: 'google/gemini-2.5-pro',
      instructions: 'base',
      input: [sysMsg('A'), userMsg('hi'), sysMsg('B')],
    });
    const systems = request.messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(String(systems[0]?.content)).toContain('base');
    expect(String(systems[0]?.content)).toContain('A');
    expect(String(systems[0]?.content)).toContain('B');
  });

  it('leaves multiple system messages untouched for a non-Gemini model', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      instructions: 'base',
      input: [sysMsg('A'), sysMsg('B')],
    });
    const systems = request.messages.filter((m) => m.role === 'system');
    expect(systems.length).toBeGreaterThan(1);
  });
});

describe('Gemini multi_tool_use.parallel shim (model-name gated)', () => {
  const MANDATE = 'Use `multi_tool_use.parallel` to parallelize tool calls and only this.';

  it('rewrites the mandate and repairs the unsupported-call rejection', () => {
    const { request } = translateRequest({
      model: 'google/gemini-2.5-pro',
      instructions: `Parallelize. ${MANDATE} End.`,
      input: [call('A'), output('A', 'unsupported call: parallel')],
    });
    const system = request.messages.find((m) => m.role === 'system');
    expect(String(system?.content)).toContain('does NOT exist in this environment');
    const toolMsg = request.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('Re-issue each inner call');
  });

  it('does not shim for a non-Gemini model', () => {
    const { request } = translateRequest({
      model: 'gpt-4',
      instructions: `Parallelize. ${MANDATE} End.`,
      input: [userMsg('hi')],
    });
    const system = request.messages.find((m) => m.role === 'system');
    expect(String(system?.content)).toContain(MANDATE);
  });
});
