// Thin synchronous git helpers for CLI-layer validation.
// Port of cmd/opencodereview/git.go.
import { spawnSync } from 'node:child_process';

/** Runs git and returns combined stdout+stderr with an ok flag. */
export function runGitCmd(repoDir: string, ...args: string[]): { out: string; ok: boolean } {
  const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true });
  if (res.error) return { out: res.error.message, ok: false };
  return { out: (res.stdout ?? '') + (res.stderr ?? ''), ok: res.status === 0 };
}

/** Runs git and returns stdout only (for path data git stderr must not pollute). */
export function runGitCmdStdout(repoDir: string, ...args: string[]): { out: string; ok: boolean } {
  const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true });
  if (res.error) return { out: '', ok: false };
  return { out: res.stdout ?? '', ok: res.status === 0 };
}

/** Returns the full commit message body of a commit. */
export function getCommitMessage(repoDir: string, commit: string): string {
  const res = runGitCmdStdout(repoDir, 'log', '-1', '--format=%B', '--end-of-options', commit);
  return res.ok ? res.out.trim() : '';
}
