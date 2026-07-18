// Session listing/summarizing. Port of internal/session/list.go.
import fs from 'node:fs';
import path from 'node:path';
import { sessionFilePath, sessionsDir } from './persist.js';

/** Compact digest of one persisted session. */
export interface Summary {
  session_id: string;
  file_path: string;
  repo_dir: string;
  git_branch?: string;
  model?: string;
  review_mode?: string;
  diff_from?: string;
  diff_to?: string;
  diff_commit?: string;
  resumed_from?: string;
  start_time?: string;
  end_time?: string;
  duration_ms?: number;
  completed_files: number;
  failed_files: number;
  reused_files: number;
  total_comments: number;
  llm_failures: number;
  aborted: boolean;
}

/** One file-level record within a session (`ocr session show`). */
export interface ItemDetail {
  type: string;
  timestamp?: string;
  file_path: string;
  old_path?: string;
  new_path?: string;
  fingerprint?: string;
  comments: number;
  source_session_id?: string;
  error?: string;
}

interface SummaryRecord {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  reviewMode?: string;
  diffFrom?: string;
  diffTo?: string;
  diffCommit?: string;
  resumedFrom?: string;
  filePath?: string;
  oldPath?: string;
  newPath?: string;
  fingerprint?: string;
  sourceSessionId?: string;
  error?: string;
  comments?: unknown[];
  files_reviewed?: string[];
  duration_seconds?: number;
  llm_failures?: number;
}

/**
 * Enumerates all persisted sessions for the repo, sorted by start time
 * descending. Missing directories return an empty list.
 */
export function listSessions(repoDir: string): Summary[] {
  const dir = sessionsDir(repoDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`read sessions dir ${JSON.stringify(dir)}: ${(err as Error).message}`);
  }
  const summaries: Summary[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory() || !name.endsWith('.jsonl')) continue;
    const sessionID = name.slice(0, -'.jsonl'.length);
    try {
      summaries.push(loadSummaryFromFile(path.join(dir, name), sessionID, repoDir));
    } catch {
      continue;
    }
  }
  summaries.sort((a, b) => (b.start_time ?? '').localeCompare(a.start_time ?? ''));
  return summaries;
}

/** Summary plus per-file item records for one session. */
export function loadDetail(repoDir: string, sessionID: string): { summary: Summary; items: ItemDetail[] } {
  const p = sessionFilePath(repoDir, sessionID);
  const summary = emptySummary(sessionID, p, repoDir);
  const items: ItemDetail[] = [];
  walkSessionFile(p, (rec) => {
    applyRecordToSummary(summary, rec);
    const item = recordToItem(rec);
    if (item) items.push(item);
  });
  if (summary.session_id === '') summary.session_id = sessionID;
  return { summary, items };
}

function emptySummary(sessionID: string, filePath: string, repoDir: string): Summary {
  return {
    session_id: sessionID,
    file_path: filePath,
    repo_dir: repoDir,
    completed_files: 0,
    failed_files: 0,
    reused_files: 0,
    total_comments: 0,
    llm_failures: 0,
    aborted: true,
  };
}

function loadSummaryFromFile(p: string, sessionID: string, repoDir: string): Summary {
  const summary = emptySummary(sessionID, p, repoDir);
  walkSessionFile(p, (rec) => applyRecordToSummary(summary, rec));
  if (summary.session_id === '') summary.session_id = sessionID;
  return summary;
}

function walkSessionFile(p: string, apply: (rec: SummaryRecord) => void): void {
  let data: string;
  try {
    data = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`open session ${JSON.stringify(p)}: ${(err as Error).message}`);
  }
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue;
    try {
      apply(JSON.parse(line) as SummaryRecord);
    } catch {
      // tolerantly skip unparseable lines
    }
  }
}

function applyRecordToSummary(s: Summary, rec: SummaryRecord): void {
  switch (rec.type) {
    case 'session_start':
      if (rec.sessionId) s.session_id = rec.sessionId;
      if (rec.cwd) s.repo_dir = rec.cwd;
      s.git_branch = rec.gitBranch || undefined;
      s.model = rec.model || undefined;
      s.review_mode = rec.reviewMode || undefined;
      s.diff_from = rec.diffFrom || undefined;
      s.diff_to = rec.diffTo || undefined;
      s.diff_commit = rec.diffCommit || undefined;
      s.resumed_from = rec.resumedFrom || undefined;
      if (rec.timestamp) s.start_time = rec.timestamp;
      break;
    case 'review_item_done':
      s.completed_files++;
      s.total_comments += rec.comments?.length ?? 0;
      break;
    case 'review_item_reused':
      s.reused_files++;
      s.total_comments += rec.comments?.length ?? 0;
      break;
    case 'review_item_failed':
      s.failed_files++;
      break;
    case 'session_end':
      s.aborted = false;
      if (
        s.completed_files === 0 &&
        s.reused_files === 0 &&
        s.failed_files === 0 &&
        (rec.files_reviewed?.length ?? 0) > 0
      ) {
        s.completed_files = rec.files_reviewed!.length;
      }
      if (rec.timestamp) s.end_time = rec.timestamp;
      if (rec.duration_seconds && rec.duration_seconds > 0) {
        s.duration_ms = Math.round(rec.duration_seconds * 1000);
      } else if (s.end_time && s.start_time) {
        s.duration_ms = new Date(s.end_time).getTime() - new Date(s.start_time).getTime();
      }
      s.llm_failures = rec.llm_failures ?? 0;
      break;
  }
}

function recordToItem(rec: SummaryRecord): ItemDetail | undefined {
  if (
    rec.type !== 'review_item_done' &&
    rec.type !== 'review_item_reused' &&
    rec.type !== 'review_item_failed'
  ) {
    return undefined;
  }
  const kind = rec.type.slice('review_item_'.length);
  let filePath = rec.filePath ?? '';
  if (filePath === '') filePath = rec.newPath ?? '';
  return {
    type: kind,
    timestamp: rec.timestamp,
    file_path: filePath,
    old_path: rec.oldPath || undefined,
    new_path: rec.newPath || undefined,
    fingerprint: rec.fingerprint || undefined,
    comments: rec.comments?.length ?? 0,
    source_session_id: rec.sourceSessionId || undefined,
    error: rec.error || undefined,
  };
}
