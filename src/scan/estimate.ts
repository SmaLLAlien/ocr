// Rough pre-run cost projection (order-of-magnitude, not billing-accurate).
// Port of internal/scan/estimate.go.
import type { ScanItem } from '../model/index.js';
import { countTokens } from '../llm/tokens.js';

// Fixed prompt scaffolding per LLM call.
const PROMPT_OVERHEAD_TOKENS = 2000;
// Assumed MAIN_TASK tool-use rounds for a typical file.
const AVG_MAIN_ROUNDS_PER_FILE = 7;
// Approximate completion tokens per round.
const AVG_OUTPUT_TOKENS_PER_ROUND = 700;

export interface Estimate {
  files: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Projects the input+output token cost of reviewing a single file
 * (PLAN + MAIN rounds). 0 for files skipped before dispatch.
 */
export function estimateFileTokens(it: ScanItem, planEnabled: boolean): number {
  if (it.is_binary || it.content === '') return 0;
  const fileTokens = countTokens(it.content);

  let total = 0;
  if (planEnabled) {
    total += fileTokens + PROMPT_OVERHEAD_TOKENS; // PLAN input
    total += 400; // PLAN output (small JSON)
  }
  total += (fileTokens + PROMPT_OVERHEAD_TOKENS) * AVG_MAIN_ROUNDS_PER_FILE;
  total += AVG_OUTPUT_TOKENS_PER_ROUND * AVG_MAIN_ROUNDS_PER_FILE;
  return total;
}

export function estimateCost(
  items: ScanItem[],
  planEnabled: boolean,
  dedupEnabled: boolean,
  summaryEnabled: boolean,
): Estimate {
  const est: Estimate = { files: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let allCommentsApprox = 0;

  for (const it of items) {
    if (it.is_binary || it.content === '') continue;
    est.files++;
    const fileTokens = countTokens(it.content);
    if (planEnabled) {
      est.inputTokens += fileTokens + PROMPT_OVERHEAD_TOKENS;
      est.outputTokens += 400;
    }
    est.inputTokens += (fileTokens + PROMPT_OVERHEAD_TOKENS) * AVG_MAIN_ROUNDS_PER_FILE;
    est.outputTokens += AVG_OUTPUT_TOKENS_PER_ROUND * AVG_MAIN_ROUNDS_PER_FILE;

    allCommentsApprox += 3;
  }

  if (dedupEnabled && allCommentsApprox > 0) {
    est.inputTokens += allCommentsApprox * 120 + PROMPT_OVERHEAD_TOKENS;
    est.outputTokens += allCommentsApprox * 20;
  }

  if (summaryEnabled && allCommentsApprox > 0) {
    est.inputTokens += allCommentsApprox * 120 + PROMPT_OVERHEAD_TOKENS;
    est.outputTokens += 2000;
  }

  est.totalTokens = est.inputTokens + est.outputTokens;
  return est;
}

export function estimateString(e: Estimate): string {
  return `~${e.files} file(s), est. ${humanTokens(e.inputTokens)} input + ${humanTokens(e.outputTokens)} output ≈ ${humanTokens(e.totalTokens)} total tokens (rough; actual reported after run)`;
}

/** "1.2M" / "850K" / "420". */
export function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
