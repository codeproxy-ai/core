// ==============================================================================
// Thought-signature tunnel (call_id transport)
// ==============================================================================
//
// Some Responses API clients (notably codex-ts, whose ResponseItem mirrors
// codex-rs's protocol and only round-trips {type, call_id, name, arguments})
// DROP the `thought_signature` field we set on a function_call output item. When
// the signature is lost, Gemini cannot continue its thinking chain across tool
// calls on the next turn — the caller falls back to `fallbackThoughtSignature`
// (i.e. skips signature validation) and the reasoning context is gone.
//
// This OPT-IN tunnel smuggles the signature through the one field such clients
// DO preserve verbatim: `call_id`. On the response we append the signature to
// the call_id after a sentinel; on the next request we split it back off,
// restoring the clean call_id sent upstream and recovering the signature. The
// client only ever stores/echoes an opaque string, so it needs no awareness of
// the field — no codex-ts / codex-rs change, and only the Gemini path opts in.
//
// The sentinel cannot collide with real data: OpenAI / Vertex call_ids are
// [A-Za-z0-9_-] and Gemini thought signatures are base64 — neither contains
// `~`. We still guard defensively and no-op if the sentinel somehow appears.

const TUNNEL_SEP = '~gts~';

/** Append a thought signature to a call_id for transport through a client that
 *  drops the dedicated `thought_signature` field. No-op when either side is
 *  empty or the sentinel would collide (never double-encodes). */
export function encodeCallIdWithSignature(callId: string, signature: string): string {
  if (!callId || !signature) {
    return callId;
  }
  if (callId.includes(TUNNEL_SEP) || signature.includes(TUNNEL_SEP)) {
    return callId;
  }
  return `${callId}${TUNNEL_SEP}${signature}`;
}

/** Split a (possibly tunneled) call_id back into the clean call_id plus the
 *  embedded thought signature, if present. A plain call_id passes through
 *  unchanged with no signature. */
export function decodeCallId(rawCallId: string): {
  callId: string;
  thoughtSignature?: string;
} {
  const idx = rawCallId.indexOf(TUNNEL_SEP);
  if (idx === -1) {
    return { callId: rawCallId };
  }
  const signature = rawCallId.slice(idx + TUNNEL_SEP.length);
  return {
    callId: rawCallId.slice(0, idx),
    thoughtSignature: signature || undefined,
  };
}
