import { describe, expect, it } from 'vitest';

import { createResponsesFetch } from '../src/fetch.js';
import {
  translateRequest,
  isAdaptiveThinkingModel,
  normalizeAnthropicEffort,
} from '../src/translate/anthropic/translateRequest.js';

describe('adaptive thinking (Responses -> Anthropic)', () => {
  describe('isAdaptiveThinkingModel', () => {
    it('returns true for adaptive-generation Claude models (Sonnet 5+, Opus 4.6+, Fable/Mythos 5)', () => {
      for (const model of [
        'claude-sonnet-5',
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'claude-fable-5',
        'claude-mythos-5',
        'anthropic/claude-sonnet-5',
        'us.anthropic.claude-opus-4-8',
      ]) {
        expect(isAdaptiveThinkingModel(model), model).toBe(true);
      }
    });

    it('returns false for pre-4.6 Claude, Haiku, dated snapshots, and non-Claude', () => {
      for (const model of [
        'claude-sonnet-4-5',
        'claude-opus-4-5',
        'claude-opus-4-1',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-3-5-sonnet-20241022',
        'claude-3-7-sonnet',
        'claude-opus-4-20250514',
        'claude',
        'gpt-4',
        'google/gemini-3.1-pro',
        undefined,
      ]) {
        expect(isAdaptiveThinkingModel(model), String(model)).toBe(false);
      }
    });
  });

  describe('normalizeAnthropicEffort', () => {
    it('passes valid Anthropic effort levels through (case-insensitive)', () => {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        expect(normalizeAnthropicEffort(effort)).toBe(effort);
      }
      expect(normalizeAnthropicEffort('HIGH')).toBe('high');
    });

    it('returns undefined for minimal / unknown / non-string', () => {
      expect(normalizeAnthropicEffort('minimal')).toBeUndefined();
      expect(normalizeAnthropicEffort('bogus')).toBeUndefined();
      expect(normalizeAnthropicEffort(undefined)).toBeUndefined();
    });
  });

  describe('translateRequest thinking mapping', () => {
    it('adaptive model + effort -> {type:"adaptive"} + output_config.effort, no budget_tokens', () => {
      const { request } = translateRequest({
        model: 'claude-sonnet-5',
        input: 'hi',
        max_output_tokens: 16384,
        reasoning: { effort: 'high' },
      });
      expect(request.thinking).toEqual({ type: 'adaptive' });
      expect(request.thinking && 'budget_tokens' in request.thinking).toBe(false);
      expect(request.output_config).toEqual({ effort: 'high' });
    });

    it('adaptive model maps xhigh through to output_config', () => {
      const { request } = translateRequest({
        model: 'claude-opus-4-7',
        input: 'hi',
        reasoning: { effort: 'xhigh' },
      });
      expect(request.thinking).toEqual({ type: 'adaptive' });
      expect(request.output_config).toEqual({ effort: 'xhigh' });
    });

    it('adaptive model + minimal effort -> no thinking, no output_config', () => {
      const { request } = translateRequest({
        model: 'claude-opus-4-8',
        input: 'hi',
        reasoning: { effort: 'minimal' },
      });
      expect(request.thinking).toBeUndefined();
      expect(request.output_config).toBeUndefined();
    });

    it('pre-4.6 model keeps {type:"enabled", budget_tokens} and sets no output_config', () => {
      const { request } = translateRequest({
        model: 'claude-sonnet-4-5',
        input: 'hi',
        max_output_tokens: 16384,
        reasoning: { effort: 'medium' },
      });
      expect(request.thinking?.type).toBe('enabled');
      expect(typeof (request.thinking as { budget_tokens?: number }).budget_tokens).toBe('number');
      expect(request.output_config).toBeUndefined();
    });

    it('no reasoning -> no thinking on an adaptive model', () => {
      const { request } = translateRequest({ model: 'claude-sonnet-5', input: 'hi' });
      expect(request.thinking).toBeUndefined();
      expect(request.output_config).toBeUndefined();
    });
  });

  describe('createResponsesFetch anthropic upstream body', () => {
    async function captureUpstreamBody(opts: {
      model: string;
      reasoning_effort?: string;
      reasoning?: { effort: string };
    }): Promise<Record<string, unknown>> {
      let captured: Record<string, unknown> = {};
      const upstream: typeof fetch = async (_input, init) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: opts.model,
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      const fetchFn = createResponsesFetch({
        upstreamFormat: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1/messages',
        fetch: upstream,
        ...(opts.reasoning_effort ? { reasoning_effort: opts.reasoning_effort } : {}),
      });
      const res = await fetchFn('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          input: 'hi',
          ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
        }),
      });
      expect(res.status).toBe(200);
      return captured;
    }

    it('adaptive model via request reasoning.effort -> adaptive body + output_config', async () => {
      const body = await captureUpstreamBody({
        model: 'claude-sonnet-5',
        reasoning: { effort: 'high' },
      });
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('adaptive model via static reasoning_effort option -> adaptive body, not budget_tokens', async () => {
      const body = await captureUpstreamBody({
        model: 'claude-opus-4-8',
        reasoning_effort: 'medium',
      });
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'medium' });
    });

    it('pre-4.6 model via static reasoning_effort option -> legacy budget_tokens', async () => {
      const body = await captureUpstreamBody({
        model: 'claude-sonnet-4-5',
        reasoning_effort: 'high',
      });
      const thinking = body.thinking as { type: string; budget_tokens: number };
      expect(thinking.type).toBe('enabled');
      expect(thinking.budget_tokens).toBe(32768);
      expect(body.output_config).toBeUndefined();
    });
  });
});
