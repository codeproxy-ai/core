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
  OpenAiChatToolChoice,
} from '../../types/openai_chat.js';
import { jsonStringifySafe } from '../../utils/json.js';

export interface TranslateRequestOptions {
  /** Default max tokens when not provided. */
  defaultMaxTokens?: number;
}

export interface TranslateRequestResult {
  request: OpenAiChatRequest;
}

/** Convert a Responses API request into an OpenAI Chat API request. */
export function translateRequest(
  data: ResponsesRequest,
  _options: TranslateRequestOptions = {},
): TranslateRequestResult {
  const messages: OpenAiChatMessage[] = [];

  const systemContent = buildSystemContent(data.instructions);
  if (systemContent) messages.push({ role: 'system', content: systemContent });

  const inputItems: ResponsesInputItem[] =
    typeof data.input === 'string'
      ? [data.input]
      : Array.isArray(data.input)
        ? data.input
        : [];

  for (const raw of inputItems) {
    if (typeof raw === 'string') {
      messages.push({ role: 'user', content: raw });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    processInputItem(raw as Record<string, unknown>, messages);
  }

  const request: OpenAiChatRequest = {
    model: data.model,
    messages,
  };

  if (typeof data.temperature === 'number') request.temperature = data.temperature;
  if (typeof data.top_p === 'number') request.top_p = data.top_p;

  const maxTokens =
    (typeof data.max_output_tokens === 'number' && data.max_output_tokens) ||
    (typeof data.max_tokens === 'number' && data.max_tokens) ||
    _options.defaultMaxTokens;
  if (typeof maxTokens === 'number') request.max_tokens = maxTokens;

  const tools = mapTools(data.tools ?? []);
  if (tools.length) {
    request.tools = tools;
    const toolChoice = mapToolChoice(data.tool_choice);
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
  }

  // Some upstreams (e.g. aihubmix routing thinking-enabled glm-4.6) reject
  // assistant tool-call messages whose reasoning_content is missing OR empty.
  // Clients like Codex with store:false don't echo reasoning items back, so
  // backfill a non-empty placeholder when the client didn't provide one.
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      if (m.reasoning_content == null || m.reasoning_content === '') {
        m.reasoning_content = '.';
      }
    }
  }

  return { request };
}

function buildSystemContent(instructions: ResponsesRequest['instructions']): string {
  if (!instructions) return '';
  if (typeof instructions === 'string') return instructions;
  if (!Array.isArray(instructions)) return '';
  let out = '';
  for (const block of instructions) {
    if (typeof block === 'string') out += block;
    else if (block && typeof block === 'object') out += String((block as { text?: string }).text ?? '');
  }
  return out;
}

function processInputItem(
  item: Record<string, unknown>,
  messages: OpenAiChatMessage[],
): void {
  const itemType = (item.type as string) || 'message';

  const getLastAssistant = (): OpenAiChatMessage => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') return last;
    const msg: OpenAiChatMessage = { role: 'assistant', content: null };
    messages.push(msg);
    return msg;
  };

  if (itemType === 'message' || itemType === 'agentMessage') {
    let role = (item.role as string) || 'user';
    if (role === 'developer') role = 'system';

    let content = '';
    const rawContent = item.content;
    if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (typeof part === 'string') {
          content += part;
        } else if (part && typeof part === 'object') {
          const p = part as ResponsesContentPart;
          if (p.type === 'input_text' || p.type === 'text' || p.type === 'output_text') {
            content += String(p.text ?? '');
          }
        }
      }
    }

    if (role === 'assistant' || role === 'model') {
      const amsg = getLastAssistant();
      if (content) {
        amsg.content = ((amsg.content as string | null | undefined) ?? '') + content;
      }
    } else {
      messages.push({ role, content: content || '' });
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
    processToolCall(item, messages, getLastAssistant);
    return;
  }

  if (
    itemType === 'function_call_output' ||
    itemType === 'commandExecutionOutput' ||
    itemType === 'fileChangeOutput' ||
    itemType === 'custom_tool_call_output'
  ) {
    processToolOutput(item, messages);
    return;
  }
}

function processToolCall(
  item: Record<string, unknown>,
  messages: OpenAiChatMessage[],
  getLastAssistant: () => OpenAiChatMessage,
): void {
  const callId =
    (item.call_id as string | undefined) ||
    (item.id as string | undefined) ||
    Math.random().toString(36).substring(7);
  let name = item.name as string | undefined;
  const itemType = item.type as string | undefined;

  if (!name) {
    if (itemType === 'commandExecution') name = 'run_shell_command';
    else if (itemType === 'local_shell_call') name = 'local_shell_command';
    else if (itemType === 'fileChange') name = 'write_file';
    else if (itemType === 'web_search_call') name = 'web_search';
  }

  let args: unknown =
    item.arguments ?? item.input ?? (isEmpty(item.arguments) && isEmpty(item.input) ? {} : {});
  if (isEmpty(args) && itemType === 'web_search_call') {
    args = item.action ?? {};
  }

  const argsStr = typeof args === 'string' ? args : jsonStringifySafe(args ?? {});

  if (!name) return;

  const amsg = getLastAssistant();
  if (!amsg.tool_calls) amsg.tool_calls = [];
  amsg.tool_calls.push({
    id: callId,
    type: 'function',
    function: { name, arguments: argsStr },
  });
}

function processToolOutput(
  item: Record<string, unknown>,
  messages: OpenAiChatMessage[],
): void {
  const callId = (item.call_id as string | undefined) || (item.id as string | undefined);
  const outputRaw = item.output ?? item.content ?? item.stdout ?? '';

  let content = '';
  if (typeof outputRaw === 'string') {
    content = outputRaw;
  } else if (Array.isArray(outputRaw)) {
    for (const part of outputRaw) {
      if (typeof part === 'string') content += part;
      else if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: string };
        if (p.type === 'input_text' || p.type === 'text') content += String(p.text ?? '');
      }
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
}

function mapTools(tools: ResponsesTool[]): OpenAiChatTool[] {
  const out: OpenAiChatTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const tt = tool.type;
    if (tt === 'function') {
      const fn = tool.function;
      const name = fn?.name ?? tool.name;
      if (!name) continue;
      out.push({
        type: 'function',
        function: {
          name,
          description: fn?.description ?? tool.description ?? '',
          parameters: (fn?.parameters ?? tool.parameters ?? { type: 'object' }) as Record<string, unknown>,
        },
      });
    }
  }
  return out;
}

function mapToolChoice(choice: ResponsesToolChoice): OpenAiChatToolChoice | undefined {
  if (choice == null) return undefined;
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  if (typeof choice === 'object') {
    if (choice.type === 'function' && 'function' in choice && choice.function?.name) {
      return { type: 'function', function: { name: choice.function.name } };
    }
    return choice as OpenAiChatToolChoice;
  }
  return undefined;
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}
