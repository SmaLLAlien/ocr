// File-enumeration engine for full-file review. Port of internal/scan/provider.go.
import fs from 'node:fs';
import path from 'node:path';
import type { ScanItem } from '../model/index.js';
import type { GitRunner } from '../git/runner.js';
import { isPathExcluded, loadGitignorePatterns } from '../diff/git.js';
import { runGitCmd } from '../cli/git.js';

// Leading bytes inspected to decide whether a file is binary (git heuristic).
const BINARY_SNIFF_WINDOW = 8000;

/**
 * Default hard cap on single-file size. The real review-feasibility limit is
 * the per-file token budget; this byte cap only stops multi-MB dumps from
 * being read into memory.
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 << 20; // 2 MiB

/**
 * Enumerates source files in a repository for full-file review. Binaries are
 * emitted as placeholder entries (content empty, is_binary=true) so previews
 * can surface them without reading their bytes.
 */
export class ScanProvider {
  private readonly paths: string[];
  private readonly maxFileSizeBytes: number;

  constructor(
    private readonly repoDir: string,
    paths: string[],
    private readonly runner: GitRunner | undefined,
    maxFileSizeBytes: number,
  ) {
    this.paths = paths
      .map((p) => p.trim())
      .filter((p) => p !== '')
      // Normalize: strip leading "./" and trailing "/" so prefix matching
      // against `git ls-files` output works.
      .map((p) => p.replace(/^\.\//, '').replace(/\/+$/, '').split(path.sep).join('/'));
    this.maxFileSizeBytes = maxFileSizeBytes <= 0 ? DEFAULT_MAX_FILE_SIZE_BYTES : maxFileSizeBytes;
  }

  /** One ScanItem per reviewable file. */
  async enumerate(signal?: AbortSignal): Promise<ScanItem[]> {
    let files = await this.listFiles(signal);

    if (this.paths.length > 0) {
      files = filterByPaths(files, this.paths);
    }

    const gitignorePatterns = loadGitignorePatterns(this.repoDir);

    const out: ScanItem[] = [];
    for (const rel of files) {
      if (signal?.aborted) throw new Error('scan enumeration aborted');
      if (rel === '') continue;
      if (isPathExcluded(this.repoDir, rel, gitignorePatterns)) continue;
      const full = path.join(this.repoDir, rel);
      let info: fs.Stats;
      try {
        info = fs.lstatSync(full);
      } catch (err) {
        process.stderr.write(`[ocr] WARNING: cannot stat ${rel}: ${(err as Error).message}\n`);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > this.maxFileSizeBytes) {
        process.stderr.write(
          `[ocr] WARNING: skipping ${rel} (${info.size} bytes exceeds ${this.maxFileSizeBytes}-byte scan limit; raise MaxTokens if the real concern is token budget, not memory)\n`,
        );
        continue;
      }
      let binary: boolean;
      try {
        binary = isBinaryFile(full);
      } catch (err) {
        process.stderr.write(`[ocr] WARNING: cannot sniff ${rel}: ${(err as Error).message}\n`);
        continue;
      }
      if (binary) {
        out.push({ path: rel, content: '', is_binary: true });
        continue;
      }
      let content: Buffer;
      try {
        content = fs.readFileSync(full);
      } catch (err) {
        process.stderr.write(`[ocr] WARNING: cannot read ${rel}: ${(err as Error).message}\n`);
        continue;
      }
      out.push({
        path: rel,
        content: content.toString('utf8'),
        is_binary: false,
        line_count: countLines(content),
      });
    }
    return out;
  }

  /**
   * All source files under repoDir: `git ls-files` in a git repo (full
   * .gitignore semantics), filesystem walk otherwise (root .gitignore +
   * ExcludedDirs blocklist only).
   */
  private async listFiles(signal?: AbortSignal): Promise<string[]> {
    if (this.isGitRepo()) return this.listFilesViaGit(signal);
    return this.listFilesViaWalk(signal);
  }

  private isGitRepo(): boolean {
    return runGitCmd(this.repoDir, '-C', this.repoDir, 'rev-parse', '--git-dir').ok;
  }

  private async listFilesViaGit(signal?: AbortSignal): Promise<string[]> {
    let tracked: string[];
    try {
      tracked = await this.gitLs(['-z'], signal);
    } catch (err) {
      throw new Error(`git ls-files (tracked): ${(err as Error).message}`);
    }
    let untracked: string[];
    try {
      untracked = await this.gitLs(['-z', '--others', '--exclude-standard'], signal);
    } catch (err) {
      throw new Error(`git ls-files (untracked): ${(err as Error).message}`);
    }

    const seen = new Set<string>();
    const all: string[] = [];
    for (const f of [...tracked, ...untracked]) {
      if (f === '' || seen.has(f)) continue;
      seen.add(f);
      all.push(f);
    }
    return all;
  }

  private listFilesViaWalk(signal?: AbortSignal): string[] {
    const gitignorePatterns = loadGitignorePatterns(this.repoDir);
    const files: string[] = [];

    const walk = (dir: string): void => {
      if (signal?.aborted) throw new Error('scan walk aborted');
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        process.stderr.write(`[ocr] WARNING: walk error at ${dir}: ${(err as Error).message}\n`);
        return;
      }
      for (const d of entries) {
        const full = path.join(dir, d.name);
        const rel = path.relative(this.repoDir, full).split(path.sep).join('/');
        if (d.isDirectory()) {
          // Skip the whole subtree if the dir itself is excluded.
          if (!isPathExcluded(this.repoDir, rel, gitignorePatterns)) walk(full);
        } else if (d.isFile()) {
          if (isPathExcluded(this.repoDir, rel, gitignorePatterns)) continue;
          files.push(rel);
        }
        // Symlinks / sockets / etc. are skipped (regular files only).
      }
    };
    walk(this.repoDir);
    return files;
  }

  private async gitLs(args: string[], signal?: AbortSignal): Promise<string[]> {
    const cmdArgs = ['-c', 'core.quotepath=false', 'ls-files', ...args];
    if (!this.runner) throw new Error('scan: no git runner');
    // stdout only: with -z git emits NUL-delimited paths; merging stderr in
    // would corrupt the filename parsing.
    const out = (await this.runner.output(this.repoDir, cmdArgs, signal)).toString('utf8');
    return out
      .replace(/\x00+$/, '')
      .split('\x00')
      .map((f) => f.trim())
      .filter((f) => f !== '');
  }
}

/**
 * Keeps only entries whose path equals a user-supplied path (exact files)
 * or lies under it (directories).
 */
export function filterByPaths(all: string[], paths: string[]): string[] {
  return all.filter((f) => paths.some((want) => f === want || f.startsWith(want + '/')));
}

/** Line count; a file without a trailing newline still counts its final line. */
export function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let n = 0;
  for (const b of content) if (b === 0x0a) n++;
  if (content[content.length - 1] !== 0x0a) n++;
  return n;
}

/** NUL byte within the first 8000 bytes → binary (git's heuristic). */
export function isBinaryFile(p: string): boolean {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_WINDOW);
    const n = fs.readSync(fd, buf, 0, BINARY_SNIFF_WINDOW, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}
