import { describe, expect, it } from 'vitest';
import { translateResponse, mapOutputItems } from '../src/translate/anthropic/translateResponse.js';

describe('anthropic translateResponse - branch coverage', () => {
  it('handles tool_use with null/undefined id (makeId fallback)', () => {
    const result = mapOutputItems([
      { type: 'tool_use', name: 'search', input: { q: 'test' } },
    ] as never[]);
    const item = result[0] as { id: string; call_id: string };
    expect(item.id).toBeTruthy();
    expect(item.call_id).toBeTruthy();
  });

  it('handles tool_use with null/undefined name (defaults to tool)', () => {
    const result = mapOutputItems([
      { type: 'tool_use', id: 'call_1', input: { q: 'test' } },
    ] as never[]);
    // eslint-disable-next-line no-restricted-syntax -- test needs wider type
    const item = result[0] as { name: string };
    expect(item.name).toBe('tool');
  });

  it('handles tool_use with shell name but non-array command', () => {
    const result = mapOutputItems([
      { type: 'tool_use', id: 'call_sh', name: 'shell', input: { command: 'ls -la' } },
    ] as never[]);
    // eslint-disable-next-line no-restricted-syntax -- test needs wider type
    const item = result[0] as { type: string; action: { command: string[] } };
    expect(item.type).toBe('local_shell_call');
    // Command string (not array) should result in empty array
    expect(item.action.command).toEqual([]);
  });

  it('handles tool_use with name set but empty input', () => {
    const result = mapOutputItems([
      { type: 'tool_use', id: 'call_2', name: 'shell', input: null },
    ] as never[]);
    // eslint-disable-next-line no-restricted-syntax -- test needs wider type
    const item = result[0] as { type: string; arguments: string };
    expect(item.type).toBe('local_shell_call');
    expect(item.arguments).toBe('{}');
  });

  it('handles thinking block with null/undefined text', () => {
    const result = mapOutputItems([
      { type: 'thinking' },
    ] as never[]);
    const item = result[0] as { type: string; content: Array<{ text: string }> };
    expect(item.type).toBe('reasoning');
    expect(item.content[0].text).toBe('');
  });
});
