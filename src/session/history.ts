// In-memory session model + write orchestration. Port of
// internal/session/history.go.
import { randomUUID } from 'node:crypto';
import type { LlmComment } from '../model/index.js';
import type { ChatResponse, Message, ToolCall } from '../llm/types.js';
import { extractText } from '../llm/types.js';
import { countTokens } from '../llm/tokens.js';
import { JsonlWriter, type SessionOptions, type TokenUsage } from './persist.js';

export type TaskType =
  | 'plan_task'
  | 'main_task'
  | 'memory_compression_task'
  | 're_location_task'
  | 'review_filter_task';

export const REVIEW_MODE_WORKSPACE = 'workspace';
export const REVIEW_MODE_RANGE = 'range';
export const REVIEW_MODE_COMMIT = 'commit';
export const REVIEW_MODE_FULL_SCAN = 'full_scan';

export interface ResponseRecord {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage?: TokenUsage;
}

export interface ToolResultRecord {
  toolName: string;
  arguments: string;
  result: string;
}

/** A single LLM request-response cycle within a file subtask. */
export class TaskRecord {
  response?: ResponseRecord;
  toolResults: ToolResultRecord[] = [];
  durationMs = 0;
  error = '';

  constructor(
    public readonly type: TaskType,
    public readonly requestNo: number,
    public readonly requestMessages: Message[],
    private readonly fileSession: FileSession,
  ) {}

  setResponse(resp: ChatResponse | undefined, durationMs: number): void {
    if (!resp || resp.choices.length === 0) {
      this.setError(new Error('empty response'), durationMs);
      return;
    }
    const choice = resp.choices[0]!;
    const content = choice.message.content ?? '';

    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    if (resp.usage) {
      promptTokens = resp.usage.prompt_tokens;
      completionTokens = resp.usage.completion_tokens;
      cacheReadTokens = resp.usage.cache_read_tokens ?? 0;
      cacheWriteTokens = resp.usage.cache_write_tokens ?? 0;
    } else {
      for (const m of this.requestMessages) promptTokens += countTokens(extractText(m));
      completionTokens = countTokens(content);
    }

    const usage: TokenUsage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
    };

    this.response = {
      content,
      toolCalls: choice.message.tool_calls ?? [],
      model: resp.model,
      usage,
    };
    this.durationMs = durationMs;

    const p = this.fileSession.session.persist;
    if (p) {
      const toolCallsJSON = (choice.message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
      p.writeLLMResponse(
        this.fileSession.filePath,
        this.type,
        content,
        toolCallsJSON,
        resp.model,
        usage,
        durationMs,
      );
    }
  }

  setError(err: Error, durationMs: number): void {
    this.error = err.message;
    this.durationMs = durationMs;
    const sh = this.fileSession.session;
    sh.persist?.writeLLMError(this.fileSession.filePath, this.type, this.requestNo, err.message, durationMs);
    sh.llmFailures++;
  }

  addToolResult(toolName: string, args: string, result: string): void {
    this.toolResults.push({ toolName, arguments: args, result });
    this.fileSession.session.persist?.writeToolCall(
      this.fileSession.filePath,
      this.type,
      toolName,
      args,
      result,
      true,
      0,
    );
  }
}

/** Conversation records for a single file subtask. */
export class FileSession {
  readonly taskRecords = new Map<TaskType, TaskRecord[]>();

  constructor(
    public readonly filePath: string,
    public readonly session: SessionHistory,
  ) {}

  appendTaskRecord(taskType: TaskType, messages: Message[]): TaskRecord {
    const list = this.taskRecords.get(taskType) ?? [];
    const rec = new TaskRecord(taskType, list.length + 1, copyMessages(messages), this);
    list.push(rec);
    this.taskRecords.set(taskType, list);

    this.session.persist?.writeLLMRequest(
      this.filePath,
      taskType,
      rec.requestNo,
      messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    );

    return rec;
  }
}

function copyMessages(msgs: Message[]): Message[] {
  return msgs.map((m) => ({
    role: m.role,
    content: m.content,
    tool_call_id: m.tool_call_id,
    tool_calls: m.tool_calls ? [...m.tool_calls] : undefined,
  }));
}

/** Top-level container for an entire review run. */
export class SessionHistory {
  readonly sessionID: string;
  readonly startTime: Date;
  endTime: Date | undefined;
  readonly fileSessions = new Map<string, FileSession>();
  llmFailures = 0;
  persist: JsonlWriter | undefined;

  constructor(
    public readonly repoDir: string,
    public readonly gitBranch: string,
    public readonly model: string,
    public readonly opts: SessionOptions,
  ) {
    this.sessionID = randomUUID();
    this.startTime = new Date();
    try {
      this.persist = new JsonlWriter(this.sessionID, repoDir, gitBranch, model, opts);
      this.persist.writeSessionStart(this.startTime);
    } catch (err) {
      console.log(`[ocr session] warning: failed to create session writer: ${(err as Error).message}`);
    }
  }

  getOrCreateFileSession(filePath: string): FileSession {
    let fsn = this.fileSessions.get(filePath);
    if (!fsn) {
      fsn = new FileSession(filePath, this);
      this.fileSessions.set(filePath, fsn);
    }
    return fsn;
  }

  recordReviewItemDone(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    comments: LlmComment[],
  ): void {
    if (filePath === '') filePath = newPath;
    if (filePath !== '') this.getOrCreateFileSession(filePath);
    this.persist?.writeReviewItemDone(filePath, oldPath, newPath, fingerprint, comments);
  }

  recordReviewItemReused(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    sourceSessionID: string,
    comments: LlmComment[],
  ): void {
    if (filePath === '') filePath = newPath;
    if (filePath !== '') this.getOrCreateFileSession(filePath);
    this.persist?.writeReviewItemReused(filePath, oldPath, newPath, fingerprint, sourceSessionID, comments);
  }

  recordReviewItemFailed(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    errorMsg: string,
  ): void {
    if (filePath === '') filePath = newPath;
    if (filePath !== '') this.getOrCreateFileSession(filePath);
    this.persist?.writeReviewItemFailed(filePath, oldPath, newPath, fingerprint, errorMsg);
  }

  finalize(): void {
    this.endTime = new Date();
    const durationMs = this.endTime.getTime() - this.startTime.getTime();
    const filesReviewed = [...this.fileSessions.keys()];
    this.persist?.writeSessionEnd(durationMs, filesReviewed, this.llmFailures);
  }
}
