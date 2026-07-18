// Anthropic Messages API client. Port of the AnthropicClient half of
// internal/llm/client.go, on the official @anthropic-ai/sdk.
import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatRequest,
  ChatResponse,
  ClientConfig,
  CompletionOptions,
  ContentBlock,
  LLMClient,
  Message,
  ToolCall,
  UsageInfo,
} from './types.js';
import { extractBlockText, userAgent } from './types.js';
import { normalizeAuthHeader } from './resolver.js';
import { resolveUsage } from './usage.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class AnthropicClient implements LLMClient {
  private readonly cfg: ClientConfig;
  private readonly sdk: Anthropic;

  constructor(cfg: ClientConfig) {
    cfg = { ...cfg };
    if (cfg.timeoutMs <= 0) cfg.timeoutMs = DEFAULT_TIMEOUT_MS;
    if (!cfg.url.endsWith('/v1/messages') && !cfg.url.endsWith('/v1/messages/')) {
      const baseURL = cfg.url.replace(/\/+$/, '');
      if (!baseURL.endsWith('/v1/messages')) {
        cfg.url = baseURL + '/v1/messages';
      }
    }

    const sdkBaseURL = cfg.url.replace(/\/+$/, '').replace(/\/v1\/messages$/, '');
    let authHeader = '';
    try {
      authHeader = normalizeAuthHeader(cfg.authHeader ?? '');
    } catch {
      authHeader = '';
    }
    if (authHeader === '') authHeader = 'authorization';
    cfg.authHeader = authHeader;

    const defaultHeaders: Record<string, string | null> = {
      'User-Agent': userAgent('claude'),
      ...(cfg.extraHeaders ?? {}),
    };

    let apiKey: string | null = null;
    let authToken: string | null = null;
    switch (authHeader) {
      case 'authorization':
        defaultHeaders['X-Api-Key'] = null;
        authToken = cfg.apiKey; // Bearer
        break;
      case 'x-api-key':
        defaultHeaders['Authorization'] = null;
        apiKey = cfg.apiKey;
        break;
      default:
        defaultHeaders['Authorization'] = null;
        defaultHeaders['X-Api-Key'] = null;
        defaultHeaders[authHeader] = cfg.apiKey;
    }

    this.cfg = cfg;
    this.sdk = new Anthropic({
      baseURL: sdkBaseURL,
      apiKey,
      authToken,
      maxRetries: 5,
      timeout: cfg.timeoutMs,
      defaultHeaders,
    });
  }

  async completions(req: ChatRequest, opts?: CompletionOptions): Promise<ChatResponse> {
    const model = req.model || this.cfg.model;
    const params = this.buildParams(model, req);
    const resp = await this.sdk.messages.create(params, { signal: opts?.signal });
    return this.mapResponse(resp);
  }

  private buildParams(model: string, req: ChatRequest): Anthropic.MessageCreateParamsNonStreaming {
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    const messages: Anthropic.MessageParam[] = [];
    let pendingToolResults: Message[] = [];

    const flushToolResults = (): void => {
      if (pendingToolResults.length === 0) return;
      const blocks: Anthropic.ContentBlockParam[] = pendingToolResults.map((tr) => ({
        type: 'tool_result' as const,
        tool_use_id: tr.tool_call_id ?? '',
        content: typeof tr.content === 'string' ? tr.content : String(tr.content),
        is_error: false,
      }));
      messages.push({ role: 'user', content: blocks });
      pendingToolResults = [];
    };

    for (const msg of req.messages) {
      switch (msg.role) {
        case 'system':
          if (typeof msg.content === 'string') {
            systemBlocks.push({ type: 'text', text: msg.content });
          }
          flushToolResults();
          break;
        case 'tool':
          pendingToolResults.push(msg);
          break;
        case 'assistant': {
          flushToolResults();
          const blocks: Anthropic.ContentBlockParam[] = [];
          if (typeof msg.content === 'string' && msg.content !== '') {
            blocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.tool_calls ?? []) {
            let argsMap: Record<string, unknown> = {};
            if (tc.function.arguments !== '') {
              try {
                argsMap = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch (err) {
                throw new Error(
                  `invalid tool call arguments for ${tc.function.name}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            blocks.push({ type: 'tool_use', id: tc.id, input: argsMap, name: tc.function.name });
          }
          if (blocks.length > 0) {
            messages.push({ role: 'assistant', content: blocks });
          } else {
            const s = typeof msg.content === 'string' ? msg.content : '';
            messages.push({ role: 'assistant', content: [{ type: 'text', text: s }] });
          }
          break;
        }
        default: {
          flushToolResults();
          if (typeof msg.content === 'string') {
            messages.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
          } else if (Array.isArray(msg.content)) {
            const blocks: Anthropic.ContentBlockParam[] = msg.content.map((b: ContentBlock) =>
              b.type === 'tool_result'
                ? {
                    type: 'tool_result' as const,
                    tool_use_id: b.tool_use_id ?? '',
                    content: extractBlockText(b),
                    is_error: false,
                  }
                : { type: 'text' as const, text: b.text ?? '' },
            );
            if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
          }
        }
      }
    }
    flushToolResults();

    const tools: Anthropic.ToolUnion[] = (req.tools ?? []).map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: buildToolInputSchema(t.function.parameters),
    }));

    let maxTokens = req.maxTokens ?? 0;
    if (maxTokens <= 0) maxTokens = 8192;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      messages,
    };

    if (systemBlocks.length > 0) {
      // Prompt caching: mark the last system block as an ephemeral cache point.
      systemBlocks[systemBlocks.length - 1]!.cache_control = { type: 'ephemeral' };
      params.system = systemBlocks;
    }
    if (tools.length > 0) {
      (tools[tools.length - 1] as Anthropic.Tool).cache_control = { type: 'ephemeral' };
      params.tools = tools;
    }
    if (req.temperature !== undefined) {
      params.temperature = req.temperature;
    }

    // Vendor-specific body fields; the SDK passes unknown properties through.
    if (this.cfg.extraBody) {
      Object.assign(params as unknown as Record<string, unknown>, this.cfg.extraBody);
    }

    return params;
  }

  private mapResponse(resp: Anthropic.Message): ChatResponse {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of resp.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'thinking':
          if (block.thinking !== '') thinkingParts.push(block.thinking);
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
      }
    }

    const contentStr = textParts.length > 0 ? textParts.join('\n') : undefined;
    const reasoningContent = thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined;

    let finishReason = resp.stop_reason ?? '';
    if (finishReason === '') finishReason = 'stop';

    let usage: UsageInfo | undefined;
    const u = resp.usage;
    if (u && (u.input_tokens > 0 || u.output_tokens > 0)) {
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      usage = {
        prompt_tokens: u.input_tokens + cacheRead + cacheWrite,
        completion_tokens: u.output_tokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        total_tokens: 0,
      };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    } else {
      usage = resolveUsage(resp);
    }

    return {
      id: resp.id,
      model: resp.model,
      choices: [
        {
          message: {
            role: 'assistant',
            content: contentStr,
            reasoning_content: reasoningContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    };
  }
}

function buildToolInputSchema(params: Record<string, unknown>): Anthropic.Tool.InputSchema {
  const schema: Anthropic.Tool.InputSchema = { type: 'object' };
  if ('properties' in params) {
    schema.properties = params['properties'] as Record<string, unknown> | null;
  }
  if (Array.isArray(params['required'])) {
    schema.required = (params['required'] as unknown[]).filter(
      (r): r is string => typeof r === 'string',
    );
  }
  for (const [k, v] of Object.entries(params)) {
    if (k === 'type' || k === 'properties' || k === 'required') continue;
    (schema as Record<string, unknown>)[k] = v;
  }
  return schema;
}
