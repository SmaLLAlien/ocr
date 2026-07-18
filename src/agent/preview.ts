// Read-only diff preview and exclusion filtering.
// Port of internal/agent/preview.go plus loadDiffs/extFromPath from agent.go.
import type { Diff, Preview, PreviewEntry } from '../model/index.js';
import { ExcludeReason } from '../model/index.js';
import type { GitRunner } from '../git/runner.js';
import type { FileFilter } from '../config/rules.js';
import { DiffProvider } from '../diff/git.js';
import { isAllowedExt, isExcludedPath } from '../config/allowlist.js';

export interface PreviewArgs {
  repoDir: string;
  from?: string;
  to?: string;
  commit?: string;
  fileFilter?: FileFilter;
  gitRunner: GitRunner;
}

export interface LoadedDiffs {
  diffs: Diff[];
  totalInsertions: number;
  totalDeletions: number;
}

/** Populates the diff set for the selected review mode. */
export async function loadDiffs(args: PreviewArgs, signal?: AbortSignal): Promise<LoadedDiffs> {
  let provider: DiffProvider;
  if (args.commit) {
    provider = DiffProvider.commit(args.repoDir, args.commit, args.gitRunner);
  } else if (args.from && args.to) {
    provider = DiffProvider.range(args.repoDir, args.from, args.to, args.gitRunner);
  } else {
    provider = DiffProvider.workspace(args.repoDir, args.gitRunner);
  }

  let diffs: Diff[];
  try {
    diffs = await provider.getDiff(signal);
  } catch (err) {
    throw new Error(`get diffs: ${(err as Error).message}`);
  }

  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const d of diffs) {
    totalInsertions += d.insertions;
    totalDeletions += d.deletions;
  }
  return { diffs, totalInsertions, totalDeletions };
}

/**
 * Applies the review filter algorithm and returns the specific reason a file
 * is excluded (ExcludeReason.None when it will be reviewed).
 */
export function whyExcluded(d: Diff, fileFilter: FileFilter | undefined): ExcludeReason {
  if (d.is_binary) return ExcludeReason.Binary;

  const p = effectivePath(d);
  const f = fileFilter;

  if (f && f.isUserExcluded(p)) return ExcludeReason.UserRule;
  if (f && f.hasInclude() && f.isUserIncluded(p)) return ExcludeReason.None;

  const ext = extFromPath(p);
  if (ext !== '' && !isAllowedExt(ext)) return ExcludeReason.Extension;
  if (isExcludedPath(p)) return ExcludeReason.DefaultPath;

  return ExcludeReason.None;
}

/**
 * Loads diffs and applies the filter algorithm, returning structured preview
 * data without dispatching any LLM calls.
 */
export async function buildPreview(args: PreviewArgs, signal?: AbortSignal): Promise<Preview> {
  const loaded = await loadDiffs(args, signal);

  const result: Preview = {
    files: [],
    total_insertions: loaded.totalInsertions,
    total_deletions: loaded.totalDeletions,
    total_files: loaded.diffs.length,
    reviewable_count: 0,
    excluded_count: 0,
  };

  for (const d of loaded.diffs) {
    const entry: PreviewEntry = {
      path: effectivePath(d),
      status: diffStatus(d),
      insertions: d.insertions,
      deletions: d.deletions,
      will_review: false,
    };

    let reason = whyExcluded(d, args.fileFilter);
    if (reason === ExcludeReason.None && d.is_deleted) reason = ExcludeReason.Deleted;

    entry.will_review = reason === ExcludeReason.None;
    entry.exclude_reason = reason;

    if (entry.will_review) result.reviewable_count++;
    else result.excluded_count++;

    result.files.push(entry);
  }

  return result;
}

export function effectivePath(d: Diff): string {
  return d.new_path === '/dev/null' ? d.old_path : d.new_path;
}

export function diffStatus(d: Diff): string {
  if (d.is_binary) return 'binary';
  if (d.is_new) return 'added';
  if (d.is_deleted) return 'deleted';
  if (d.is_renamed) return 'renamed';
  if (d.old_path !== d.new_path && d.old_path !== '' && d.old_path !== '/dev/null') {
    return 'renamed';
  }
  return 'modified';
}

/** File extension with leading dot, lowercased ("" when none). */
export function extFromPath(p: string): string {
  const idx = p.lastIndexOf('/');
  const basename = idx >= 0 ? p.slice(idx + 1) : p;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return '';
  return basename.slice(dot).toLowerCase();
}
