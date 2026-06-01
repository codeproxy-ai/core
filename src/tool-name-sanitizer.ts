// ==============================================================================
// Tool Name Sanitizer
// ==============================================================================
// Some Chat Completions upstreams (e.g. DeepSeek) reject tool names that
// contain chars outside [a-zA-Z0-9_-].  Namespace tools flattened by
// translateRequest use dots as separators (e.g. "multi_agent_v1.spawn_agent").
//
// These helpers sanitize names before the upstream request and restore the
// originals in the response/stream so callers always see the original names.

/** Replace [^a-zA-Z0-9_-] with '_'; mutates body.tools in place.
 *  Returns a map of sanitized→original for every renamed tool. */
export function sanitizeUpstreamToolNames(body: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  const tools = body.tools;
  if (!Array.isArray(tools)) {
    return map;
  }
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- Chat Completions tool is Record; no stable type
    const toolRecord = tool as Record<string, unknown>;
    const fn = toolRecord.function;
    if (!fn || typeof fn !== 'object') {
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- function field is Record; no stable type
    const fnRecord = fn as Record<string, unknown>;
    const original = fnRecord.name;
    if (typeof original !== 'string') {
      continue;
    }
    const sanitized = original.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitized !== original) {
      map.set(sanitized, original);
      fnRecord.name = sanitized;
    }
  }
  return map;
}

/** Restore tool_call function names in a non-streaming Chat Completions response. */
export function restoreToolNamesInChatResponse<T extends Record<string, unknown>>(
  body: T,
  map: Map<string, string>,
): T {
  if (map.size === 0) {
    return body;
  }
  const choices = body.choices;
  if (!Array.isArray(choices)) {
    return body;
  }
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') {
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- Chat Completions choice is Record; no stable type
    const choiceRecord = choice as Record<string, unknown>;
    const message = choiceRecord.message;
    if (!message || typeof message !== 'object') {
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- message is Record; no stable type
    const msg = message as Record<string, unknown>;
    const toolCalls = msg.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') {
        continue;
      }
      // eslint-disable-next-line no-restricted-syntax -- tool call is Record; no stable type
      const callRecord = tc as Record<string, unknown>;
      const fn = callRecord.function;
      if (!fn || typeof fn !== 'object') {
        continue;
      }
      // eslint-disable-next-line no-restricted-syntax -- function is Record; no stable type
      const fnRecord = fn as Record<string, unknown>;
      const name = fnRecord.name;
      if (typeof name === 'string' && map.has(name)) {
        fnRecord.name = map.get(name);
      }
    }
  }
  return body;
}

/** Wrap a ReadableStream<Uint8Array> to restore tool names on the fly (handles SSE). */
export function createToolNameRestoreStream(
  body: ReadableStream<Uint8Array>,
  map: Map<string, string>,
): ReadableStream<Uint8Array> {
  if (map.size === 0) {
    return body;
  }
  const entries = Array.from(map.entries());
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // eslint-disable-next-line no-restricted-syntax -- try/catch needed for stream error handling
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        let text = decoder.decode(value, { stream: true });
        for (const [sanitized, original] of entries) {
          const escapedSanitized = sanitized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`("name"\\s*:\\s*")${escapedSanitized}(")`, 'g');
          text = text.replace(re, `$1${original}$2`);
        }
        controller.enqueue(encoder.encode(text));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel().catch(() => {
        /* noop */
      });
    },
  });
}
