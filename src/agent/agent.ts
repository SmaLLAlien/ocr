// Diff-review orchestrator. Port of internal/agent/agent.go + util.go
// (telemetry spans dropped; console progress preserved).
import { createHash } from 'node:crypto';
import type { Diff, LlmComment } from '../model/index.js';
import { ExcludeReason } from '../model/index.js';
import type { Template } from '../config/template.js';
import type { FileFilter, RuleResolver } from '../config/rules.js';
import type { LLMClient, Message, ToolDef } from '../llm/types.js';
import { newTextMessage, responseContent } from '../llm/types.js';
import { countTokens } from '../llm/tokens.js';
import type { GitRunner } from '../git/runner.js';
import { runGitCmdStdout } from '../cli/git.js';
import {
  REVIEW_MODE_COMMIT,
  REVIEW_MODE_RANGE,
  REVIEW_MODE_WORKSPACE,
  SessionHistory,
} from '../session/history.js';
import type { ResumeState } from '../session/resume.js';
import { CommentCollector } from '../tools/collector.js';
import { ToolRegistry, TOOL_FILE_READ_DIFF } from '../tools/registry.js';
import { DiffMap, FileReadDiffProvider } from '../tools/fileReadDiff.js';
import type { CommentWorkerPool, AgentWarning } from '../loop/pool.js';
import { LoopRunner } from '../loop/runner.js';
import { countMessagesTokens, stripMarkdownFences } from '../loop/compression.js';
import { loadDiffs as loadDiffsForMode, whyExcluded, effectivePath } from './preview.js';
import { out } from '../util/logger.js';
import { Semaphore } from '../util/semaphore.js';

/** All dependencies and configuration needed to run a review session. */
export interface AgentArgs {
  repoDir: string;
  from?: string;
  to?: string;
  commit?: string;
  /** "workspace" | "range" | "commit"; derived from refs when empty. */
  reviewMode?: string;
  template: Template;
  systemRule?: RuleResolver;
  fileFilter?: FileFilter;
  llmClient: LLMClient;
  tools?: ToolRegistry;
  planToolDefs?: ToolDef[];
  mainToolDefs?: ToolDef[];
  commentWorkerPool?: CommentWorkerPool;
  maxConcurrency?: number;
  /** Concurrent task timeout in minutes; 0 = no timeout. */
  concurrentTaskTimeout?: number;
  commentCollector?: CommentCollector;
  /** Optional requirement/business context ({{requirement_background}}). */
  background?: string;
  model: string;
  gitRunner: GitRunner;
  session?: SessionHistory;
  resume?: ResumeState;
}

/** Summary of file-level reuse for a resumed review. */
export interface ResumeInfo {
  resumed_from: string;
  reused_files: number;
  rerun_files: number;
  previous_model?: string;
  current_model?: string;
}

// Matches the optional "Review Plan" section wrapper in a MAIN_TASK user
// message (English "Review Plan" or Chinese 审查计划 header +
// {{plan_guidance}} on its own line + one trailing blank line).
const planBlockPattern = /^### [^\n]*(?:Review Plan|审查计划)[^\n]*\n\{\{plan_guidance\}\}\n\n?/gm;

export function stripEmptyPlanBlock(content: string): string {
  return content.replace(planBlockPattern, '');
}

export function reviewModeString(from: string, to: string, commit: string): string {
  if (commit !== '') return REVIEW_MODE_COMMIT;
  if (from !== '' && to !== '') return REVIEW_MODE_RANGE;
  return REVIEW_MODE_WORKSPACE;
}

export function reviewItemFingerprint(mode: string, d: Diff): string {
  return createHash('sha256')
    .update(mode + '\x00' + d.old_path + '\x00' + d.new_path + '\x00' + d.diff)
    .digest('hex');
}

/** Current git branch name, or "" on failure. */
export function detectGitBranch(repoDir: string): string {
  const res = runGitCmdStdout(repoDir, '-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  return res.ok ? res.out.trim() : '';
}

/** Orchestrates the AI-powered code review over a git diff. */
export class ReviewAgent {
  readonly args: Required<
    Pick<AgentArgs, 'tools' | 'commentCollector'>
  > &
    AgentArgs;
  diffs: Diff[] = [];
  totalInsertions = 0;
  totalDeletions = 0;
  private currentDate = '';
  readonly session: SessionHistory;
  private subtaskFailed = 0;
  readonly runner: LoopRunner;
  private resumeInfoData: ResumeInfo | undefined;

  constructor(args: AgentArgs) {
    const tools = args.tools ?? new ToolRegistry();
    const commentCollector = args.commentCollector ?? new CommentCollector();
    let session = args.session;
    if (!session) {
      const gitBranch = detectGitBranch(args.repoDir);
      const mode = args.reviewMode || reviewModeString(args.from ?? '', args.to ?? '', args.commit ?? '');
      session = new SessionHistory(args.repoDir, gitBranch, args.model, {
        reviewMode: mode,
        diffFrom: args.from,
        diffTo: args.to,
        diffCommit: args.commit,
        resumedFrom: args.resume?.sessionID,
      });
    }
    this.args = { ...args, tools, commentCollector };
    this.session = session;
    this.runner = new LoopRunner({
      llmClient: args.llmClient,
      model: args.model,
      template: args.template,
      tools,
      mainToolDefs: args.mainToolDefs ?? [],
      commentCollector,
      commentWorkerPool: args.commentWorkerPool,
      session,
      diffLookup: (p) => this.findDiff(p),
    });
  }

  /** Full pipeline: parse diffs → per-file plan + tool-loop → comments. */
  async run(signal?: AbortSignal): Promise<LlmComment[]> {
    const loaded = await loadDiffsForMode(
      {
        repoDir: this.args.repoDir,
        from: this.args.from,
        to: this.args.to,
        commit: this.args.commit,
        fileFilter: this.args.fileFilter,
        gitRunner: this.args.gitRunner,
      },
      signal,
    );
    this.diffs = loaded.diffs;
    this.totalInsertions = loaded.totalInsertions;
    this.totalDeletions = loaded.totalDeletions;

    // Build the read-only DiffMap from ALL parsed diffs (before filtering)
    // so the LLM can query diffs of related but filtered-out files.
    this.injectDiffMap();
    this.args.tools.freeze();

    const totalChanged = this.diffs.length;
    const reviewCount = this.countReviewable(this.diffs);
    out(`[ocr] ${totalChanged} file(s) changed, reviewing ${reviewCount} in ${this.args.repoDir}`);

    this.diffs = this.filterDiffs(this.diffs);

    if (this.diffs.length === 0) {
      out('[ocr] No supported files changed. Skipping review.');
      this.session.finalize();
      return [];
    }

    this.currentDate = formatDate(new Date());

    const comments = await this.dispatchSubtasks(signal);
    this.session.finalize();
    return comments;
  }

  sessionID(): string {
    return this.session.sessionID;
  }

  resumeInfo(): ResumeInfo | undefined {
    return this.resumeInfoData ? { ...this.resumeInfoData } : undefined;
  }

  filesReviewed(): number {
    return this.diffs.length;
  }

  projectSummary(): string {
    return '';
  }

  warnings(): AgentWarning[] {
    return this.runner.warnings();
  }

  toolCalls(): Map<string, number> {
    return this.runner.toolCalls();
  }

  totalTokensUsed(): number {
    return this.runner.totalTokensUsed();
  }

  totalInputTokens(): number {
    return this.runner.totalInputTokens();
  }

  totalOutputTokens(): number {
    return this.runner.totalOutputTokens();
  }

  totalCacheReadTokens(): number {
    return this.runner.totalCacheReadTokens();
  }

  totalCacheWriteTokens(): number {
    return this.runner.totalCacheWriteTokens();
  }

  private injectDiffMap(): void {
    const m: Record<string, string> = {};
    for (const d of this.diffs) {
      if (d.new_path !== '/dev/null') m[d.new_path] = d.diff;
    }
    const p = this.args.tools.get(TOOL_FILE_READ_DIFF);
    if (p instanceof FileReadDiffProvider) {
      p.setDiffMap(new DiffMap(m));
    }
  }

  /** Runs the Plan + Main phases for each changed file concurrently. */
  private async dispatchSubtasks(signal?: AbortSignal): Promise<LlmComment[]> {
    // Pre-filter: discard diffs whose diff content alone exceeds 80% of MaxTokens.
    this.diffs = this.filterLargeDiffs(this.diffs);
    if (this.diffs.length === 0) {
      throw new Error('all diffs filtered out by token size');
    }
    const toDispatch = this.applyResume(this.diffs);

    const concurrency = (this.args.maxConcurrency ?? 0) > 0 ? this.args.maxConcurrency! : 8;
    const sem = new Semaphore(concurrency);
    const timeoutMs = (this.args.concurrentTaskTimeout ?? 0) * 60 * 1000;

    let dispatched = 0;
    const tasks: Array<Promise<void>> = [];

    for (const d of toDispatch) {
      if (d.is_deleted) continue;
      dispatched++;

      tasks.push(
        sem.with(async () => {
          const fingerprint = reviewItemFingerprint(this.reviewMode(), d);
          let fileSignal = signal;
          if (timeoutMs > 0) {
            const t = AbortSignal.timeout(timeoutMs);
            fileSignal = signal ? AbortSignal.any([signal, t]) : t;
          }

          try {
            const { completed, skipReason } = await this.executeSubtask(d, fileSignal);
            if (!completed) {
              if (skipReason !== '') {
                this.session.recordReviewItemFailed(d.new_path, d.old_path, d.new_path, fingerprint, skipReason);
              }
              return;
            }
            const comments = this.args.commentCollector.forPath(d.new_path);
            this.session.recordReviewItemDone(d.new_path, d.old_path, d.new_path, fingerprint, comments);
          } catch (err) {
            // Both errors and unexpected exceptions are isolated per file so
            // other files still complete (Go: error return + panic recover).
            this.subtaskFailed++;
            const msg = (err as Error).message;
            this.session.recordReviewItemFailed(d.new_path, d.old_path, d.new_path, fingerprint, msg);
            out(`[ocr] Subtask error for ${d.new_path}: ${msg}`);
            this.runner.recordWarning('subtask_error', d.new_path, msg);
          }
        }),
      );
    }

    await Promise.all(tasks);

    if (dispatched === 0) {
      return this.args.commentCollector.all();
    }

    if (this.args.commentWorkerPool) {
      await this.args.commentWorkerPool.await();
    }

    if (this.subtaskFailed > 0 && this.subtaskFailed === dispatched) {
      throw new Error(
        `all ${dispatched} file review(s) failed — check your LLM configuration and API key`,
      );
    }

    return this.args.commentCollector.all();
  }

  private applyResume(diffs: Diff[]): Diff[] {
    const resume = this.args.resume;
    if (!resume) return diffs;

    const mode = this.reviewMode();
    const toDispatch: Diff[] = [];
    let reused = 0;
    for (const d of diffs) {
      if (d.is_deleted) {
        toDispatch.push(d);
        continue;
      }
      const fingerprint = reviewItemFingerprint(mode, d);
      const item = resume.item(fingerprint);
      if (!item) {
        toDispatch.push(d);
        continue;
      }
      for (const cm of item.comments) this.args.commentCollector.add(cm);
      this.session.recordReviewItemReused(
        effectivePath(d),
        d.old_path,
        d.new_path,
        fingerprint,
        resume.sessionID,
        item.comments,
      );
      reused++;
    }

    const rerun = toDispatch.filter((d) => !d.is_deleted).length;
    this.resumeInfoData = {
      resumed_from: resume.sessionID,
      reused_files: reused,
      rerun_files: rerun,
      previous_model: resume.model || undefined,
      current_model: this.args.model || undefined,
    };
    out(`[ocr] Resume ${resume.sessionID}: reusing ${reused} file(s), reviewing ${rerun} file(s)`);
    return toDispatch;
  }

  reviewMode(): string {
    if (this.args.reviewMode) return this.args.reviewMode;
    return reviewModeString(this.args.from ?? '', this.args.to ?? '', this.args.commit ?? '');
  }

  /** Plan Phase + Main Loop for a single file. */
  private async executeSubtask(
    d: Diff,
    signal?: AbortSignal,
  ): Promise<{ completed: boolean; skipReason: string }> {
    if (signal?.aborted) throw new Error('subtask aborted');

    const newPath = d.new_path;
    const changeFilesExcludingCurrent = this.buildChangeFilesExcept(newPath);
    const rule = this.resolveSystemRule(newPath.toLowerCase());

    const threshold = this.args.template.planModeLineThreshold;
    const changeLines = d.insertions + d.deletions;

    // Phase 1: Plan (skip when changes are below threshold)
    let planResult = '';
    const planTask = this.args.template.planTask;
    if (planTask && planTask.messages.length > 0 && threshold > 0 && changeLines < threshold) {
      out(`[ocr] Skipping plan phase for ${newPath} (${changeLines} lines < threshold ${threshold})`);
    } else if (planTask && planTask.messages.length > 0) {
      try {
        planResult = await this.executePlanPhase(newPath, d.diff, changeFilesExcludingCurrent, rule, signal);
      } catch (err) {
        out(`[ocr] Plan phase failed for ${newPath}: ${(err as Error).message} (continuing without plan)`);
        planResult = '';
      }
    }

    // Phase 2: Main task loop
    if (this.args.template.mainTask.messages.length === 0) {
      throw new Error('main_task.messages is empty in template');
    }

    const messages: Message[] = this.args.template.mainTask.messages.map((m) => {
      let content = m.content;
      content = content.replaceAll('{{current_system_date_time}}', this.currentDate);
      content = content.replaceAll('{{current_file_path}}', newPath);
      content = content.replaceAll('{{system_rule}}', rule);
      content = content.replaceAll('{{change_files}}', changeFilesExcludingCurrent);
      content = content.replaceAll('{{diff}}', d.diff);
      content = content.replaceAll('{{requirement_background}}', this.args.background ?? '');
      // Strip MUST run before replaceAll: the regex requires the literal
      // {{plan_guidance}} token; replacing first would leave a dangling header.
      if (planResult === '') {
        content = stripEmptyPlanBlock(content);
      }
      content = content.replaceAll('{{plan_guidance}}', planResult);
      return newTextMessage(m.role, content);
    });

    const tokenCount = countMessagesTokens(messages);
    const maxAllowed = this.args.template.maxTokens;
    const tokenLimit = Math.trunc((maxAllowed * 4) / 5); // 80% of MaxTokens
    if (tokenCount > tokenLimit) {
      const msg = `prompt tokens (${tokenCount}) exceed 80% of max_tokens(${maxAllowed})`;
      out(`[ocr] WARNING: ${msg} for ${newPath}`);
      this.runner.recordWarning('token_threshold_exceeded', newPath, msg);
      return { completed: false, skipReason: msg };
    }

    const mainCompleted = await this.runner.runPerFile(messages, newPath, signal);

    // REVIEW_FILTER_TASK runs after the main loop; it must see comments
    // produced by the async CommentWorkerPool, so drain that first.
    if (this.args.commentWorkerPool) {
      await this.args.commentWorkerPool.await();
    }
    await this.executeReviewFilter(d, newPath, signal);

    if (!mainCompleted) {
      return { completed: false, skipReason: 'main_task did not complete before stopping' };
    }
    return { completed: true, skipReason: '' };
  }

  /**
   * Runs REVIEW_FILTER_TASK to remove comments that are provably incorrect
   * based solely on the diff. Errors are logged and silently ignored.
   */
  private async executeReviewFilter(d: Diff, newPath: string, signal?: AbortSignal): Promise<void> {
    const ft = this.args.template.reviewFilterTask;
    if (!ft || ft.messages.length === 0) return;

    const comments = this.args.commentCollector.forPath(newPath);
    if (comments.length === 0) return;

    const commentsJSON = buildFilterCommentsJSON(comments);

    const messages: Message[] = ft.messages.map((m) => {
      let content = m.content;
      content = content.replaceAll('{{path}}', newPath);
      content = content.replaceAll('{{diff}}', d.diff);
      content = content.replaceAll('{{comments}}', commentsJSON);
      return newTextMessage(m.role, content);
    });

    let effSignal = signal;
    if (ft.timeout > 0) {
      const t = AbortSignal.timeout(ft.timeout * 1000);
      effSignal = signal ? AbortSignal.any([signal, t]) : t;
    }

    const fsn = this.session.getOrCreateFileSession(newPath);
    const rec = fsn.appendTaskRecord('review_filter_task', messages);
    const startTime = Date.now();

    let resp;
    try {
      resp = await this.args.llmClient.completions(
        { model: this.args.model, messages, maxTokens: this.args.template.maxTokens },
        { signal: effSignal },
      );
    } catch (err) {
      rec.setError(err as Error, Date.now() - startTime);
      out(`[ocr] Review filter failed for ${newPath}: ${(err as Error).message}`);
      return;
    }
    rec.setResponse(resp, Date.now() - startTime);
    this.runner.recordUsage(resp.usage);

    const indices = parseFilterResponse(responseContent(resp), comments.length);
    if (indices.size === 0) return;

    this.args.commentCollector.removeByPathAndIndices(newPath, indices);
    out(`[ocr] Review filter removed ${indices.size} comment(s) for ${newPath}`);
  }

  /** Formatted list of changed files except the given path. */
  private buildChangeFilesExcept(excludePath: string): string {
    const lines: string[] = [];
    this.diffs.forEach((d, i) => {
      if (d.is_binary) return;
      if (d.new_path === excludePath || d.old_path === excludePath) return;
      let status = 'MODIFIED';
      if (d.is_new) status = 'ADDED';
      else if (d.is_deleted) status = 'DELETED';
      else if (d.old_path !== d.new_path) status = 'RENAMED';
      lines.push(status + '   ' + d.new_path + (i < this.diffs.length - 1 ? '' : ''));
    });
    return lines.join('\n');
  }

  private resolveSystemRule(p: string): string {
    return this.args.systemRule?.resolve(p) ?? '';
  }

  /** Drops diffs whose diff content alone exceeds 80% of MaxTokens. */
  private filterLargeDiffs(diffs: Diff[]): Diff[] {
    const limit = Math.trunc((this.args.template.maxTokens * 4) / 5);
    if (limit <= 0) return diffs;
    const kept: Diff[] = [];
    let skipped = 0;

    for (const d of diffs) {
      const tokens = countTokens(d.diff);
      if (tokens > limit) {
        out(
          `[ocr] Skipping ${d.new_path} (~${tokens} tokens exceeds 80% of max_tokens(${this.args.template.maxTokens}))`,
        );
        skipped++;
        continue;
      }
      kept.push(d);
    }

    if (skipped > 0) {
      out(`[ocr] Pre-filtered ${skipped} file(s) exceeding 80% of max_tokens`);
    }
    return kept;
  }

  private countReviewable(diffs: Diff[]): number {
    return diffs.filter((d) => this.shouldReview(d) && !d.is_deleted).length;
  }

  private shouldReview(d: Diff): boolean {
    return whyExcluded(d, this.args.fileFilter) === ExcludeReason.None;
  }

  private filterDiffs(diffs: Diff[]): Diff[] {
    const kept: Diff[] = [];
    let skipped = 0;

    for (const d of diffs) {
      const p = effectivePath(d);
      if (!this.shouldReview(d)) {
        if (d.is_binary) out(`[ocr] Skipping ${p} — binary file`);
        else out(`[ocr] Skipping ${p} — filtered by path/extension rules`);
        skipped++;
        continue;
      }
      kept.push(d);
    }

    if (skipped > 0) {
      out(`[ocr] Filtered ${skipped} file(s) by include/exclude rules`);
    }
    return kept;
  }

  /** Plan task for a single file: one LLM call returning free-text guidance. */
  private async executePlanPhase(
    newPath: string,
    rawDiff: string,
    changeFiles: string,
    rule: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const pt = this.args.template.planTask!;
    const messages: Message[] = pt.messages.map((m) => {
      let content = m.content;
      content = content.replaceAll('{{current_system_date_time}}', this.currentDate);
      content = content.replaceAll('{{current_file_path}}', newPath);
      content = content.replaceAll('{{system_rule}}', rule);
      content = content.replaceAll('{{change_files}}', changeFiles);
      content = content.replaceAll('{{diff}}', rawDiff);
      content = content.replaceAll('{{requirement_background}}', this.args.background ?? '');
      content = content.replaceAll('{{plan_tools}}', formatToolDefs(this.args.planToolDefs ?? []));
      return newTextMessage(m.role, content);
    });

    const fsn = this.session.getOrCreateFileSession(newPath);
    const rec = fsn.appendTaskRecord('plan_task', messages);
    const startTime = Date.now();

    let resp;
    try {
      resp = await this.args.llmClient.completions(
        { model: this.args.model, messages, maxTokens: this.args.template.maxTokens },
        { signal },
      );
    } catch (err) {
      rec.setError(err as Error, Date.now() - startTime);
      throw new Error(`plan request: ${(err as Error).message}`);
    }
    rec.setResponse(resp, Date.now() - startTime);
    this.runner.recordUsage(resp.usage);
    out(`[ocr] Plan completed for ${newPath}`);
    return responseContent(resp);
  }

  /** The Diff for the given file path, or undefined if not found. */
  findDiff(p: string): Diff | undefined {
    return this.diffs.find((d) => d.new_path === p || d.old_path === p);
  }
}

/** Serializes comments into a JSON array with generated c-N IDs. */
export function buildFilterCommentsJSON(comments: LlmComment[]): string {
  return JSON.stringify(
    comments.map((cm, i) => ({
      id: `c-${i}`,
      content: cm.content,
      ...(cm.existing_code ? { existing_code: cm.existing_code } : {}),
    })),
  );
}

/**
 * Extracts 0-based comment indices from the LLM filter response. Invalid IDs
 * or out-of-range indices are ignored.
 */
export function parseFilterResponse(raw: string, total: number): Set<number> {
  raw = stripMarkdownFences(raw);
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch (err) {
    let preview = raw;
    if (preview.length > 200) preview = preview.slice(0, 200) + '...';
    out(`[ocr] Review filter: failed to parse LLM response: ${(err as Error).message}, raw: ${preview}`);
    return new Set();
  }
  const indices = new Set<number>();
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const m = /^c-(\d+)$/.exec(id);
      if (m) {
        const idx = Number(m[1]);
        if (idx >= 0 && idx < total) indices.add(idx);
      }
    }
  }
  return indices;
}

/** Renders tool definitions as human-readable text for prompts. */
export function formatToolDefs(toolDefs: ToolDef[]): string {
  if (toolDefs.length === 0) return '';

  let sb = '### Available Tools (reference only — do not call)\n';
  for (const td of toolDefs) {
    const fn = td.function;
    sb += `- **${fn.name}**: ${fn.description}\n`;
    const params = fn.parameters['properties'];
    if (typeof params === 'object' && params !== null && Object.keys(params).length > 0) {
      sb += '  Parameters:\n';
      const required = new Set<string>(
        Array.isArray(fn.parameters['required'])
          ? (fn.parameters['required'] as unknown[]).filter((r): r is string => typeof r === 'string')
          : [],
      );
      for (const [name, p] of Object.entries(params as Record<string, unknown>)) {
        const suffix = required.has(name) ? ' (required)' : '';
        if (typeof p === 'object' && p !== null) {
          const desc = (p as Record<string, unknown>)['description'];
          sb += `  - ${name}: ${typeof desc === 'string' ? desc : ''}${suffix}\n`;
        } else {
          sb += `  - ${name}${suffix}\n`;
        }
      }
    }
  }
  return sb;
}

/** "YYYY-MM-DD HH:mm" like Go's 2006-01-02 15:04. */
function formatDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
