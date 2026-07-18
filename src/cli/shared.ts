// Shared setup for review/scan. Port of the pre-LLM half of
// cmd/opencodereview/shared.go (loadCommonContext, resolveWorkingDir,
// applyCLIExcludes; the llmRuntime half arrives with M4).
import fs from 'node:fs';
import path from 'node:path';
import { FileFilter, newResolver, type RuleResolver } from '../config/rules.js';
import { GitRunner } from '../git/runner.js';
import { runGitCmd, runGitCmdStdout } from './git.js';

/**
 * State both `ocr review` and `ocr scan` need before deciding whether to
 * dispatch a preview or a real LLM session.
 */
export interface CommonContext {
  repoDir: string;
  resolver: RuleResolver;
  fileFilter: FileFilter | undefined;
  gitRunner: GitRunner;
  /** Whether repoDir is inside a git repository (always true when requireGit). */
  isGitRepo: boolean;
}

/**
 * Validates the working directory, resolves the absolute repo path, loads
 * review rules, and creates the git subprocess limiter.
 *
 * requireGit=true fails fast when the directory is not a git repo (review
 * path); requireGit=false allows non-git directories (scan path).
 */
export function loadCommonContext(
  repoDirInput: string,
  rulePath: string,
  maxGitProcs: number,
  requireGit: boolean,
): CommonContext {
  const { repoDir, isGit } = resolveWorkingDir(repoDirInput, requireGit);

  let resolved;
  try {
    resolved = newResolver(repoDir, rulePath);
  } catch (err) {
    throw new Error(`load rules: ${(err as Error).message}`);
  }

  return {
    repoDir,
    resolver: resolved.resolver,
    fileFilter: resolved.fileFilter,
    gitRunner: new GitRunner(maxGitProcs),
    isGitRepo: isGit,
  };
}

/**
 * Returns (absPath, isGitRepo). When requireGit is true, errors if the
 * directory is not a git repo. #287: for the review path the repo dir is
 * anchored at the git top-level so root-relative diff paths resolve from
 * monorepo subdirectories; scan keeps the CWD.
 */
export function resolveWorkingDir(
  input: string,
  requireGit: boolean,
): { repoDir: string; isGit: boolean } {
  if (input === '') input = process.cwd();
  const absPath = path.resolve(input);
  if (!fs.existsSync(absPath)) {
    throw new Error(`stat ${absPath}: no such file or directory`);
  }
  const gitDir = runGitCmd(absPath, 'rev-parse', '--git-dir');
  const isGit = gitDir.ok && gitDir.out.length > 0;
  if (!isGit && requireGit) {
    throw new Error(`${absPath} is not a git repository`);
  }
  if (isGit && requireGit) {
    const top = runGitCmdStdout(absPath, 'rev-parse', '--show-toplevel');
    const t = top.out.trim();
    if (!top.ok || t === '') {
      throw new Error(
        `${absPath} is a git repository without a work tree (bare repo?); cannot resolve its top level for review`,
      );
    }
    return { repoDir: t, isGit };
  }
  return { repoDir: absPath, isGit };
}

/** Resolves the repo dir for commands that require a git repository. */
export function resolveRepoDir(input: string): string {
  return resolveWorkingDir(input, true).repoDir;
}

/**
 * Appends user-supplied --exclude patterns onto the FileFilter, creating it
 * if no rule.json layer produced one.
 */
export function applyCLIExcludes(cc: CommonContext, patterns: string[]): void {
  if (patterns.length === 0) return;
  if (!cc.fileFilter) cc.fileFilter = new FileFilter();
  cc.fileFilter.exclude.push(...patterns);
}
