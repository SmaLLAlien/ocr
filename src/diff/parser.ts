// Unified diff text → Diff[] parsing. Port of internal/diff/parser.go.
import type { Diff } from '../model/index.js';
import { emptyDiff } from '../model/index.js';
import type { GitRunner } from '../git/runner.js';
import { readWorkspaceFileForDiff } from './workspaceFile.js';

const diffHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/;
const binaryRe = /Binary files /;

const PARSE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Splits the unified diff text into per-file Diff structs. ref, if non-empty,
 * is a git ref used to read new-file content via git show instead of the
 * working tree. runner executes git through the shared concurrency limiter.
 */
export async function parseDiffText(
  diffText: string,
  repoDir: string,
  ref: string,
  runner: GitRunner | undefined,
  signal?: AbortSignal,
): Promise<Diff[]> {
  const lines = diffText.split('\n');
  const diffs: Diff[] = [];
  let current: Diff | undefined;
  let buf: string[] = [];

  const timeoutSignal = AbortSignal.timeout(PARSE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const flush = async (): Promise<void> => {
    if (!current) return;
    current.diff = buf.join('\n').replace(/\n$/, '');
    await finalizeDiff(current, repoDir, ref, runner, combined);
    diffs.push(current);
    buf = [];
  };

  for (const line of lines) {
    const m = diffHeaderRe.exec(line);
    if (m) {
      await flush();
      current = { ...emptyDiff(), old_path: m[1]!, new_path: m[2]! };
    }
    if (!current) continue;

    if (binaryRe.test(line)) {
      current.is_binary = true;
    } else if (line.startsWith('new file mode ')) {
      current.is_new = true;
    } else if (line.startsWith('deleted file mode ')) {
      current.is_deleted = true;
    } else if (line.startsWith('rename from ')) {
      // Authoritative old path for renames; more reliable than the
      // "diff --git" header when paths contain spaces.
      current.old_path = line.slice('rename from '.length);
      current.is_renamed = true;
    } else if (line.startsWith('rename to ')) {
      current.new_path = line.slice('rename to '.length);
      current.is_renamed = true;
    } else if (line === '--- /dev/null') {
      current.is_new = true;
    } else if (line === '+++ /dev/null') {
      current.is_deleted = true;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.insertions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions++;
    }
    buf.push(line + '\n');
  }

  await flush();
  return diffs;
}

/**
 * Reads the new file content: via git show when ref is non-empty, otherwise
 * from disk. Failures are warnings, not errors (file stays content-less).
 */
async function finalizeDiff(
  d: Diff,
  repoDir: string,
  ref: string,
  runner: GitRunner | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (d.is_deleted || d.new_path === '/dev/null') {
    d.new_path = '/dev/null';
    return;
  }
  if (ref !== '') {
    const args = ['-c', 'core.quotepath=false', 'show', '--end-of-options', `${ref}:${d.new_path}`];
    try {
      if (!runner) throw new Error('no git runner');
      const output = await runner.output(repoDir, args, signal);
      d.new_file_content = output.toString('utf8');
    } catch (err) {
      process.stderr.write(
        `[ocr] WARNING: cannot read file ${d.new_path} at ref ${ref}: ${(err as Error).message}\n`,
      );
    }
    return;
  }
  try {
    d.new_file_content = readWorkspaceFileForDiff(repoDir, d.new_path).toString('utf8');
  } catch (err) {
    process.stderr.write(
      `[ocr] WARNING: cannot read file ${d.new_path} for review: ${(err as Error).message}\n`,
    );
  }
}
