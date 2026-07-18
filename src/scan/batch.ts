// Batch-grouping policy for scan dispatch. Port of internal/scan/batch.go.
import type { ScanItem } from '../model/index.js';

export type BatchStrategy = 'none' | 'by-language' | 'by-directory';

/** Normalizes a user-supplied strategy; unknown/empty → "none". */
export function parseBatchStrategy(s: string): BatchStrategy {
  switch (s.trim().toLowerCase()) {
    case 'by-language':
      return 'by-language';
    case 'by-directory':
      return 'by-directory';
    default:
      return 'none';
  }
}

/**
 * Partitions items by strategy, then chunks each natural group into
 * size-sized slices (when size > 0). Input order preserved within a batch;
 * batches sorted by group key for determinism.
 */
export function groupBatches(
  items: ScanItem[],
  strategy: BatchStrategy,
  size: number,
): ScanItem[][] {
  if (items.length === 0) return [];

  const keyFn = batchKeyFunc(strategy);
  const buckets = new Map<string, ScanItem[]>();
  for (const it of items) {
    const key = keyFn(it);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(it);
  }

  const keys = [...buckets.keys()].sort();

  const out: ScanItem[][] = [];
  for (const k of keys) {
    const group = buckets.get(k)!;
    if (size <= 0 || group.length <= size) {
      out.push(group);
      continue;
    }
    for (let start = 0; start < group.length; start += size) {
      out.push(group.slice(start, Math.min(start + size, group.length)));
    }
  }
  return out;
}

function batchKeyFunc(strategy: BatchStrategy): (it: ScanItem) => string {
  switch (strategy) {
    case 'by-language':
      return languageKey;
    case 'by-directory':
      return firstLevelDirKey;
    default:
      // "none": each file is its own batch.
      return (it) => it.path;
  }
}

/** Lowercased extension with leading dot, or "<no-ext>". */
export function languageKey(it: ScanItem): string {
  let base = it.path;
  const i = base.lastIndexOf('/');
  if (i >= 0) base = base.slice(i + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '<no-ext>';
  return base.slice(dot).toLowerCase();
}

/** First path segment, or "<root>" for files directly in the repo root. */
export function firstLevelDirKey(it: ScanItem): string {
  const idx = it.path.indexOf('/');
  if (idx < 0) return '<root>';
  return it.path.slice(0, idx);
}
