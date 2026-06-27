// ==============================================================================
// Gemini-specific request fixups (gated on the model name)
// ==============================================================================
//
// Gemini's OpenAI-compat endpoint diverges from OpenAI Chat in two ways that
// break Codex histories. Both are applied in place, only for Gemini models.

import type { OpenAiChatMessage } from '../../types/openai_chat.js';

export function isGeminiModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const lower = model.toLowerCase();
  return lower.includes('gemini') || lower.startsWith('google/');
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') {
      out += part;
    } else if (part && typeof part === 'object') {
      // eslint-disable-next-line no-restricted-syntax -- text read from an unknown content part
      out += String((part as { text?: string }).text ?? '');
    }
  }
  return out;
}

/**
 * Gemini's OpenAI-compat endpoint silently honors ONLY the last system message.
 * Codex emits several (base instructions, role prompt, usage hints), so fold
 * every system message into one at the front, preserving order.
 */
function mergeSystemMessages(messages: OpenAiChatMessage[]): void {
  const systemTexts: string[] = [];
  const rest: OpenAiChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemTexts.push(extractTextContent(msg.content));
    } else {
      rest.push(msg);
    }
  }
  if (systemTexts.length <= 1) {
    return;
  }
  messages.length = 0;
  messages.push({ role: 'system', content: systemTexts.join('\n\n') }, ...rest);
}

const MULTI_TOOL_USE_MANDATE =
  'Use `multi_tool_use.parallel` to parallelize tool calls and only this.';
const MULTI_TOOL_USE_REWRITE =
  'Parallelize by returning multiple tool calls in a single response. A tool named `multi_tool_use.parallel` does NOT exist in this environment — never call it.';
// Matches Codex's rejection for both observed spellings: "unsupported call:
// parallel" and "unsupported call: multi_tool_useparallel".
const UNSUPPORTED_PARALLEL_RE = /^unsupported call: (?:multi_tool_use\W*)?parallel/iu;
const UNSUPPORTED_PARALLEL_HINT =
  ' (`multi_tool_use.parallel` is not a real tool here. Re-issue each inner call as its own separate tool call — several tool calls in one response are fine.)';

/**
 * Codex's base instructions mandate the GPT-only `multi_tool_use.parallel`
 * wrapper. Gemini obeys it, the dispatcher rejects "unsupported call: parallel",
 * and the model loops retrying. Rewrite the mandate to native guidance and
 * append a corrective hint to the rejection so an in-loop model self-corrects.
 */
function applyGeminiToolUseShim(messages: OpenAiChatMessage[]): void {
  for (const msg of messages) {
    if (
      msg.role === 'system' &&
      typeof msg.content === 'string' &&
      msg.content.includes(MULTI_TOOL_USE_MANDATE)
    ) {
      msg.content = msg.content.split(MULTI_TOOL_USE_MANDATE).join(MULTI_TOOL_USE_REWRITE);
    } else if (
      msg.role === 'tool' &&
      typeof msg.content === 'string' &&
      UNSUPPORTED_PARALLEL_RE.test(msg.content)
    ) {
      msg.content = msg.content + UNSUPPORTED_PARALLEL_HINT;
    }
  }
}

/**
 * Apply all Gemini-specific message fixups in place. No-op for non-Gemini
 * models, so it is safe to call unconditionally.
 */
export function applyGeminiFixups(messages: OpenAiChatMessage[], model: string | undefined): void {
  if (!isGeminiModel(model)) {
    return;
  }
  mergeSystemMessages(messages);
  applyGeminiToolUseShim(messages);
}
