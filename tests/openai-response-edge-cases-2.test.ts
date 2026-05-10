import { describe, expect, it } from 'vitest';
import { translateResponse } from '../src/translate/openai/translateResponse.js';

describe('openai translateResponse - remaining branch coverage', () => {
  it('handles body without id (makeId fallback, line 24)', () => {
    const res = translateResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
    });
    expect(res.id).toBeTruthy();
    expect(res.id.startsWith('resp')).toBe(true);
  });
});
