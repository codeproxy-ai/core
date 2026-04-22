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
  /** Thinking budget overrides, keyed by effort. Falls back to defaults. */
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
      // Anthropic does not accept redriving thinking blocks without signature
      // from a prior turn; drop them unless they already carry a signature.
      continue;
    }

    flushPending();
    if (itemType !== 'message' && itemType !== 'agentMessage') continue;

    let role = (item.role as string) || 'user';
    if (role === 'model') role = 'assistant';
    if (role === 'developer') role = 'system';

    const { blocks, cache } = mapContentBlocks(item.content);
    hasPromptCache = hasPromptCache || cache;

    if (role === 'system') {
      for (const b of blocks) if (b.type === 'text') systemBlocks.push(b as AnthropicTextBlock);
    } else if (role === 'user' || role === 'assistant') {
      messages.push({ role, content: blocks });
    }
  }

  flushPending();

  if (!messages.length) {
    messages.push({ role: 'user', content: [{ type: 'text', text: '...' }] });
  }

  return { messages, hasPromptCache };
}

interface ContentMapResult {
  blocks: AnthropicContentBlock[];
  cache: boolean;
}

function mapContentBlocks(content: unknown): ContentMapResult {
  if (typeof content === 'string') {
    return { blocks: [{ type: 'text', text: content }], cache: false };
  }
  if (!Array.isArray(content)) {
    return { blocks: [{ type: 'text', text: String(content ?? '') }], cache: false };
  }

  let cache = false;
  const blocks: AnthropicContentBlock[] = [];
  for (const raw of content) {
    if (typeof raw === 'string') {
      blocks.push({ type: 'text', text: raw });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as ResponsesContentPart;
    const ptype = part.type;
    const cacheControl = part.cache_control;

    if (ptype === 'input_text' || ptype === 'text' || ptype === 'output_text' || ptype === 'reasoning_text') {
      const block: AnthropicTextBlock = { type: 'text', text: String(part.text ?? '') };
      if (cacheControl) {
        block.cache_control = cacheControl;
        cache = true;
      }
      blocks.push(block);
    } else if (ptype === 'input_image' || ptype === 'image' || ptype === 'image_url') {
      const block = buildImageBlock(part);
      if (block) {
        if (cacheControl) {
          block.cache_control = cacheControl;
          cache = true;
        }
        blocks.push(block);
      }
    } else if (ptype === 'input_file' || ptype === 'file') {
      const block = buildFileBlock(part);
      if (block) {
        if (cacheControl) {
          block.cache_control = cacheControl;
          cache = true;
        }
        blocks.push(block);
      }
    } else if (ptype === 'tool_result') {
      const block: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: String(part.tool_use_id ?? part.call_id ?? ''),
        content:
          typeof part.content === 'string'
            ? part.content
            : ((part.content as AnthropicContentBlock[] | undefined) ?? ''),
      };
      if (cacheControl) {
        block.cache_control = cacheControl;
        cache = true;
      }
      blocks.push(block);
    }
  }

  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  return { blocks, cache };
}

function buildImageBlock(part: ResponsesContentPart): AnthropicImageBlock | undefined {
  const source = part.source;
  if (source && typeof source === 'object' && (source as { type?: string }).type) {
    return { type: 'image', source: { ...(source as unknown as AnthropicImageBlock["source"]) } };
  }

  let imageUrl: string | undefined;
  const rawUrl = part.image_url;
  if (typeof rawUrl === 'string') imageUrl = rawUrl;
  else if (rawUrl && typeof rawUrl === 'object') imageUrl = (rawUrl as { url?: string }).url;

  if (!imageUrl) {
    const data = (part.data as string | undefined) || (part.base64 as string | undefined);
    if (data) {
      const mediaType = part.media_type || part.mime_type || 'image/png';
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      };
    }
    return undefined;
  }

  if (imageUrl.startsWith('data:')) {
    const [header, b64] = imageUrl.split(',', 2);
    if (b64 === undefined) return undefined;
    let mediaType = 'image/png';
    if (header?.startsWith('data:') && header.includes(';')) {
      mediaType = header.slice(5).split(';', 1)[0] || 'image/png';
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: b64 },
    };
  }

  return { type: 'image', source: { type: 'url', url: imageUrl } };
}

function buildFileBlock(part: ResponsesContentPart): AnthropicDocumentBlock | undefined {
  const source = part.source;
  if (source && typeof source === 'object' && (source as { type?: string }).type) {
    return { type: 'document', source: { ...(source as unknown as AnthropicDocumentBlock["source"]) } };
  }

  let fileData = (part.file_data as string | undefined) || (part.data as string | undefined);
  if (typeof fileData === 'string' && fileData) {
    let mediaType = part.media_type || part.mime_type || 'application/pdf';
    if (fileData.startsWith('data:')) {
      const [header, b64] = fileData.split(',', 2);
      if (b64 === undefined) return undefined;
      if (header?.startsWith('data:') && header.includes(';')) {
        mediaType = header.slice(5).split(';', 1)[0] || mediaType;
      }
      fileData = b64;
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: mediaType, data: fileData },
    };
  }

  let fileUrl: string | undefined;
  const rawUrl = part.file_url;
  if (typeof rawUrl === 'string') fileUrl = rawUrl;
  else if (rawUrl && typeof rawUrl === 'object') fileUrl = (rawUrl as { url?: string }).url;
  if (typeof fileUrl === 'string' && fileUrl) {
    return { type: 'document', source: { type: 'url', url: fileUrl } };
  }
  return undefined;
}

function mapInputToolCall(item: Record<string, unknown>): AnthropicToolUseBlock | undefined {
  let name = item.name as string | undefined;
  const itype = item.type as string | undefined;
  if (!name) {
    if (itype === 'commandExecution') name = 'run_shell_command';
    else if (itype === 'local_shell_call') name = 'local_shell_command';
    else if (itype === 'fileChange') name = 'write_file';
    else if (itype === 'web_search_call') name = 'web_search';
  }
  if (!name) return undefined;

  let args: unknown = item.arguments ?? item.input ?? {};
  if (itype === 'local_shell_call' && (!args || (typeof args === 'object' && !Object.keys(args as object).length))) {
    const action = (item.action as Record<string, unknown> | undefined) ?? {};
    const exec = (action.exec as Record<string, unknown> | undefined) ?? {};
    args = {
      command: exec.command ?? [],
      working_directory: exec.working_directory,
    };
  }

  if (typeof args === 'string') {
    args = safeJsonParse(args) ?? { raw: args };
  }
  if (!args || typeof args !== 'object') args = { raw: String(args ?? '') };

  const id = (item.call_id as string) || (item.id as string) || makeId('call');
  return {
    type: 'tool_use',
    id,
    name,
    input: args as Record<string, unknown>,
  };
}

function extractToolOutputText(item: Record<string, unknown>): string {
  const raw = item.output ?? item.content ?? item.stdout ?? '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const p of raw) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p === 'object') parts.push(String((p as { text?: string }).text ?? ''));
    }
    return parts.join('');
  }
  if (raw && typeof raw === 'object') {
    return String((raw as { content?: string }).content ?? '');
  }
  return String(raw ?? '');
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
