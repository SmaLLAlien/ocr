// Per-file LLM tool-use loop shared by review and scan. Port of
// internal/llmloop/loop.go + the Runner-side compression orchestration from
// compression.go.
import type { Diff, LlmComment } from '../model/index.js';
import type { Template } from '../config/template.js';
import type {
  ChatResponse,
  LLMClient,
  Message,
  ToolCall,
  ToolDef,
  UsageInfo,
} from '../llm/types.js';
import {
  newTextMessage,
  newToolCallMessage,
  newToolResultMessage,
  responseContent,
  responseToolCalls,
} from '../llm/types.js';
import type { SessionHistory, TaskRecord } from '../session/history.js';
import type { CommentCollector } from '../tools/collector.js';
import type { ToolRegistry, TaskCheckpoint, ToolCallResult } from '../tools/registry.js';
import {
  COMMENT_SUCCEED,
  TOOL_CODE_COMMENT,
  TOOL_NOT_FOUND_MSG,
  TOOL_TASK_DONE,
  checkpointComplete,
  checkpointOf,
  isReserved,
} from '../tools/registry.js';
import { parseComments } from '../tools/codeComment.js';
import { resolveComment } from '../diff/resolver.js';
import { reLocateComment } from '../diff/relocation.js';
import {
  TOKEN_SOFT_THRESHOLD,
  TOKEN_WARNING_THRESHOLD,
  buildMessageXML,
  countMessagesTokens,
  partitionMessages,
  rebuildWithSummary,
  stripMarkdownFences,
} from './compression.js';
import type { AgentWarning, CommentWorkerPool } from './pool.js';
import { out, printToolCallError, printToolCallFinished, printToolCallStarted } from '../util/logger.js';

export interface RunnerDeps {
  llmClient: LLMClient;
  model: string;
  template: Template;
  tools: ToolRegistry;
  mainToolDefs: ToolDef[];
  commentCollector: CommentCollector;
  commentWorkerPool?: CommentWorkerPool;
  session: SessionHistory;
  /**
   * Consulted by the code_comment path to resolve line numbers against the
   * file's diff (scan mode returns a synthetic Diff whose new_file_content
   * is the whole file and diff is empty).
   */
  diffLookup?: (path: string) => Diff | undefined;
}

interface CompressionJob {
  promise: Promise<Message[] | undefined>;
  settled: boolean;
  rebuilt?: Message[];
  cancelled: boolean;
  snapshotLen: number;
}

/**
 * Per-session (across files) executor of the LLM tool-use loop. Token
 * counters, warnings, and the optional background compression job are
 * aggregated across every runPerFile call.
 */
export class LoopRunner {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private readonly warningsList: AgentWarning[] = [];
  private readonly toolCallCounts = new Map<string, number>();
  private pendingJob: CompressionJob | undefined;

  constructor(private readonly deps: RunnerDeps) {}

  totalInputTokens(): number {
    return this.inputTokens;
  }

  totalOutputTokens(): number {
    return this.outputTokens;
  }

  totalCacheReadTokens(): number {
    return this.cacheReadTokens;
  }

  totalCacheWriteTokens(): number {
    return this.cacheWriteTokens;
  }

  totalTokensUsed(): number {
    return this.inputTokens + this.outputTokens;
  }

  warnings(): AgentWarning[] {
    return [...this.warningsList];
  }

  recordWarning(warningType: string, file: string, message: string): void {
    this.warningsList.push({ file, message, type: warningType });
  }

  toolCalls(): Map<string, number> {
    return new Map(this.toolCallCounts);
  }

  private recordToolCall(name: string): void {
    this.toolCallCounts.set(name, (this.toolCallCounts.get(name) ?? 0) + 1);
  }

  /** Adds usage from an LLM call made outside runPerFile (plan phase etc.). */
  recordUsage(u: UsageInfo | undefined): void {
    if (!u) return;
    this.inputTokens += u.prompt_tokens;
    this.outputTokens += u.completion_tokens;
    this.cacheReadTokens += u.cache_read_tokens ?? 0;
    this.cacheWriteTokens += u.cache_write_tokens ?? 0;
  }

  /** Awaits async comment workers and returns the aggregated comments. */
  async collectPendingComments(): Promise<LlmComment[]> {
    if (this.deps.commentWorkerPool) {
      await this.deps.commentWorkerPool.await();
    }
    return this.deps.commentCollector.all();
  }

  /**
   * Drives the main LLM conversation loop for a single file until task_done
   * is called or limits are reached. Returns true only when the model
   * explicitly called task_done.
   */
  async runPerFile(messages: Message[], newPath: string, signal?: AbortSignal): Promise<boolean> {
    let toolReqCount = this.deps.template.maxToolRequestTimes;
    const maxConsecutiveEmptyRounds = 3;
    let consecutiveEmptyRounds = 0;

    while (toolReqCount > 0) {
      if (signal?.aborted) throw abortReason(signal);

      toolReqCount--;

      const fsn = this.deps.session.getOrCreateFileSession(newPath);
      const rec = fsn.appendTaskRecord('main_task', [...messages]);
      const startTime = Date.now();

      let resp: ChatResponse;
      try {
        resp = await this.deps.llmClient.completions(
          {
            model: this.deps.model,
            messages,
            tools: this.deps.mainToolDefs,
            maxTokens: this.deps.template.maxTokens,
          },
          { signal },
        );
      } catch (err) {
        rec.setError(err as Error, Date.now() - startTime);
        throw new Error(`LLM completion error: ${(err as Error).message}`);
      }
      rec.setResponse(resp, Date.now() - startTime);
      if (resp.usage) {
        this.inputTokens += resp.usage.prompt_tokens;
        this.outputTokens += resp.usage.completion_tokens;
        this.cacheReadTokens += resp.usage.cache_read_tokens ?? 0;
        this.cacheWriteTokens += resp.usage.cache_write_tokens ?? 0;
      }

      const content = responseContent(resp);
      const calls = responseToolCalls(resp);

      if (calls.length === 0) {
        out(`[ocr] No tool calls parsed for ${newPath}, retrying...`);
        const corrective = newTextMessage(
          'user',
          'You did not successfully call any tools. Please try again or use task_done if finished.',
        );
        if (content !== '') {
          messages.push(newTextMessage('assistant', content), corrective);
        } else {
          messages.push(corrective);
        }
        continue;
      }

      const results: ToolCallResult[] = [];
      let taskCompleted = false;
      let hasValidResult = false;

      for (const call of calls) {
        const cp = await this.executeToolCall(newPath, call, rec, signal);
        if (cp.completed) {
          results.push({
            toolCallID: call.id,
            name: call.function.name,
            result: 'Task completed successfully.',
          });
          taskCompleted = true;
        } else if (cp.data !== '') {
          results.push({ toolCallID: call.id, name: call.function.name, result: cp.data });
          hasValidResult = true;
        } else {
          results.push({
            toolCallID: call.id,
            name: call.function.name,
            result: 'Error: Tool execution returned no result.',
          });
        }
      }

      if (taskCompleted) return true;
      if (!hasValidResult) {
        consecutiveEmptyRounds++;
        if (consecutiveEmptyRounds >= maxConsecutiveEmptyRounds) {
          out(`[ocr] Too many empty retries for ${newPath}, stopping.`);
          break;
        }
        out(`[ocr] No valid tool results for ${newPath}, retrying...`);
      } else {
        consecutiveEmptyRounds = 0;
      }

      const next = await this.addNextMessage(content, calls, results, messages, newPath, signal);
      messages = next.messages;
      if (!next.ok) {
        out(`[ocr] Context compression exceeded threshold for ${newPath}, stopping.`);
        break;
      }
    }

    if (toolReqCount <= 0) {
      out(`[ocr] Max tool requests reached for ${newPath}.`);
    }
    return false;
  }

  /**
   * Dispatches a single tool call. code_comment includes optional async
   * dispatch through CommentWorkerPool plus line-number resolution /
   * re-location; unknown names fall through to MCP-registered tools.
   */
  private async executeToolCall(
    newPath: string,
    call: ToolCall,
    rec: TaskRecord | undefined,
    signal?: AbortSignal,
  ): Promise<TaskCheckpoint> {
    const name = call.function.name;

    if (!isReserved(name)) {
      const p = this.deps.tools.get(name);
      if (!p) return checkpointOf(TOOL_NOT_FOUND_MSG);
      this.recordToolCall(name);
      let dynArgs: Record<string, unknown>;
      try {
        dynArgs = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch (err) {
        return checkpointOf(`Error parsing tool arguments for ${name}: ${(err as Error).message}`);
      }
      printToolCallStarted(name, dynArgs);
      const startTime = Date.now();
      let result: string;
      try {
        result = await p.execute(dynArgs, signal);
      } catch (err) {
        printToolCallError(name, err as Error);
        return checkpointOf(`Error executing tool ${name}: ${(err as Error).message}`);
      }
      printToolCallFinished(name, Date.now() - startTime);
      rec?.addToolResult(name, call.function.arguments, result);
      return checkpointOf(result);
    }

    if (name === TOOL_TASK_DONE) {
      return checkpointComplete();
    }

    const p = this.deps.tools.get(name);
    if (!p) return checkpointOf(TOOL_NOT_FOUND_MSG);

    this.recordToolCall(name);

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch (err) {
      return checkpointOf(`Error parsing tool arguments for ${name}: ${(err as Error).message}`);
    }

    // Always inject the current file path for code_comment: the model
    // sometimes hallucinates a path, so we override it.
    if (name === TOOL_CODE_COMMENT && newPath !== '') {
      args['path'] = newPath;
    }

    const startTime = Date.now();

    if (name === TOOL_CODE_COMMENT) {
      printToolCallStarted(name, args);

      const { comments, errMsg } = parseComments(args);
      if (errMsg !== '') return checkpointOf(errMsg);

      const resolveAndCollect = async (rsignal?: AbortSignal): Promise<void> => {
        for (const cm of comments) {
          const d = this.deps.diffLookup?.(cm.path);
          if (d) {
            if (!resolveComment(cm, d) && this.deps.template.reLocationTask) {
              const rlStart = Date.now();
              const rl = await reLocateComment(
                cm,
                d,
                this.deps.llmClient,
                this.deps.template.reLocationTask,
                this.deps.model,
                this.deps.template.maxTokens,
                rsignal,
              );
              if (rl.messages) {
                const fsn = this.deps.session.getOrCreateFileSession(cm.path);
                const rlRec = fsn.appendTaskRecord('re_location_task', rl.messages);
                if (rl.response) {
                  rlRec.setResponse(rl.response, Date.now() - rlStart);
                  this.recordUsage(rl.response.usage);
                } else {
                  rlRec.setError(new Error('re-location LLM call failed'), Date.now() - rlStart);
                }
              }
            }
          }
          this.deps.commentCollector.add(cm);
        }
      };

      if (this.deps.commentWorkerPool) {
        rec?.addToolResult(name, call.function.arguments, '(async)');
        // Async path is detached from the per-file signal (Go uses
        // context.WithoutCancel).
        this.deps.commentWorkerPool.submit(async () => {
          await resolveAndCollect(undefined);
          printToolCallFinished(name, Date.now() - startTime);
          return [];
        });
        return checkpointOf(COMMENT_SUCCEED);
      }

      await resolveAndCollect(signal);
      printToolCallFinished(name, Date.now() - startTime);
      rec?.addToolResult(name, call.function.arguments, COMMENT_SUCCEED);
      return checkpointOf(COMMENT_SUCCEED);
    }

    // Synchronous path for all other tools
    printToolCallStarted(name, args);
    let result: string;
    try {
      result = await p.execute(args, signal);
    } catch (err) {
      printToolCallError(name, err as Error);
      return checkpointOf(`Error executing tool ${name}: ${(err as Error).message}`);
    }
    printToolCallFinished(name, Date.now() - startTime);
    rec?.addToolResult(name, call.function.arguments, result);
    return checkpointOf(result);
  }

  /**
   * Extends the conversation with the assistant message and tool responses,
   * applying three-zone compression at the soft (60%) and warning (80%)
   * thresholds. ok=false when even after synchronous compression the
   * conversation is still over the warning threshold.
   */
  private async addNextMessage(
    assistantContent: string,
    toolCalls: ToolCall[],
    results: ToolCallResult[],
    messages: Message[],
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ messages: Message[]; ok: boolean }> {
    const maxAllowed = this.deps.template.maxTokens;
    const softLimit = Math.trunc(maxAllowed * TOKEN_SOFT_THRESHOLD);
    const warnLimit = Math.trunc(maxAllowed * TOKEN_WARNING_THRESHOLD);

    messages = this.tryApplyPendingCompression(messages);

    let tokenCount = countMessagesTokens(messages);

    if (tokenCount > warnLimit) {
      this.cancelPendingCompression();
      messages = await this.runCompression(messages, filePath, signal);
      tokenCount = countMessagesTokens(messages);
    }

    if (tokenCount > softLimit && !this.pendingJob) {
      this.triggerAsyncCompression(messages, filePath);
    }

    if (toolCalls.length > 0) {
      messages.push(newToolCallMessage(assistantContent, toolCalls));
    } else if (assistantContent !== '') {
      messages.push(newTextMessage('assistant', assistantContent));
    }

    for (const rs of results) {
      messages.push(newToolResultMessage(rs.toolCallID, rs.result));
    }

    const finalCount = countMessagesTokens(messages);
    if (finalCount > warnLimit) {
      this.cancelPendingCompression();
      messages = await this.runCompression(messages, filePath, signal);
    }

    return { messages, ok: countMessagesTokens(messages) < warnLimit };
  }

  /**
   * Three-zone memory compression: summarizes the compress zone while
   * preserving the active zone intact. On failure or empty summary the
   * original messages are kept (never truncate).
   */
  private async runCompression(
    msgs: Message[],
    filePath: string,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    if (this.deps.template.memoryCompressionTask.messages.length === 0 || msgs.length <= 2) {
      return msgs.slice(0, Math.min(msgs.length, 2));
    }

    const part = partitionMessages(msgs, this.deps.template.maxTokens, 0);
    if (part.compressEnd <= part.frozenEnd) return msgs;

    const contextXML = buildMessageXML(msgs.slice(part.frozenEnd, part.compressEnd));

    const compressionMsgs: Message[] = this.deps.template.memoryCompressionTask.messages.map((m) =>
      newTextMessage(m.role, m.content.replaceAll('{{context}}', contextXML)),
    );

    const startTime = Date.now();
    const fsn = this.deps.session.getOrCreateFileSession(filePath);
    const rec = fsn.appendTaskRecord('memory_compression_task', compressionMsgs);
    let resp: ChatResponse;
    try {
      resp = await this.deps.llmClient.completions(
        {
          model: this.deps.model,
          messages: compressionMsgs,
          maxTokens: this.deps.template.maxTokens,
        },
        { signal },
      );
    } catch (err) {
      rec.setError(err as Error, Date.now() - startTime);
      out(`[ocr] Memory compression failed: ${(err as Error).message}`);
      // Return msgs unchanged: truncating would discard all conversation
      // context, which is worse than staying over the token limit briefly.
      return msgs;
    }
    rec.setResponse(resp, Date.now() - startTime);
    this.recordUsage(resp.usage);

    const rawSummary = stripMarkdownFences(responseContent(resp));
    if (rawSummary === '') return msgs;

    return rebuildWithSummary(msgs, part.compressEnd, rawSummary);
  }

  /** Kicks off a background compression job on a message snapshot. */
  private triggerAsyncCompression(messages: Message[], filePath: string): void {
    const msgSnapshot = [...messages];
    const timeout = AbortSignal.timeout(5 * 60 * 1000);

    const job: CompressionJob = {
      settled: false,
      cancelled: false,
      snapshotLen: messages.length,
      promise: Promise.resolve(undefined),
    };
    job.promise = (async () => {
      try {
        const rebuilt = await this.runCompression(msgSnapshot, filePath, timeout);
        return rebuilt;
      } catch {
        return undefined;
      }
    })();
    void job.promise.then((rebuilt) => {
      job.settled = true;
      if (!job.cancelled && rebuilt && rebuilt !== msgSnapshot) {
        job.rebuilt = rebuilt;
      }
    });
    this.pendingJob = job;
  }

  /**
   * Applies a completed background compression, preserving any messages
   * appended after the snapshot was taken.
   */
  private tryApplyPendingCompression(messages: Message[]): Message[] {
    const job = this.pendingJob;
    if (!job || !job.settled) return messages;

    this.pendingJob = undefined;
    if (!job.rebuilt) return messages;

    let rebuilt = job.rebuilt;
    if (job.snapshotLen < messages.length) {
      rebuilt = [...rebuilt, ...messages.slice(job.snapshotLen)];
    }
    return rebuilt;
  }

  private cancelPendingCompression(): void {
    if (this.pendingJob) {
      this.pendingJob.cancelled = true;
      this.pendingJob = undefined;
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'operation aborted');
}
