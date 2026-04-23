# responses-api-translator

A zero-dependency TypeScript library that translates between the **OpenAI
Responses API** and third-party AI provider APIs. Designed to run in **pure
frontend** environments (browser, edge runtimes) — **no proxy server
required**.

This package only performs **format translation**. It does not manage API
keys, storage, or any transport state. Authentication is purely
caller-driven: you set `Authorization: Bearer <key>` (or the provider's
native header) on your outbound call like you would against the real OpenAI
Responses endpoint, and the wrapper forwards it.

Currently supported providers:

- **Anthropic Claude** (Messages API, including streaming SSE, tool use,
  thinking / reasoning, image & file blocks, prompt caching).

## Install

```bash
npm install responses-api-translator
```

## Quick start

The recommended entry point is `createResponsesFetch`, which returns a
`fetch`-compatible function that transparently translates any `POST` to
`/v1/responses` into the chosen provider's wire format (JSON or SSE).

### Without the OpenAI SDK (plain `fetch`)

The wrapper *is* a `fetch`, so call it exactly like you would call the real
OpenAI Responses endpoint. Any host works — only the `/v1/responses` path
suffix is inspected.

```ts
import { createResponsesFetch, parseSseStream } from 'responses-api-translator';

const apiFetch = createResponsesFetch({ provider: 'claude' });

// Non-streaming
const res = await apiFetch('https://api.anthropic.com/v1/responses', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${ANTHROPIC_API_KEY}`,
    // In the browser, Anthropic additionally requires:
    // 'anthropic-dangerous-direct-browser-access': 'true',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-5',
    instructions: 'You are a helpful assistant.',
    input: 'Hello!',
  }),
});
const json = await res.json();
console.log(json.output);

// Streaming (SSE)
const stream = await apiFetch('https://api.anthropic.com/v1/responses', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${ANTHROPIC_API_KEY}`,
  },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'Hi', stream: true }),
});

for await (const msg of parseSseStream(stream.body!)) {
  if (msg.data === '[DONE]') break;
  const evt = JSON.parse(msg.data);
  if (evt.type === 'response.output_text.delta') {
    process.stdout.write(evt.delta);
  }
}
```

### With the OpenAI SDK

```ts
import OpenAI from 'openai';
import { createResponsesFetch } from 'responses-api-translator';

const openai = new OpenAI({
  apiKey: ANTHROPIC_API_KEY,            // forwarded as-is to the provider
  baseURL: 'https://api.anthropic.com/v1', // any host works; only the /v1/responses path is inspected
  dangerouslyAllowBrowser: true,        // browser-only, for the OpenAI SDK itself
  fetch: createResponsesFetch({ provider: 'claude' }),
  defaultHeaders: {
    // Required for browser calls to Anthropic:
    // 'anthropic-dangerous-direct-browser-access': 'true',
  },
});

const res = await openai.responses.create({
  model: 'claude-sonnet-4-5',
  input: 'Hello!',
});

const stream = await openai.responses.create({
  model: 'claude-sonnet-4-5',
  input: 'Tell me a joke.',
  stream: true,
});
for await (const event of stream) {
  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
}
```

The wrapper only intercepts `POST /v1/responses`. Any other request
(chat completions, embeddings, files, …) is forwarded to the underlying
`fetch` or `passthroughFetch` unchanged.

### Pure translation (no HTTP)

If you already own the transport (custom proxy, signed headers, etc.) you can
call the translators directly and skip the fetch wrapper entirely:

```ts
import {
  translateRequest,
  translateResponse,
  translateStream,
} from 'responses-api-translator/claude';

// Responses API request -> Anthropic Messages API request body
const { request: anthropicBody } = translateRequest({
  model: 'claude-sonnet-4-5',
  input: 'hi',
});

// POST `anthropicBody` to Anthropic yourself, then map back:
const responsesResponse = translateResponse(anthropicResponseJson, {
  model: 'claude-sonnet-4-5',
});

// Or, for streaming, pipe the fetch body through the translator:
for await (const evt of translateStream(fetchResponse.body!, { model: 'claude-sonnet-4-5' })) {
  // evt matches the Responses API SSE event shape
}
```

## `createResponsesFetch` behaviour

- Matches any `POST` whose URL path ends in `/v1/responses`. The host you
  pass is **never** contacted — it is only used as a trigger pattern. The
  actual upstream request is sent to the provider (`options.baseUrl`, default
  `https://api.anthropic.com/v1/messages` for Claude). You can therefore use
  any URL that ends with `/v1/responses` — provider-branded
  (`https://api.anthropic.com/v1/responses`), neutral
  (`https://example.invalid/v1/responses`), or just the relative path
  (`/v1/responses`).
- Forwards the caller's headers to the provider, after:
  - Dropping request-only / OpenAI-internal headers (`host`, `content-length`,
    `connection`, `accept-encoding`, `accept`, `user-agent`, `openai-*`,
    `x-stainless-*`).
  - Rewriting `Authorization: Bearer <key>` → `x-api-key: <key>` for Anthropic
    (an explicit `x-api-key` header is respected as-is).
  - Injecting `anthropic-version` when missing.
- Parses the JSON body, runs `translateRequest`, issues the provider call, and
  translates the upstream response back into the Responses-API shape (JSON)
  or SSE stream (ending with `data: [DONE]`).
- Upstream errors are re-wrapped as `{ "error": { "message", "type", "code" } }`
  with the original HTTP status code preserved.
- Anything that is not a `POST /v1/responses` is forwarded to `passthroughFetch`
  (defaulting to `options.fetch` or `globalThis.fetch`).

### Options

```ts
createResponsesFetch({
  provider: 'claude',                // 'claude' | 'anthropic'
  baseUrl?: string,                  // override upstream URL
  apiVersion?: string,               // override 'anthropic-version' (default 2023-06-01)
  defaultHeaders?: Record<string, string>,
  fetch?: typeof fetch,              // underlying fetch (defaults to globalThis.fetch)
  passthroughFetch?: typeof fetch,   // fetch used for non-/responses paths
  translate?: TranslateRequestOptions,
});
```

## Run as a local proxy

If you don't want to embed the translator as a `fetch` wrapper (e.g. you're
calling from a language that isn't JS, or from a tool whose HTTP client isn't
pluggable), this package also ships a tiny local HTTP proxy that exposes the
**OpenAI Responses API** on one port and forwards translated requests to the
configured provider.

Like the `fetch` wrapper, the proxy is **auth-agnostic**: credentials are
never stored — callers must send `Authorization: Bearer <key>` (or the
provider's native header) on every request.

### CLI

```bash
npx responses-api-translator --provider claude
# responses-api-translator listening on http://127.0.0.1:8787/v1/responses

# Now point any Responses-API client at http://127.0.0.1:8787
curl -N http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ANTHROPIC_API_KEY" \
  -d '{"model":"claude-sonnet-4-5","input":"Hello!","stream":true}'
```

Common flags:

| Flag | Default | Description |
| --- | --- | --- |
| `--config <file>` | — | Use a config file instead of --provider. See [CONFIG.md](./CONFIG.md) for details. |
| `--provider <name>` | — | **Required.** `claude` or `anthropic`. |
| `--host <host>` | `127.0.0.1` | Bind host. Use `0.0.0.0` for LAN. |
| `-p, --port <port>` | `8787` | Bind port. `0` picks a random free port. |
| `--base-url <url>` | provider default | Override upstream endpoint. |
| `--api-version <ver>` | `2023-06-01` | Override `anthropic-version` header. |
| `--no-cors` | CORS on | Disable the permissive CORS headers (browser dev only). |

### Programmatic

```ts
import { startProxy } from 'responses-api-translator/server';

const proxy = await startProxy({
  provider: 'claude',
  host: '127.0.0.1',
  port: 8787,
});
console.log(`Listening on ${proxy.url}`);

// …later
await proxy.close();
```

`startProxy` accepts the same options as `createResponsesFetch`
(`provider`, `baseUrl`, `apiVersion`, `defaultHeaders`, `fetch`,
`translate`) plus `host`, `port`, `cors`, `logger`.

The proxy only implements `POST /v1/responses`. Any other path returns `404`.
It is designed for local dev / desktop apps; it does not authenticate,
rate-limit, or persist anything.


## What gets translated

### Request (Responses → Anthropic)

- `instructions` → `system` blocks (with optional `cache_control`).
- `input` items → ordered `messages`:
  - Text / image / file content parts mapped to Anthropic content blocks
    (`text`, `image` base64/url, `document`).
  - `function_call` / `local_shell_call` / `commandExecution` / `fileChange`
    / `custom_tool_call` → `tool_use` blocks.
  - `function_call_output` / `commandExecutionOutput` / `custom_tool_call_output`
    → `tool_result` blocks, automatically re-ordered and repaired so each
    `tool_use` is immediately followed by its matching `tool_result`.
- `tools` with `type: 'function'` → Anthropic `{ name, description, input_schema }`.
  Anthropic built-in server tools (`web_search_20250305`, `computer_use_…`,
  `text_editor_…`, `bash_…`) are passed through unchanged.
- `tool_choice`: `auto` / `required` / `none` / `{type:'function',function:{name}}`
  → Anthropic equivalents.
- `reasoning.effort` (`low` / `medium` / `high`) → `thinking: { type: 'enabled', budget_tokens }`
  with sane defaults (overridable via `TranslateRequestOptions.reasoningBudgets`).
- `max_output_tokens` / `max_tokens` → Anthropic `max_tokens` (required by Anthropic).

### Response (Anthropic → Responses)

- Anthropic `text` blocks → single `message` output item with
  `{ type: 'output_text', text }` content.
- Anthropic `tool_use` → `function_call` output item. Shell-ish tools
  (`shell`, `container.exec`, `shell_command`) are promoted to
  `local_shell_call` with an `action.exec.command` field.
- Anthropic `thinking` → `reasoning` output item.
- Usage / cache tokens preserved under `usage.input_tokens_details`.

### Streaming

`translateStream` consumes an Anthropic SSE `ReadableStream<Uint8Array>` and
yields Responses-API style events:

- `response.created`
- `response.output_item.added`
- `response.output_text.delta`
- `response.reasoning_text.delta`
- `response.function_call_arguments.delta`
- `response.output_item.done`
- `response.completed` (with final `output` + `usage`)

If you already have parsed Anthropic events, use `translateAnthropicEvents`
instead.

## API reference

### `createResponsesFetch(options)`

Returns a `fetch`-compatible function. See the “behaviour” and “options”
sections above.

**Note:** For detailed configuration file usage, see [CONFIG.md](./CONFIG.md).

### `translateRequest(req, options?)`

```ts
function translateRequest(
  req: ResponsesRequest,
  options?: {
    defaultMaxTokens?: number;          // default 8192
    reasoningBudgets?: { minimal?: number; low?: number; medium?: number; high?: number };
  },
): { request: AnthropicRequest; hasPromptCache: boolean };
```

### `translateResponse(body, options?)`

```ts
function translateResponse(
  body: AnthropicResponse,
  options?: { responseId?: string; createdAt?: number; model?: string },
): ResponsesResponse;
```

### `translateStream(stream, options?)` / `translateAnthropicEvents(iter, options?)`

```ts
function translateStream(
  stream: ReadableStream<Uint8Array>,
  options?: {
    model?: string;
    responseId?: string;
    createdAt?: number;
    requestMetadata?: {
      temperature?: number;
      top_p?: number;
      tools?: unknown[];
      tool_choice?: unknown;
      store?: boolean;
      metadata?: Record<string, unknown>;
    };
  },
): AsyncGenerator<ResponsesStreamEvent>;
```

### SSE helpers

```ts
import { parseSseStream, encodeSseEvent } from 'responses-api-translator';
```

- `parseSseStream(stream)` — async-iterates `{ event?, data }` messages from a
  byte `ReadableStream`. Works in both browser and Node 18+.
- `encodeSseEvent(event, data)` — serialize a message to the SSE wire format.

## Runtime requirements

- **Node.js**: 18+ (needs global `fetch` and `ReadableStream`).
- **Browsers**: any modern browser that ships `fetch` + WHATWG Streams.
- **Edge runtimes** (Cloudflare Workers, Vercel Edge, Deno): fully supported.

Zero runtime dependencies.

## Roadmap

- Gemini provider
- Z.AI / GLM provider
- OpenAI Chat Completions provider

## License

MIT

## Configuration

The proxy server can be configured using a `config.json` file. Copy `config.example.json` and customize it with your settings:

```bash
cp config.example.json config.json
# Edit config.json with your API keys and settings
```

### Configuration Options

- `provider`: API provider to use (`claude` or `zai`)
- `port`: Port to listen on (default: 8787)
- `host`: Host to bind to (default: 127.0.0.1)
- `apiKey`: Your API key for the provider
- `baseUrl`: Optional custom base URL for the API
- `model`: Optional model override
- `cors`: Enable CORS headers (default: true)
- `logLevel`: Logging level (`info`, `warn`, `error`)

### Security Note

**Never commit `config.json` to version control!** It contains sensitive API keys.

- `config.json` is listed in `.gitignore` to prevent accidental commits
- Use `config.example.json` as a template for your configuration
- Keep your real API keys only in your local `config.json`

### Quick Start

1. Copy the example configuration:
   ```bash
   cp config.example.json config.json
   ```

2. Edit `config.json` with your API key and settings

3. Start the server:
   ```bash
   npm run dev:config
   ```
