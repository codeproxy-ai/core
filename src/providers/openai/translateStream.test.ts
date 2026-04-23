import { describe, it, expect } from 'vitest';
import { translateStream } from './translateStream.js';

describe('OpenAI translateStream', () => {
  it('should translate SSE stream with text chunks', async () => {
    const sseData = `data: {"id":"chat-123","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chat-123","choices":[{"index":0,"delta":{"content":" world"}}]}

data: {"id":"chat-123","choices":[{"index":0,"delta":{}}],"finish_reason":"stop"}

data: [DONE]

`;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(sseData));
        controller.close();
      },
    });

    const chunks = [];
    for await (const chunk of translateStream(stream)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const text = chunks[0].output?.[0];
    expect(text).toMatchObject({
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
    });
  });

  it('should filter out [DONE] marker', async () => {
    const sseData = `data: {"id":"chat-123","choices":[{"index":0,"delta":{"content":"Hi"}}]}

data: [DONE]

`;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(sseData));
        controller.close();
      },
    });

    const chunks = [];
    for await (const chunk of translateStream(stream)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
  });

  it('should handle empty lines', async () => {
    const sseData = `

data: {"id":"chat-123","choices":[{"index":0,"delta":{"content":"Test"}}]}


`;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(sseData));
        controller.close();
      },
    });

    const chunks = [];
    for await (const chunk of translateStream(stream)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
  });
});
