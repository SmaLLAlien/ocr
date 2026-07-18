// Result rendering (text + JSON + preview). Port of cmd/opencodereview/output.go.
import type { LlmComment, Preview } from '../model/index.js';
import type { AgentWarning } from '../loop/pool.js';
import type { ResumeInfo } from '../agent/agent.js';
import { DiffLineType, computeLineDiff, type DiffLine } from '../util/suggestdiff.js';
import { formatDurationSeconds } from '../util/logger.js';

/** Strips terminal control characters (keeps \t and \n). */
export function sanitizeTerminal(s: string): string {
  let b = '';
  for (const r of s) {
    if (r === '\t' || r === '\n' || !isControl(r)) b += r;
  }
  return b;
}

function isControl(r: string): boolean {
  const code = r.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function hasSubtaskErrors(warnings: AgentWarning[]): boolean {
  return warnings.some((w) => w.type === 'subtask_error');
}

export function outputTextWithWarnings(comments: LlmComment[], warnings: AgentWarning[]): void {
  if (comments.length === 0) {
    if (hasSubtaskErrors(warnings)) {
      console.log('Some files could not be reviewed due to errors (see warnings below).');
    } else {
      console.log('No comments generated. Looks good to me.');
    }
  } else {
    for (const c of comments) renderComment(c);
  }
  for (const w of warnings) {
    if (w.type === 'subtask_error') continue;
    process.stderr.write(
      `[ocr] WARNING [${w.type}] ${sanitizeTerminal(w.file)}: ${sanitizeTerminal(w.message)}\n`,
    );
  }
}

function renderComment(comment: LlmComment): void {
  const lines = buildDiffLines(comment);
  if (lines.length === 0 && comment.content === '') return;

  console.log(
    `\n\x1b[2m─── ${sanitizeTerminal(comment.path)}:${comment.start_line}-${comment.end_line} ───\x1b[0m`,
  );

  if (comment.content !== '') {
    const badge = buildBadge(comment);
    let content = sanitizeTerminal(comment.content);
    if (badge !== '') {
      // Prepend plain badge so it wraps inline; colorize after wrapping.
      content = badge + ' ' + content;
    }
    const wrapped = wrapByRunes(content, 100);
    wrapped.forEach((ln, i) => {
      if (i === 0 && badge !== '' && ln.startsWith(badge)) {
        const color = severityColor(comment.severity ?? '');
        ln = color + badge + '\x1b[0m' + ln.slice(badge.length);
      }
      console.log(ln);
    });
    console.log();
  }

  for (const dl of lines) {
    switch (dl.type) {
      case DiffLineType.Added:
        printDiffLine('+', sanitizeTerminal(dl.content), '\x1b[92m', '\x1b[48;2;0;60;0m');
        break;
      case DiffLineType.Deleted:
        printDiffLine('-', sanitizeTerminal(dl.content), '\x1b[91m', '\x1b[48;2;70;0;0m');
        break;
      case DiffLineType.Context:
        printDiffLine(' ', sanitizeTerminal(dl.content), '\x1b[2m', '\x1b[48;2;38;38;38m');
        break;
    }
  }

  console.log();
}

/** Compact "[category · severity]" tag ("" when neither field present). */
function buildBadge(comment: LlmComment): string {
  const category = sanitizeTerminal(comment.category ?? '');
  const severity = sanitizeTerminal(comment.severity ?? '');
  if (category !== '' && severity !== '') return `[${category} · ${severity}]`;
  if (category !== '') return `[${category}]`;
  if (severity !== '') return `[${severity}]`;
  return '';
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return '\x1b[1;91m'; // bold bright red
    case 'high':
      return '\x1b[91m';
    case 'medium':
      return '\x1b[93m';
    case 'low':
      return '\x1b[94m';
    default:
      return '\x1b[2m';
  }
}

function printDiffLine(prefix: string, content: string, fgColor: string, bgColor: string): void {
  console.log(`${fgColor + bgColor}${prefix}${'\x1b[0m' + bgColor} ${content}\x1b[0m`);
}

/** Wraps text at ~maxW display columns, respecting newlines and words. */
export function wrapByRunes(text: string, maxW: number): string[] {
  if (text === '') return [];
  const result: string[] = [];
  for (const para of text.split('\n')) {
    result.push(...wrapSingleRuneLine(para, maxW));
  }
  return result;
}

function wrapSingleRuneLine(line: string, maxW: number): string[] {
  let runes = [...line];
  if (visibleRunesLen(runes) <= maxW) return [line];
  const result: string[] = [];
  while (runes.length > 0) {
    const cut = runeWrapCut(runes, maxW);
    result.push(runes.slice(0, cut).join(''));
    runes = runes.slice(cut);
    while (runes.length > 0 && runes[0] === ' ') runes = runes.slice(1);
  }
  return result;
}

function runeWrapCut(runes: string[], maxW: number): number {
  if (visibleRunesLen(runes) <= maxW) return runes.length;
  const best = maxW;
  if (best >= runes.length) return runes.length;
  for (let i = best; i > 0; i--) {
    if (runes[i] === ' ' || runes[i] === '\t') return i;
  }
  return best;
}

function visibleRunesLen(runes: string[]): number {
  let n = 0;
  for (const r of runes) {
    const code = r.codePointAt(0)!;
    if (code >= 32 && code !== 127) n++;
  }
  return n;
}

export function splitToLines(s: string): string[] {
  const lines = s.replaceAll('\r\n', '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function buildDiffLines(comment: LlmComment): DiffLine[] {
  if (!comment.suggestion_code || !comment.existing_code) return [];
  return computeLineDiff(splitToLines(comment.existing_code), splitToLines(comment.suggestion_code));
}

// --- JSON output (the machine-readable --format json contract) ---

interface JsonSummary {
  files_reviewed: number;
  comments: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  elapsed: string;
}

interface JsonToolCalls {
  total: number;
  by_tool: Record<string, number>;
}

interface JsonOutput {
  status: string;
  trace_id?: string;
  message?: string;
  summary?: JsonSummary;
  tool_calls: JsonToolCalls | null;
  comments: LlmComment[];
  warnings?: AgentWarning[];
  project_summary?: string;
  resume?: ResumeInfo;
  session_id?: string;
}

function printJSON(out: JsonOutput): void {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

export interface RunSummaryArgs {
  comments: LlmComment[];
  warnings: AgentWarning[];
  filesReviewed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  projectSummary: string;
  toolCalls: Map<string, number>;
  traceID: string;
  resumeInfo?: ResumeInfo;
  sessionID: string;
}

export function outputJSONWithWarnings(a: RunSummaryArgs): void {
  const byTool: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of a.toolCalls) {
    byTool[k] = v;
    total += v;
  }

  const out: JsonOutput = {
    status: 'success',
    trace_id: a.traceID || undefined,
    comments: a.comments,
    summary: {
      files_reviewed: a.filesReviewed,
      comments: a.comments.length,
      total_tokens: a.totalTokens,
      input_tokens: a.inputTokens,
      output_tokens: a.outputTokens,
      ...(a.cacheReadTokens > 0 ? { cache_read_tokens: a.cacheReadTokens } : {}),
      ...(a.cacheWriteTokens > 0 ? { cache_write_tokens: a.cacheWriteTokens } : {}),
      elapsed: formatDurationSeconds(a.durationMs),
    },
    tool_calls: { total, by_tool: byTool },
    project_summary: a.projectSummary || undefined,
    resume: a.resumeInfo,
    session_id: a.sessionID || undefined,
  };
  if (a.comments.length === 0) {
    out.message = hasSubtaskErrors(a.warnings)
      ? 'Some files could not be reviewed due to errors.'
      : 'No comments generated. Looks good to me.';
  }
  if (a.warnings.length > 0) {
    out.warnings = a.warnings;
    out.status = hasSubtaskErrors(a.warnings) ? 'completed_with_errors' : 'completed_with_warnings';
  }
  printJSON(out);
}

export function outputJSONNoFiles(traceID: string): void {
  printJSON({
    status: 'skipped',
    trace_id: traceID || undefined,
    message: 'No supported files changed.',
    comments: [],
    tool_calls: { total: 0, by_tool: {} },
  });
}

// --- Preview rendering ---

export function outputPreviewText(p: Preview): void {
  if (p.total_files === 0) {
    console.log('No files changed.');
    return;
  }

  let maxPathLen = 0;
  for (const e of p.files) {
    const n = sanitizeTerminal(e.path).length;
    if (n > maxPathLen) maxPathLen = n;
  }
  if (maxPathLen < 20) maxPathLen = 20;

  console.log(
    `\nPreview: ${p.total_files} file(s) changed  |  \x1b[32m+${p.total_insertions}\x1b[0m  \x1b[31m-${p.total_deletions}\x1b[0m`,
  );

  if (p.reviewable_count > 0) {
    console.log(`\n\x1b[1mWill review (${p.reviewable_count}):\x1b[0m`);
    for (const e of p.files) {
      if (!e.will_review) continue;
      console.log(
        `  ${statusBadge(e.status)}  ${sanitizeTerminal(e.path).padEnd(maxPathLen)} \x1b[32m+${String(e.insertions).padEnd(4)}\x1b[0m \x1b[31m-${String(e.deletions).padEnd(4)}\x1b[0m`,
      );
    }
  }

  if (p.excluded_count > 0) {
    console.log(`\n\x1b[1mExcluded from review (${p.excluded_count}):\x1b[0m`);
    for (const e of p.files) {
      if (e.will_review) continue;
      console.log(
        `  ${statusBadge(e.status)}  ${sanitizeTerminal(e.path).padEnd(maxPathLen)} \x1b[2m(${sanitizeTerminal(e.exclude_reason ?? '')})\x1b[0m`,
      );
    }
  }

  console.log();
}

export function statusBadge(status: string): string {
  switch (status) {
    case 'added':
      return '\x1b[32m[A]\x1b[0m';
    case 'modified':
      return '\x1b[33m[M]\x1b[0m';
    case 'deleted':
      return '\x1b[31m[D]\x1b[0m';
    case 'renamed':
      return '\x1b[36m[R]\x1b[0m';
    case 'binary':
      return '\x1b[35m[B]\x1b[0m';
    case 'scan':
      return '\x1b[34m[S]\x1b[0m';
    default:
      return '[?]';
  }
}
