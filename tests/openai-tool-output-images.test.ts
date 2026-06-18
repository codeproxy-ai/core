import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/openai/translateRequest.js';

// A chat `tool` message cannot carry images, so image parts inside a
// function_call_output (e.g. codex view_image screenshots) must be lifted into
// a following `user` message — otherwise they are silently dropped and the
// upstream model never sees the image (IMAGE-NOT-VISIBLE).
describe('translateRequest (Responses -> OpenAI Chat): tool-output images', () => {
  it('lifts a data-URL image in a function_call_output into a following user message', () => {
    const { request } = translateRequest({
      model: 'deepseek-v4-flash',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'screenshot:' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          ],
        },
      ],
    });

    // The tool message keeps the text, never the image.
    const toolMsg = request.messages.find((m) => m.role === 'tool') as {
      content: string;
    };
    expect(toolMsg.content).toBe('screenshot:');

    // The image is lifted into a user message as image_url content.
    const userMsg = request.messages.find((m) => m.role === 'user') as {
      content: Array<{ type: string; image_url?: { url: string } }>;
    };
    const imageParts = userMsg.content.filter((p) => p.type === 'image_url');
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0].image_url?.url).toBe('data:image/png;base64,AAA');
  });

  it('lifts raw base64 image data (data + mime_type) from a tool output', () => {
    const { request } = translateRequest({
      model: 'deepseek-v4-flash',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_image', data: 'QkJC', mime_type: 'image/jpeg' }],
        },
      ],
    });
    const userMsg = request.messages.find((m) => m.role === 'user') as {
      content: Array<{ type: string; image_url?: { url: string } }>;
    };
    const imageParts = userMsg.content.filter((p) => p.type === 'image_url');
    expect(imageParts[0].image_url?.url).toBe('data:image/jpeg;base64,QkJC');
  });

  it('does not lift tool-output images when dropImages is set', () => {
    const { request } = translateRequest(
      {
        model: 'deepseek-v4-flash',
        input: [
          { type: 'function_call', call_id: 'c1', name: 'view_image', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'c1',
            output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }],
          },
        ],
      },
      { dropImages: true },
    );
    expect(request.messages.some((m) => m.role === 'user')).toBe(false);
  });
});
