import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateRequest } from '../src/translate/anthropic/translateRequest.js';
import type { AnthropicRequest, AnthropicToolUseBlock } from '../src/types/anthropic.js';

// Behavior-level regression for the Anthropic-leg tool-argument mapping.
// The OpenAI Responses spec sends `function_call.arguments` as a JSON *string*;
// `mapInputToolCall` used to keep it only when `typeof arguments === 'object'`,
// so every historical tool call was forwarded with `tool_use.input` silently
// replaced by `{}`. The existing coverage test fed `arguments: '{"q":"test"}'`
// but never asserted `tool_use.input`, which is how a 100% loss survived at
// 100% line coverage. These assertions are on the produced input VALUE.

function translateWithArguments(
  args: string | Record<string, unknown> | undefined,
): AnthropicRequest {
  return translateRequest({
    model: 'claude-sonnet-4-5',
    input: [
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        arguments: args,
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
  }).request;
}

function firstToolUse(request: AnthropicRequest): AnthropicToolUseBlock {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        return block as AnthropicToolUseBlock;
      }
    }
  }
  throw new Error('no tool_use block found in translated request');
}

describe('anthropic mapInputToolCall — function_call.arguments → tool_use.input', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a string JSON-object arguments into tool_use.input (core regression)', () => {
    const request = translateWithArguments('{"q":"test"}');
    expect(firstToolUse(request).input).toEqual({ q: 'test' });
  });

  it('passes an already-object arguments through unchanged (backward compat)', () => {
    const request = translateWithArguments({ q: 'test' });
    expect(firstToolUse(request).input).toEqual({ q: 'test' });
  });

  it('round-trips nested + unicode string arguments intact', () => {
    const decoded = {
      path: 'skills/set-canvas/SKILL.md',
      meta: { n: 1 },
      note: 'café ☕',
    };
    const request = translateWithArguments(JSON.stringify(decoded));
    expect(firstToolUse(request).input).toEqual(decoded);
  });

  describe('malformed string arguments fall back to {} without throwing', () => {
    const cases: Array<[string, string]> = [
      ['invalid JSON', '{not valid json'],
      ['empty string', ''],
      ['JSON array', '[1,2]'],
      ['JSON scalar number', '42'],
      ['JSON null', 'null'],
    ];
    for (const [label, value] of cases) {
      it(`${label} → input is {}`, () => {
        let request!: AnthropicRequest;
        expect(() => {
          request = translateWithArguments(value);
        }).not.toThrow();
        expect(firstToolUse(request).input).toEqual({});
      });
    }
  });

  describe('warn diagnostics — never leak argument payload content', () => {
    it('warns on unparseable arguments without logging the payload content', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // A recognizable sentinel standing in for the user prompts / creative
      // content that real tool arguments carry. It must NEVER reach a log line:
      // this is a general-purpose library published to npm.
      const sentinel = 'SENTINEL_PROMPT_CONTENT_DO_NOT_LOG';
      translateWithArguments(sentinel);

      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).not.toContain(sentinel);
      // Diagnostic-only: identifies the tool and reports the length, not content.
      expect(logged).toContain('search');
      expect(logged).toContain(String(sentinel.length));
    });

    it('does not warn on a valid JSON-object string or an already-object argument', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      translateWithArguments('{"q":"test"}');
      translateWithArguments({ q: 'test' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn on empty or whitespace-only arguments (ordinary no-arg calls)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      translateWithArguments('');
      translateWithArguments('   ');
      expect(warn).not.toHaveBeenCalled();
    });

    it('still warns on structurally-invalid non-object forms, with length but no content', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      translateWithArguments('[1,2]');

      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('length');
    });
  });
});
