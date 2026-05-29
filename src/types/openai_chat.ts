/**
 * OpenAI chat/completions API type definitions (subset used by the openai-chat upstream format).
 * Only the fields needed for request/response/stream translation are typed.
 */

export interface OpenAiChatToolCall {
  id?: string;
  type?: 'function' | string;
  extra_content?: {
    google?: {
      thought_signature?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
  thought_signature?: string;
}

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: string | Array<{ type: string; text?: string; [k: string]: unknown }> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiChatToolCall[];
  reasoning_content?: string;
  [key: string]: unknown;
}

export interface OpenAiChatFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAiChatWebSearchTool {
  type: 'web_search';
  web_search: {
    enable: boolean;
    search_engine?: string;
    [k: string]: unknown;
  };
}

export type OpenAiChatTool =
  | OpenAiChatFunctionTool
  | OpenAiChatWebSearchTool
  | Record<string, unknown>;

export type OpenAiChatToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } }
  | Record<string, unknown>;

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: OpenAiChatTool[];
  tool_choice?: OpenAiChatToolChoice;
  [key: string]: unknown;
}

export interface OpenAiChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenAiChatChoice {
  index?: number;
  message: {
    role?: string;
    content?: string | null;
    tool_calls?: OpenAiChatToolCall[];
    reasoning_content?: string;
    [key: string]: unknown;
  };
  finish_reason?: string;
  [key: string]: unknown;
}

export interface OpenAiChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: OpenAiChatChoice[];
  usage?: OpenAiChatUsage;
  [key: string]: unknown;
}

export interface OpenAiChatStreamDeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  extra_content?: OpenAiChatToolCall['extra_content'];
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
  thought_signature?: string;
}

export interface OpenAiChatStreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: OpenAiChatStreamDeltaToolCall[];
  [key: string]: unknown;
}

export interface OpenAiChatStreamChoice {
  index?: number;
  delta?: OpenAiChatStreamDelta;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface OpenAiChatStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAiChatStreamChoice[];
  usage?: OpenAiChatUsage;
  [key: string]: unknown;
}
