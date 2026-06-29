// ==============================================================================
// Main Translation
// ==============================================================================

import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesTool,
  ResponsesToolChoice,
  ResponsesContentPart,
} from '../../types/responses.js';
import type {
  OpenAiChatMessage,
  OpenAiChatRequest,
  OpenAiChatTool,
  OpenAiChatToolCall,
  OpenAiChatToolChoice,
} from '../../types/openai_chat.js';
import { makeId } from '../../utils/id.js';
import { jsonStringifySafe } from '../../utils/json.js';
import { applyGeminiFixups, isGeminiModel } from './gemini-fixups.js';

export interface TranslateRequestOptions {
  /** Default max tokens when not provided. */
  defaultMaxTokens?: number;
  /** If true, backfill reasoning_content on assistant tool-call messages. */
  backfillReasoning?: boolean;
  /** Placeholder string for backfilled reasoning_content. Defaults to '.'. */
  reasoningPlaceholder?: string;
  /** If true, strip `strict` from function tools (some upstreams reject it). */
  /** If true, drop image/file parts from user messages (e.g. DeepSeek text-only models). */
  dropImages?: boolean;
  /** Fallback signature for Gemini OpenAI histories that lack returned signatures. */
  fallbackThoughtSignature?: string;
}

export interface TranslateRequestResult {
  request: OpenAiChatRequest;
}

/** Convert a Responses API request into an OpenAI Chat API request. */
export function translateRequest(
  data: ResponsesRequest,
  options: TranslateRequestOptions = {},
): TranslateRequestResult {
  const messages: OpenAiChatMessage[] = [];

  const systemContent = buildSystemContent(data.instructions);
  if (systemContent) {
    messages.push({ role: 'system', content: systemContent });
  }

  const inputItems: ResponsesInputItem[] =
    typeof data.input === 'string' ? [data.input] : Array.isArray(data.input) ? data.input : [];

  for (const raw of inputItems) {
    if (typeof raw === 'string') {
      messages.push({ role: 'user', content: raw });
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const rawItem: Record<string, unknown> = raw;
    processInputItem(rawItem, messages, options);
  }

  const request: OpenAiChatRequest = {
    model: data.model,
    messages,
  };

  if (typeof data.temperature === 'number') {
    request.temperature = data.temperature;
  }
  if (typeof data.top_p === 'number') {
    request.top_p = data.top_p;
  }
  const effort = typeof data.reasoning?.effort === 'string' ? data.reasoning.effort : undefined;
  if (effort) {
    const req: Record<string, unknown> = request;
    if (isGeminiModel(data.model)) {
      // Gemini's OpenAI-compat endpoint never returns thought text for a plain
      // reasoning_effort (that only spends a thinking budget), and rejects
      // reasoning_effort + thinking_config together with a hard 400. To actually
      // surface chain-of-thought we request include_thoughts via google.thinking_config
      // and drop reasoning_effort; thoughts then stream back as content chunks tagged
      // extra_content.google.thought === true (decoded in translateStream).
      req.google = { thinking_config: { include_thoughts: true } };
    } else {
      req.reasoning_effort = effort;
    }
  }

  const maxTokens =
    (typeof data.max_output_tokens === 'number' && data.max_output_tokens) ||
    (typeof data.max_tokens === 'number' && data.max_tokens) ||
    options.defaultMaxTokens;
  if (typeof maxTokens === 'number') {
    request.max_tokens = maxTokens;
  }

  const tools = mapTools(data.tools ?? []);
  if (tools.length) {
    request.tools = tools;
    const toolChoice = mapToolChoice(data.tool_choice);
    if (toolChoice !== undefined) {
      request.tool_choice = toolChoice;
    }
  }

  // Some upstreams (e.g. GLM thinking mode) require reasoning_content on every
  // assistant turn when thinking is enabled — not just ones that make tool calls.
  const placeholder = options.reasoningPlaceholder ?? '.';
  if (options.backfillReasoning !== false && placeholder) {
    for (const m of messages) {
      if (m.role === 'assistant' && m.reasoning_content == null) {
        m.reasoning_content = placeholder;
      }
    }
  }

  // Reorder messages to ensure tool outputs immediately follow their tool calls.
  // Some upstreams (e.g. GLM) require tool messages to come right after the assistant
  // message that emitted the tool_calls, with no other message in between.
  repairToolMessageOrder(messages);

  // Gemini (OpenAI-compat) needs extra fixups, gated on the model name (merge
  // system messages; rewrite Codex's GPT-only multi_tool_use.parallel mandate).
  applyGeminiFixups(messages, data.model);

  return { request };
}

function buildSystemContent(instructions: ResponsesRequest['instructions']): string {
  if (!instructions) {
    return '';
  }
  if (typeof instructions === 'string') {
    return instructions;
  }
  if (!Array.isArray(instructions)) {
    return '';
  }
  let out = '';
  for (const block of instructions) {
    if (typeof block === 'string') {
      out += block;
    } else if (block && typeof block === 'object') {
      // eslint-disable-next-line no-restricted-syntax -- Record extraction from unknown union
      out += String((block as { text?: string }).text ?? '');
    }
  }
  return out;
}

// ==============================================================================
// Input Processing
// ==============================================================================

function processInputItem(
  item: Record<string, unknown>,
  messages: OpenAiChatMessage[],
  options: TranslateRequestOptions,
): void {
  const itemType: string = String(item.type) || 'message';

  const getLastAssistant = (): OpenAiChatMessage => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
      return last;
    }
    const msg: OpenAiChatMessage = { role: 'assistant', content: null };
    messages.push(msg);
    return msg;
  };

  if (itemType === 'message' || itemType === 'agentMessage') {
    // ==============================================================================
    // Helpers
    // ==============================================================================

    let role: string = String(item.role) || 'user';
    if (role === 'developer') {
      role = 'system';
    }

    let reasoningContent: string = String(item.reasoning_content ?? '');
    const rawContent = item.content;

    if (role === 'assistant' || role === 'model') {
      let content = '';
      if (typeof rawContent === 'string') {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        for (const part of rawContent) {
          if (typeof part === 'string') {
            content += part;
          } else if (part && typeof part === 'object') {
            const contentPart: ResponsesContentPart = part;
            if (
              contentPart.type === 'input_text' ||
              contentPart.type === 'text' ||
              contentPart.type === 'output_text'
            ) {
              content += String(contentPart.text ?? '');
            } else if (contentPart.type === 'reasoning_text') {
              reasoningContent += String(contentPart.text ?? '');
            }
          }
        }
      }
      const amsg = getLastAssistant();
      if (content) {
        amsg.content = (amsg.content ?? '') + content;
      }
      if (reasoningContent) {
        amsg.reasoning_content = (amsg.reasoning_content ?? '') + reasoningContent;
      }
      const sig = item.thought_signature;
      if (typeof sig === 'string' && sig) {
        amsg.thought_signature = sig;
      }
    } else {
      if (typeof rawContent === 'string') {
        messages.push({ role, content: rawContent });
      } else if (Array.isArray(rawContent)) {
        const contentBlocks: Array<{ type: string; [k: string]: unknown }> = [];
        for (const part of rawContent) {
          if (typeof part === 'string') {
            contentBlocks.push({ type: 'text', text: part });
          } else if (part && typeof part === 'object') {
            const contentPart: ResponsesContentPart = part;
            if (
              contentPart.type === 'input_text' ||
              contentPart.type === 'text' ||
              contentPart.type === 'output_text'
            ) {
              contentBlocks.push({ type: 'text', text: String(contentPart.text ?? '') });
            } else if (contentPart.type === 'reasoning_text') {
              reasoningContent += String(contentPart.text ?? '');
            } else if (isImagePart(contentPart)) {
              if (options.dropImages) {
                continue;
              }
              const url = imagePartToUrl(part);
              if (url) {
                contentBlocks.push({ type: 'image_url', image_url: { url } });
              }
            } else if (part.type === 'input_file' || part.type === 'file') {
              const fileData = String(contentPart.file_data ?? contentPart.data ?? '');
              const mimeType = String(
                contentPart.mime_type ?? contentPart.media_type ?? 'application/pdf',
              );
              if (fileData) {
                const url = fileData.startsWith('data:')
                  ? fileData
                  : `data:${mimeType};base64,${fileData}`;
                contentBlocks.push({ type: 'image_url', image_url: { url } });
              }
            } else if (contentPart.type === 'input_audio') {
              const ia = contentPart.input_audio; // song audio (base64 / gs:// on Vertex)
              const data = String(ia?.data ?? contentPart.data ?? '');
              const format = String(ia?.format ?? contentPart.format ?? 'mp3');
              if (data) {
                contentBlocks.push({ type: 'input_audio', input_audio: { data, format } });
              }
            }
          }
        }
        const msg: OpenAiChatMessage = { role, content: contentBlocks };
        if (reasoningContent) {
          msg.reasoning_content = reasoningContent;
        }
        const sig = item.thought_signature;
        if (typeof sig === 'string' && sig) {
          msg.thought_signature = sig;
        }
        messages.push(msg);
      } else {
        messages.push({ role, content: '' });
      }
    }
    return;
  }

  if (itemType === 'reasoning') {
    const rawList = item.content;
    let content = '';
    if (Array.isArray(rawList)) {
      for (const cp of rawList) {
        if (typeof cp === 'string') {
          content += cp;
        } else if (cp && typeof cp === 'object') {
          // eslint-disable-next-line no-restricted-syntax -- Record extraction from unknown union
          content += String((cp as { text?: string }).text ?? '');
        }
      }
    } else if (typeof rawList === 'string') {
      content += rawList;
    }
    const amsg = getLastAssistant();
    amsg.reasoning_content = (amsg.reasoning_content ?? '') + content;
    const sig = item.thought_signature;
    if (typeof sig === 'string' && sig) {
      amsg.thought_signature = sig;
    }
    return;
  }

  if (
    itemType === 'function_call' ||
    itemType === 'commandExecution' ||
    itemType === 'local_shell_call' ||
    itemType === 'fileChange' ||
    itemType === 'custom_tool_call' ||
    itemType === 'web_search_call'
  ) {
    processToolCall(item, messages, getLastAssistant, options.fallbackThoughtSignature);
    return;
  }

  if (
    itemType === 'function_call_output' ||
    itemType === 'commandExecutionOutput' ||
    itemType === 'fileChangeOutput' ||
    itemType === 'custom_tool_call_output'
  ) {
    processToolOutput(item, messages, options);
    return;
  }
}

function processToolCall(
  item: Record<string, unknown>,
  messages: OpenAiChatMessage[],
  getLastAssistant: () => OpenAiChatMessage,
  fallbackThoughtSignature?: string,
): void {
  const callId: string = String(item.call_id ?? '') || String(item.id ?? '') || makeId('call');
  let name: string | undefined = item.name === undefined ? undefined : String(item.name);
  const itemType: string | undefined = item.type === undefined ? undefined : String(item.type);

  if (!name) {
    if (itemType === 'commandExecution') {
      name = 'run_shell_command';
    } else if (itemType === 'local_shell_call') {
      name = 'local_shell_command';
    } else if (itemType === 'fileChange') {
      name = 'write_file';
    } else if (itemType === 'web_search_call') {
      name = 'web_search';
    }
  }

  let args: unknown =
    item.arguments ?? item.input ?? (isEmpty(item.arguments) && isEmpty(item.input) ? {} : {});
  if (isEmpty(args) && itemType === 'web_search_call') {
    args = item.action ?? {};
  }
  if (isEmpty(args)) {
    if (itemType === 'commandExecution') {
      args = {
        command: item.command ?? '',
        dir_path: item.cwd ?? '.',
      };
    } else if (itemType === 'local_shell_call') {
      // eslint-disable-next-line no-restricted-syntax -- Narrow unknown to Record
      const action = (item.action === undefined ? {} : item.action) as Record<string, unknown>;
      // eslint-disable-next-line no-restricted-syntax -- Narrow unknown to Record
      const execChild = (action.exec === undefined ? {} : action.exec) as Record<string, unknown>;
      args = {
        command: execChild.command ?? [],
        working_directory: execChild.working_directory,
      };
    } else if (itemType === 'fileChange') {
      const changes: Array<Record<string, unknown>> = Array.isArray(item.changes)
        ? item.changes
        : [];
      const path = changes[0]?.path ?? 'unknown';
      args = { file_path: path };
    }
  }

  const argsStr = typeof args === 'string' ? args : jsonStringifySafe(args ?? {});

  if (!name) {
    return;
  }

  const amsg = getLastAssistant();
  if (!amsg.tool_calls) {
    amsg.tool_calls = [];
  }
  const toolCall: OpenAiChatToolCall = {
    id: callId,
    type: 'function',
    function: { name, arguments: argsStr },
  };

  const sig = item.thought_signature ?? fallbackThoughtSignature;
  const thought = item.thought;
  if (typeof sig === 'string' && sig) {
    toolCall.extra_content = { google: { thought_signature: sig } };
    amsg.thought_signature = sig;
  }
  amsg.tool_calls.push(toolCall);
  if (typeof thought === 'string' && thought) {
    amsg.reasoning_content = (amsg.reasoning_content ?? '') + thought;
  }
  void messages;
}

function isImagePart(part: { type?: string }): boolean {
  return part.type === 'input_image' || part.type === 'image' || part.type === 'image_url';
}

// Extract a chat `image_url` value (http(s) URL or data: URI) from a Responses
// image part. Shared by user-message and tool-output handling so both translate
// images identically.
function imagePartToUrl(part: {
  image_url?: string | { url?: string };
  data?: string;
  base64?: string;
  mime_type?: string;
  media_type?: string;
}): string {
  const imgUrl = part.image_url;
  if (typeof imgUrl === 'string') {
    return imgUrl;
  }
  if (imgUrl && typeof imgUrl === 'object' && imgUrl.url) {
    return imgUrl.url;
  }
  const imgData = String(part.data ?? part.base64 ?? '');
  if (imgData) {
    const mimeType = String(part.mime_type ?? part.media_type ?? 'image/png');
    return imgData.startsWith('data:') ? imgData : `data:${mimeType};base64,${imgData}`;
  }
  return '';
}

function processToolOutput(
  item: Record<string, unknown>,
  messages: OpenAiChatMessage[],
  options: TranslateRequestOptions,
): void {
  const callId: string | undefined = item.call_id === undefined ? undefined : String(item.call_id);
  const outputRaw = item.output ?? item.content ?? item.stdout ?? '';

  let content = '';
  const imageBlocks: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  if (typeof outputRaw === 'string') {
    content = outputRaw;
  } else if (Array.isArray(outputRaw)) {
    for (const part of outputRaw) {
      if (typeof part === 'string') {
        content += part;
      } else if (part && typeof part === 'object') {
        const partItem: { type?: string; text?: string } = part;
        if (partItem.type === 'input_text' || partItem.type === 'text') {
          content += String(partItem.text ?? '');
        } else if (!options.dropImages && isImagePart(partItem)) {
          const url = imagePartToUrl(part);
          if (url) {
            imageBlocks.push({ type: 'image_url', image_url: { url } });
          }
        }
      }
    }
  } else if (outputRaw && typeof outputRaw === 'object') {
    // eslint-disable-next-line no-restricted-syntax -- Narrow object to Record
    const obj = outputRaw as Record<string, unknown>;
    content = String(obj.content ?? '');
    if (!content && obj.success === false) {
      content = 'Error: Tool execution failed';
    }
  }

  if (!content && typeof item.stderr === 'string' && item.stderr) {
    content = `Error: ${item.stderr}`;
  }

  messages.push({
    role: 'tool',
    tool_call_id: callId,
    content,
  });

  // A chat `tool` message cannot carry images, so image parts in a tool output
  // (e.g. codex `view_image` screenshots) would be dropped on translation. Lift
  // them into a following `user` message — user messages DO map to chat
  // `image_url` content, so the upstream model can still see them.
  if (imageBlocks.length > 0) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: '[Image output returned by the preceding tool call]' },
        ...imageBlocks,
      ],
    });
  }
}

// ==============================================================================
// Tool Mapping
// ==============================================================================
function mapTools(tools: ResponsesTool[]): OpenAiChatTool[] {
  /** If true, drop image/file parts from user messages (e.g. DeepSeek text-only models). */
  const out: OpenAiChatTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const tt = tool.type;
    if (tt === 'function') {
      const fn = tool.function;
      const name = fn?.name ?? tool.name;
      if (!name) {
        continue;
      }
      const params = fn?.parameters ?? tool.parameters ?? { type: 'object' };
      out.push({
        type: 'function',
        function: {
          name,
          description: fn?.description ?? tool.description ?? '',
          parameters: params,
        },
      });
      continue;
    }
    if (tt === 'namespace') {
      // Flatten namespace sub-tools as "{namespace}.{tool}" function tools so
      // Chat Completions upstreams (e.g. DeepSeek) can call them.  Codex
      // dispatches tool calls by full dotted name, so the prefix is required.
      const ns = tool.name;
      // eslint-disable-next-line no-restricted-syntax -- ResponsesTool[] extraction from unknown index signature
      const nested = tool.tools as ResponsesTool[] | undefined;
      if (ns && Array.isArray(nested)) {
        for (const sub of nested) {
          if (!sub || typeof sub !== 'object' || sub.type !== 'function') {
            continue;
          }
          const subName = sub.name;
          if (!subName) {
            continue;
          }
          const params = sub.parameters ?? { type: 'object' };
          out.push({
            type: 'function',
            function: {
              name: `${ns}.${subName}`,
              description: sub.description ?? '',
              // eslint-disable-next-line no-restricted-syntax -- schema is Record<string,unknown> by OpenAPI convention
              parameters: params as Record<string, unknown>,
            },
          });
        }
      }
      continue;
    }
  }
  return out;
}

function mapToolChoice(choice: ResponsesToolChoice): OpenAiChatToolChoice | undefined {
  if (choice == null) {
    return undefined;
  }
  if (choice === 'auto' || choice === 'required' || choice === 'none') {
    return choice;
  }
  if (typeof choice === 'object') {
    if (choice.type === 'function' && 'function' in choice && choice.function?.name) {
      return { type: 'function', function: { name: choice.function.name } };
    }
    return choice;
  }
  return undefined;
}

function isEmpty(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Reorder messages so that every `role: 'tool'` message immediately follows
 * the `role: 'assistant'` message that contains its matching `tool_call_id`.
 *
 * Codex Desktop sometimes injects a user message (e.g. a warning) between a
 * `function_call` and the corresponding `function_call_output`.  OpenAI Chat
 * format requires strict alternating: assistant (with tool_calls) → tool →
 * assistant → tool → …  This function repairs that ordering.
 */
function repairToolMessageOrder(messages: OpenAiChatMessage[]): void {
  if (messages.length === 0) {
    return;
  }

  // Collect every tool message by tool_call_id. A response can drift far from
  // its call — Codex interleaves user/assistant items between a function_call
  // and its function_call_output, and parallel calls land out of order — so a
  // tool response may sit in a different assistant "block" than its call.
  // Block-local reordering can't fix that; we re-home each response globally.
  const toolById = new Map<string, OpenAiChatMessage>();
  for (const msg of messages) {
    if (
      msg.role === 'tool' &&
      msg.tool_call_id !== undefined &&
      !toolById.has(String(msg.tool_call_id))
    ) {
      toolById.set(String(msg.tool_call_id), msg);
    }
  }

  const used = new Set<string>();
  const out: OpenAiChatMessage[] = [];
  for (const msg of messages) {
    // Tool messages are re-emitted right after their assistant below; skipping
    // them at their original position also drops orphans (no matching call).
    if (msg.role === 'tool') {
      continue;
    }
    if (msg.role !== 'assistant') {
      out.push(msg);
      continue;
    }

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // Keep assistants that carry content; drop empty placeholders.
      if (msg.content != null || msg.reasoning_content != null) {
        out.push(msg);
      }
      continue;
    }

    // Keep the assistant and ALL its tool_calls (a trailing call still awaiting
    // execution is legitimate — never drop it), then pull each call's response,
    // if present, to immediately follow in tool_calls order. This gives what
    // providers like Gemini enforce per turn (a turn's functionCall count must
    // equal the immediately-following functionResponse count). A genuinely
    // orphaned tool_call (no response anywhere) is left as-is here — this
    // provider-agnostic reorder never invents responses; for Gemini, where an
    // unpaired call is a hard 400, synthesizeMissingToolResponses (gemini-fixups,
    // run right after) pairs it with a placeholder. Orphan tool messages (no
    // matching call) are dropped by being skipped at their original spot.
    out.push(msg);
    for (const call of calls) {
      const id = call.id ? String(call.id) : '';
      const tool = id ? toolById.get(id) : undefined;
      if (id && tool && !used.has(id)) {
        out.push(tool);
        used.add(id);
      }
    }
  }

  messages.length = 0;
  messages.push(...out);
}
