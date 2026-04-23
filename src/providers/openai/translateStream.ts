import type {
  ResponsesResponse,
  ResponsesOutputItem,
} from '../../types/responses.js';

export interface TranslateStreamOptions {
  /** Id used for the resulting Responses object. Defaults to generated. */
  responseId?: string;
  /** Created timestamp (seconds). Defaults to `Date.now() / 1000`. */
  createdAt?: number;
  /** Original Responses-API model that callers want surfaced. */
  model?: string;
}

/**
 * Convert an OpenAI Chat SSE stream into a Responses-API stream.
 */
export async function* translateStream(
  upstream: ReadableStream<Uint8Array>,
  options: TranslateStreamOptions = {},
): AsyncGenerator<ResponsesResponse, void, unknown> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();

  const responseId = options.responseId || `resp_${Date.now()}`;
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const model = options.model ?? '';

  let buffer = '';
  let currentText = '';
  let currentToolCalls: Map<string, any> = new Map();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data) as any;
          
          // Handle delta content
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          const output: ResponsesOutputItem[] = [];
          let hasContent = false;

          // Process text content
          if (delta.content) {
            currentText += delta.content;
            output.push({
              id: `msg_${responseId}`,
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [{ type: 'output_text', text: currentText }],
            });
            hasContent = true;
          }

          // Process tool calls
          if (delta.tool_calls && delta.tool_calls.length > 0) {
            for (const toolCall of delta.tool_calls) {
              const id = toolCall.id;
              if (id && !currentToolCalls.has(id)) {
                currentToolCalls.set(id, { id, function: { name: '', arguments: '' } });
              }
              
              const current = id ? currentToolCalls.get(id) : currentToolCalls.get(delta.index);
              if (current) {
                if (toolCall.function?.name) {
                  current.function.name += toolCall.function.name;
                }
                if (toolCall.function?.arguments) {
                  current.function.arguments += toolCall.function.arguments;
                }
                
                output.push({
                  id: current.id,
                  type: 'function_call',
                  status: 'in_progress',
                  name: current.function.name,
                  arguments: current.function.arguments,
                  call_id: current.id,
                });
                hasContent = true;
              }
            }
          }

          if (hasContent) {
            const transformed: ResponsesResponse = {
              id: responseId,
              object: 'response',
              created_at: createdAt,
              model,
              status: 'in_progress',
              output,
            };
            yield transformed;
          }
        } catch (e) {
          // Skip invalid JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
