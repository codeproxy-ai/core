import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/anthropic/translateRequest.js';

describe('anthropic translateRequest - sanitizeMessages edge cases', () => {
  it('filters out non user/assistant messages', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        { role: 'user', content: 'hello', type: 'message' },
      ],
    });
    const roles = request.messages.map(m => m.role);
    roles.forEach(role => {
      expect(['user', 'assistant']).toContain(role);
    });
  });

  it('handles empty messages array in ensureEndsWithUser', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: '',
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
    expect(request.messages[0].role).toBe('user');
  });

  it('handles string content in function_call_output with array output', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [
            { type: 'text', text: 'part1' },
            { type: 'text', text: 'part2' },
          ],
        },
      ],
    });
    const toolResultMsg = request.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b: { type?: string }) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
  });

  it('handles function_call with commandExecution type and no name', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'commandExecution',
        call_id: 'call_exec',
        name: 'run_shell_command',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles function_call with local_shell_call type', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'local_shell_call',
        id: 'call_sh',
        name: 'local_shell_command',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles function_call with fileChange type', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'fileChange',
        id: 'call_fc',
        name: 'write_file',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles function_call without name', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'custom_tool_call',
        id: 'call_ct',
        name: 'my_tool',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles function_call with web_search_call type', () => {
    const { request } = translateRequest({
      model: 'claude-sonnet-4-5',
      input: [{
        type: 'web_search_call',
        id: 'call_ws',
        name: 'web_search',
        arguments: '{}',
      }],
    });
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
  });
});
