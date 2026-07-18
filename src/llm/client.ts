// Client factory. Port of NewLLMClient from internal/llm/client.go.
import type { LLMClient } from './types.js';
import type { ResolvedEndpoint } from './resolver.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAIClient } from './openai.js';

/**
 * Creates the appropriate client for the resolved endpoint protocol:
 * "anthropic" -> AnthropicClient, anything else -> OpenAIClient.
 */
export function newLLMClient(ep: ResolvedEndpoint): LLMClient {
  const cfg = {
    url: ep.url,
    apiKey: ep.token,
    model: ep.model,
    authHeader: ep.authHeader,
    timeoutMs: ep.timeoutMs,
    extraBody: ep.extraBody,
    extraHeaders: ep.extraHeaders,
  };
  if (ep.protocol === 'anthropic') {
    return new AnthropicClient(cfg);
  }
  return new OpenAIClient(cfg);
}
