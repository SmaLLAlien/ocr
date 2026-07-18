// file_find tool. Port of internal/tool/file_find.go.
import fs from 'node:fs';
import path from 'node:path';
import type { ToolArgs, ToolProvider } from './registry.js';
import { TOOL_FILE_FIND } from './registry.js';
import type { FileReader } from './fileReader.js';
import { isPathExcluded, loadGitignorePatterns } from '../diff/git.js';

const FILE_FIND_MAX_COUNT = 100;
const FILE_FIND_TIMEOUT_MS = 10_000;

/** Finds files by basename keyword via git ls-files / ls-tree. */
export class FileFindProvider implements ToolProvider {
  constructor(private readonly fileReader: FileReader) {}

  toolName(): string {
    return TOOL_FILE_FIND;
  }

  async execute(args: ToolArgs, signal?: AbortSignal): Promise<string> {
    const queryName = typeof args['query_name'] === 'string' ? args['query_name'] : '';
    if (queryName.trim() === '') return '// The file was not found';

    const caseSensitive = args['case_sensitive'] === true;

    const files = await this.listGitFiles(signal);

    const matched: string[] = [];
    for (const f of files) {
      const idx = f.lastIndexOf('/');
      const base = idx !== -1 ? f.slice(idx + 1) : f;
      const match = caseSensitive
        ? base.includes(queryName)
        : base.toLowerCase().includes(queryName.toLowerCase());
      if (match) matched.push(f);
      if (matched.length >= FILE_FIND_MAX_COUNT) break;
    }

    if (matched.length === 0) return '// The file was not found';
    return matched.join('\n');
  }

  /**
   * Tracked + untracked files (respecting .gitignore) via git ls-files; in
   * range/commit mode uses git ls-tree at the reviewed ref. Falls back to a
   * filesystem walk for non-git directories (scan mode, no ref).
   */
  private async listGitFiles(signal?: AbortSignal): Promise<string[]> {
    const timeout = AbortSignal.timeout(FILE_FIND_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const ref = this.fileReader.ref;
    const args =
      ref !== ''
        ? ['ls-tree', '-r', '--name-only', '--end-of-options', ref]
        : ['ls-files', '--cached', '--others', '--exclude-standard'];

    let output: Buffer;
    try {
      if (!this.fileReader.runner) throw new Error('no git runner');
      output = await this.fileReader.runner.output(this.fileReader.repoDir, args, combined);
    } catch (err) {
      if (combined.aborted) throw err;
      if (ref === '') return this.listWalkFiles(combined);
      throw err;
    }

    const files: string[] = [];
    for (const line of output.toString('utf8').replace(/\n+$/, '').split('\n')) {
      if (line.length > 0 && !shouldSkipFile(line)) files.push(line);
    }
    return files;
  }

  /** Non-git fallback: walks the repo dir honoring .gitignore + blocklist. */
  private listWalkFiles(signal: AbortSignal): string[] {
    const root = this.fileReader.repoDir;
    const gitignorePatterns = loadGitignorePatterns(root);
    const files: string[] = [];

    const walk = (dir: string): void => {
      if (signal.aborted) throw new Error('file_find walk aborted');
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // skip unreadable entries
      }
      for (const d of entries) {
        const full = path.join(dir, d.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (d.isDirectory()) {
          if (!isPathExcluded(root, rel, gitignorePatterns)) walk(full);
        } else if (d.isFile()) {
          if (isPathExcluded(root, rel, gitignorePatterns)) continue;
          if (shouldSkipFile(rel)) continue;
          files.push(rel);
        }
      }
    };
    walk(root);
    return files;
  }
}

/**
 * True if a listing path should be skipped: extensionless files except
 * well-known ones (Makefile, Dockerfile, LICENSE, ...).
 */
function shouldSkipFile(p: string): boolean {
  const idx = p.lastIndexOf('/');
  const base = idx !== -1 ? p.slice(idx + 1) : p;
  if (!base.includes('.')) {
    switch (base) {
      case 'Makefile':
      case 'Dockerfile':
      case 'LICENSE':
      case 'Vagrantfile':
      case 'Containerfile':
        return false;
      default:
        return true;
    }
  }
  return false;
}
