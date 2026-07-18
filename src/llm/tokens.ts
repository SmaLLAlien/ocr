// Token counting. Port of the tiktoken half of internal/llm/client.go,
// backed by js-tiktoken (pure JS, offline ranks — replaces the Go embedded
// BPE loader). Encoders are lazily loaded and cached; on any failure the
// bytes/4 heuristic is used, matching the Go fallback.
import { createRequire } from 'node:module';
import { Tiktoken } from 'js-tiktoken/lite';

const require = createRequire(import.meta.url);

type EncodingName = 'cl100k_base' | 'o200k_base';

const cache = new Map<EncodingName, Tiktoken | null>();

function getOrLoad(encName: EncodingName): Tiktoken | null {
  let enc = cache.get(encName);
  if (enc !== undefined) return enc;
  try {
    // Lazy synchronous load keeps startup fast and the API sync like Go's.
    const ranks = require(`js-tiktoken/ranks/${encName}`) as { default?: unknown };
    enc = new Tiktoken((ranks.default ?? ranks) as ConstructorParameters<typeof Tiktoken>[0]);
  } catch {
    enc = null;
  }
  cache.set(encName, enc);
  return enc;
}

function countTokensWithEncoding(text: string, encName: EncodingName): number {
  const enc = getOrLoad(encName);
  if (!enc) return Math.floor(Buffer.byteLength(text, 'utf8') / 4);
  return enc.encode(text).length;
}

export function countTokens(text: string): number {
  return countTokensForModel(text, '');
}

export function countTokensForModel(text: string, modelName: string): number {
  if (text === '') return 0;
  return countTokensWithEncoding(text, encodingForModel(modelName));
}

function encodingForModel(modelName: string): EncodingName {
  const lower = modelName.toLowerCase();
  if (lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) {
    return 'o200k_base';
  }
  return 'cl100k_base';
}
