/* eslint-disable max-lines */
// ==============================================================================
// Block Conversion
// ==============================================================================

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
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
} from '../../types/anthropic.js';
import { makeId } from '../../utils/id.js';

const ANTHROPIC_BUILTIN_TOOL_TYPES = new Set([
  'web_search_20250305',
  'computer_use_20250124',
  'text_editor_20250124',
  'bash_20250124',
]);

// ==============================================================================
// Main Translation
// ==============================================================================

export interface TranslateRequestOptions {
  /** Default max tokens when not provided (Anthropic requires `max_tokens`). */
  defaultMaxTokens?: number;
  /** Thinking budget overrides, keyed by effort. */
  reasoningBudgets?: Partial<Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh', number>>;
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
  xhigh: 65536,
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

  let systemBlocks: AnthropicTextBlock[] = extractSystemBlocks(data.instructions);

  const built = buildMessages(data, systemBlocks);
  let messages = built.messages;
  let hasPromptCache = built.hasPromptCache;

  if (data.prompt_cache_key) {
    hasPromptCache = true;
    systemBlocks = markBlocksForCache(systemBlocks);
    messages = markCacheBreakpoint(messages);
  }

  messages = repairToolAdjacency(messages);
  messages = sanitizeMessages(messages);
  messages = ensureEndsWithUser(messages);

  if (data.prompt_cache_key) {
    messages = markCacheBreakpoint(messages);
  }

  const request: AnthropicRequest = {
    model,
    messages,
    max_tokens: maxTokens,
  };

  if (systemBlocks.length) {
    request.system = systemBlocks;
  }
  if (typeof data.temperature === 'number') {
    request.temperature = data.temperature;
  }
  if (typeof data.top_p === 'number') {
    request.top_p = data.top_p;
  }

  const tools = mapTools(data.tools || []);
  if (tools.length) {
    request.tools = tools;
    const toolChoice = mapToolChoice(data.tool_choice);
    if (toolChoice) {
      request.tool_choice = toolChoice;
    }
  }

  if (data.metadata && typeof data.metadata === 'object') {
    request.metadata = data.metadata;
  }

  const thinking = mapThinking(data, maxTokens, options.reasoningBudgets);
  if (thinking) {
    request.thinking = thinking;
    // Adaptive models take thinking depth via output_config.effort, not a token
    // budget. Carry the Responses reasoning.effort through so depth is preserved.
    if (thinking.type === 'adaptive') {
      const effort = normalizeAnthropicEffort(data.reasoning?.effort);
      if (effort) {
        request.output_config = { effort };
      }
    }
  }

  return { request, hasPromptCache };
}

function extractSystemBlocks(instructions: ResponsesRequest['instructions']): AnthropicTextBlock[] {
  if (!instructions) {
    return [];
  }
  if (typeof instructions === 'string') {
    return [{ type: 'text', text: instructions }];
  }
  if (!Array.isArray(instructions)) {
    return [];
  }
  const blocks: AnthropicTextBlock[] = [];
  for (const item of instructions) {
    if (typeof item === 'string') {
      blocks.push({ type: 'text', text: item });
    } else if (item && typeof item === 'object') {
      const block: AnthropicTextBlock = {
        type: 'text',
        text: String(item.text ?? ''),
      };
      // eslint-disable-next-line no-restricted-syntax -- TypeScript narrowing requires this cast
      const cacheItem = item as { cache_control?: Record<string, unknown> };
      const cache = cacheItem.cache_control;
      if (cache) {
        block.cache_control = cache;
      }
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
    typeof rawInput === 'string' ? [rawInput] : Array.isArray(rawInput) ? rawInput : [];

  for (const raw of inputItems) {
    if (typeof raw === 'string') {
      flushPending();
      messages.push({ role: 'user', content: [{ type: 'text', text: raw }] });
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const item: Record<string, unknown> = raw;
    const itemType: string = String(item.type || 'message');

    if (
      itemType === 'function_call_output' ||
      itemType === 'commandExecutionOutput' ||
      itemType === 'fileChangeOutput' ||
      itemType === 'custom_tool_call_output'
    ) {
      flushToolUses();
      const callId: string = String(item.call_id || item.id || makeId('call'));
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
      if (block) {
        pendingToolUses.push(block);
      }
      continue;
    }

    if (itemType === 'reasoning') {
      flushPending();
      continue;
    }

    if (itemType === 'message' || itemType === 'agentMessage') {
      flushPending();
      let role: string = String(item.role || 'user');
      if (role === 'developer') {
        role = 'system';
      }

      if (role === 'system') {
        const text = extractMessageText(item);
        if (text) {
          systemBlocks.push({ type: 'text', text });
        }
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
            const contentPart: ResponsesContentPart = part;
            if (
              contentPart.type === 'input_text' ||
              contentPart.type === 'text' ||
              contentPart.type === 'output_text'
            ) {
              const textBlock: AnthropicContentBlock = {
                type: 'text',
                text: String(contentPart.text ?? ''),
              };
              // eslint-disable-next-line no-restricted-syntax -- ResponsesContentPart union doesn't expose cache_control
              const cc = (contentPart as { cache_control?: Record<string, unknown> }).cache_control;
              if (cc) {
                textBlock.cache_control = cc;
              }
              contentBlocks.push(textBlock);
            } else if (
              contentPart.type === 'input_image' ||
              contentPart.type === 'image' ||
              contentPart.type === 'image_url'
            ) {
              const imgUrlPart: { image_url?: string | { url: string } } = contentPart;
              const imgUrl = imgUrlPart.image_url;
              const urlStr =
                typeof imgUrl === 'string'
                  ? imgUrl
                  : imgUrl && typeof imgUrl === 'object'
                    ? imgUrl.url
                    : '';
              if (urlStr.startsWith('data:')) {
                const match = /^data:([^;,]+);base64,(.*)$/.exec(urlStr);
                if (match) {
                  contentBlocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] },
                  });
                }
              } else if (urlStr) {
                const imgSource = { type: 'url', url: urlStr };
                contentBlocks.push({
                  type: 'image',
                  source: imgSource,
                });
              } else {
                const data = String(contentPart.data ?? contentPart.base64 ?? '');
                if (data) {
                  contentBlocks.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: contentPart.mime_type || contentPart.media_type || 'image/png',
                      data,
                    },
                  });
                }
                // ==============================================================================
                // Tool Adjacency
                // ==============================================================================
              }
            } else if (contentPart.type === 'input_file') {
              contentBlocks.push({
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: contentPart.mime_type || 'application/pdf',
                  data: String(contentPart.data ?? ''),
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
    if (block.cache_control) {
      hasPromptCache = true;
    }
  }

  return { messages, hasPromptCache };
}

function extractMessageText(item: Record<string, unknown>): string {
  const rawContent = item.content;
  if (typeof rawContent === 'string') {
    return rawContent;
  }
  if (Array.isArray(rawContent)) {
    let out = '';
    for (const part of rawContent) {
      if (typeof part === 'string') {
        out += part;
      } else if (part && typeof part === 'object') {
        out += String(part.text ?? '');
      }
    }
    return out;
  }
  return '';
}

function extractToolOutputText(item: Record<string, unknown>): string {
  const raw = item.output ?? item.content ?? item.stdout ?? '';
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    let out = '';
    for (const part of raw) {
      if (typeof part === 'string') {
        out += part;
      } else if (part && typeof part === 'object') {
        out += String(part.text ?? '');
      }
    }
    return out;
  }

  if (raw && typeof raw === 'object') {
    // eslint-disable-next-line no-restricted-syntax -- type narrowing for unknown type
    return String((raw as Record<string, unknown>).content ?? '');
  }
  return '';
}

function mapInputToolCall(item: Record<string, unknown>): AnthropicToolUseBlock | undefined {
  const callId: string = String(item.call_id || item.id || makeId('call'));
  let name = typeof item.name === 'string' ? item.name : undefined;
  const itemType = typeof item.type === 'string' ? item.type : undefined;

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

  if (!name) {
    return undefined;
  }

  // The OpenAI Responses spec sends `function_call.arguments` as a JSON string,
  // whereas Anthropic requires `tool_use.input` to be a JSON object. Parse the
  // string form; pass an already-object form through unchanged; fall back to
  // `{}` for anything that is not a plain object, so a corrupt history item can
  // never emit a non-object `input` (Anthropic 400s on that).
  let input: Record<string, unknown> = {};
  const rawArgs = item.arguments;
  if (typeof rawArgs === 'string') {
    if (rawArgs.trim() === '') {
      // Empty / whitespace-only is the ordinary no-argument call (equivalent to
      // `"{}"`): forward `{}` silently — normal traffic, not a corrupt payload.
      input = {};
    } else {
      let parsed: unknown;
      let reason = '';
      // eslint-disable-next-line no-restricted-syntax -- fail-open parse of untrusted history JSON
      try {
        parsed = JSON.parse(rawArgs);
        if (parsed === null) {
          reason = 'null';
        } else if (Array.isArray(parsed)) {
          reason = 'array';
        } else if (typeof parsed !== 'object') {
          reason = 'scalar';
        }
      } catch {
        reason = 'parse-failed';
      }
      if (reason === '') {
        // eslint-disable-next-line no-restricted-syntax -- narrowed to a plain object above
        input = parsed as Record<string, unknown>;
      } else {
        // Diagnostics ONLY — never log the argument content. This library is
        // published and its arguments routinely carry user prompts / creative
        // content; the parse error message also embeds a payload fragment, so
        // it is withheld too. Log just the tool name, a coarse reason, and the
        // length.
        console.warn(
          `[anthropic] tool "${name}" arguments were not a JSON object (${reason}, length ${rawArgs.length}); input set to {}`,
        );
      }
    }
  } else if (rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    // eslint-disable-next-line no-restricted-syntax -- TypeScript narrowing requires this cast
    input = rawArgs as Record<string, unknown>;
  }

  const block: AnthropicToolUseBlock = {
    type: 'tool_use',
    id: callId,
    name,
    input: input,
  };

  const cacheItem: { cache_control?: Record<string, unknown> } = item;
  const cache = cacheItem.cache_control;
  if (cache) {
    block.cache_control = cache;
  }

  return block;
}

// ==============================================================================
// Utility Functions
// ==============================================================================

function mapTools(tools: ResponsesTool[]): (AnthropicTool | Record<string, unknown>)[] {
  const out: (AnthropicTool | Record<string, unknown>)[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const tt = tool.type || '';
    if (ANTHROPIC_BUILTIN_TOOL_TYPES.has(tt)) {
      out.push(tool);
      continue;
    }
    if (tt !== 'function') {
      continue;
    }
    const fn = tool.function;
    const name = fn?.name ?? tool.name;
    if (!name) {
      continue;
    }
    const toolInputSchema: Record<string, unknown> = fn?.parameters ??
      tool.parameters ?? { type: 'object' };
    out.push({
      name,
      description: fn?.description ?? tool.description ?? '',
      input_schema: toolInputSchema,
    });
  }
  return out;
}

function mapToolChoice(choice: ResponsesToolChoice): AnthropicToolChoice | undefined {
  if (choice == null || choice === 'auto') {
    return { type: 'auto' };
  }
  if (choice === 'required') {
    return { type: 'any' };
  }
  if (choice === 'none') {
    return undefined;
  }
  if (typeof choice === 'object') {
    if (choice.type === 'function' && 'function' in choice && choice.function?.name) {
      return { type: 'tool', name: choice.function.name };
    }
    if (choice.type === 'auto' || choice.type === 'any') {
      return { type: choice.type };
    }
  }
  return { type: 'auto' };
}

// ==============================================================================
// Thinking & Effort
// ==============================================================================

/**
 * Claude "adaptive-generation" models — Sonnet 5+, Opus 4.6+, and the
 * Fable/Mythos 5 family — use `thinking: {type:'adaptive'}` and REJECT the
 * legacy `{type:'enabled', budget_tokens}` with a 400. Older Claude models
 * (Opus ≤4.5, Sonnet ≤4.5, every Haiku shipped so far) and non-Claude models
 * keep the budget_tokens shape. On adaptive models, thinking depth is set by
 * `output_config.effort`, not a token budget.
 *
 * Tolerant of provider prefixes (`anthropic/claude-…`, `us.anthropic.claude-…`)
 * and of dated snapshots mis-captured as a version (`claude-3-5-sonnet-20241022`).
 */
export function isAdaptiveThinkingModel(model: string | undefined): boolean {
  if (typeof model !== 'string' || !/claude/i.test(model)) {
    return false;
  }
  const lower = model.toLowerCase();
  if (/(fable|mythos)/.test(lower)) {
    return true;
  }
  const match = /(opus|sonnet|haiku)[-/ ]?(\d+)(?:[-.](\d+))?/.exec(lower);
  if (!match) {
    return false;
  }
  const family = match[1];
  const major = Number(match[2]);
  let minor = match[3] === undefined ? 0 : Number(match[3]);
  // A 3-digit-plus "version" is really a dated snapshot caught by the digit
  // group (e.g. ...-20241022) — treat it as no version rather than a huge one.
  if (major >= 100) {
    return false;
  }
  if (minor >= 100) {
    minor = 0;
  }
  if (family === 'opus' || family === 'sonnet') {
    return major >= 5 || (major === 4 && minor >= 6);
  }
  // haiku: no adaptive-thinking generation has shipped (4.5 uses budget_tokens);
  // treat a hypothetical 5+ as adaptive for forward-compat.
  return major >= 5;
}

const ANTHROPIC_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Map a Responses `reasoning.effort` to an Anthropic `output_config.effort`
 *  value, or undefined when there is no direct equivalent (e.g. 'minimal'). */
export function normalizeAnthropicEffort(effort: string | undefined): string | undefined {
  if (typeof effort !== 'string') {
    return undefined;
  }
  const lower = effort.toLowerCase();
  return ANTHROPIC_EFFORT_LEVELS.has(lower) ? lower : undefined;
}

function mapThinking(
  data: ResponsesRequest,
  maxTokens: number,
  overrides?: Partial<Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh', number>>,
): AnthropicThinkingConfig | undefined {
  const reasoning = data.reasoning;
  if (!reasoning) {
    return undefined;
  }
  const effort = reasoning.effort;
  if (!effort || effort === 'minimal') {
    return undefined;
  }
  // Adaptive-generation models reject budget_tokens; emit the adaptive shape.
  // Depth is carried separately via output_config.effort (see translateRequest).
  if (isAdaptiveThinkingModel(data.model)) {
    return { type: 'adaptive' };
  }
  const budgets = { ...DEFAULT_REASONING_BUDGETS, ...overrides };
  const budget = budgets[effort] ?? DEFAULT_REASONING_BUDGETS.medium;
  const clamped = Math.max(1024, Math.min(budget, Math.max(1024, maxTokens - 1024)));
  return { type: 'enabled', budget_tokens: clamped };
}

function repairToolAdjacency(messages: AnthropicMessage[]): AnthropicMessage[] {
  const repaired: AnthropicMessage[] = [];
  const working = messages.map((msg) => ({
    ...msg,
    content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
  }));

  for (let i = 0; i < working.length; i++) {
    const msg = working[i];
    repaired.push(msg);
    const content = msg.content;
    if (msg.role !== 'assistant' || !Array.isArray(content)) {
      continue;
    }

    const toolUseIds = content
      .filter((block): block is AnthropicToolUseBlock => !!block && block.type === 'tool_use')
      .map((block) => block.id);
    if (!toolUseIds.length) {
      continue;
    }

    const next = working[i + 1];
    const nextUserContent =
      next && next.role === 'user' && Array.isArray(next.content) ? next.content : [];

    const foundById = new Map<string, AnthropicToolResultBlock>();
    const consumedInNext = new Set<string>();
    for (const block of nextUserContent) {
      if (block && block.type === 'tool_result') {
        // eslint-disable-next-line no-restricted-syntax -- TypeScript narrowing requires this cast
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
        if (later.role !== 'user' || !Array.isArray(later.content)) {
          continue;
        }
        const keep: AnthropicContentBlock[] = [];
        for (const block of later.content) {
          if (block && block.type === 'tool_result') {
            // eslint-disable-next-line no-restricted-syntax -- TypeScript narrowing requires this cast
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
        if (block && block.type === 'tool_result') {
          // eslint-disable-next-line no-restricted-syntax -- TypeScript narrowing requires this cast
          const tr = block as AnthropicToolResultBlock;
          if (consumedInNext.has(tr.tool_use_id)) {
            consumedInNext.delete(tr.tool_use_id);
            return false;
          }
        }
        return true;
      });
      if (remaining.length) {
        repaired.push({ role: 'user', content: remaining });
      }
      i += 1;
    }
  }

  return repaired;
}

function sanitizeMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) {
      continue;
    }
    if (Array.isArray(msg.content)) {
      const blocks = msg.content.filter((block) => {
        if (!block || typeof block !== 'object') {
          return false;
        }
        if (block.type === 'text' && !block.text) {
          return false;
        }
        return true;
      });
      if (!blocks.length) {
        continue;
      }
      out.push({ role: msg.role, content: blocks });
    } else if (typeof msg.content === 'string' && msg.content) {
      out.push({ role: msg.role, content: [{ type: 'text', text: msg.content }] });
    }
  }
  return out;
}

function ensureEndsWithUser(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (!messages.length) {
    return [{ role: 'user', content: [{ type: 'text', text: '...' }] }];
  }
  const last = messages[messages.length - 1];
  if (last.role === 'user') {
    return messages;
  }
  return [...messages, { role: 'user', content: [{ type: 'text', text: 'Continue.' }] }];
}

// ── prompt_cache_key → cache_control helpers ──

function markBlocksForCache(blocks: AnthropicTextBlock[]): AnthropicTextBlock[] {
  // Anthropic allows at most 4 cache_control breakpoints total.
  // Reserve 1 for the conversation breakpoint, leaving 3 for system blocks.
  let count = 0;
  for (const block of blocks) {
    if (!block.cache_control) {
      block.cache_control = { type: 'ephemeral' };
      count++;
      if (count >= 3) {
        break;
      }
    }
  }
  return blocks;
}

/**
 * Mark a stable cache breakpoint on the last assistant message's last text block.
 * Falls back to the first user message if there's no assistant message (first turn).
 *
 * The last assistant message won't change across turns, so the cache key stays
 * stable and can be reused for subsequent requests (unlike the last user message
 * which contains the new input each time).
 */
function markCacheBreakpoint(messages: AnthropicMessage[]): AnthropicMessage[] {
  // First assistant is at a fixed position from turn 2 onwards
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (block.type === 'text') {
          if (!block.cache_control) {
            block.cache_control = { type: 'ephemeral' };
          }
          return messages;
        }
      }
    }
  }

  // First turn: no assistant yet, mark the first user message's last text block
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (block.type === 'text') {
          if (!block.cache_control) {
            block.cache_control = { type: 'ephemeral' };
          }
          return messages;
        }
      }
    }
  }

  return messages;
}
