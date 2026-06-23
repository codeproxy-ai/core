import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

// Responses -> Chat: an input_audio content part must survive translation as a
// Chat `input_audio` block. mv injects the song this way (base64, or a gs:// URI
// on Vertex) so the agent can "hear" it; before this case the part was dropped.
describe('openai translateRequest - input_audio', () => {
  it('translates a nested input_audio part to a Chat input_audio block (gs:// on Vertex)', () => {
    const { request } = translateRequest({
      model: 'gemini-3.5-flash',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'listen to this' },
            {
              type: 'input_audio',
              input_audio: { data: 'gs://bucket/song.wav', format: 'wav' },
            },
          ],
        },
      ],
    });
    const msg = request.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(msg).toBeDefined();
    const blocks = (msg?.content ?? []) as Array<{ type: string; [k: string]: unknown }>;
    expect(blocks).toContainEqual({ type: 'text', text: 'listen to this' });
    expect(blocks).toContainEqual({
      type: 'input_audio',
      input_audio: { data: 'gs://bucket/song.wav', format: 'wav' },
    });
  });

  it('accepts data/format on the part itself and defaults format to mp3', () => {
    const { request } = translateRequest({
      model: 'gemini-3.5-flash',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_audio', data: 'QkFTRTY0' }],
        },
      ],
    });
    const msg = request.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = (msg?.content ?? []) as Array<{ type: string; [k: string]: unknown }>;
    expect(blocks).toContainEqual({
      type: 'input_audio',
      input_audio: { data: 'QkFTRTY0', format: 'mp3' },
    });
  });

  it('drops an input_audio part that carries no data', () => {
    const { request } = translateRequest({
      model: 'gemini-3.5-flash',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'hi' },
            { type: 'input_audio', input_audio: {} },
          ],
        },
      ],
    });
    const msg = request.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = (msg?.content ?? []) as Array<{ type: string; [k: string]: unknown }>;
    expect(blocks.some((b) => b.type === 'input_audio')).toBe(false);
  });
});
