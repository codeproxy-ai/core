// ==============================================================================
// Gemini-specific request fixups (gated on the model name)
// ==============================================================================
//
// Gemini's OpenAI-compat endpoint diverges from OpenAI Chat in several ways that
// break Codex histories. All are applied in place, only for Gemini models.

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

// Synthetic tool result injected to pair an orphan tool_call (a call with no
// response anywhere). Neutral on purpose: the call may have been interrupted
// mid-flight or its result simply never persisted, so we must not claim it
// succeeded or failed — only that the agent should re-check before acting.
const SYNTHETIC_TOOL_RESPONSE =
  '{"status":"no_result","note":"No tool result was recorded for this call before the request was sent (the turn was interrupted or the result was not persisted). Treat the call as unfinished — do not assume it succeeded; re-check the underlying state before retrying."}';

/**
 * Gemini enforces, per turn, that a model turn's functionCall count equals the
 * immediately-following functionResponse count — an unpaired call is a hard 400
 * ("the number of function response parts is equal to the number of function
 * call parts of the function call turn"). repairToolMessageOrder (run earlier,
 * for every provider) homes each response after its call and drops orphan
 * responses, but deliberately KEEPS an orphan tool_call: for OpenAI a trailing
 * unanswered call is legitimate. For Gemini it is fatal, so pair each such call
 * with a synthetic placeholder response. The call itself is preserved (the model
 * still sees it dispatched the call), only the missing response is filled in.
 */
function synthesizeMissingToolResponses(messages: OpenAiChatMessage[]): void {
  // tool_call_ids answered ANYWHERE — computed globally so a response that the
  // reorder placed non-contiguously can never be double-answered here.
  const answered = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id !== undefined) {
      answered.add(String(msg.tool_call_id));
    }
  }

  const out: OpenAiChatMessage[] = [];
  let cursor = 0;
  while (cursor < messages.length) {
    const msg = messages[cursor];
    out.push(msg);
    cursor += 1;
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      continue;
    }
    // Re-emit the tool responses already homed after this turn by the reorder.
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      out.push(messages[cursor]);
      cursor += 1;
    }
    // Pad every call with no response anywhere, immediately after the real ones,
    // so this turn ends up with one response per call.
    for (const call of msg.tool_calls) {
      const id = call.id ? String(call.id) : '';
      if (id && !answered.has(id)) {
        out.push({ role: 'tool', tool_call_id: id, content: SYNTHETIC_TOOL_RESPONSE });
        answered.add(id);
      }
    }
  }
  messages.length = 0;
  messages.push(...out);
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
  synthesizeMissingToolResponses(messages);
}
