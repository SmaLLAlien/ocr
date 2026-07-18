// ocr review. M3 scope: flags, ref validation, and the --preview path
// (port of the corresponding parts of cmd/opencodereview/review_cmd.go;
// the full LLM review path arrives with M4).
import { buildPreview } from '../agent/preview.js';
import { parseReviewFlags, printReviewUsage, splitPaths, type ReviewOptions } from './flags.js';
import { applyCLIExcludes, loadCommonContext, type CommonContext } from './shared.js';
import { runGitCmd } from './git.js';
import { outputPreviewText } from './output.js';

export async function runReview(args: string[]): Promise<void> {
  const opts = parseReviewFlags(args);
  if (opts.showHelp) {
    printReviewUsage();
    return;
  }

  const cc = loadCommonContext(opts.repoDir, opts.rulePath, opts.maxGitProcs, true);
  applyCLIExcludes(cc, splitPaths(opts.excludes));

  validateReviewRefs(cc.repoDir, opts);

  if (opts.preview) {
    return runPreview(cc, opts);
  }

  throw new Error("'ocr review' without --preview is not implemented yet (M4 of the TypeScript port)");
}

/**
 * Rejects ref-option injection (#112): any --from/--to/--commit value must be
 * a real commit ref and must not start with '-'.
 */
export function validateReviewRefs(repoDir: string, opts: ReviewOptions): void {
  const refs: Array<{ flag: string; ref: string }> = [
    { flag: '--from', ref: opts.from },
    { flag: '--to', ref: opts.to },
    { flag: '--commit', ref: opts.commit },
  ];
  for (const item of refs) {
    if (item.ref === '') continue;
    if (item.ref.startsWith('-')) {
      throw new Error(
        `${item.flag} value ${JSON.stringify(item.ref)} is not a valid git ref: refs must not start with '-'`,
      );
    }
    const res = runGitCmd(repoDir, 'rev-parse', '--verify', '--end-of-options', `${item.ref}^{commit}`);
    if (!res.ok) {
      const msg = res.out.trim();
      if (msg !== '') {
        throw new Error(`${item.flag} value ${JSON.stringify(item.ref)} is not a valid commit ref: ${msg}`);
      }
      throw new Error(`${item.flag} value ${JSON.stringify(item.ref)} is not a valid commit ref`);
    }
  }
}

async function runPreview(cc: CommonContext, opts: ReviewOptions): Promise<void> {
  let preview;
  try {
    preview = await buildPreview({
      repoDir: cc.repoDir,
      from: opts.from,
      to: opts.to,
      commit: opts.commit,
      fileFilter: cc.fileFilter,
      gitRunner: cc.gitRunner,
    });
  } catch (err) {
    throw new Error(`preview failed: ${(err as Error).message}`);
  }

  outputPreviewText(preview);
}
