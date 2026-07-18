// ocr review. Port of cmd/opencodereview/review_cmd.go (MCP wiring arrives
// with M6; everything else is complete).
import { ReviewAgent } from '../agent/agent.js';
import { buildPreview } from '../agent/preview.js';
import {
  REVIEW_MODE_COMMIT,
  REVIEW_MODE_RANGE,
  REVIEW_MODE_WORKSPACE,
} from '../session/history.js';
import { loadResumeState, type ResumeState } from '../session/resume.js';
import { CommentCollector } from '../tools/collector.js';
import { FileReader, parseReviewMode, ReviewMode } from '../tools/fileReader.js';
import { ToolRegistry } from '../tools/registry.js';
import { FileReadProvider } from '../tools/fileRead.js';
import { FileFindProvider } from '../tools/fileFind.js';
import { FileReadDiffProvider } from '../tools/fileReadDiff.js';
import { CodeSearchProvider } from '../tools/codeSearch.js';
import { CodeCommentProvider } from '../tools/codeComment.js';
import { CommentWorkerPool } from '../loop/pool.js';
import { parseReviewFlags, printReviewUsage, splitPaths, type ReviewOptions } from './flags.js';
import {
  QuietHandle,
  applyCLIExcludes,
  emitRunResult,
  loadCommonContext,
  loadLLMRuntime,
  type CommonContext,
} from './shared.js';
import { getCommitMessage, runGitCmd } from './git.js';
import { loadBackgroundFile, mergeBackground } from './backgroundFile.js';
import { outputPreviewText } from './output.js';

export async function runReview(args: string[]): Promise<void> {
  const opts = parseReviewFlags(args);
  if (opts.showHelp) {
    printReviewUsage();
    return;
  }

  // review path: git repo is required (diff concepts depend on it).
  const cc = loadCommonContext(opts.repoDir, opts.rulePath, opts.maxTools, opts.maxGitProcs, true);
  applyCLIExcludes(cc, splitPaths(opts.excludes));

  // Security (#112): reject ref-option injection before any git invocation.
  validateReviewRefs(cc.repoDir, opts);

  if (opts.commit !== '' && opts.background === '') {
    const msg = getCommitMessage(cc.repoDir, opts.commit);
    if (msg !== '') opts.background = msg;
  }

  // Only touch the background when --background-file is set, so the raw
  // --background behaviour is preserved for users who don't opt in.
  if (opts.backgroundFile !== '') {
    const fileBackground = loadBackgroundFile(opts.backgroundFile);
    opts.background = mergeBackground(opts.background, fileBackground);
  }

  if (opts.preview) {
    return runPreview(cc, opts);
  }

  const resumeState = loadReviewResumeState(cc.repoDir, opts);

  const rt = loadLLMRuntime(cc.template, opts.toolConfigPath, opts.model);

  const mode = parseReviewMode(opts.from, opts.to, opts.commit);
  const ref = mode === ReviewMode.Range ? opts.to : mode === ReviewMode.Commit ? opts.commit : '';
  const fileReader = new FileReader(cc.repoDir, mode, ref, cc.gitRunner);
  const tools = buildToolRegistry(rt.collector, fileReader);

  // MCP clients: M6. Built-in tools only for now.

  const ag = new ReviewAgent({
    repoDir: cc.repoDir,
    from: opts.from,
    to: opts.to,
    commit: opts.commit,
    reviewMode: reviewModeFromOptions(opts),
    template: cc.template,
    systemRule: cc.resolver,
    fileFilter: cc.fileFilter,
    llmClient: rt.client,
    tools,
    planToolDefs: rt.planToolDefs,
    mainToolDefs: rt.mainToolDefs,
    commentCollector: rt.collector,
    commentWorkerPool: new CommentWorkerPool(opts.concurrency),
    maxConcurrency: opts.concurrency,
    concurrentTaskTimeout: opts.perFileTimeout,
    model: rt.model,
    background: opts.background,
    gitRunner: cc.gitRunner,
    resume: resumeState,
  });

  // Silence progress output during execution; restored before the trace
  // summary in agent-text mode (and by emitRunResult otherwise).
  const q = new QuietHandle(opts.outputFormat, opts.audience);
  const startTime = Date.now();

  let comments;
  try {
    comments = await ag.run();
  } catch (err) {
    q.restore();
    const id = ag.sessionID();
    if (id !== '') {
      process.stderr.write(`[ocr] Session: ${id} (retry with: --resume ${id})\n`);
    }
    throw new Error(`review failed: ${(err as Error).message}`);
  }

  try {
    emitRunResult(ag, comments, startTime, opts.outputFormat, opts.audience, q);
  } finally {
    q.restore();
  }
}

function loadReviewResumeState(repoDir: string, opts: ReviewOptions): ResumeState | undefined {
  if (opts.resume === '') return undefined;
  const mode = reviewModeFromOptions(opts);
  if (mode === REVIEW_MODE_WORKSPACE) {
    throw new Error('resume requires --from/--to or --commit; workspace resume is not supported');
  }
  let state: ResumeState;
  try {
    state = loadResumeState(repoDir, opts.resume);
  } catch (err) {
    throw new Error(
      `load resume session: ${(err as Error).message} (run 'ocr session list' to see available sessions)`,
    );
  }
  try {
    state.validateOptions({
      reviewMode: mode,
      diffFrom: opts.from,
      diffTo: opts.to,
      diffCommit: opts.commit,
    });
  } catch (err) {
    throw new Error(`${(err as Error).message} (run 'ocr session list' to see available sessions)`);
  }
  if (state.completedCount() === 0) {
    throw new Error(
      `resume session ${JSON.stringify(opts.resume)} has no completed review items (run 'ocr session list' to see available sessions)`,
    );
  }
  return state;
}

function reviewModeFromOptions(opts: ReviewOptions): string {
  if (opts.commit !== '') return REVIEW_MODE_COMMIT;
  if (opts.from !== '' && opts.to !== '') return REVIEW_MODE_RANGE;
  return REVIEW_MODE_WORKSPACE;
}

function buildToolRegistry(collector: CommentCollector, fr: FileReader): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(new FileReadProvider(fr));
  reg.register(new FileFindProvider(fr));
  reg.register(new FileReadDiffProvider());
  reg.register(new CodeSearchProvider(fr));
  reg.register(new CodeCommentProvider(collector));
  return reg;
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
