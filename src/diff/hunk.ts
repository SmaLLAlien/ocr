// @@ ... @@ block parsing. Port of internal/diff/hunk.go.

export enum HunkLineType {
  Context = 0, // ' ' prefix: unchanged context line
  Added = 1, // '+' prefix: added line
  Deleted = 2, // '-' prefix: removed line
}

/** A single line within a hunk (content without the leading marker). */
export interface HunkLine {
  type: HunkLineType;
  content: string;
}

/** One @@ ... @@ block in a unified diff (1-indexed starts). */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses raw unified diff text for a single file into hunks. Lines before
 * the first @@ header are ignored; a following file's "diff --git" header
 * stops processing.
 */
export function parseHunks(rawDiffText: string): Hunk[] {
  const lines = rawDiffText.split('\n');
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;

  for (const line of lines) {
    const m = hunkHeaderRe.exec(line);
    if (m) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(m[1]),
        oldCount: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newCount: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      };
      continue;
    }

    if (!current) continue; // skip file-level headers and preamble

    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('diff --git ')) break;

    if (line.startsWith('+')) {
      current.lines.push({ type: HunkLineType.Added, content: line.slice(1) });
    } else if (line.startsWith('-')) {
      current.lines.push({ type: HunkLineType.Deleted, content: line.slice(1) });
    } else {
      let content = line;
      if (content.startsWith(' ')) content = content.slice(1);
      current.lines.push({ type: HunkLineType.Context, content });
    }
  }

  if (current) hunks.push(current);
  return hunks;
}
