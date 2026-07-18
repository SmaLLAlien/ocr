// Bounded git subprocess execution. Port of internal/gitcmd/runner.go.
import { spawn } from 'node:child_process';
import { Semaphore } from '../util/semaphore.js';

const DEFAULT_MAX_CONCURRENT = 16;

export interface GitResult {
  /** Combined stdout+stderr text (stdout first). */
  out: string;
  /** True when git exited 0. */
  ok: boolean;
  /** Error message / exit description when not ok. */
  error?: string;
}

/**
 * Limits the number of concurrent git subprocesses via an internal semaphore.
 * All git command invocations should go through a shared GitRunner instance
 * so the total system-wide subprocess count stays bounded.
 */
export class GitRunner {
  private readonly sem: Semaphore;

  constructor(maxConcurrent = 0) {
    this.sem = new Semaphore(maxConcurrent <= 0 ? DEFAULT_MAX_CONCURRENT : maxConcurrent);
  }

  /** Executes git and returns combined stdout+stderr with an ok flag. */
  async run(repoDir: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
    return this.sem.with(async () => {
      const { stdout, stderr, code, error } = await execGit(repoDir, args, signal);
      return {
        out: stdout + stderr,
        ok: code === 0 && !error,
        error: error ?? (code === 0 ? undefined : `git exited with code ${code}`),
      };
    }, signal);
  }

  /** Executes git and returns stdout only; throws on failure. */
  async output(repoDir: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
    return this.sem.with(async () => {
      const { stdoutBuf, stderr, code, error } = await execGit(repoDir, args, signal);
      if (error) throw new Error(error);
      if (code !== 0) {
        throw new Error(stderr.trim() !== '' ? stderr.trim() : `git exited with code ${code}`);
      }
      return stdoutBuf;
    }, signal);
  }

  /** Executes git and returns stdout and stderr separately. */
  async runSplit(
    repoDir: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; ok: boolean }> {
    return this.sem.with(async () => {
      const { stdout, stderr, code, error } = await execGit(repoDir, args, signal);
      return { stdout, stderr, ok: code === 0 && !error };
    }, signal);
  }
}

interface ExecGitResult {
  stdout: string;
  stdoutBuf: Buffer;
  stderr: string;
  code: number | null;
  error?: string;
}

function execGit(repoDir: string, args: string[], signal?: AbortSignal): Promise<ExecGitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: repoDir,
      signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => outChunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err) => {
      resolve({
        stdout: '',
        stdoutBuf: Buffer.alloc(0),
        stderr: '',
        code: null,
        error: err.message,
      });
    });
    child.on('close', (code) => {
      const stdoutBuf = Buffer.concat(outChunks);
      resolve({
        stdout: stdoutBuf.toString('utf8'),
        stdoutBuf,
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code,
      });
    });
  });
}
