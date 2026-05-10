import { describe, expect, it } from 'vitest';
import { translateResponse, mapOutputItems } from '../src/translate/anthropic/translateResponse.js';

describe('anthropic translateResponse - remaining branch coverage', () => {
  it('handles content items with non-string text values', () => {
    const result = mapOutputItems([
      { type: 'text', text: null },
      { type: 'text', text: 'Hello' },
    ] as never[]);
    const msg = result[0] as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe('Hello');
  });

  it('handles content items where tool_use has empty id', () => {
    const result = mapOutputItems([
      { type: 'tool_use', id: undefined, name: 'search', input: { q: 'test' } },
    ] as never[]);
    const item = result[0] as { id: string; call_id: string };
    expect(item.id).toBeTruthy();
  });
});
