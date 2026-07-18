// Three-zone context compression. Line-by-line port of
// internal/llmloop/compression.go — behavior-sensitive.
//
// Zones: frozen (always messages[0:2] — system + initial user prompt),
// compress, and active (the K most recent complete assistant+tool rounds
// that fit the remaining budget). Thresholds are fractions of MaxTokens:
// soft 0.60 (background compression), warning 0.80 (immediate sync).
import type { Message } from '../llm/types.js';
import { extractText, newTextMessage } from '../llm/types.js';
import { countTokens } from '../llm/tokens.js';

export const TOKEN_SOFT_THRESHOLD = 0.6;
export const TOKEN_WARNING_THRESHOLD = 0.8;

/** Consecutive messages: one assistant message + zero or more tool results. */
export interface Round {
  assistantIdx: number;
  toolIdxs: number[];
}

export interface PartitionResult {
  frozenEnd: number;
  compressEnd: number;
  rounds: Round[];
  activeCount: number;
}

/** Rough token count of msgs by summing per-message text token counts. */
export function countMessagesTokens(msgs: Message[]): number {
  let total = 0;
  for (const m of msgs) total += countTokens(extractText(m));
  return total;
}

/** Parses messages[start:] into logical (assistant + tool_results) pairs. */
export function groupIntoRounds(messages: Message[], start: number): Round[] {
  const rounds: Round[] = [];
  let i = start;
  while (i < messages.length) {
    if (messages[i]!.role === 'assistant') {
      const r: Round = { assistantIdx: i, toolIdxs: [] };
      i++;
      while (i < messages.length && messages[i]!.role === 'tool') {
        r.toolIdxs.push(i);
        i++;
      }
      rounds.push(r);
    } else {
      i++;
    }
  }
  return rounds;
}

/**
 * How many trailing rounds fit within the remaining token budget after
 * accounting for the frozen zone and the compressed summary.
 */
export function computeActiveZoneSize(
  rounds: Round[],
  messages: Message[],
  maxTokens: number,
  reservedTokens: number,
): number {
  const budget = Math.trunc(maxTokens * TOKEN_WARNING_THRESHOLD) - reservedTokens;
  if (budget <= 0) return 0;

  let count = 0;
  let tokensUsed = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    let roundTokens = countTokens(extractText(messages[rounds[i]!.assistantIdx]!));
    for (const ti of rounds[i]!.toolIdxs) {
      roundTokens += countTokens(extractText(messages[ti]!));
    }
    if (tokensUsed + roundTokens > budget) break;
    tokensUsed += roundTokens;
    count++;
  }
  return count;
}

/**
 * Divides messages into frozen, compress, and active zones. Frozen zone is
 * always messages[0:2]; active preserves the K most recent complete rounds.
 */
export function partitionMessages(
  messages: Message[],
  maxTokens: number,
  prevSummaryTokenEstimate: number,
): PartitionResult {
  const result: PartitionResult = { frozenEnd: 2, compressEnd: 0, rounds: [], activeCount: 0 };
  if (messages.length <= 2) {
    result.compressEnd = messages.length;
    return result;
  }

  result.rounds = groupIntoRounds(messages, 2);
  if (result.rounds.length === 0) {
    result.compressEnd = messages.length;
    return result;
  }

  result.activeCount = computeActiveZoneSize(result.rounds, messages, maxTokens, prevSummaryTokenEstimate);
  if (result.activeCount >= result.rounds.length) {
    // Everything fits — no compression needed.
    result.compressEnd = messages.length;
    result.activeCount = 0;
    return result;
  }

  // compressEnd = index after the last round NOT in active zone.
  const activeStartIdx = result.rounds.length - result.activeCount;
  const lastCompressRound = result.rounds[activeStartIdx - 1]!;
  if (lastCompressRound.toolIdxs.length > 0) {
    result.compressEnd = lastCompressRound.toolIdxs[lastCompressRound.toolIdxs.length - 1]! + 1;
  } else {
    result.compressEnd = lastCompressRound.assistantIdx + 1;
  }

  return result;
}

/** Removes ```json / ``` wrappers some models add around structured output. */
export function stripMarkdownFences(s: string): string {
  s = s.trim();
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n');
    if (nl >= 0) {
      s = s.slice(nl + 1);
    } else {
      if (s.startsWith('```json')) s = s.slice('```json'.length);
      else if (s.startsWith('```')) s = s.slice(3);
    }
  }
  s = s.trim();
  if (s.endsWith('```')) {
    s = s.slice(0, -3).trim();
  }
  return s;
}

/**
 * Serializes msgs into the <message><content> form expected by the
 * MEMORY_COMPRESSION_TASK prompt template.
 */
export function buildMessageXML(msgs: Message[]): string {
  let sb = '';
  msgs.forEach((m, i) => {
    sb += `<message id="${i}" role="${m.role}">\n`;
    sb += '    <content>\n';
    sb += `      ${extractText(m)}\n`;
    sb += '    </content>\n';
    sb += '</message>';
    if (i < msgs.length - 1) sb += '\n';
  });
  return sb;
}

/** Rebuilds messages after compression: [frozen w/ summary] + [active]. */
export function rebuildWithSummary(
  msgs: Message[],
  compressEnd: number,
  rawSummary: string,
): Message[] {
  const rebuilt: Message[] = [msgs[0]!, msgs[1]!];

  const userMsg = rebuilt[1]!;
  const currentText = extractText(userMsg);
  rebuilt[1] = newTextMessage(
    userMsg.role,
    currentText + '\n\n<previous_review_summary>\n' + rawSummary + '\n</previous_review_summary>',
  );

  for (let i = compressEnd; i < msgs.length; i++) {
    rebuilt.push(msgs[i]!);
  }
  return rebuilt;
}
