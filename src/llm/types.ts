// Shared LLM request/response types. Port of the data-type half of
// internal/llm/client.go. JSON field names follow the Go wire contract.

export let appVersion = '0.0.1-dev';
export function setAppVersion(v: string): void {
  appVersion = v;
}

export function userAgent(provider?: string): string {
  let ua = `open-code-review/${appVersion}`;
  if (provider) ua += ` | ${provider}`;
  return ua;
}

/** A single block within a multi-part message content. */
export interface ContentBlock {
  type: string; // "text" or "tool_result"
  text?: string;
  tool_use_id?: string;
  content?: ContentBlock[];
}

/**
 * A single message in a chat conversation. Content is either a plain string
 * or an array of content blocks (Claude multi-part content).
 */
export interface Message {
  role: string;
  content: string | ContentBlock[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export function newTextMessage(role: string, content: string): Message {
  return { role, content };
}

export function newToolCallMessage(content: string, toolCalls: ToolCall[]): Message {
  return { role: 'assistant', content, tool_calls: toolCalls.length > 0 ? [...toolCalls] : undefined };
}

/** Tool-role message in the OpenAI Chat Completions format. */
export function newToolResultMessage(toolCallID: string, result: string): Message {
  return { role: 'tool', content: result, tool_call_id: toolCallID };
}

/** Concatenated text content of a message (string or nested blocks). */
export function extractText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(extractBlockText).join('');
  return '';
}

export function extractBlockText(block: ContentBlock): string {
  if (block.text) return block.text;
  return (block.content ?? []).map(extractBlockText).join('');
}

export interface FunctionCall {
  name: string;
  arguments: string; // JSON-encoded string
}

export interface ToolCall {
  id: string;
  type: string;
  function: FunctionCall;
}

export interface ResponseMessage {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
}

export interface Choice {
  message: ResponseMessage;
  finish_reason: string;
}

/** Token usage extracted from an LLM API response. */
export interface UsageInfo {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Choice[];
  usage?: UsageInfo;
}

/** Removes reasoning wrapper tags from content. */
export function stripThinkTags(s: string): string {
  return s.replaceAll('<think>', '').replaceAll('</think>', '');
}

/** Text content of the first choice, falling back to reasoning content. */
export function responseContent(r: ChatResponse): string {
  const msg = r.choices[0]?.message;
  if (!msg) return '';
  if (msg.content) return stripThinkTags(msg.content).trim();
  return msg.reasoning_content ?? '';
}

/** Tool calls of the first choice. */
export function responseToolCalls(r: ChatResponse): ToolCall[] {
  return r.choices[0]?.message.tool_calls ?? [];
}

export interface FunctionDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDef {
  type: string;
  function: FunctionDef;
}

/** Payload for a chat completion call. */
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
}

/** Configuration for connecting to an LLM service. */
export interface ClientConfig {
  url: string;
  apiKey: string;
  model: string;
  authHeader?: string;
  /** Per-request timeout in ms; 0 = client default (5 min). */
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

export interface CompletionOptions {
  signal?: AbortSignal;
}

/** Unified interface for all LLM protocol implementations (no streaming). */
export interface LLMClient {
  completions(req: ChatRequest, opts?: CompletionOptions): Promise<ChatResponse>;
}
