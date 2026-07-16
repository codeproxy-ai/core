/**
 * Request extraction helpers for the `/responses` fetch wrapper.
 *
 * Split so the wrapper can route from metadata alone (method/headers/signal)
 * BEFORE touching the body: the non-POST passthrough must forward the original
 * Request with its body unread, and the POST path reads the body exactly once
 * without clone() — cloning forces the runtime to buffer a second full copy of
 * the body, a real cost for multi-MB agent contexts on memory-capped edge
 * runtimes (e.g. 128 MB Cloudflare Workers isolates).
 */

export function isResponsesEndpoint(url: string): boolean {
  // eslint-disable-next-line no-restricted-syntax -- try/catch needed for server-side HTTP error handling
  try {
    return /\/v1\/responses\/?$/.test(new URL(url, 'http://_internal_').pathname);
  } catch {
    return /\/v1\/responses(?:\?|$)/.test(url);
  }
}

export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

export function parseHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) {
    return out;
  }
  if (typeof Headers !== 'undefined' && raw instanceof Headers) {
    raw.forEach((val, key) => {
      out[key.toLowerCase()] = val;
    });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) {
      out[String(k).toLowerCase()] = String(v);
    }
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

/** Metadata-only extraction — never touches the body. */
export function extractRequestMeta(
  input: RequestInfo | URL,
  init?: RequestInit,
): {
  signal: AbortSignal | undefined;
  method: string;
  headers: Record<string, string>;
} {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return { signal: input.signal, method: input.method, headers: parseHeaders(input.headers) };
  }
  return {
    signal: init?.signal ?? undefined,
    method: init?.method?.toUpperCase() ?? 'GET',
    headers: parseHeaders(init?.headers),
  };
}

/** Body extraction for the /responses POST path — single read, no clone(). */
export async function extractRequestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | undefined> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const text = await input.text();
    return text || undefined;
  }
  return init?.body != null
    ? typeof init.body === 'string'
      ? init.body
      : readBody(init.body)
    : undefined;
}

async function readBody(body: BodyInit): Promise<string> {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  return String(body);
}
