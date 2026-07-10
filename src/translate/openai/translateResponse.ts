import type { OpenAiChatResponse, OpenAiChatToolCall } from '../../types/openai_chat.js';
import type {
  ResponsesOutputFunctionCall,
  ResponsesOutputItem,
  ResponsesResponse,
} from '../../types/responses.js';
import { makeId } from '../../utils/id.js';
import { safeJsonParse, jsonStringifySafe } from '../../utils/json.js';
import { encodeCallIdWithSignature } from './thought-signature-tunnel.js';

export interface TranslateResponseOptions {
  responseId?: string;
  createdAt?: number;
  model?: string;
  /** Chat Completions tool list from the translated request — used to recover
   *  namespace when the upstream omits the "namespace." prefix in a tool call. */
  requestTools?: unknown[];
  /** Tunnel the Gemini thought signature through the function_call `call_id`
   *  (append it after a sentinel) for clients that drop `thought_signature`.
   *  translateRequest strips it back off. */
  tunnelThoughtSignatureInCallId?: boolean;
}

const SHELL_TOOL_NAMES = new Set(['shell', 'container.exec', 'shell_command']);

// ==============================================================================
// Namespace Tool Helpers
// ==============================================================================

/** Build shortName → namespace map — handles both flattened Chat Completions
 *  tools ("ns.tool") and original Responses API namespace tools. */
function buildShortNameToNamespace(tools: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- Record extraction from unknown union
    const entry = tool as Record<string, unknown>;
    // eslint-disable-next-line no-restricted-syntax -- nested Record extraction
    const fn = entry.function as Record<string, unknown> | undefined;
    const flatName =
      typeof fn?.name === 'string' ? fn.name : typeof entry.name === 'string' ? entry.name : '';
    const dotIdx = flatName.indexOf('.');
    if (dotIdx !== -1) {
      map.set(flatName.slice(dotIdx + 1), flatName.slice(0, dotIdx));
      continue;
    }
    if (
      entry.type === 'namespace' &&
      typeof entry.name === 'string' &&
      Array.isArray(entry.tools)
    ) {
      const ns = entry.name;
      // eslint-disable-next-line no-restricted-syntax -- unknown[] iteration over nested tools
      for (const sub of entry.tools as unknown[]) {
        if (!sub || typeof sub !== 'object') {
          continue;
        }
        // eslint-disable-next-line no-restricted-syntax -- Record extraction from unknown
        const subEntry = sub as Record<string, unknown>;
        const subName = typeof subEntry.name === 'string' ? subEntry.name : '';
        if (subName) {
          map.set(subName, ns);
        }
      }
    }
  }
  return map;
}

/** Convert an OpenAI Chat response into a Responses-API response. */
export function translateResponse(
  body: OpenAiChatResponse,
  options: TranslateResponseOptions = {},
): ResponsesResponse {
  const createdAt = options.createdAt ?? body.created ?? Math.floor(Date.now() / 1000);
  const id = options.responseId ?? body.id ?? makeId('resp');
  const model = options.model ?? body.model ?? '';

  const choice = body.choices?.[0];
  const message = choice?.message;
  const output: ResponsesOutputItem[] = [];

  const shortNameToNs = buildShortNameToNamespace(options.requestTools ?? []);
  if (message?.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      const item = mapToolCallToOutput(tc, shortNameToNs, options.tunnelThoughtSignatureInCallId);
      if (item) {
        output.push(item);
      }
    }
  }

  if (typeof message?.content === 'string' && message.content) {
    output.push({
      id: makeId('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content }],
    });
  }

  const usage = body.usage ?? {};
  const input = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? input + completion;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    id,
    object: 'response',
    created_at: createdAt,
    model,
    status: 'completed',
    output,
    usage: {
      input_tokens: input,
      output_tokens: completion,
      total_tokens: total,
      input_tokens_details: {
        cached_tokens: cached,
      },
    },
  };
}

function mapToolCallToOutput(
  tc: OpenAiChatToolCall,
  shortNameToNs?: Map<string, string>,
  tunnelThoughtSignatureInCallId?: boolean,
): ResponsesOutputFunctionCall | undefined {
  const name = tc.function?.name;
  if (!name) {
    return undefined;
  }
  const callId = tc.id ?? makeId('call');
  let args = tc.function?.arguments ?? '';
  if (typeof args !== 'string') {
    args = jsonStringifySafe(args ?? {});
  }

  // Restore namespace so codex can route the call to the correct handler.
  // Skip splitting if the full name is already a known shell tool (e.g. "container.exec").
  // Case 1: upstream preserved the prefix  → split on first dot.
  // Case 2: upstream stripped the prefix   → look up the reverse map.
  let resolvedName = name;
  let resolvedNamespace: string | undefined;
  if (!SHELL_TOOL_NAMES.has(name)) {
    const dotIdx = name.indexOf('.');
    if (dotIdx !== -1) {
      resolvedNamespace = name.slice(0, dotIdx);
      resolvedName = name.slice(dotIdx + 1);
    } else {
      resolvedNamespace = shortNameToNs?.get(name);
    }
  }

  const item: ResponsesOutputFunctionCall = {
    id: callId,
    type: 'function_call',
    status: 'completed',
    name: resolvedName,
    ...(resolvedNamespace ? { namespace: resolvedNamespace } : {}),
    arguments: args,
    call_id: callId,
  };
  const thoughtSignature = getThoughtSignature(tc);
  if (thoughtSignature) {
    item.thought_signature = thoughtSignature;
    if (tunnelThoughtSignatureInCallId && item.call_id) {
      // Smuggle the signature through call_id for clients that drop
      // thought_signature; translateRequest splits it back off.
      item.call_id = encodeCallIdWithSignature(item.call_id, thoughtSignature);
    }
  }

  if (SHELL_TOOL_NAMES.has(resolvedName)) {
    item.type = 'local_shell_call';
    const parsed = safeJsonParse<{ command?: string[] }>(args);
    item.action = { type: 'exec', command: parsed?.command ?? [] };
  }

  return item;
}

function getThoughtSignature(tc: OpenAiChatToolCall): string | undefined {
  const sig = tc.extra_content?.google?.thought_signature ?? tc.thought_signature;
  return typeof sig === 'string' && sig ? sig : undefined;
}
