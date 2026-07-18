// Comment line-number resolution. Line-by-line port of
// internal/diff/resolver.go — behavior-sensitive, keep close to the original.
import type { Diff, LlmComment } from '../model/index.js';
import { HunkLineType, parseHunks, type Hunk } from './hunk.js';

/**
 * Populates start_line/end_line on each comment by matching existing_code
 * against the corresponding file's diff hunks (primary), or falling back to
 * scanning the full new-file content line-by-line.
 */
export function resolveLineNumbers(comments: LlmComment[], diffs: Diff[]): LlmComment[] {
  if (comments.length === 0 || diffs.length === 0) return comments;

  const diffByPath = new Map<string, Diff>();
  for (const d of diffs) {
    if (d.new_path !== '/dev/null' && d.new_path !== '') diffByPath.set(d.new_path, d);
    if (d.old_path !== '/dev/null' && d.old_path !== '') diffByPath.set(d.old_path, d);
  }

  const result = comments.map((c) => ({ ...c }));

  for (const cm of result) {
    if (cm.start_line > 0 || cm.end_line > 0) continue;
    if (!cm.existing_code) continue;
    const d = diffByPath.get(cm.path);
    if (!d) continue;

    // Primary: try matching from deleted/context lines in diff hunks
    if (resolveFromHunk(d, cm)) continue;

    // Fallback: scan the new file content for consecutive matches
    resolveFromFileContent(d, cm);
  }

  return result;
}

/**
 * Attempts to resolve start_line/end_line for a single comment by matching
 * existing_code against the diff. Returns true on success.
 */
export function resolveComment(cm: LlmComment, d: Diff): boolean {
  if (cm.start_line > 0 || cm.end_line > 0) return true;
  if (!cm.existing_code) return false;
  if (resolveFromHunk(d, cm)) return true;
  return resolveFromFileContent(d, cm);
}

/** A normalized line paired with its absolute file line number. */
interface IndexedLine {
  lineNum: number;
  content: string;
}

/**
 * Tries new-side first (context + added lines → new-file line numbers), then
 * old-side (context + deleted → old-file line numbers).
 */
function resolveFromHunk(d: Diff, cm: LlmComment): boolean {
  const hunks = parseHunks(d.diff);
  if (hunks.length === 0) return false;

  const targetLines = splitAndNormalize(cm.existing_code ?? '');
  if (targetLines.length === 0) return false;

  for (const hunk of hunks) {
    const newSide = extractSideLines(hunk, true);
    const m = matchConsecutive(newSide, targetLines);
    if (m) {
      cm.start_line = m.start;
      cm.end_line = m.end;
      return true;
    }
  }

  for (const hunk of hunks) {
    const oldSide = extractSideLines(hunk, false);
    const m = matchConsecutive(oldSide, targetLines);
    if (m) {
      cm.start_line = m.start;
      cm.end_line = m.end;
      return true;
    }
  }

  return false;
}

/**
 * Extracts one side of the diff from a hunk. newSide=true → context+added
 * with new-file line numbers; false → context+deleted with old-file numbers.
 */
function extractSideLines(hunk: Hunk, newSide: boolean): IndexedLine[] {
  const result: IndexedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const l of hunk.lines) {
    switch (l.type) {
      case HunkLineType.Context:
        if (newSide) result.push({ lineNum: newLine, content: normalizeLine(l.content) });
        else result.push({ lineNum: oldLine, content: normalizeLine(l.content) });
        oldLine++;
        newLine++;
        break;
      case HunkLineType.Added:
        if (newSide) result.push({ lineNum: newLine, content: normalizeLine(l.content) });
        newLine++;
        break;
      case HunkLineType.Deleted:
        if (!newSide) result.push({ lineNum: oldLine, content: normalizeLine(l.content) });
        oldLine++;
        break;
    }
  }
  return result;
}

/** Scans sideLines for a consecutive run matching all targetLines. */
function matchConsecutive(
  sideLines: IndexedLine[],
  targetLines: string[],
): { start: number; end: number } | undefined {
  if (targetLines.length === 0 || sideLines.length < targetLines.length) return undefined;
  for (let i = 0; i <= sideLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (sideLines[i + j]!.content !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return {
        start: sideLines[i]!.lineNum,
        end: sideLines[i + targetLines.length - 1]!.lineNum,
      };
    }
  }
  return undefined;
}

/**
 * Scans the new file content line-by-line for consecutive matches of the
 * normalized existing_code. Blank lines in the source are skipped so they
 * don't break the sliding-window match.
 */
function resolveFromFileContent(d: Diff, cm: LlmComment): boolean {
  if (d.new_file_content === '') return false;

  const fileLines = d.new_file_content.split('\n');
  const targetLines = splitAndNormalize(cm.existing_code ?? '');
  if (targetLines.length === 0) return false;

  const normalizedFileLines: string[] = [];
  const fileLineNums: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const n = normalizeLine(fileLines[i]!.replace(/\r$/, ''));
    if (n === '') continue;
    normalizedFileLines.push(n);
    fileLineNums.push(i + 1);
  }

  if (normalizedFileLines.length < targetLines.length) return false;

  for (let i = 0; i <= normalizedFileLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (normalizedFileLines[i + j] !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      cm.start_line = fileLineNums[i]!;
      cm.end_line = fileLineNums[i + targetLines.length - 1]!;
      return true;
    }
  }

  return false;
}

/** Splits code text into lines and normalizes each one (blanks dropped). */
function splitAndNormalize(code: string): string[] {
  const result: string[] = [];
  for (const line of code.split('\n')) {
    const n = normalizeLine(line);
    if (n === '') continue;
    result.push(n);
  }
  return result;
}

/**
 * Removes leading/trailing whitespace and strips a single leading '+' or '-'
 * diff marker (mirrors Java's processTargetLineCode).
 */
function normalizeLine(s: string): string {
  s = s.trim();
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) s = s.slice(1);
  return s.trim();
}
