# @codeproxy/core

> **中文版** → [README.zh-CN.md](./README.zh-CN.md)

**@codeproxy/core** is a zero-dependency TypeScript library that converts upstream LLM responses in **Chat Completions** or **Anthropic Messages** format into the **OpenAI Responses API** format, so that AI coding agents like Codex and Claude Code can work with any language model.

The goal: **let any language model work directly in Codex or Claude Code**, no matter what API format the upstream provider speaks.

## Quick Start

```ts
import OpenAI from 'openai';
import { createResponsesFetch } from '@codeproxy/core';

const client = new OpenAI({
  fetch: createResponsesFetch({
    upstreamFormat: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultHeaders: {
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
  }),
});

const response = await client.responses.create({
  model: 'deepseek-v4-flash',
  input: 'Hello!',
});
```

## How it works

```
Upstream API (Chat Completions / Anthropic Messages)
        │
        ▼  createResponsesFetch translates automatically
        │
OpenAI Responses API ←── consumed by Codex / Claude Code
```

> **CLI** → [`@codeproxy/cli`](https://github.com/codeproxy-ai/cli) — local proxy server for running any LLM with Codex / Claude Code

## Install

```bash
npm install @codeproxy/core
```

## API

### `createResponsesFetch(options)`

Creates a `fetch` wrapper that translates Responses API traffic to the configured upstream format.

| Option | Type | Description |
|---|---|---|
| `upstreamFormat` | `'anthropic'` \| `'openai-chat'` | Upstream API format (inferred from `baseUrl` if omitted) |
| `baseUrl` | `string` | Upstream endpoint URL |
| `apiVersion` | `string` | Override Anthropic version header |
| `model` | `string` | Override the model for all requests |
| `defaultHeaders` | `Record<string, string>` | Extra headers sent to upstream |
| `dropImages` | `boolean` | Strip image parts from messages (text-only models) |
| `timeoutMs` | `number` | Upstream request timeout |
| `onCacheStats` | `(stats) => void` | Receive cache usage stats |
| `fallbackUpstream` | `object` | When `dropImages: true` and the request contains images, automatically route to this upstream instead (e.g. a vision-capable model) |

### Translators

Low-level translators are also available by namespace:

- `anthropic.translateRequest` / `anthropic.translateResponse` / `anthropic.translateStream`
- `openai.translateRequest` / `openai.translateResponse` / `openai.translateStream`
- `translate.*` — unified re-exports

### Types

All Responses API, Anthropic, and OpenAI Chat types are exported from the package root.

### Utilities

- `parseSseStream(stream)` — Consume `ReadableStream` → parsed SSE messages
- `encodeSseEvent(event, data)` — Serialize SSE event to wire format
- `makeId(prefix)` — Generate monotonic-ish IDs

## License

MIT
