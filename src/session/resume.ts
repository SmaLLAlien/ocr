// Resume-state replay. Port of internal/session/resume.go.
import fs from 'node:fs';
import type { LlmComment } from '../model/index.js';
import {
  REVIEW_MODE_COMMIT,
  REVIEW_MODE_RANGE,
  REVIEW_MODE_WORKSPACE,
} from './history.js';
import { sessionFilePath, type SessionOptions } from './persist.js';

/** A completed file-level checkpoint, keyed by diff fingerprint. */
export interface ResumeItem {
  filePath: string;
  oldPath: string;
  newPath: string;
  fingerprint: string;
  comments: LlmComment[];
}

interface ResumeRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  reviewMode?: string;
  diffFrom?: string;
  diffTo?: string;
  diffCommit?: string;
  filePath?: string;
  oldPath?: string;
  newPath?: string;
  fingerprint?: string;
  sourceSessionId?: string;
  error?: string;
  comments?: LlmComment[];
}

/** Replayed, read-only checkpoint index for one prior session. */
export class ResumeState {
  sessionID: string;
  repoDir: string;
  gitBranch = '';
  model = '';
  reviewMode = '';
  diffFrom = '';
  diffTo = '';
  diffCommit = '';
  readonly items = new Map<string, ResumeItem>();

  constructor(sessionID: string, repoDir: string) {
    this.sessionID = sessionID;
    this.repoDir = repoDir;
  }

  completedCount(): number {
    return this.items.size;
  }

  item(fingerprint: string): ResumeItem | undefined {
    const it = this.items.get(fingerprint);
    if (!it) return undefined;
    return { ...it, comments: [...it.comments] };
  }

  /** Verifies that the requested review range matches the prior session. */
  validateOptions(opts: SessionOptions): void {
    const mode = opts.reviewMode ?? '';
    if (mode === '' || mode === REVIEW_MODE_WORKSPACE) {
      throw new Error('resume requires --from/--to or --commit; workspace resume is not supported');
    }
    if (this.reviewMode === '') {
      throw new Error(`resume session ${JSON.stringify(this.sessionID)} is missing review mode metadata`);
    }
    if (this.reviewMode !== mode) {
      throw new Error(
        `resume session review mode ${JSON.stringify(this.reviewMode)} does not match current mode ${JSON.stringify(mode)}`,
      );
    }
    switch (mode) {
      case REVIEW_MODE_RANGE:
        if (this.diffFrom !== (opts.diffFrom ?? '') || this.diffTo !== (opts.diffTo ?? '')) {
          throw new Error(
            `resume session range ${JSON.stringify(this.diffFrom)}..${JSON.stringify(this.diffTo)} does not match current range ${JSON.stringify(opts.diffFrom ?? '')}..${JSON.stringify(opts.diffTo ?? '')}`,
          );
        }
        break;
      case REVIEW_MODE_COMMIT:
        if (this.diffCommit !== (opts.diffCommit ?? '')) {
          throw new Error(
            `resume session commit ${JSON.stringify(this.diffCommit)} does not match current commit ${JSON.stringify(opts.diffCommit ?? '')}`,
          );
        }
        break;
      default:
        throw new Error(`resume mode ${JSON.stringify(mode)} is not supported`);
    }
  }
}

/** Replays a previous session JSONL into a fingerprint index. */
export function loadResumeState(repoDir: string, sessionID: string): ResumeState {
  const p = sessionFilePath(repoDir, sessionID);
  let data: string;
  try {
    data = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`open resume session ${JSON.stringify(sessionID)}: ${(err as Error).message}`);
  }

  const state = new ResumeState(sessionID, repoDir);
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue;
    let rec: ResumeRecord;
    try {
      rec = JSON.parse(line) as ResumeRecord;
    } catch (err) {
      throw new Error(`parse resume session ${JSON.stringify(sessionID)}: ${(err as Error).message}`);
    }
    applyResumeLine(state, rec);
  }
  if (state.sessionID === '') state.sessionID = sessionID;
  return state;
}

function applyResumeLine(s: ResumeState, rec: ResumeRecord): void {
  switch (rec.type) {
    case 'session_start':
      if (rec.sessionId) s.sessionID = rec.sessionId;
      if (rec.cwd) s.repoDir = rec.cwd;
      s.gitBranch = rec.gitBranch ?? '';
      s.model = rec.model ?? '';
      s.reviewMode = rec.reviewMode ?? '';
      s.diffFrom = rec.diffFrom ?? '';
      s.diffTo = rec.diffTo ?? '';
      s.diffCommit = rec.diffCommit ?? '';
      break;
    case 'review_item_done':
    case 'review_item_reused': {
      if (!rec.fingerprint) return;
      let filePath = rec.filePath ?? '';
      if (filePath === '') filePath = rec.newPath ?? '';
      s.items.set(rec.fingerprint, {
        filePath,
        oldPath: rec.oldPath ?? '',
        newPath: rec.newPath ?? '',
        fingerprint: rec.fingerprint,
        comments: rec.comments ? [...rec.comments] : [],
      });
      break;
    }
    case 'review_item_failed':
      if (rec.fingerprint) s.items.delete(rec.fingerprint);
      break;
  }
}
