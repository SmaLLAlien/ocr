// Line-level diff between code snippets for ANSI CLI rendering of review
// suggestions. Port of internal/suggestdiff/diff.go (Myers-style LCS;
// whitespace-insensitive, case-insensitive line matching).

export enum DiffLineType {
  Context = 0,
  Added = 1,
  Deleted = 2,
}

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

function linesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Line-level diff between oldLines and newLines via an LCS DP table. */
export function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0 && n === 0) return [];

  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesEqual(oldLines[i - 1]!, newLines[j - 1]!)) {
        lcs[i]![j] = lcs[i - 1]![j - 1]! + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
      }
    }
  }

  const back: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesEqual(oldLines[i - 1]!, newLines[j - 1]!)) {
      back.push({ type: DiffLineType.Context, content: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
      back.push({ type: DiffLineType.Added, content: newLines[j - 1]! });
      j--;
    } else {
      back.push({ type: DiffLineType.Deleted, content: oldLines[i - 1]! });
      i--;
    }
  }

  return back.reverse();
}
