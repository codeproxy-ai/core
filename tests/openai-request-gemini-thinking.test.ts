import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

describe('translateRequest (Responses -> OpenAI chat) — reasoning effort', () => {
  it('maps reasoning.effort to google.thinking_config.include_thoughts for Gemini (no reasoning_effort)', () => {
    const { request } = translateRequest({
      model: 'google/gemini-3.1-pro-preview',
      input: 'hi',
      reasoning: { effort: 'medium' },
    });
    const req = request as Record<string, unknown>;
    expect(req.reasoning_effort).toBeUndefined();
    expect(req.google).toEqual({ thinking_config: { include_thoughts: true } });
  });

  it('keeps reasoning_effort for non-Gemini models (no google field)', () => {
    const { request } = translateRequest({
      model: 'deepseek-reasoner',
      input: 'hi',
      reasoning: { effort: 'high' },
    });
    const req = request as Record<string, unknown>;
    expect(req.reasoning_effort).toBe('high');
    expect(req.google).toBeUndefined();
  });

  it('adds neither field when no reasoning requested', () => {
    const { request } = translateRequest({
      model: 'google/gemini-3.1-pro-preview',
      input: 'hi',
    });
    const req = request as Record<string, unknown>;
    expect(req.reasoning_effort).toBeUndefined();
    expect(req.google).toBeUndefined();
  });
});
