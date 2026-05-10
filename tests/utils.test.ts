import { describe, expect, it } from 'vitest';
import { nowMs, nextSeq, makeId } from '../src/utils/id.js';
import { safeJsonParse, jsonStringifySafe } from '../src/utils/json.js';
import { parseSseStream, encodeSseEvent } from '../src/utils/sse.js';

describe('id utils', () => {
  it('nowMs returns a number', () => {
    expect(typeof nowMs()).toBe('number');
    expect(nowMs()).toBeGreaterThan(0);
  });

  it('nextSeq returns incrementing values', () => {
    const a = nextSeq();
    const b = nextSeq();
    expect(b).toBe((a + 1) & 0x7fffffff);
  });

  it('makeId generates correct format', () => {
    const id = makeId('test');
    expect(id).toMatch(/^test_\d+_\d+$/);
  });
});

describe('json utils', () => {
  it('safeJsonParse returns parsed value for valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('safeJsonParse returns undefined for invalid JSON', () => {
    expect(safeJsonParse('invalid')).toBeUndefined();
  });

  it('jsonStringifySafe returns JSON string for valid input', () => {
    expect(jsonStringifySafe({ a: 1 })).toBe('{"a":1}');
  });

  it('jsonStringifySafe returns empty string for circular reference', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(jsonStringifySafe(obj)).toBe('');
  });
});

describe('SSE utils', () => {
  it('encodeSseEvent serializes with object data', () => {
    const result = encodeSseEvent('test', { msg: 'hello' });
    expect(result).toBe('event: test\ndata: {"msg":"hello"}\n\n');
  });

  it('encodeSseEvent serializes with string data', () => {
    const result = encodeSseEvent('test', 'raw string');
    expect(result).toBe('event: test\ndata: raw string\n\n');
  });

  it('parseSseStream handles multiple events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: a\ndata: {"n":1}\n\n'));
        controller.enqueue(encoder.encode('event: b\ndata: {"n":2}\n\n'));
        controller.close();
      },
    });

    const events: Array<{ event?: string; data: string }> = [];
    for await (const msg of parseSseStream(stream)) {
      events.push(msg);
    }
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('a');
    expect(events[1].event).toBe('b');
  });

  it('parseSseStream handles events without event field', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"n":1}\n\n'));
        controller.close();
      },
    });
    for await (const msg of parseSseStream(stream)) {
      expect(msg.event).toBeUndefined();
      expect(msg.data).toBe('{"n":1}');
    }
  });

  it('parseSseStream handles comment lines', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(':comment\ndata: value\n\n'));
        controller.close();
      },
    });
    for await (const msg of parseSseStream(stream)) {
      expect(msg.data).toBe('value');
    }
  });

  it('parseSseStream handles trailing data as final event', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\ndata: second'));
        controller.close();
      },
    });
    const events: Array<{ data: string }> = [];
    for await (const msg of parseSseStream(stream)) {
      events.push(msg);
    }
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('first');
    expect(events[1].data).toBe('second');
  });

  it('parseSseStream skips blocks with no data lines', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: only\n\n'));
        controller.close();
      },
    });
    const events: Array<unknown> = [];
    for await (const msg of parseSseStream(stream)) {
      events.push(msg);
    }
    expect(events).toHaveLength(0);
  });

  it('parseSseStream handles CRLF line endings', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: hello\r\n\r\n'));
        controller.close();
      },
    });
    for await (const msg of parseSseStream(stream)) {
      expect(msg.data).toBe('hello');
    }
  });

  it('parseSseStream handles field without colon', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data\n\n'));
        controller.close();
      },
    });
    for await (const msg of parseSseStream(stream)) {
      expect(msg.data).toBe('');
    }
  });


});
