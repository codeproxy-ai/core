import type { AnthropicErrorEnvelope } from '../../types/anthropic.js';

/**
 * Anthropic reports a request-level failure with a top-level error envelope:
 * `{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }`.
 *
 * It can arrive in three places, and the last one is the dangerous one:
 *   1. as the body of a non-2xx response — handled by the transport;
 *   2. as an `event: error` frame inside an otherwise-2xx SSE stream;
 *   3. as the whole body of a **200** response, which some gateways/proxies emit
 *      when they fail to propagate the upstream status code.
 *
 * In (2) and (3) the payload has no `content` and no `usage`, so a translator
 * that reads `body.content ?? []` and `body.usage ?? {0,0}` will happily emit a
 * `status: "completed"` response with empty output and an all-zero usage report:
 * a FABRICATED SUCCESS. Downstream agents cannot tell that apart from "the model
 * legitimately said nothing", and the zero usage overwrites their context
 * accounting — observed in production as an agent whose auto-compaction meter was
 * reset to 0 while its real history was ~1.7M tokens, after which it never
 * compacted again and every subsequent request was rejected for exceeding the
 * context window.
 *
 * So: detect the envelope explicitly and surface it as a failure.
 */
export function isAnthropicErrorEnvelope(body: unknown): body is AnthropicErrorEnvelope {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const record: Record<string, unknown> = Object(body);
  if (record.type !== 'error') {
    return false;
  }
  const error = record.error;
  return typeof error === 'object' && error !== null;
}

/** `{ type, message }` for an error envelope, with defensive fallbacks. */
export function anthropicErrorInfo(envelope: AnthropicErrorEnvelope): {
  type: string;
  message: string;
} {
  const error: Record<string, unknown> = Object(envelope.error);
  const type = typeof error.type === 'string' ? error.type : 'upstream_error';
  const message =
    typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : 'upstream returned an error envelope with no message';
  return { message, type };
}
