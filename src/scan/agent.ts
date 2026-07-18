// Full-file scan orchestrator. Port of internal/scan/agent.go + preview.go.
// Delegates the per-file LLM tool-use loop to LoopRunner; owns only
// scan-specific concerns (enumeration, FULL_SCAN rendering, batching).
import type { Diff, LlmComment, Preview, PreviewEntry, ScanItem } from '../model/index.js';
import { ExcludeReason, scanItemAsDiff } from '../model/index.js';
import type { ScanTemplate, Template } from '../config/template.js';
import type { FileFilter, RuleResolver } from '../config/rules.js';
import { isAllowedExt, isExcludedPath } from '../config/allowlist.js';
import type { LLMClient, Message, ToolDef } from '../llm/types.js';
import { newTextMessage, responseContent } from '../llm/types.js';
import { countTokens } from '../llm/tokens.js';
import type { GitRunner } from '../git/runner.js';
import { REVIEW_MODE_FULL_SCAN, SessionHistory } from '../session/history.js';
import { CommentCollector } from '../tools/collector.js';
import { ToolRegistry, TOOL_FILE_READ_DIFF } from '../tools/registry.js';
import { DiffMap, FileReadDiffProvider } from '../tools/fileReadDiff.js';
import type { AgentWarning, CommentWorkerPool } from '../loop/pool.js';
import { LoopRunner } from '../loop/runner.js';
import { countMessagesTokens, stripMarkdownFences } from '../loop/compression.js';
import { ScanProvider } from './provider.js';
import { groupBatches, parseBatchStrategy, type BatchStrategy } from './batch.js';
import { estimateCost, estimateFileTokens, estimateString, humanTokens } from './estimate.js';
import { out } from '../util/logger.js';
import { Semaphore } from '../util/semaphore.js';

// Substitutes for {{change_files}}: full-scan has no "other changed files".
const CHANGE_FILES_SCAN_LITERAL = '(not applicable in full-scan mode)';

/** All dependencies for one scan session. */
export interface ScanArgs {
  repoDir: string;
  paths: string[]; // empty = whole repo
  template: ScanTemplate;
  systemRule?: RuleResolver;
  fileFilter?: FileFilter;
  llmClient?: LLMClient;
  tools?: ToolRegistry;
  mainToolDefs?: ToolDef[];
  commentCollector?: CommentCollector;
  commentWorkerPool?: CommentWorkerPool;
  maxConcurrency?: number;
  concurrentTaskTimeout?: number;
  model?: string;
  background?: string;
  gitRunner?: GitRunner;
  session?: SessionHistory;
  maxFileSizeBytes?: number;
  skipPlan?: boolean;
  skipDedup?: boolean;
  skipSummary?: boolean;
  /** Caps total token usage (input+output); 0 = unlimited. */
  maxTokensBudget?: number;
}

/**
 * Maps the scan-specific template onto the subset of fields LoopRunner
 * reads (MaxTokens / MaxToolRequestTimes / MemoryCompressionTask /
 * ReLocationTask); diff-only fields stay empty.
 */
function toLoopTemplate(s: ScanTemplate): Template {
  return {
    mainTask: { timeout: 0, messages: [] },
    memoryCompressionTask: s.memoryCompressionTask,
    maxTokens: s.maxTokens,
    maxToolRequestTimes: s.maxToolRequestTimes,
    planModeLineThreshold: 0,
    reLocationTask: s.reLocationTask,
  };
}

export class ScanAgent {
  readonly args: ScanArgs & Required<Pick<ScanArgs, 'tools' | 'commentCollector'>>;
  private items: ScanItem[] = [];
  private currentDate = '';
  readonly session: SessionHistory;
  private subtaskFailed = 0;
  readonly runner: LoopRunner;
  private projectSummaryText = '';

  constructor(args: ScanArgs) {
    const tools = args.tools ?? new ToolRegistry();
    const commentCollector = args.commentCollector ?? new CommentCollector();
    const session =
      args.session ??
      new SessionHistory(args.repoDir, '', args.model ?? '', { reviewMode: REVIEW_MODE_FULL_SCAN });
    this.args = { ...args, tools, commentCollector };
    this.session = session;
    this.runner = new LoopRunner({
      llmClient: args.llmClient ?? (undefined as unknown as LLMClient),
      model: args.model ?? '',
      template: toLoopTemplate(args.template),
      tools,
      mainToolDefs: args.mainToolDefs ?? [],
      commentCollector,
      commentWorkerPool: args.commentWorkerPool,
      session,
      // Synthetic Diff so code_comment line resolution matches against the
      // full file content of the scanned file.
      diffLookup: (p) => this.lookupDiff(p),
    });
  }

  private planEnabled(): boolean {
    return (
      !this.args.skipPlan &&
      this.args.template.planTask !== undefined &&
      this.args.template.planTask.messages.length > 0
    );
  }

  private dedupEnabled(): boolean {
    return (
      !this.args.skipDedup &&
      this.args.template.dedupTask !== undefined &&
      this.args.template.dedupTask.messages.length > 0
    );
  }

  private summaryEnabled(): boolean {
    return (
      !this.args.skipSummary &&
      this.args.template.projectSummaryTask !== undefined &&
      this.args.template.projectSummaryTask.messages.length > 0
    );
  }

  projectSummary(): string {
    return this.projectSummaryText;
  }

  sessionID(): string {
    return this.session.sessionID;
  }

  filesReviewed(): number {
    return this.items.length;
  }

  /** Scanned items adapted to Diff form (uniform output/line-resolution). */
  get diffs(): Diff[] {
    return this.items.map((it) => scanItemAsDiff(it));
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

  warnings(): AgentWarning[] {
    return this.runner.warnings();
  }

  toolCalls(): Map<string, number> {
    return this.runner.toolCalls();
  }

  /** Enumerate → filter → token-filter → dispatch per file → comments. */
  async run(signal?: AbortSignal): Promise<LlmComment[]> {
    if (this.args.template.mainTask.messages.length === 0) {
      throw new Error('scan template MAIN_TASK is missing or empty');
    }

    const provider = new ScanProvider(
      this.args.repoDir,
      this.args.paths,
      this.args.gitRunner,
      this.args.maxFileSizeBytes ?? 0,
    );
    let items: ScanItem[];
    try {
      items = await provider.enumerate(signal);
    } catch (err) {
      throw new Error(`enumerate files: ${(err as Error).message}`);
    }

    this.items = items;
    this.injectScanContentMap();
    this.args.tools.freeze();

    const totalDiscovered = this.items.length;
    this.items = this.filterScanItems(this.items);
    this.items = this.filterLargeScans(this.items);

    const reviewable = this.items.length;
    out(`[ocr] full-scan: ${totalDiscovered} file(s) discovered, reviewing ${reviewable} in ${this.args.repoDir}`);

    if (reviewable === 0) {
      out('[ocr] No reviewable files. Skipping scan.');
      this.session.finalize();
      return [];
    }

    // Pre-run cost projection so users aren't surprised by a large scan.
    const est = estimateCost(this.items, this.planEnabled(), this.dedupEnabled(), this.summaryEnabled());
    out(`[ocr] estimated cost: ${estimateString(est)}`);
    const budget = this.args.maxTokensBudget ?? 0;
    if (budget > 0) {
      out(`[ocr] token budget: ${humanTokens(budget)} (dispatch stops once exceeded)`);
      if (est.totalTokens > budget) {
        out(
          `[ocr] WARNING: estimate (${humanTokens(est.totalTokens)}) exceeds budget (${humanTokens(budget)}); scan will stop partway`,
        );
      }
    }

    this.currentDate = formatDate(new Date());

    // Mirror Go: even when dispatch fails, the summary hook (no-op without
    // comments) and Finalize still run so the session gets session_end.
    let comments: LlmComment[] = [];
    let dispatchErr: Error | undefined;
    try {
      comments = await this.dispatchSubtasks(signal);
    } catch (err) {
      dispatchErr = err as Error;
    }

    // Project-level summary runs after all batches; never blocks return.
    await this.maybeRunProjectSummary(comments, signal);

    this.session.finalize();
    if (dispatchErr) throw dispatchErr;
    return comments;
  }

  /** Read-only enumeration + reviewability filter, no LLM calls. */
  async preview(signal?: AbortSignal): Promise<Preview> {
    const provider = new ScanProvider(
      this.args.repoDir,
      this.args.paths,
      this.args.gitRunner,
      this.args.maxFileSizeBytes ?? 0,
    );
    let items: ScanItem[];
    try {
      items = await provider.enumerate(signal);
    } catch (err) {
      throw new Error(`enumerate files: ${(err as Error).message}`);
    }

    const result: Preview = {
      files: [],
      total_insertions: 0,
      total_deletions: 0,
      total_files: items.length,
      reviewable_count: 0,
      excluded_count: 0,
    };

    for (const it of items) {
      const entry: PreviewEntry = {
        path: it.path,
        status: 'scan',
        insertions: it.line_count ?? 0,
        deletions: 0,
        will_review: false,
      };
      const reason = this.whyExcluded(it);
      entry.will_review = reason === ExcludeReason.None;
      entry.exclude_reason = reason;
      if (entry.will_review) {
        result.reviewable_count++;
        result.total_insertions += entry.insertions;
      } else {
        result.excluded_count++;
      }
      result.files.push(entry);
    }
    return result;
  }

  private lookupDiff(p: string): Diff | undefined {
    const it = this.items.find((i) => i.path === p);
    return it ? scanItemAsDiff(it) : undefined;
  }

  /**
   * Fills the file_read_diff tool's DiffMap with full file content keyed by
   * path, so a model call returns the whole file rather than failing.
   */
  private injectScanContentMap(): void {
    const m: Record<string, string> = {};
    for (const it of this.items) {
      if (it.path !== '') m[it.path] = it.content;
    }
    const p = this.args.tools.get(TOOL_FILE_READ_DIFF);
    if (p instanceof FileReadDiffProvider) {
      p.setDiffMap(new DiffMap(m));
    }
  }

  private filterScanItems(items: ScanItem[]): ScanItem[] {
    const kept: ScanItem[] = [];
    let skipped = 0;
    for (const it of items) {
      if (this.whyExcluded(it) !== ExcludeReason.None) {
        if (it.is_binary) out(`[ocr] Skipping ${it.path} — binary file`);
        else out(`[ocr] Skipping ${it.path} — filtered by path/extension rules`);
        skipped++;
        continue;
      }
      kept.push(it);
    }
    if (skipped > 0) out(`[ocr] Filtered ${skipped} file(s) by include/exclude rules`);
    return kept;
  }

  private filterLargeScans(items: ScanItem[]): ScanItem[] {
    const limit = Math.trunc((this.args.template.maxTokens * 4) / 5);
    if (limit <= 0) return items;
    const kept: ScanItem[] = [];
    let skipped = 0;
    for (const it of items) {
      const tokens = countTokens(it.content);
      if (tokens > limit) {
        out(`[ocr] Skipping ${it.path} (~${tokens} tokens exceeds 80% of max_tokens(${this.args.template.maxTokens}))`);
        skipped++;
        continue;
      }
      kept.push(it);
    }
    if (skipped > 0) out(`[ocr] Pre-filtered ${skipped} file(s) exceeding 80% of max_tokens`);
    return kept;
  }

  /** Mirrors agent.whyExcluded but for ScanItem inputs. */
  whyExcluded(it: ScanItem): ExcludeReason {
    if (it.is_binary) return ExcludeReason.Binary;
    const p = it.path;
    const f = this.args.fileFilter;
    if (f && f.isUserExcluded(p)) return ExcludeReason.UserRule;
    const ext = extFromPath(p);
    if (ext !== '' && !isAllowedExt(ext)) return ExcludeReason.Extension;
    if (f && f.hasInclude() && f.isUserIncluded(p)) return ExcludeReason.None;
    if (isExcludedPath(p)) return ExcludeReason.DefaultPath;
    return ExcludeReason.None;
  }

  /**
   * Groups items into batches, processes batches sequentially with files
   * inside each batch running concurrently up to maxConcurrency.
   */
  private async dispatchSubtasks(signal?: AbortSignal): Promise<LlmComment[]> {
    if (this.items.length === 0) return [];

    this.subtaskFailed = 0;

    const strategy = this.resolveBatchStrategy();
    const batches = groupBatches(this.items, strategy, this.args.template.batchSize);
    out(`[ocr] scan dispatch: ${batches.length} batch(es) by ${strategy} strategy`);

    let dispatched = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      if (signal?.aborted) return this.args.commentCollector.all();
      // Snapshot so we can isolate this batch's comments for dedup.
      const batchStart = this.args.commentCollector.snapshot();

      const { dispatched: n, budgetHit } = await this.dispatchBatch(bi, batches[bi]!, signal);
      dispatched += n;

      // Drain async comment workers BEFORE dedup so all of this batch's
      // comments are visible (batches are sequential, so cumulative await is fine).
      if (this.args.commentWorkerPool) {
        await this.args.commentWorkerPool.await();
      }

      await this.maybeRunDedup(bi, batchStart, signal);

      if (budgetHit) break;
    }

    if (this.subtaskFailed > 0 && this.subtaskFailed === dispatched) {
      throw new Error(`all ${dispatched} file scan(s) failed — check your LLM configuration and API key`);
    }
    return this.args.commentCollector.all();
  }

  private resolveBatchStrategy(): BatchStrategy {
    return parseBatchStrategy(this.args.template.batchStrategy);
  }

  /**
   * Fans out one batch's files concurrently with a per-file budget
   * look-ahead: if tokens spent plus this file's estimate would exceed the
   * budget, the file and the rest of the batch are skipped.
   */
  private async dispatchBatch(
    batchIdx: number,
    batch: ScanItem[],
    signal?: AbortSignal,
  ): Promise<{ dispatched: number; budgetHit: boolean }> {
    const concurrency = (this.args.maxConcurrency ?? 0) > 0 ? this.args.maxConcurrency! : 8;
    const sem = new Semaphore(concurrency);
    const timeoutMs = (this.args.concurrentTaskTimeout ?? 0) * 60 * 1000;
    const budget = this.args.maxTokensBudget ?? 0;

    let dispatched = 0;
    let budgetHit = false;
    const tasks: Array<Promise<void>> = [];

    for (const it of batch) {
      if (budget > 0) {
        const used = this.runner.totalTokensUsed();
        const projected = used + estimateFileTokens(it, this.planEnabled());
        if (projected > budget) {
          out(
            `[ocr] token budget reached (used ${humanTokens(used)} + next-file est ≈ ${humanTokens(projected)} > budget ${humanTokens(budget)}) — skipping ${it.path} and remaining files`,
          );
          this.runner.recordWarning(
            'token_budget_reached',
            it.path,
            `stopped in batch #${batchIdx}: used ${used} tokens + next-file estimate exceeds budget ${budget}`,
          );
          budgetHit = true;
          break;
        }
      }

      if (signal?.aborted) break;

      dispatched++;
      tasks.push(
        sem.with(async () => {
          let fileSignal = signal;
          if (timeoutMs > 0) {
            const t = AbortSignal.timeout(timeoutMs);
            fileSignal = signal ? AbortSignal.any([signal, t]) : t;
          }
          try {
            await this.executeSubtask(it, fileSignal);
          } catch (err) {
            this.subtaskFailed++;
            out(`[ocr] Scan subtask error for ${it.path} (batch #${batchIdx}): ${(err as Error).message}`);
            this.runner.recordWarning('scan_subtask_error', it.path, (err as Error).message);
          }
        }),
      );
    }

    await Promise.all(tasks);
    return { dispatched, budgetHit };
  }

  /** Optional PLAN_TASK, then MAIN_TASK through the shared loop. */
  private async executeSubtask(it: ScanItem, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('scan subtask aborted');

    const rule = this.args.systemRule?.resolve(it.path.toLowerCase()) ?? '';

    const planGuidance = await this.maybeRunPlan(it, rule, signal);

    const messages = this.renderMessages(it, rule, planGuidance);

    const tokenCount = countMessagesTokens(messages);
    const maxAllowed = this.args.template.maxTokens;
    const tokenLimit = Math.trunc((maxAllowed * 4) / 5);
    if (tokenCount > tokenLimit) {
      const msg = `prompt tokens (${tokenCount}) exceed 80% of max_tokens(${maxAllowed})`;
      out(`[ocr] WARNING: ${msg} for ${it.path}`);
      this.runner.recordWarning('token_threshold_exceeded', it.path, msg);
      return;
    }

    await this.runner.runPerFile(messages, it.path, signal);
  }

  /**
   * Invokes PLAN_TASK, returning guidance for {{plan_guidance}}. On any
   * failure returns a non-empty "no plan" sentinel so the surrounding
   * section header in MAIN_TASK doesn't dangle.
   */
  private async maybeRunPlan(it: ScanItem, rule: string, signal?: AbortSignal): Promise<string> {
    const noPlan = '(no pre-scan plan; review the entire file as usual)';

    if (!this.planEnabled()) return noPlan;
    const pt = this.args.template.planTask!;

    const messages: Message[] = pt.messages.map((m) => {
      let content = m.content;
      content = content.replaceAll('{{current_system_date_time}}', this.currentDate);
      content = content.replaceAll('{{current_file_path}}', it.path);
      content = content.replaceAll('{{system_rule}}', rule);
      content = content.replaceAll('{{file_content}}', it.content);
      return newTextMessage(m.role, content);
    });

    const fsn = this.session.getOrCreateFileSession(it.path);
    const rec = fsn.appendTaskRecord('plan_task', messages);
    const startTime = Date.now();

    let resp;
    try {
      resp = await this.args.llmClient!.completions(
        { model: this.args.model ?? '', messages, maxTokens: this.args.template.maxTokens },
        { signal },
      );
    } catch (err) {
      rec.setError(err as Error, Date.now() - startTime);
      out(`[ocr] scan plan failed for ${it.path}: ${(err as Error).message} (falling back to plan-less)`);
      return noPlan;
    }
    rec.setResponse(resp, Date.now() - startTime);
    this.runner.recordUsage(resp.usage);

    const guidance = formatPlanGuidance(responseContent(resp));
    return guidance === '' ? noPlan : guidance;
  }

  /** Best-effort PROJECT_SUMMARY_TASK over all collected comments. */
  private async maybeRunProjectSummary(comments: LlmComment[], signal?: AbortSignal): Promise<void> {
    if (!this.summaryEnabled()) return;
    const pt = this.args.template.projectSummaryTask!;
    if (comments.length === 0) return;

    const fileSet = new Set(comments.map((c) => c.path));
    const payload = buildSummaryCommentsList(comments);

    const messages: Message[] = pt.messages.map((m) => {
      let content = m.content;
      content = content.replaceAll('{{comment_count}}', String(comments.length));
      content = content.replaceAll('{{file_count}}', String(fileSet.size));
      content = content.replaceAll('{{all_comments}}', payload);
      return newTextMessage(m.role, content);
    });

    const pathKey = '__scan_project_summary__';
    const fsn = this.session.getOrCreateFileSession(pathKey);
    // Reuse existing task type; no scan-specific type to invent.
    const rec = fsn.appendTaskRecord('memory_compression_task', messages);
    const startTime = Date.now();

    let resp;
    try {
      resp = await this.args.llmClient!.completions(
        { model: this.args.model ?? '', messages, maxTokens: this.args.template.maxTokens },
        { signal },
      );
    } catch (err) {
      rec.setError(err as Error, Date.now() - startTime);
      out(`[ocr] scan project summary failed: ${(err as Error).message}`);
      return;
    }
    rec.setResponse(resp, Date.now() - startTime);
    this.runner.recordUsage(resp.usage);

    const body = stripMarkdownFences(responseContent(resp)).trim();
    if (body === '') return;
    this.projectSummaryText = body;
  }

  /**
   * Per-batch DEDUP_TASK: merges near-duplicate findings. Best-effort — on
   * any failure the original batch comments are kept unchanged.
   */
  private async maybeRunDedup(batchIdx: number, batchStart: number, signal?: AbortSignal): Promise<void> {
    if (!this.dedupEnabled()) return;
    const dt = this.args.template.dedupTask!;
    let minN = this.args.template.dedupMinComments;
    if (minN <= 0) minN = 2;

    const batchComments = this.args.commentCollector.since(batchStart);
    if (batchComments.length < minN) return;

    const payload = buildDedupCommentsJSON(batchComments);
    const messages: Message[] = dt.messages.map((m) =>
      newTextMessage(m.role, m.content.replaceAll('{{batch_comments}}', payload)),
    );

    // Synthetic file path keyed by batch index keeps dedup records distinct
    // from per-file plan/main records in session JSONL.
    const pathKey = `__scan_dedup_batch_${batchIdx}__`;
    const fsn = this.session.getOrCreateFileSession(pathKey);
    const rec = fsn.appendTaskRecord('memory_compression_task', messages);
    const startTime = Date.now();

    let resp;
    try {
      resp = await this.args.llmClient!.completions(
        { model: this.args.model ?? '', messages, maxTokens: this.args.template.maxTokens },
        { signal },
      );
    } catch (err) {
      rec.setError(err as Error, Date.now() - startTime);
      out(`[ocr] scan dedup failed for batch #${batchIdx}: ${(err as Error).message} (keeping originals)`);
      return;
    }
    rec.setResponse(resp, Date.now() - startTime);
    this.runner.recordUsage(resp.usage);

    const deduped = applyDedupGroups(responseContent(resp), batchComments);
    if (!deduped) {
      out(`[ocr] scan dedup batch #${batchIdx}: malformed groups, keeping originals`);
      return;
    }
    if (deduped.length === batchComments.length) return; // no-op
    this.args.commentCollector.replaceSince(batchStart, deduped);
    out(`[ocr] scan dedup batch #${batchIdx}: ${batchComments.length} → ${deduped.length} comments`);
  }

  /** Substitutes placeholders in the scan MAIN_TASK for one item. */
  private renderMessages(it: ScanItem, rule: string, planGuidance: string): Message[] {
    return this.args.template.mainTask.messages.map((m) => {
      let content = m.content;
      content = content.replaceAll('{{plan_guidance}}', planGuidance);
      content = content.replaceAll('{{current_system_date_time}}', this.currentDate);
      content = content.replaceAll('{{current_file_path}}', it.path);
      content = content.replaceAll('{{system_rule}}', rule);
      content = content.replaceAll('{{change_files}}', CHANGE_FILES_SCAN_LITERAL);
      content = content.replaceAll('{{file_content}}', it.content);
      content = content.replaceAll('{{requirement_background}}', this.args.background ?? '');
      return newTextMessage(m.role, content);
    });
  }
}

function extFromPath(p: string): string {
  const idx = p.lastIndexOf('/');
  const basename = idx >= 0 ? p.slice(idx + 1) : p;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return '';
  return basename.slice(dot).toLowerCase();
}

/** "- `path`: <one-line content (≤280 chars)>" list for PROJECT_SUMMARY. */
export function buildSummaryCommentsList(comments: LlmComment[]): string {
  const maxLine = 280;
  let sb = '';
  for (const c of comments) {
    let oneLine = c.content.replaceAll('\n', ' ');
    if (oneLine.length > maxLine) oneLine = oneLine.slice(0, maxLine) + '...';
    sb += `- \`${c.path}\`: ${oneLine}\n`;
  }
  return sb;
}

/** JSON list with stable c-N ids for the DEDUP_TASK prompt. */
export function buildDedupCommentsJSON(comments: LlmComment[]): string {
  return JSON.stringify(
    comments.map((cm, i) => ({
      id: `c-${i}`,
      path: cm.path,
      content: cm.content,
      ...(cm.existing_code ? { existing_code: cm.existing_code } : {}),
    })),
  );
}

/**
 * Parses DEDUP_TASK output into the deduped comment slice. Returns undefined
 * when the response is malformed OR the groups don't cover every input id
 * exactly once (never silently drop unaccounted comments).
 */
export function applyDedupGroups(
  rawJSON: string,
  originals: LlmComment[],
): LlmComment[] | undefined {
  const stripped = stripMarkdownFences(rawJSON).trim();
  if (stripped === '') return undefined;

  interface Parsed {
    groups?: Array<{ members?: string[]; merged_content?: string }>;
  }
  let parsed: Parsed;
  try {
    parsed = JSON.parse(stripped) as Parsed;
  } catch {
    return undefined;
  }

  const idToIdx = new Map<string, number>();
  originals.forEach((_, i) => idToIdx.set(`c-${i}`, i));

  const seen = new Set<string>();
  const outList: LlmComment[] = [];
  for (const g of parsed.groups ?? []) {
    const members = g.members ?? [];
    if (members.length === 0) return undefined;
    const canonicalIdx = idToIdx.get(members[0]!);
    if (canonicalIdx === undefined) return undefined;
    for (const id of members) {
      if (!idToIdx.has(id)) return undefined; // unknown id
      if (seen.has(id)) return undefined; // duplicate assignment
      seen.add(id);
    }
    const canonical = { ...originals[canonicalIdx]! };
    if (members.length > 1 && g.merged_content) {
      canonical.content = g.merged_content;
    }
    outList.push(canonical);
  }

  if (seen.size !== originals.length) return undefined; // some id missing
  return outList;
}

/**
 * Parses PLAN_TASK JSON output into a markdown snippet. On parse failure
 * returns the raw content (better than nothing when the LLM said something
 * useful in the wrong shape).
 */
export function formatPlanGuidance(raw: string): string {
  const stripped = stripMarkdownFences(raw).trim();
  if (stripped === '') return '';

  interface Plan {
    summary?: string;
    checkpoints?: Array<{ focus?: string; lines?: string; why?: string }>;
  }
  let plan: Plan;
  try {
    plan = JSON.parse(stripped) as Plan;
  } catch {
    return stripped;
  }

  let sb = '';
  if (plan.summary) {
    sb += `**Summary**: ${plan.summary}\n\n`;
  }
  const checkpoints = plan.checkpoints ?? [];
  if (checkpoints.length === 0) {
    return sb.replace(/\n+$/, '');
  }
  sb += '**Focus areas (give these extra attention; not exhaustive):**\n';
  checkpoints.forEach((cp, i) => {
    sb += `${i + 1}. \`${cp.focus ?? ''}\``;
    if (cp.lines) sb += ` (lines ${cp.lines})`;
    if (cp.why) sb += ` — ${cp.why}`;
    sb += '\n';
  });
  return sb.replace(/\n+$/, '');
}

function formatDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
