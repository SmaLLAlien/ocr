// OpenAI-compatible chat completions client. Port of the OpenAIClient half
// of internal/llm/client.go, on the official openai SDK.
import OpenAI from 'openai';
import type {
  ChatRequest,
  ChatResponse,
  Choice,
  ClientConfig,
  CompletionOptions,
  LLMClient,
  ToolCall,
} from './types.js';
import { extractText, userAgent } from './types.js';
import { resolveUsage } from './usage.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class OpenAIClient implements LLMClient {
  private readonly cfg: ClientConfig;
  private readonly sdk: OpenAI;

  constructor(cfg: ClientConfig) {
    cfg = { ...cfg };
    if (cfg.timeoutMs <= 0) cfg.timeoutMs = DEFAULT_TIMEOUT_MS;
    let baseURL = cfg.url.replace(/\/+$/, '');
    if (!baseURL.endsWith('/chat/completions')) {
      cfg.url = baseURL + '/chat/completions';
    }
    const sdkBaseURL = cfg.url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

    this.cfg = cfg;
    this.sdk = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: sdkBaseURL,
      maxRetries: 5,
      timeout: cfg.timeoutMs,
      defaultHeaders: {
        'User-Agent': userAgent(),
        ...(cfg.extraHeaders ?? {}),
      },
    });
  }

  async completions(req: ChatRequest, opts?: CompletionOptions): Promise<ChatResponse> {
    const model = req.model || this.cfg.model;
    const params = this.buildParams(model, req);
    const resp = await this.sdk.chat.completions.create(params, { signal: opts?.signal });
    return this.mapResponse(resp);
  }

  private buildParams(
    model: string,
    req: ChatRequest,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    for (const msg of req.messages) {
      const content = extractText(msg);
      switch (msg.role) {
        case 'system':
          messages.push({ role: 'system', content });
          break;
        case 'user':
          messages.push({ role: 'user', content });
          break;
        case 'tool':
          messages.push({ role: 'tool', content, tool_call_id: msg.tool_call_id ?? '' });
          break;
        case 'assistant':
          if (!msg.tool_calls || msg.tool_calls.length === 0) {
            messages.push({ role: 'assistant', content });
          } else {
            messages.push({
              role: 'assistant',
              ...(content !== '' ? { content } : {}),
              tool_calls: msg.tool_calls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.function.name, arguments: tc.function.arguments },
              })),
            });
          }
          break;
        default:
          messages.push({ role: 'user', content });
      }
    }

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
    };

    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as Record<string, unknown>,
        },
      }));
    }
    if (req.maxTokens && req.maxTokens > 0) {
      params.max_completion_tokens = req.maxTokens;
    }
    if (req.temperature !== undefined) {
      params.temperature = req.temperature;
    }

    // Vendor-specific body fields (extra_body) merge into the request payload;
    // the SDK passes unknown properties through to the wire.
    if (this.cfg.extraBody) {
      Object.assign(params as unknown as Record<string, unknown>, this.cfg.extraBody);
    }

    return params;
  }

  private mapResponse(resp: OpenAI.Chat.Completions.ChatCompletion): ChatResponse {
    let usage = resolveUsage(resp);
    if (!usage && resp.usage && (resp.usage.prompt_tokens > 0 || resp.usage.completion_tokens > 0)) {
      usage = {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
      };
    }

    const choices: Choice[] = (resp.choices ?? []).map((ch) => {
      const toolCalls: ToolCall[] = [];
      for (const tc of ch.message.tool_calls ?? []) {
        if (tc.type === 'function') {
          toolCalls.push({
            id: tc.id,
            type: tc.type,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          });
        }
      }

      // Some OpenAI-compatible providers return reasoning in a non-standard field.
      const raw = ch.message as unknown as Record<string, unknown>;
      const reasoning = raw['reasoning_content'];

      return {
        message: {
          role: 'assistant',
          content: ch.message.content ?? undefined,
          reasoning_content: typeof reasoning === 'string' ? reasoning : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: ch.finish_reason ?? '',
      };
    });

    return { id: resp.id, model: resp.model, choices, usage };
  }
}
