import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesTool,
  ResponsesToolChoice,
  ResponsesContentPart,
} from '../../types/responses.js';
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicThinkingConfig,
  AnthropicImageBlock,
  AnthropicDocumentBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
} from '../../types/anthropic.js';
import { makeId } from '../../utils/id.js';
import { safeJsonParse } from '../../utils/json.js';

const ANTHROPIC_BUILTIN_TOOL_TYPES = new Set([
  'web_search_20250305',
  'computer_use_20250124',
  'text_editor_20250124',
  'bash_20250124',
]);

export interface TranslateRequestOptions {
  /** Default max tokens when not provided (Anthropic requires `max_tokens`). */
  defaultMaxTokens?: number;
  /** Thinking budget overrides, keyed by effort. */
  reasoningBudgets?: Partial<Record<'minimal' | 'low' | 'medium' | 'high', number>>;
}

export interface TranslateRequestResult {
  request: AnthropicRequest;
  hasPromptCache: boolean;
}

const DEFAULT_REASONING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 16384,
  high: 32768,
};

/** Convert a Responses API request into an Anthropic Messages API request. */
export function translateRequest(
  data: ResponsesRequest,
  options: TranslateRequestOptions = {},
): TranslateRequestResult {
  const model = data.model;
  const maxTokens =
    (typeof data.max_output_tokens === 'number' && data.max_output_tokens) ||
    (typeof data.max_tokens === 'number' && data.max_tokens) ||
    options.defaultMaxTokens ||
    8192;

  const systemBlocks: AnthropicTextBlock[] = extractSystemBlocks(data.instructions);

  const built = buildMessages(data, systemBlocks);
  let messages = built.messages;
  const hasPromptCache = built.hasPromptCache;

  messages = repairToolAdjacency(messages);
  messages = sanitizeMessages(messages);
  messages = ensureEndsWithUser(messages);

  const request: AnthropicRequest = {
    model,
    messages,
    max_tokens: maxTokens,
  };

  if (systemBlocks.length) {
    request.system = systemBlocks;
  }
  if (typeof data.temperature === 'number') request.temperature = data.temperature;
  if (typeof data.top_p === 'number') request.top_p = data.top_p;

  const tools = mapTools(data.tools || []);
  if (tools.length) {
    request.tools = tools;
    const toolChoice = mapToolChoice(data.tool_choice);
    if (toolChoice) request.tool_choice = toolChoice;
  }

  if (data.metadata && typeof data.metadata === 'object') {
    request.metadata = data.metadata;
  }

  const thinking = mapThinking(data, maxTokens, options.reasoningBudgets);
  if (thinking) request.thinking = thinking;

  return { request, hasPromptCache };
}

function extractSystemBlocks(instructions: ResponsesRequest['instructions']): AnthropicTextBlock[] {
  if (!instructions) return [];
  if (typeof instructions === 'string') {
    return [{ type: 'text', text: instructions }];
  }
  if (!Array.isArray(instructions)) return [];
  const blocks: AnthropicTextBlock[] = [];
  for (const item of instructions) {
    if (typeof item === 'string') blocks.push({ type: 'text', text: item });
    else if (item && typeof item === 'object') {
      const block: AnthropicTextBlock = { type: 'text', text: String((item as { text?: string }).text ?? '') };
      const cache = (item as { cache_control?: Record<string, unknown> }).cache_control;
      if (cache) block.cache_control = cache;
      blocks.push(block);
    }
  }
  return blocks;
}

interface BuildResult {
  messages: AnthropicMessage[];
  hasPromptCache: boolean;
}

function buildMessages(data: ResponsesRequest, systemBlocks: AnthropicTextBlock[]): BuildResult {
  const messages: AnthropicMessage[] = [];
  let hasPromptCache = false;

  let pendingToolUses: AnthropicToolUseBlock[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushToolUses = () => {
    if (pendingToolUses.length) {
      messages.push({ role: 'assistant', content: pendingToolUses });
      pendingToolUses = [];
    }
  };
  const flushToolResults = () => {
    if (pendingToolResults.length) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };
  const flushPending = () => {
    flushToolUses();
    flushToolResults();
  };

  const rawInput = data.input;
  const inputItems: ResponsesInputItem[] =
    typeof rawInput === 'string'
      ? [rawInput]
      : Array.isArray(rawInput)
        ? rawInput
        : [];

  for (const raw of inputItems) {
    if (typeof raw === 'string') {
      flushPending();
      messages.push({ role: 'user', content: [{ type: 'text', text: raw }] });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const itemType = (item.type as string) || 'message';

    if (
      itemType === 'function_call_output' ||
      itemType === 'commandExecutionOutput' ||
      itemType === 'fileChangeOutput' ||
      itemType === 'custom_tool_call_output'
    ) {
      flushToolUses();
      const callId = (item.call_id as string) || (item.id as string) || makeId('call');
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: extractToolOutputText(item),
      });
      continue;
    }

    if (
      itemType === 'function_call' ||
      itemType === 'commandExecution' ||
      itemType === 'local_shell_call' ||
      itemType === 'fileChange' ||
      itemType === 'custom_tool_call' ||
      itemType === 'web_search_call'
    ) {
      flushToolResults();
      const block = mapInputToolCall(item);
      if (block) pendingToolUses.push(block);
      continue;
    }

    if (itemType === 'reasoning') {
      flushPending();
      continue;
    }

    if (itemType === 'message' || itemType === 'agentMessage') {
      flushPending();
      let role = (item.role as string) || 'user';
      if (role === 'developer') role = 'system';

      if (role === 'system') {
        const text = extractMessageText(item);
        if (text) systemBlocks.push({ type: 'text', text });
        continue;
      }

      const contentBlocks: AnthropicContentBlock[] = [];
      const rawContent = item.content;
      if (typeof rawContent === 'string') {
        contentBlocks.push({ type: 'text', text: rawContent });
      } else if (Array.isArray(rawContent)) {
        for (const part of rawContent) {
          if (typeof part === 'string') {
            contentBlocks.push({ type: 'text', text: part });
          } else if (part && typeof part === 'object') {
            const p = part as ResponsesContentPart;
            if (p.type === 'input_text' || p.type === 'text' || p.type === 'output_text') {
              contentBlocks.push({ type: 'text', text: String(p.text ?? '') });
            } else if (p.type === 'input_image' || p.type === 'image' || p.type === 'image_url') {
              const imgUrl = (p as { image_url?: string | { url: string } }).image_url;
              const urlStr =
                typeof imgUrl === 'string'
                  ? imgUrl
                  : imgUrl && typeof imgUrl === 'object'
                    ? imgUrl.url
                    : '';
              if (urlStr.startsWith('data:')) {
                const m = /^data:([^;,]+);base64,(.*)$/.exec(urlStr);
                if (m) {
                  contentBlocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: m[1], data: m[2] },
                  });
                }
              } else if (urlStr) {
                contentBlocks.push({
                  type: 'image',
                  source: { type: 'url', url: urlStr } as unknown as {
                    type: 'base64';
                    media_type: string;
                    data: string;
                  },
                });
              } else {
                const data = String((p as { data?: string; base64?: string }).data ?? (p as { base64?: string }).base64 ?? '');
                if (data) {
                  contentBlocks.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type:
                        (p as { mime_type?: string; media_type?: string }).mime_type ||
                        (p as { media_type?: string }).media_type ||
                        'image/png',
                      data,
                    },
                  });
                }
              }
            } else if (p.type === 'input_file') {
              contentBlocks.push({
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: (p as { mime_type?: string }).mime_type || 'application/pdf',
                  data: String((p as { data?: string }).data ?? ''),
                },
              });
            }
          }
        }
      }

      if (role === 'assistant' || role === 'model') {
        if (contentBlocks.length) {
          messages.push({ role: 'assistant', content: contentBlocks });
        }
      } else {
        if (contentBlocks.length) {
          messages.push({ role: 'user', content: contentBlocks });
        }
      }
      continue;
    }
  }

  flushPending();

  for (const block of systemBlocks) {
    if ((block as AnthropicTextBlock).cache_control) hasPromptCache = true;
  }

  return { messages, hasPromptCache };
}

function extractMessageText(item: Record<string, unknown>): string {
  const rawContent = item.content;
  if (typeof rawContent === 'string') return rawContent;
  if (Array.isArray(rawContent)) {
    let out = '';
    for (const part of rawContent) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        out += String((part as { text?: string }).text ?? '');
      }
    }
    return out;
  }
  return '';
}

function extractToolOutputText(item: Record<string, unknown>): string {
  const raw = item.output ?? item.content ?? item.stdout ?? '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    let out = '';
    for (const part of raw) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') out += String((part as { text?: string }).text ?? '');
    }
    return out;
  }
  if (raw && typeof raw === 'object') return String((raw as { content?: string }).content ?? '');
  return '';
}

function mapInputToolCall(item: Record<string, unknown>): AnthropicToolUseBlock | undefined {
  const callId = (item.call_id as string) || (item.id as string) || makeId('call');
  let name = item.name as string | undefined;
  const itemType = item.type as string | undefined;

  if (!name) {
    if (itemType === 'commandExecution') name = 'run_shell_command';
    else if (itemType === 'local_shell_call') name = 'local_shell_command';
    else if (itemType === 'fileChange') name = 'write_file';
    else if (itemType === 'web_search_call') name = 'web_search';
  }

  if (!name) return undefined;

  const input =
    (item.arguments as Record<string, unknown>) ??
    (item.input as Record<string, unknown>) ??
    {};

  const block: AnthropicToolUseBlock = {
    type: 'tool_use',
    id: callId,
    name,
    input: input as Record<string, unknown>,
  };

  const cache = (item as { cache_control?: Record<string, unknown> }).cache_control;
  if (cache) block.cache_control = cache;

  return block;
}

function mapTools(tools: ResponsesTool[]): (AnthropicTool | Record<string, unknown>)[] {
  const out: (AnthropicTool | Record<string, unknown>)[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const tt = tool.type || '';
    if (ANTHROPIC_BUILTIN_TOOL_TYPES.has(tt)) {
      out.push(tool as Record<string, unknown>);
      continue;
    }
    if (tt !== 'function') continue;
    const fn = tool.function;
    const name = fn?.name ?? tool.name;
    if (!name) continue;
    out.push({
      name,
      description: fn?.description ?? tool.description ?? '',
      input_schema: (fn?.parameters ?? tool.parameters ?? { type: 'object' }) as Record<string, unknown>,
    });
  }
  return out;
}

function mapToolChoice(choice: ResponsesToolChoice): AnthropicToolChoice | undefined {
  if (choice == null || choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return undefined;
  if (typeof choice === 'object') {
    if (choice.type === 'function' && 'function' in choice && choice.function?.name) {
      return { type: 'tool', name: choice.function.name };
    }
    if (choice.type === 'auto' || choice.type === 'any') return { type: choice.type };
  }
  return { type: 'auto' };
}

function mapThinking(
  data: ResponsesRequest,
  maxTokens: number,
  overrides?: Partial<Record<'minimal' | 'low' | 'medium' | 'high', number>>,
): AnthropicThinkingConfig | undefined {
  const reasoning = data.reasoning;
  if (!reasoning) return undefined;
  const effort = reasoning.effort;
  if (!effort || effort === 'minimal') return undefined;
  const budgets = { ...DEFAULT_REASONING_BUDGETS, ...overrides };
  const budget = (budgets as Record<string, number | undefined>)[effort] ?? DEFAULT_REASONING_BUDGETS.medium;
  const clamped = Math.max(1024, Math.min(budget, Math.max(1024, maxTokens - 1024)));
  return { type: 'enabled', budget_tokens: clamped };
}

function repairToolAdjacency(messages: AnthropicMessage[]): AnthropicMessage[] {
  const repaired: AnthropicMessage[] = [];
  const working = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));

  for (let i = 0; i < working.length; i++) {
    const msg = working[i];
    repaired.push(msg);
    const content = msg.content;
    if (msg.role !== 'assistant' || !Array.isArray(content)) continue;

    const toolUseIds = content
      .filter((b): b is AnthropicToolUseBlock => !!b && (b as { type?: string }).type === 'tool_use')
      .map((b) => b.id);
    if (!toolUseIds.length) continue;

    const next = working[i + 1];
    const nextUserContent =
      next && next.role === 'user' && Array.isArray(next.content) ? next.content : [];

    const foundById = new Map<string, AnthropicToolResultBlock>();
    const consumedInNext = new Set<string>();
    for (const block of nextUserContent) {
      if (block && (block as { type?: string }).type === 'tool_result') {
        const tr = block as AnthropicToolResultBlock;
        if (toolUseIds.includes(tr.tool_use_id) && !foundById.has(tr.tool_use_id)) {
          foundById.set(tr.tool_use_id, tr);
          consumedInNext.add(tr.tool_use_id);
        }
      }
    }

    const missing = toolUseIds.filter((id) => !foundById.has(id));
    if (missing.length) {
      const missingSet = new Set(missing);
      for (let j = i + 2; j < working.length && missingSet.size; j++) {
        const later = working[j];
        if (later.role !== 'user' || !Array.isArray(later.content)) continue;
        const keep: AnthropicContentBlock[] = [];
        for (const block of later.content) {
          if (block && (block as { type?: string }).type === 'tool_result') {
            const tr = block as AnthropicToolResultBlock;
            if (missingSet.has(tr.tool_use_id)) {
              foundById.set(tr.tool_use_id, tr);
              missingSet.delete(tr.tool_use_id);
              continue;
            }
          }
          keep.push(block);
        }
        later.content = keep;
      }
    }

    const ordered: AnthropicToolResultBlock[] = toolUseIds.map(
      (id) =>
        foundById.get(id) ?? {
          type: 'tool_result',
          tool_use_id: id,
          content: '',
        },
    );
    repaired.push({ role: 'user', content: ordered });

    if (nextUserContent.length) {
      const remaining = nextUserContent.filter((block) => {
        if (block && (block as { type?: string }).type === 'tool_result') {
          const tr = block as AnthropicToolResultBlock;
          if (consumedInNext.has(tr.tool_use_id)) {
            consumedInNext.delete(tr.tool_use_id);
            return false;
          }
        }
        return true;
      });
      if (remaining.length) repaired.push({ role: 'user', content: remaining });
      i += 1;
    }
  }

  return repaired;
}

function sanitizeMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    if (Array.isArray(msg.content)) {
      const blocks = msg.content.filter((b) => {
        if (!b || typeof b !== 'object') return false;
        if ((b as { type?: string }).type === 'text' && !(b as AnthropicTextBlock).text) return false;
        return true;
      });
      if (!blocks.length) continue;
      out.push({ role: msg.role, content: blocks });
    } else if (typeof msg.content === 'string' && msg.content) {
      out.push({ role: msg.role, content: [{ type: 'text', text: msg.content }] });
    }
  }
  return out;
}

function ensureEndsWithUser(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (!messages.length) return [{ role: 'user', content: [{ type: 'text', text: '...' }] }];
  const last = messages[messages.length - 1];
  if (last.role === 'user') return messages;
  return [...messages, { role: 'user', content: [{ type: 'text', text: 'Continue.' }] }];
}
