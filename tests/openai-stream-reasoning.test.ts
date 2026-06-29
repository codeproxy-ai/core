import { describe, expect, it } from 'vitest';
import { translateStream } from '../src/translate/openai/translateStream.js';
import type { ResponsesStreamEvent } from '../src/types/responses.js';

describe('openai translateStream - reasoning content', () => {
  it('surfaces delta.reasoning_content as response.reasoning_text.delta', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        // thinking chunks first, then the answer
        c.enqueue(
          encoder.encode(
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"let me think"}}]}\n\n',
          ),
        );
        c.enqueue(
          encoder.encode(
            'data: {"choices":[{"index":0,"delta":{"reasoning_content":" harder"}}]}\n\n',
          ),
        );
        c.enqueue(
          encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n'),
        );
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const events: ResponsesStreamEvent[] = [];
    for await (const evt of translateStream(stream)) {
      events.push(evt);
    }

    const reasoningDeltas = events.filter(
      (e) => e.type === 'response.reasoning_text.delta',
    ) as unknown as Array<{ delta: string }>;
    expect(reasoningDeltas.map((e) => e.delta)).toEqual(['let me think', ' harder']);

    // a reasoning output item was opened
    const reasoningAdded = events.find(
      (e) =>
        e.type === 'response.output_item.added' &&
        (e as { item?: { type?: string } }).item?.type === 'reasoning',
    );
    expect(reasoningAdded).toBeTruthy();

    // answer text still flows as output_text
    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(textDeltas.length).toBe(1);
  });
});
