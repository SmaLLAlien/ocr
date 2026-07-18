// code_search tool (git grep). Port of internal/tool/code_search.go.
import type { ToolArgs, ToolProvider } from './registry.js';
import { TOOL_CODE_SEARCH } from './registry.js';
import type { FileReader } from './fileReader.js';

const GIT_GREP_MAX_COUNT = 100;
const GIT_GREP_TIMEOUT_MS = 10_000;

/** Performs text search across the repository using git grep. */
export class CodeSearchProvider implements ToolProvider {
  constructor(private readonly fileReader: FileReader) {}

  toolName(): string {
    return TOOL_CODE_SEARCH;
  }

  async execute(args: ToolArgs, signal?: AbortSignal): Promise<string> {
    const searchText = typeof args['search_text'] === 'string' ? args['search_text'] : '';
    const caseSensitive = args['case_sensitive'] === true;
    const usePerlRegexp = args['use_perl_regexp'] === true;

    const patternsIface = Array.isArray(args['file_patterns']) ? args['file_patterns'] : [];
    const patterns: string[] = [];
    for (const item of patternsIface) {
      if (typeof item === 'string' && item !== '') {
        if (hasTraversalPathComponent(item)) {
          return 'Error: file_patterns must not contain ..';
        }
        patterns.push(item);
      }
    }

    if (searchText.trim() === '') return 'Error: search_text is blank';

    try {
      return await this.gitGrep(searchText, caseSensitive, usePerlRegexp, patterns, signal);
    } catch (err) {
      throw new Error(`code_search failed: ${(err as Error).message}`);
    }
  }

  private buildGrepArgs(
    searchText: string,
    caseSensitive: boolean,
    usePerlRegexp: boolean,
    noIndex: boolean,
    pathspec: string[],
  ): string[] {
    const cmdArgs = ['--no-pager', 'grep'];

    if (noIndex) {
      // Non-git directory: search the working tree directly while still
      // honoring .gitignore and skipping .git (via --exclude-standard).
      cmdArgs.push('--no-index', '--exclude-standard');
    } else if (this.fileReader.ref === '') {
      cmdArgs.push('--untracked');
    }

    if (!caseSensitive) cmdArgs.push('-i');
    cmdArgs.push(usePerlRegexp ? '-P' : '-F');

    cmdArgs.push('-n', '--no-color');
    cmdArgs.push('--max-count', String(GIT_GREP_MAX_COUNT));
    cmdArgs.push('-e', searchText);

    if (this.fileReader.ref !== '') {
      cmdArgs.push('--end-of-options', this.fileReader.ref);
    }

    cmdArgs.push('--', ...pathspec);
    return cmdArgs;
  }

  private async runGitGrep(
    cmdArgs: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; ok: boolean; timedOut: boolean }> {
    const timeout = AbortSignal.timeout(GIT_GREP_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const runner = this.fileReader.runner;
    if (!runner) throw new Error('code_search: no git runner');
    try {
      const res = await runner.runSplit(this.fileReader.repoDir, cmdArgs, combined);
      return { ...res, timedOut: false };
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) {
        return { stdout: '', stderr: '', ok: false, timedOut: true };
      }
      throw err;
    }
  }

  private async gitGrep(
    searchText: string,
    caseSensitive: boolean,
    usePerlRegexp: boolean,
    pathspec: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    let cmdArgs = this.buildGrepArgs(searchText, caseSensitive, usePerlRegexp, false, pathspec);
    let res = await this.runGitGrep(cmdArgs, signal);

    // Non-git directory: `git grep` fails with "not a git repository".
    // `ocr scan` supports plain directories, so retry in --no-index mode.
    // Ref-based search needs a real repo, so it is not retried.
    if (
      !res.ok &&
      !res.timedOut &&
      this.fileReader.ref === '' &&
      (res.stderr.includes('not a git repository') || res.stderr.includes('.git'))
    ) {
      cmdArgs = this.buildGrepArgs(searchText, caseSensitive, usePerlRegexp, true, pathspec);
      res = await this.runGitGrep(cmdArgs, signal);
    }

    if (res.timedOut) {
      return 'code_search timed out. Try narrowing file_patterns to a more specific path.';
    }
    if (!res.ok && res.stdout === '') {
      if (res.stderr === '') return 'No matches found';
      return `Error: ${res.stderr.trim()}`;
    }

    const lines = res.stdout.replace(/\n+$/, '').split('\n');
    const truncated = lines.length >= GIT_GREP_MAX_COUNT;

    interface Match {
      lineNum: number;
      content: string;
    }
    const fileMatches = new Map<string, Match[]>();
    const fileOrder: string[] = [];

    const hasRef = this.fileReader.ref !== '';
    const splitN = hasRef ? 4 : 3;
    const offset = hasRef ? 1 : 0;

    let sb = '';
    if (truncated) {
      sb += `Note: The results have been truncated. Only showing first ${GIT_GREP_MAX_COUNT} results.\n`;
    }

    for (const line of lines) {
      if (line === '') continue;
      const parts = splitNParts(line, ':', splitN);
      if (parts.length < splitN) continue;
      const fname = parts[offset]!;
      const ln = Number(parts[offset + 1]);
      if (!Number.isInteger(ln)) continue;
      const m: Match = { lineNum: ln, content: parts[offset + 2]! };
      if (!fileMatches.has(fname)) {
        fileMatches.set(fname, []);
        fileOrder.push(fname);
      }
      fileMatches.get(fname)!.push(m);
    }

    for (const p of fileOrder) {
      const matches = fileMatches.get(p)!;
      sb += `File: ${p}\nMatch lines: ${matches.length}\n`;
      for (const m of matches) {
        sb += `${m.lineNum}|${m.content}\n`;
      }
      sb += '\n';
    }

    if (!res.ok && res.stderr !== '') {
      sb += `Warning: ${res.stderr.trim()}\n`;
    }

    return sb;
  }
}

function hasTraversalPathComponent(pathspec: string): boolean {
  return pathspec.split('/').includes('..');
}

/** strings.SplitN equivalent: split on sep into at most n parts. */
function splitNParts(s: string, sep: string, n: number): string[] {
  const parts: string[] = [];
  let rest = s;
  while (parts.length < n - 1) {
    const idx = rest.indexOf(sep);
    if (idx < 0) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  return parts;
}
