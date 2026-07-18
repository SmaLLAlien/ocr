// Diff retrieval (workspace / commit / range modes). Port of internal/diff/git.go.
import fs from 'node:fs';
import path from 'node:path';
import type { Diff } from '../model/index.js';
import type { GitRunner } from '../git/runner.js';
import { simpleMatch } from '../util/glob.js';
import { parseDiffText } from './parser.js';
import { readWorkspaceFileForDiff } from './workspaceFile.js';

/** Number of context lines around each changed hunk. */
export const DIFF_CONTEXT_LINES = 3;

// Directory prefixes to always exclude from diff results.
const providerDirIgnoreDirs = [
  '.idea/',
  '.vscode/',
  '.svn/',
  '.git/',
  'vendor/',
  'node_modules/',
  'target/',
  '.happypack/',
  '.cachefile/',
  '_packages/',
  'rpm/',
  'pkgs/',
];

/** The directory blocklist, exposed for scan and other consumers. */
export function excludedDirs(): string[] {
  return [...providerDirIgnoreDirs];
}

export enum DiffMode {
  Workspace = 0, // current workspace (staged + unstaged + untracked)
  Commit = 1, // single commit vs its parent
  Range = 2, // merge-base(from,to)..to
}

/** Retrieves and parses git diffs from a repository. */
export class DiffProvider {
  private mergeBaseCache = '';

  private constructor(
    private readonly repoDir: string,
    private readonly mode: DiffMode,
    private readonly runner: GitRunner,
    private readonly from = '',
    private readonly to = '',
    private readonly commit = '',
  ) {}

  /** Range mode: from..to (via merge-base). */
  static range(repoDir: string, from: string, to: string, runner: GitRunner): DiffProvider {
    return new DiffProvider(repoDir, DiffMode.Range, runner, from, to);
  }

  /** Commit mode: changes introduced by a single commit. */
  static commit(repoDir: string, commit: string, runner: GitRunner): DiffProvider {
    return new DiffProvider(repoDir, DiffMode.Commit, runner, '', '', commit);
  }

  /** Workspace mode: current uncommitted changes. */
  static workspace(repoDir: string, runner: GitRunner): DiffProvider {
    return new DiffProvider(repoDir, DiffMode.Workspace, runner);
  }

  isRangeMode(): boolean {
    return this.mode === DiffMode.Range;
  }

  isCommitMode(): boolean {
    return this.mode === DiffMode.Commit;
  }

  /** Computed merge-base commit hash for range mode (cached). */
  async mergeBase(signal?: AbortSignal): Promise<string> {
    if (this.mode !== DiffMode.Range || this.mergeBaseCache !== '') {
      return this.mergeBaseCache;
    }
    const res = await this.runner.run(
      this.repoDir,
      ['merge-base', '--end-of-options', this.from, this.to],
      signal,
    );
    this.mergeBaseCache = res.ok ? res.out.trim() : '';
    return this.mergeBaseCache;
  }

  /** Returns all changes as parsed Diff structs. */
  async getDiff(signal?: AbortSignal): Promise<Diff[]> {
    let combined = '';
    const U = `-U${DIFF_CONTEXT_LINES}`;
    const common = [
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ];

    switch (this.mode) {
      case DiffMode.Range: {
        const base = await this.mergeBase(signal);
        if (base === '') {
          throw new Error(`cannot find merge-base between ${this.from} and ${this.to}`);
        }
        const res = await this.runner.run(
          this.repoDir,
          ['diff', ...common, '--no-color', U, '--end-of-options', base, this.to, '--'],
          signal,
        );
        if (!res.ok) throw new Error(`git diff failed: ${res.error ?? res.out}`);
        combined += res.out;
        break;
      }
      case DiffMode.Commit: {
        const res = await this.runner.run(
          this.repoDir,
          ['show', ...common, '--no-color', U, '--end-of-options', this.commit],
          signal,
        );
        if (!res.ok) throw new Error(`git show failed: ${res.error ?? res.out}`);
        combined += res.out;
        break;
      }
      case DiffMode.Workspace: {
        combined += await this.workspaceTrackedDiff(signal);
        for (const ud of await this.untrackedFileDiffs(signal)) {
          combined += ud + '\n\n';
        }
        break;
      }
    }

    let ref = '';
    if (this.mode === DiffMode.Range) ref = this.to;
    else if (this.mode === DiffMode.Commit) ref = this.commit;

    const diffs = await parseDiffText(combined, this.repoDir, ref, this.runner, signal);
    return this.filterDiffs(diffs);
  }

  /** Reads and parses .gitignore patterns from the repo root. */
  loadGitignorePatterns(): string[] {
    let data: string;
    try {
      data = fs.readFileSync(path.join(this.repoDir, '.gitignore'), 'utf8');
    } catch {
      return [];
    }
    const patterns: string[] = [];
    for (let line of data.split('\n')) {
      line = line.trim();
      if (line === '' || line.startsWith('#')) continue;
      patterns.push(line);
    }
    return patterns;
  }

  /** True when relPath should be skipped (hardcoded dirs or .gitignore). */
  isPathExcluded(relPath: string, gitignorePatterns: string[]): boolean {
    for (const prefix of providerDirIgnoreDirs) {
      const dirPart = prefix.replace(/\/$/, '');
      if (relPath === dirPart || relPath.startsWith(prefix)) return true;
    }
    for (const pat of gitignorePatterns) {
      if (matchGitignorePattern(relPath, pat)) return true;
    }
    return false;
  }

  private filterDiffs(diffs: Diff[]): Diff[] {
    const patterns = this.loadGitignorePatterns();
    return diffs.filter((d) => {
      let p = d.new_path;
      if (p === '/dev/null') p = d.old_path;
      return !this.isPathExcluded(p, patterns);
    });
  }

  private async workspaceTrackedDiff(signal?: AbortSignal): Promise<string> {
    const U = `-U${DIFF_CONTEXT_LINES}`;
    const common = [
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ];
    const res = await this.runner.run(
      this.repoDir,
      ['diff', ...common, 'HEAD', '--no-color', U, '--'],
      signal,
    );
    if (res.ok && res.out !== '') return res.out;
    const staged = await this.runner.run(
      this.repoDir,
      ['diff', ...common, '--staged', '--no-color', U, '--'],
      signal,
    );
    return staged.ok ? staged.out : '';
  }

  /** Synthesizes all-added diffs for untracked files. */
  private async untrackedFileDiffs(signal?: AbortSignal): Promise<string[]> {
    const files = await this.untrackedFilesList(signal);
    const results: string[] = [];
    for (const f of files) {
      let content: Buffer;
      try {
        content = readWorkspaceFileForDiff(this.repoDir, f);
      } catch {
        continue;
      }

      let lineCount = 0;
      for (const b of content) if (b === 0x0a) lineCount++;
      if (content.length > 0 && content[content.length - 1] !== 0x0a) lineCount++;

      let sb = `diff --git a/${f} b/${f}\n`;
      sb += '--- /dev/null\n';
      sb += `+++ b/${f}\n`;
      sb += `@@ -0,0 +1,${lineCount} @@\n`;

      let text = content.toString('utf8');
      if (text.endsWith('\n')) text = text.slice(0, -1);
      const lines = text === '' && content.length === 0 ? [] : text.split('\n');
      for (const line of lines) {
        sb += '+' + line + '\n';
      }
      results.push(sb);
    }
    return results;
  }

  private async untrackedFilesList(signal?: AbortSignal): Promise<string[]> {
    const res = await this.runner.run(
      this.repoDir,
      ['ls-files', '--others', '--exclude-standard'],
      signal,
    );
    if (!res.ok || res.out === '') return [];
    const patterns = this.loadGitignorePatterns();
    const files: string[] = [];
    for (let line of res.out.trim().split('\n')) {
      line = line.trim();
      if (line === '') continue;
      if (!this.isPathExcluded(line, patterns)) files.push(line);
    }
    return files;
  }
}

/**
 * Checks if relPath matches a single .gitignore pattern (simplified
 * semantics: directory-only suffix, basename match, full-path match;
 * negation ignored).
 */
export function matchGitignorePattern(relPath: string, pat: string): boolean {
  // Directory-only patterns (trailing /)
  if (pat.endsWith('/')) {
    const dirName = pat.slice(0, -1);
    return relPath.split('/').includes(dirName);
  }

  // Negation patterns are not needed for exclusion purposes
  if (pat.startsWith('!')) return false;

  // Patterns without / match basename
  if (!pat.includes('/')) {
    const base = relPath.split('/').pop() ?? relPath;
    return simpleMatch(pat, base);
  }

  // Patterns with / match against the full relative path
  if (simpleMatch(pat, relPath)) return true;
  // Also try matching against suffix of path
  return relPath.endsWith(pat);
}

/** Public wrappers so internal/scan-equivalent code reuses the same logic. */
export function loadGitignorePatterns(repoDir: string): string[] {
  return stubProvider(repoDir).loadGitignorePatterns();
}

export function isPathExcluded(repoDir: string, relPath: string, patterns: string[]): boolean {
  return stubProvider(repoDir).isPathExcluded(relPath, patterns);
}

function stubProvider(repoDir: string): DiffProvider {
  return DiffProvider.workspace(repoDir, undefined as unknown as GitRunner);
}
