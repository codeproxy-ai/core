/** Anthropic Messages API type definitions (subset). */

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: Record<string, unknown>;
}

export interface AnthropicImageSource {
  type: 'base64' | 'url';
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: AnthropicImageSource;
  cache_control?: Record<string, unknown>;
}

export interface AnthropicDocumentBlock {
  type: 'document';
  source: AnthropicImageSource;
  cache_control?: Record<string, unknown>;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
  cache_control?: Record<string, unknown>;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | { type: string; [k: string]: unknown };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[] | string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface AnthropicThinkingConfig {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  tools?: (AnthropicTool | Record<string, unknown>)[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, unknown>;
  thinking?: AnthropicThinkingConfig;
  stream?: boolean;
  [k: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason?: string;
  stop_sequence?: string | null;
  usage: AnthropicUsage;
}

/** Anthropic streaming SSE events. */
export type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicResponse }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta'; signature: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: Record<string, unknown>; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: string; [k: string]: unknown };
