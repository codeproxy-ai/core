# responses-api-translator

A zero-dependency TypeScript library that translates between the **OpenAI
Responses API** and upstream AI APIs (Anthropic Messages, OpenAI-compatible
Chat Completions — OpenAI, ZAI, DeepSeek, …). Runs in the browser, Node 18+,
and edge runtimes; no server required for the `fetch` wrapper.

This package only performs **format translation**. Authentication is
caller-driven: set `Authorization: Bearer <key>` (or the upstream's native
header) on your outbound call and the wrapper forwards it upstream.

## Install

```bash
npm install responses-api-translator
```

## Concepts

- **Client side** always speaks the OpenAI Responses API (`POST /v1/responses`).
- **Upstream** speaks one of two formats, identified by `upstreamFormat`:
  - `'anthropic'` — Anthropic Messages API
  - `'openai-chat'` — OpenAI-compatible Chat Completions
- `upstreamFormat` is **optional**. If omitted, it is inferred from `baseUrl`.
- `baseUrl` can omit the path suffix — if only the host is given, `/v1/messages`
  (anthropic) or `/v1/chat/completions` (openai-chat) is appended automatically.
  You can also use `https://api.example.com/v1` and the remaining part is appended.

## Quick start

### Plain `fetch`

```ts
import { createResponsesFetch, parseSseStream } from 'responses-api-translator';

const apiFetch = createResponsesFetch({
  baseUrl: 'https://api.anthropic.com/v1', // inferred → anthropic, appends /messages
});

const res = await apiFetch('https://example.invalid/v1/responses', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${ANTHROPIC_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-5',
    instructions: 'You are a helpful assistant.',
    input: 'Hello!',
  }),
});
const json = await res.json();
```

Streaming:

```ts
const stream = await apiFetch('https://example.invalid/v1/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'Hi', stream: true }),
});
for await (const msg of parseSseStream(stream.body!)) {
  if (msg.data === '[DONE]') break;
  const evt = JSON.parse(msg.data);
  if (evt.type === 'response.output_text.delta') process.stdout.write(evt.delta);
}
```

### With the OpenAI SDK

```ts
import OpenAI from 'openai';
import { createResponsesFetch } from 'responses-api-translator';

const openai = new OpenAI({
  apiKey: API_KEY,
  baseURL: 'https://example.invalid/v1', // only the /v1/responses path is inspected
  fetch: createResponsesFetch({
    baseUrl: 'https://api.openai.com/v1', // inferred → openai-chat, appends /chat/completions
  }),
});

const res = await openai.responses.create({ model: 'gpt-4o-mini', input: 'Hello' });
```

### Explicit `upstreamFormat`

If the URL doesn't match the inference rules, pass it explicitly:

```ts
createResponsesFetch({
  upstreamFormat: 'openai-chat',
  baseUrl: 'https://my-gateway.example.com/v1',
});
```

## `createResponsesFetch(options)`

```ts
createResponsesFetch({
  baseUrl: string,                       // required — upstream endpoint
  upstreamFormat?: 'anthropic' | 'openai-chat', // optional — inferred from baseUrl
  apiVersion?: string,                   // anthropic-version header (anthropic only)
  model?: string,                        // override model field in incoming requests
  defaultHeaders?: Record<string, string>,
  fetch?: typeof fetch,                  // underlying fetch
  passthroughFetch?: typeof fetch,       // fetch used for non-/responses paths
  onCacheStats?: (stats) => void,
});
```

Behaviour:

- Matches any `POST` whose URL path ends in `/v1/responses`. The host is only a
  trigger — the actual request goes to `options.baseUrl`.
- Forwards caller headers upstream after dropping transport-only and
  OpenAI-internal headers, and (for `anthropic`) rewriting
  `Authorization: Bearer <key>` → `x-api-key: <key>` and injecting
  `anthropic-version` when missing.
- Upstream errors are preserved with the original HTTP status.
- Non-`/v1/responses` requests are forwarded to `passthroughFetch` unchanged.

## Run as a local proxy

```bash
# Auto-infer upstreamFormat from --base-url
npx responses-api-translator --base-url https://api.anthropic.com/v1

# Explicit format
npx responses-api-translator --upstream-format openai-chat \
  --base-url https://api.openai.com/v1

# From config file
npx responses-api-translator --config ./config.json
```

Point any Responses-API client at `http://127.0.0.1:8787`:

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $API_KEY" \
  -d '{"model":"claude-sonnet-4-5","input":"Hello!","stream":true}'
```

### CLI flags

| Flag | Default | Description |
| --- | --- | --- |
| `--base-url <url>` | — | **Required** (unless `--config`). Upstream endpoint. |
| `--upstream-format <fmt>` | inferred | `anthropic` or `openai-chat`. |
| `--config <file>` | — | Use a JSON config file. |
| `--host <host>` | `127.0.0.1` | Bind host. |
| `-p, --port <port>` | `8787` | Bind port (`0` = random). |
| `--api-version <ver>` | `2023-06-01` | Override `anthropic-version`. |
| `--apikey <key>` | — | Inject `Authorization: Bearer <key>` for upstream. |
| `--model <name>` | — | Override the incoming `model` field. |
| `--drop-images` | — | Drop image/file parts from user messages (for text-only upstreams). |
| `--no-cors` | CORS on | Disable permissive CORS. |

### Config file

```json
{
  "version": "1.0",
  "currentUpstream": "anthropic",
  "upstreams": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKey": "sk-ant-...",
      "model": "claude-sonnet-4-5",
      "dropImages": true
    },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "gpt-4o-mini"
    }
  }
}
```

`format` is optional — inferred from `baseUrl` when omitted.
`baseUrl` can omit the path suffix (`/v1/messages` or `/v1/chat/completions`);
it is appended automatically based on the format.

### Programmatic

```ts
import { startProxy } from 'responses-api-translator/server';

const proxy = await startProxy({
  baseUrl: 'https://api.anthropic.com/v1', // appends /messages
  host: '127.0.0.1',
  port: 8787,
});
await proxy.close();
```

## Pure translation (no HTTP)

```ts
import { translate } from 'responses-api-translator';

// Responses → Anthropic
const { request } = translate.anthropic.translateRequest({
  model: 'claude-sonnet-4-5',
  input: 'hi',
});

// Anthropic → Responses
const responsesResponse = translate.anthropic.translateResponse(anthropicJson, {
  model: 'claude-sonnet-4-5',
});

// Streaming
for await (const evt of translate.openai.translateStream(upstream.body!, {
  model: 'gpt-4o-mini',
})) {
  // evt matches the Responses API SSE event shape
}
```

## SSE helpers

```ts
import { parseSseStream, encodeSseEvent } from 'responses-api-translator';
```

## Runtime requirements

- Node.js 18+ (global `fetch` + `ReadableStream`).
- Modern browsers with `fetch` + WHATWG Streams.
- Edge runtimes (Cloudflare Workers, Vercel Edge, Deno).

Zero runtime dependencies. MIT.
