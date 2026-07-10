import { describe, expect, it } from 'vitest';

import {
  decodeCallId,
  encodeCallIdWithSignature,
} from '../src/translate/openai/thought-signature-tunnel.js';
import { translateRequest } from '../src/translate/openai/translateRequest.js';
import { translateResponse } from '../src/translate/openai/translateResponse.js';
import type { OpenAiChatResponse } from '../src/types/openai_chat.js';
import type { ResponsesOutputFunctionCall, ResponsesOutputItem } from '../src/types/responses.js';

// A base64-ish signature containing chars (+/=) outside the call_id alphabet, to
// prove the sentinel never collides with real signature bytes.
const SIG = 'CikBrq3+9/aZ==';

function functionCall(output: ResponsesOutputItem[]): ResponsesOutputFunctionCall {
  const fc = output.find((o) => o.type === 'function_call');
  if (!fc) {
    throw new Error('expected a function_call output item');
  }
  return fc as ResponsesOutputFunctionCall;
}

function responseWithSignature(callId: string): OpenAiChatResponse {
  return {
    id: 'resp_1',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name: 'do_thing', arguments: '{}' },
              extra_content: { google: { thought_signature: SIG } },
            },
          ],
        },
      },
    ],
  } as unknown as OpenAiChatResponse;
}

describe('thought-signature tunnel codec', () => {
  it('round-trips a signature through call_id', () => {
    const encoded = encodeCallIdWithSignature('call_123', SIG);
    expect(encoded).not.toBe('call_123');
    expect(decodeCallId(encoded)).toEqual({ callId: 'call_123', thoughtSignature: SIG });
  });

  it('passes a plain call_id through unchanged', () => {
    expect(decodeCallId('call_123')).toEqual({ callId: 'call_123' });
  });

  it('no-ops when either side is empty', () => {
    expect(encodeCallIdWithSignature('call_123', '')).toBe('call_123');
    expect(encodeCallIdWithSignature('', SIG)).toBe('');
  });

  it('never double-encodes', () => {
    const once = encodeCallIdWithSignature('call_123', SIG);
    expect(encodeCallIdWithSignature(once, 'other')).toBe(once);
  });
});

describe('translateResponse - tunnel encode', () => {
  it('encodes the signature into call_id when enabled', () => {
    const res = translateResponse(responseWithSignature('call_abc'), {
      tunnelThoughtSignatureInCallId: true,
    });
    const fc = functionCall(res.output);
    expect(fc.call_id).toBe(encodeCallIdWithSignature('call_abc', SIG));
    expect(fc.thought_signature).toBe(SIG);
  });

  it('leaves call_id clean when disabled', () => {
    const res = translateResponse(responseWithSignature('call_abc'), {});
    const fc = functionCall(res.output);
    expect(fc.call_id).toBe('call_abc');
    expect(fc.thought_signature).toBe(SIG);
  });
});

describe('translateRequest - tunnel decode', () => {
  const fatId = encodeCallIdWithSignature('call_abc', SIG);
  const input = [
    { type: 'function_call', call_id: fatId, name: 'do_thing', arguments: '{}' },
    { type: 'function_call_output', call_id: fatId, output: 'ok' },
  ];

  it('recovers the signature and restores the clean call_id upstream', () => {
    const { request } = translateRequest(
      { model: 'gpt-4', input },
      { tunnelThoughtSignatureInCallId: true },
    );
    const assistant = request.messages.find((m) => m.role === 'assistant');
    const toolMsg = request.messages.find((m) => m.role === 'tool');
    expect(assistant?.tool_calls?.[0]?.id).toBe('call_abc');
    expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(SIG);
    // The tool result must still pair to the SAME clean id upstream.
    expect(toolMsg?.tool_call_id).toBe('call_abc');
  });

  it('leaves the fat call_id intact when disabled (no decode)', () => {
    const { request } = translateRequest({ model: 'gpt-4', input }, {});
    const assistant = request.messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.id).toBe(fatId);
  });
});

describe('tunnel end-to-end', () => {
  it('response encode -> signature-dropping client echo -> request decode preserves the signature', () => {
    // 1. Upstream returns a tool call carrying the signature; encode it into call_id.
    const res = translateResponse(responseWithSignature('call_xyz'), {
      tunnelThoughtSignatureInCallId: true,
    });
    // 2. A client that only preserves {type, call_id, name, arguments} echoes this back.
    const carried = functionCall(res.output).call_id ?? '';

    const { request } = translateRequest(
      {
        model: 'gpt-4',
        input: [
          { type: 'function_call', call_id: carried, name: 'do_thing', arguments: '{}' },
          { type: 'function_call_output', call_id: carried, output: 'done' },
        ],
      },
      { tunnelThoughtSignatureInCallId: true },
    );

    // 3. The signature is recovered and the clean id is sent upstream.
    const assistant = request.messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.id).toBe('call_xyz');
    expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(SIG);
  });
});
