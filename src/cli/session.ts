// ocr session. Port of cmd/opencodereview/session_cmd.go.
import {
  REVIEW_MODE_COMMIT,
  REVIEW_MODE_RANGE,
} from '../session/history.js';
import { listSessions, loadDetail, type ItemDetail, type Summary } from '../session/list.js';
import { OcrFlagSet } from './flags.js';
import { resolveWorkingDir } from './shared.js';
import { renderTable } from './table.js';

export async function runSession(args: string[]): Promise<void> {
  if (args.length === 0) {
    printSessionUsage();
    return;
  }
  switch (args[0]) {
    case 'list':
    case 'ls':
      return runSessionList(args.slice(1));
    case 'show':
      return runSessionShow(args.slice(1));
    case '-h':
    case '--help':
      printSessionUsage();
      return;
    default:
      throw new Error(`unknown session sub-command: ${args[0]}\nRun 'ocr session -h' for usage`);
  }
}

async function runSessionList(args: string[]): Promise<void> {
  const a = new OcrFlagSet('ocr session list');
  a.string('repo', '');
  a.bool('json', false);
  a.int('limit', 20);
  a.parse(args);
  if (a.showHelp) {
    printSessionListUsage();
    return;
  }

  const resolvedRepo = resolveWorkingDirForSession(a.getString('repo'));
  let summaries: Summary[];
  try {
    summaries = listSessions(resolvedRepo);
  } catch (err) {
    throw new Error(`list sessions: ${(err as Error).message}`);
  }
  const limit = a.getInt('limit');
  if (limit > 0 && summaries.length > limit) summaries = summaries.slice(0, limit);

  if (a.getBool('json')) {
    process.stdout.write(JSON.stringify(summaries, null, 2) + '\n');
    return;
  }

  if (summaries.length === 0) {
    console.log(`No sessions found for ${resolvedRepo}`);
    return;
  }
  printSessionTable(summaries);
}

async function runSessionShow(args: string[]): Promise<void> {
  const a = new OcrFlagSet('ocr session show');
  a.string('repo', '');
  a.bool('json', false);
  a.parse(args);
  if (a.showHelp) {
    printSessionShowUsage();
    return;
  }

  if (a.rest.length === 0) {
    printSessionShowUsage();
    throw new Error('session show requires a session ID');
  }
  const sessionID = a.rest[0]!;

  const resolvedRepo = resolveWorkingDirForSession(a.getString('repo'));
  let detail;
  try {
    detail = loadDetail(resolvedRepo, sessionID);
  } catch (err) {
    throw new Error(`load session ${JSON.stringify(sessionID)}: ${(err as Error).message}`);
  }

  if (a.getBool('json')) {
    process.stdout.write(JSON.stringify({ summary: detail.summary, items: detail.items }, null, 2) + '\n');
    return;
  }

  printSessionDetail(detail.summary, detail.items);
}

/** Unlike resolveRepoDir this does not require a git repository. */
function resolveWorkingDirForSession(input: string): string {
  return resolveWorkingDir(input, false).repoDir;
}

function printSessionTable(summaries: Summary[]): void {
  const rows: string[][] = [
    ['SESSION ID', 'MODE', 'RANGE', 'FILES', 'COMMENTS', 'STATUS', 'STARTED'],
    ...summaries.map((s) => [
      s.session_id,
      displayMode(s.review_mode),
      describeRange(s),
      describeFiles(s),
      String(s.total_comments),
      describeStatus(s),
      describeStart(s),
    ]),
  ];
  console.log(renderTable(rows, ''));
}

function printSessionDetail(s: Summary, items: ItemDetail[]): void {
  console.log(`Session: ${s.session_id}`);
  console.log(`  File:      ${s.file_path}`);
  console.log(`  Repo:      ${s.repo_dir}`);
  if (s.git_branch) console.log(`  Branch:    ${s.git_branch}`);
  if (s.model) console.log(`  Model:     ${s.model}`);
  console.log(`  Mode:      ${displayMode(s.review_mode)}`);
  const r = describeRange(s);
  if (r !== '' && r !== '-') console.log(`  Range:     ${r}`);
  if (s.resumed_from) console.log(`  Resumed:   from session ${s.resumed_from}`);
  console.log(`  Started:   ${describeStart(s)}`);
  if (s.end_time) console.log(`  Ended:     ${formatLocal(s.end_time)}`);
  if (s.duration_ms && s.duration_ms > 0) {
    console.log(`  Duration:  ${Math.round(s.duration_ms / 1000)}s`);
  }
  console.log(`  Status:    ${describeStatus(s)}`);
  console.log(`  Files:     ${s.completed_files} completed, ${s.reused_files} reused, ${s.failed_files} failed`);
  console.log(`  Comments:  ${s.total_comments}`);
  if (s.llm_failures > 0) console.log(`  LLM err:   ${s.llm_failures}`);

  if (items.length === 0) return;
  console.log();
  console.log('Files:');
  const rows: string[][] = [
    ['TYPE', 'FILE', 'COMMENTS', 'NOTE'],
    ...items.map((it) => {
      let note = '';
      if (it.type === 'reused') note = 'from ' + shortSessionID(it.source_session_id ?? '');
      else if (it.type === 'failed') note = truncate(it.error ?? '', 60);
      return [it.type, it.file_path, String(it.comments), note];
    }),
  ];
  console.log(renderTable(rows));
}

function displayMode(m: string | undefined): string {
  return m || '-';
}

function describeRange(s: Summary): string {
  switch (s.review_mode) {
    case REVIEW_MODE_RANGE:
      if (s.diff_from || s.diff_to) return `${s.diff_from ?? ''}..${s.diff_to ?? ''}`;
      break;
    case REVIEW_MODE_COMMIT:
      if (s.diff_commit) return s.diff_commit;
      break;
  }
  return '-';
}

function describeFiles(s: Summary): string {
  const total = s.completed_files + s.reused_files;
  if (s.reused_files > 0) return `${total} (reused ${s.reused_files})`;
  return String(total);
}

function describeStatus(s: Summary): string {
  if (s.aborted) return 'aborted';
  if (s.failed_files > 0) return `completed (${s.failed_files} fail)`;
  return 'completed';
}

function describeStart(s: Summary): string {
  if (!s.start_time) return '-';
  return formatLocal(s.start_time);
}

function formatLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortSessionID(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function truncate(s: string, n: number): string {
  s = s.replaceAll('\n', ' ').replaceAll('\t', ' ');
  const runes = [...s];
  if (runes.length <= n) return s;
  if (n <= 1) return '…';
  return runes.slice(0, n - 1).join('') + '…';
}

function printSessionUsage(): void {
  console.log(`Usage:
  ocr session <sub-command>

Sub-commands:
  list, ls    List recent review sessions for the current repo
  show <id>   Show one session's metadata and per-file items

Use "ocr session list -h" or "ocr session show -h" for details.`);
}

function printSessionListUsage(): void {
  console.log(`Usage:
  ocr session list [flags]
  ocr session ls [flags]

List review sessions previously persisted to ~/.opencodereview/sessions/. The
session id printed here can be passed to 'ocr review --resume <id>'.

Flags:
  --repo string   Root directory of the git repository (default: current dir)
  --json          Emit JSON instead of a table
  --limit int     Cap the number of listed sessions (default 20; 0 = unlimited)`);
}

function printSessionShowUsage(): void {
  console.log(`Usage:
  ocr session show [flags] <session-id>

Show metadata and per-file items for a single session.

Flags:
  --repo string   Root directory of the git repository (default: current dir)
  --json          Emit JSON instead of a table`);
}
