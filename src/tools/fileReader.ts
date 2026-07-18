// Mode-aware file content resolution. Port of internal/tool/filereader.go.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, withinBase } from '../util/path.js';
import type { GitRunner } from '../git/runner.js';

export enum ReviewMode {
  Workspace = 0, // read files from the current working tree
  Range = 1, // read files as they exist at the --to ref
  Commit = 2, // read files as they exist at a specific commit
}

export function parseReviewMode(from: string, to: string, commit: string): ReviewMode {
  if (commit !== '') return ReviewMode.Commit;
  if (from !== '' && to !== '') return ReviewMode.Range;
  return ReviewMode.Workspace;
}

const GIT_SHOW_TIMEOUT_MS = 30_000;

/** Resolves file contents according to the active review mode. */
export class FileReader {
  constructor(
    public readonly repoDir: string,
    public readonly mode: ReviewMode,
    /** Git ref for Range (--to) / Commit modes; empty for Workspace. */
    public readonly ref: string,
    public readonly runner: GitRunner | undefined,
  ) {}

  /** Full content of a repo-relative path per the active review mode. */
  async read(p: string, signal?: AbortSignal): Promise<string> {
    if (this.mode === ReviewMode.Range || this.mode === ReviewMode.Commit) {
      return this.readFromGitShow(p, signal);
    }
    return this.readFromDisk(p);
  }

  private readFromDisk(p: string): string {
    const fullPath = this.resolveWorkspacePath(p);
    try {
      return fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      throw new Error(`read file ${JSON.stringify(p)}: ${(err as Error).message}`);
    }
  }

  private resolveWorkspacePath(p: string): string {
    let repoRoot: string;
    try {
      repoRoot = canonicalPath(this.repoDir);
    } catch (err) {
      throw new Error(
        `resolve repository path ${JSON.stringify(this.repoDir)}: ${(err as Error).message}`,
      );
    }

    const fullPath = path.join(repoRoot, p);
    if (!withinBase(repoRoot, fullPath)) {
      throw new Error(`file path ${JSON.stringify(p)} is outside repository`);
    }

    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(fullPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fullPath;
      throw new Error(`resolve file ${JSON.stringify(p)}: ${(err as Error).message}`);
    }
    if (!withinBase(repoRoot, resolvedPath)) {
      throw new Error(`file path ${JSON.stringify(p)} is outside repository`);
    }
    return resolvedPath;
  }

  private async readFromGitShow(p: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(GIT_SHOW_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const args = ['-c', 'core.quotepath=false', 'show', '--end-of-options', `${this.ref}:${p}`];
    if (!this.runner) throw new Error(`git show ${this.ref}:${p}: no git runner`);
    try {
      const output = await this.runner.output(this.repoDir, args, combined);
      return output.toString('utf8');
    } catch (err) {
      throw new Error(`git show ${this.ref}:${p}: ${(err as Error).message}`);
    }
  }

  /**
   * Returns a window of lines from the file plus the total line count.
   * startLine is 1-based; maxLines is the max number of lines to collect.
   */
  async readLines(
    p: string,
    startLine: number,
    maxLines: number,
    signal?: AbortSignal,
  ): Promise<{ lines: string[]; totalLines: number }> {
    const content = await this.read(p, signal);
    return scanLines(content, startLine, maxLines);
  }
}

/**
 * Collects at most maxLines lines starting from startLine (1-based) while
 * counting total lines. Matches strings.Split(content, "\n") semantics for
 * trailing-newline files (a trailing newline yields a final empty line).
 */
export function scanLines(
  content: string,
  startLine: number,
  maxLines: number,
): { lines: string[]; totalLines: number } {
  const parts = content.split('\n');
  const collected: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const lineNum = i + 1;
    let line = parts[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (lineNum >= startLine && collected.length < maxLines) {
      collected.push(line);
    }
  }
  return { lines: collected, totalLines: parts.length === 1 && parts[0] === '' ? 0 : parts.length };
}
