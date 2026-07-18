// Token-usage extraction from arbitrary provider/proxy response shapes.
// Port of internal/llm/usage_resolver.go — keep the path lists and the
// Anthropic-vs-OpenAI cache accounting rule exactly.
import type { UsageInfo } from './types.js';

const promptTokensPaths = [
  'usage.prompt_tokens', // OpenAI standard
  'prompt_tokens', // flat at root
  'data.usage.prompt_tokens', // wrapped in data layer
];

const completionTokensPaths = [
  'usage.completion_tokens',
  'completion_tokens',
  'data.usage.completion_tokens',
];

const cacheReadTokensPaths = [
  'usage.cache_read_input_tokens', // Anthropic
  'cache_read_input_tokens', // flat at root
  'data.usage.cache_read_input_tokens', // wrapped Anthropic-compatible proxy
  'usage.prompt_tokens_details.cached_tokens', // OpenAI-compatible providers
  'data.usage.prompt_tokens_details.cached_tokens', // wrapped OpenAI-compatible
];

const cacheWriteTokensPaths = [
  'usage.cache_creation_input_tokens', // Anthropic / proxy
  'cache_creation_input_tokens', // flat at root
  'data.usage.cache_creation_input_tokens', // wrapped Anthropic-compatible proxy
  'usage.prompt_tokens_details.cache_creation_tokens', // proxy normalization
  'data.usage.prompt_tokens_details.cache_creation_tokens', // wrapped proxy normalization
];

// Number of Anthropic-style paths at the start of the cache path lists.
// OpenAI-style paths follow; under OpenAI semantics cached tokens are
// already included in prompt_tokens.
const anthropicCacheReadPathCount = 3;
const anthropicCacheWritePathCount = 3;

const totalTokensPaths = ['usage.total_tokens', 'total_tokens', 'data.usage.total_tokens'];

/**
 * Extracts token usage from a parsed response body by probing configured
 * paths sequentially. Returns undefined if nothing usable is found.
 */
export function resolveUsage(rawBody: unknown): UsageInfo | undefined {
  if (typeof rawBody !== 'object' || rawBody === null) return undefined;
  const root = rawBody as Record<string, unknown>;

  const [total, , hasAny] = probePathIndex(root, totalTokensPaths);
  const [prompt] = probePathIndex(root, promptTokensPaths);
  const [completion] = probePathIndex(root, completionTokensPaths);
  const [cacheRead, cacheReadIdx] = probePathIndex(root, cacheReadTokensPaths);
  const [cacheWrite, cacheWriteIdx] = probePathIndex(root, cacheWriteTokensPaths);

  if (!hasAny && prompt === 0 && completion === 0) return undefined;

  const ui: UsageInfo = {
    total_tokens: total,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };

  // If total_tokens wasn't explicitly available but we have prompt+completion,
  // compute it. Anthropic reports cache tokens separately from input_tokens, so
  // include them in the fallback total. OpenAI prompt_tokens already includes
  // cached_tokens, so only add cache counts when they came from Anthropic-style
  // top-level fields.
  if (total === 0 && (prompt > 0 || completion > 0)) {
    ui.total_tokens = prompt + completion;
    if (cacheReadIdx >= 0 && cacheReadIdx < anthropicCacheReadPathCount) {
      ui.total_tokens += cacheRead;
    }
    if (cacheWriteIdx >= 0 && cacheWriteIdx < anthropicCacheWritePathCount) {
      ui.total_tokens += cacheWrite;
    }
  }

  return ui;
}

/** Walks candidate dot-paths in order; returns [value, matchedIndex, found]. */
function probePathIndex(
  root: Record<string, unknown>,
  paths: string[],
): [number, number, boolean] {
  outer: for (let i = 0; i < paths.length; i++) {
    const parts = paths[i]!.split('.');
    let current: unknown = root;
    for (const part of parts) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) continue outer;
      const obj = current as Record<string, unknown>;
      if (!(part in obj)) continue outer;
      current = obj[part];
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      return [Math.trunc(current), i, true];
    }
  }
  return [0, -1, false];
}
