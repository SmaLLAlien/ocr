// JSONL session persistence. Port of internal/session/persist.go.
// Records are chained via uuid/parentUuid; review_item_* records are the
// resume checkpoints and are flushed immediately (here: written synchronously).
//
// This TS implementation is the canonical session format. Sessions written
// by the original Go binary are NOT supported (same record/field layout, but
// no cross-compatibility guarantee — see PROGRESS.md decision journal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LlmComment } from '../model/index.js';
import type { TaskType } from './history.js';

export let sessionSubDir = 'sessions';

/** Test hook mirroring session.UseTestSessions. */
export function useTestSessions(): void {
  sessionSubDir = 'test-sessions';
}

export function encodeRepoPath(p: string): string {
  if (p === '') return 'empty';

  // Volume name (Windows drive letter) handling.
  let vol = '';
  const volMatch = /^[a-zA-Z]:/.exec(p);
  if (volMatch) {
    vol = volMatch[0];
    p = p.slice(vol.length);
  }

  p = p.replace(/^[/\\]+/, '');
  p = p.replaceAll('/', '-').replaceAll('\\', '-');
  vol = vol.replaceAll(':', '_');

  const result = vol + p;
  return result === '' ? 'empty' : result;
}

export interface SessionOptions {
  reviewMode?: string;
  diffFrom?: string;
  diffTo?: string;
  diffCommit?: string;
  resumedFrom?: string;
}

/** The JSONL path for a persisted session. */
export function sessionFilePath(repoDir: string, sessionID: string): string {
  if (sessionID === '') throw new Error('session id is required');
  return path.join(
    os.homedir(),
    '.opencodereview',
    sessionSubDir,
    encodeRepoPath(repoDir),
    sessionID + '.jsonl',
  );
}

export function sessionsDir(repoDir: string): string {
  return path.join(os.homedir(), '.opencodereview', sessionSubDir, encodeRepoPath(repoDir));
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** Streams session records to a JSONL file. */
export class JsonlWriter {
  private fd: number | undefined;
  private lastUUID: string | null = null;

  constructor(
    private readonly sessionID: string,
    private readonly repoDir: string,
    private readonly gitBranch: string,
    private readonly model: string,
    private readonly opts: SessionOptions,
  ) {
    const dir = sessionsDir(repoDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filename = path.join(dir, sessionID + '.jsonl');
    this.fd = fs.openSync(filename, 'w', 0o600);
  }

  private writeRecord(rec: Record<string, unknown>): void {
    if (this.fd === undefined) return;
    try {
      fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
    } catch (err) {
      console.log(`[ocr session] failed to write record: ${(err as Error).message}`);
    }
  }

  writeSessionStart(startTime: Date): string {
    const uuid = randomUUID();
    const rec: Record<string, unknown> = {
      uuid,
      parentUuid: null,
      type: 'session_start',
      sessionId: this.sessionID,
      timestamp: startTime.toISOString(),
      cwd: this.repoDir,
      gitBranch: this.gitBranch,
      model: this.model,
    };
    if (this.opts.reviewMode) rec['reviewMode'] = this.opts.reviewMode;
    if (this.opts.diffFrom) rec['diffFrom'] = this.opts.diffFrom;
    if (this.opts.diffTo) rec['diffTo'] = this.opts.diffTo;
    if (this.opts.diffCommit) rec['diffCommit'] = this.opts.diffCommit;
    if (this.opts.resumedFrom) rec['resumedFrom'] = this.opts.resumedFrom;
    this.writeRecord(rec);
    this.lastUUID = uuid;
    return uuid;
  }

  writeReviewItemDone(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    comments: LlmComment[],
  ): void {
    this.writeReviewItemRecord('review_item_done', filePath, oldPath, newPath, fingerprint, '', '', comments);
  }

  writeReviewItemReused(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    sourceSessionID: string,
    comments: LlmComment[],
  ): void {
    this.writeReviewItemRecord(
      'review_item_reused',
      filePath,
      oldPath,
      newPath,
      fingerprint,
      sourceSessionID,
      '',
      comments,
    );
  }

  writeReviewItemFailed(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    errorMsg: string,
  ): void {
    this.writeReviewItemRecord('review_item_failed', filePath, oldPath, newPath, fingerprint, '', errorMsg, undefined);
  }

  private writeReviewItemRecord(
    recordType: string,
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    sourceSessionID: string,
    errorMsg: string,
    comments: LlmComment[] | undefined,
  ): void {
    const uuid = randomUUID();
    const rec: Record<string, unknown> = {
      uuid,
      parentUuid: this.lastUUID,
      type: recordType,
      sessionId: this.sessionID,
      timestamp: nowISO(),
      filePath,
      oldPath,
      newPath,
      fingerprint,
      model: this.model,
    };
    if (comments && comments.length > 0) rec['comments'] = comments;
    if (sourceSessionID !== '') rec['sourceSessionId'] = sourceSessionID;
    if (errorMsg !== '') rec['error'] = errorMsg;
    this.writeRecord(rec);
    this.lastUUID = uuid;
  }

  writeLLMRequest(filePath: string, taskType: TaskType, requestNo: number, messages: unknown): void {
    const uuid = randomUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: 'llm_request',
      sessionId: this.sessionID,
      timestamp: nowISO(),
      filePath,
      taskType,
      request_no: requestNo,
      messages,
    });
    this.lastUUID = uuid;
  }

  writeLLMResponse(
    filePath: string,
    taskType: TaskType,
    content: string,
    toolCalls: Array<Record<string, unknown>>,
    model: string,
    usage: TokenUsage,
    durationMs: number,
  ): void {
    const uuid = randomUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: 'llm_response',
      sessionId: this.sessionID,
      timestamp: nowISO(),
      filePath,
      taskType,
      model,
      content,
      tool_calls: toolCalls,
      duration_ms: Math.round(durationMs),
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        cache_read_tokens: usage.cache_read_tokens ?? 0,
        cache_write_tokens: usage.cache_write_tokens ?? 0,
      },
    });
    this.lastUUID = uuid;
  }

  writeLLMError(
    filePath: string,
    taskType: TaskType,
    requestNo: number,
    errorMsg: string,
    durationMs: number,
  ): void {
    const uuid = randomUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: 'llm_error',
      sessionId: this.sessionID,
      timestamp: nowISO(),
      filePath,
      taskType,
      request_no: requestNo,
      error: errorMsg,
      duration_ms: Math.round(durationMs),
    });
    this.lastUUID = uuid;
  }

  writeToolCall(
    filePath: string,
    taskType: TaskType,
    toolName: string,
    args: string,
    result: string,
    ok: boolean,
    durationMs: number,
  ): void {
    const uuid = randomUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: 'tool_call',
      sessionId: this.sessionID,
      timestamp: nowISO(),
      filePath,
      taskType,
      tool_name: toolName,
      arguments: args,
      result,
      ok,
      duration_ms: Math.round(durationMs),
    });
    this.lastUUID = uuid;
  }

  writeSessionEnd(durationMs: number, filesReviewed: string[], llmFailures: number): void {
    const uuid = randomUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: 'session_end',
      sessionId: this.sessionID,
      timestamp: nowISO(),
      files_reviewed: filesReviewed,
      duration_seconds: durationMs / 1000,
      llm_failures: llmFailures,
    });
    this.lastUUID = uuid;
    this.close();
  }

  close(): void {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = undefined;
    }
  }
}

function nowISO(): string {
  return new Date().toISOString();
}
