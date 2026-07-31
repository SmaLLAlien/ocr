// GitLab merge-request publishing for review comments (--gitlab flag).
// TS-port extension — the Go original ships this as an external CI script
// (examples/gitlab_ci); here it is built into the CLI behind an opt-in flag.
//
// Strategy per comment:
//   1. start_line > 0 → try an inline diff discussion at that line.
//   2. GitLab rejected the position (line not in the MR diff) or the comment
//      has no line → post it as a general MR note with an explanatory prefix.
import type { LlmComment } from '../model/index.js';

/** Connection/target settings for one MR. */
export interface GitLabTarget {
  /** API v4 base, e.g. https://gitlab.com/api/v4 */
  apiUrl: string;
  /** Numeric project id or URL-encoded full path. */
  project: string;
  /** Merge request IID (the number in the MR URL). */
  mrIid: string;
  token: string;
}

export interface GitLabFlags {
  gitlabUrl: string;
  gitlabProject: string;
  gitlabMr: string;
}

/**
 * Resolves the GitLab target from CLI flags with GitLab-CI env fallbacks
 * (CI_API_V4_URL / CI_PROJECT_ID / CI_MERGE_REQUEST_IID), so inside a
 * GitLab pipeline `--gitlab` alone is enough. The token comes only from
 * env (OCR_GITLAB_TOKEN or GITLAB_TOKEN) — secrets don't belong in argv.
 * Throws listing everything that is missing.
 */
export function resolveGitLabTarget(flags: GitLabFlags): GitLabTarget {
  const env = (n: string): string => process.env[n] ?? '';
  const apiUrl = (flags.gitlabUrl || env('CI_API_V4_URL')).replace(/\/+$/, '');
  const project = flags.gitlabProject || env('CI_PROJECT_ID');
  const mrIid = flags.gitlabMr || env('CI_MERGE_REQUEST_IID');
  const token = env('OCR_GITLAB_TOKEN') || env('PROJECT_ACCESS_TOKEN');

  const missing: string[] = [];
  if (apiUrl === '') missing.push('API URL (--gitlab-url или env CI_API_V4_URL)');
  if (project === '') missing.push('project (--gitlab-project или env CI_PROJECT_ID)');
  if (mrIid === '') missing.push('MR IID (--gitlab-mr или env CI_MERGE_REQUEST_IID)');
  if (token === '') missing.push('token (env OCR_GITLAB_TOKEN или GITLAB_TOKEN)');
  if (missing.length > 0) {
    throw new Error(`--gitlab: не хватает настроек: ${missing.join('; ')}`);
  }
  return { apiUrl, project, mrIid, token };
}

export interface PublishResult {
  /** Comments placed as inline diff discussions. */
  inline: number;
  /** Comments placed as general MR notes (no line / rejected position). */
  general: number;
  /** Comments that could not be posted at all. */
  failed: number;
}

interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

/**
 * Posts review comments to the MR. Inline first; on a rejected position the
 * comment falls back to a general note that names the intended location.
 * Network/API failures per comment are counted, logged to stderr, and never
 * abort the rest of the batch.
 */
export async function publishToGitLab(
  target: GitLabTarget,
  comments: LlmComment[],
): Promise<PublishResult> {
  const result: PublishResult = { inline: 0, general: 0, failed: 0 };
  if (comments.length === 0) return result;

  const api = (p: string, init?: RequestInit): Promise<Response> =>
    fetch(`${target.apiUrl}/projects/${encodeURIComponent(target.project)}${p}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': target.token,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

  // MR diff SHAs are required to position inline discussions.
  const mrResp = await api(`/merge_requests/${target.mrIid}`);
  if (!mrResp.ok) {
    throw new Error(`GitLab: не удалось получить MR !${target.mrIid}: HTTP ${mrResp.status} ${await safeText(mrResp)}`);
  }
  const mr = (await mrResp.json()) as { diff_refs?: DiffRefs };
  if (!mr.diff_refs?.head_sha) {
    throw new Error(`GitLab: у MR !${target.mrIid} нет diff_refs (MR без изменений?)`);
  }
  const refs = mr.diff_refs;

  for (const c of comments) {
    const posted = await postOne(api, target.mrIid, refs, c);
    result[posted]++;
  }

  return result;
}

async function postOne(
  api: (p: string, init?: RequestInit) => Promise<Response>,
  mrIid: string,
  refs: DiffRefs,
  c: LlmComment,
): Promise<keyof PublishResult> {
  // 1. Inline attempt (only when the resolver produced a line number).
  if (c.start_line > 0) {
    const resp = await api(`/merge_requests/${mrIid}/discussions`, {
      method: 'POST',
      body: JSON.stringify({
        body: buildInlineBody(c),
        position: {
          position_type: 'text',
          base_sha: refs.base_sha,
          start_sha: refs.start_sha,
          head_sha: refs.head_sha,
          old_path: c.path,
          new_path: c.path,
          new_line: c.start_line,
        },
      }),
    });
    if (resp.ok) return 'inline';
    // Position rejected (typically the line is not part of the MR diff) —
    // fall through to a general note. Anything else (401/403/network) will
    // likely fail there too and be counted as failed.
    process.stderr.write(
      `[ocr] GitLab: инлайн-комментарий к ${c.path}:${c.start_line} отклонён (HTTP ${resp.status}) — публикую как общий\n`,
    );
  }

  // 2. General-note fallback.
  const resp = await api(`/merge_requests/${mrIid}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body: buildGeneralBody(c) }),
  });
  if (resp.ok) return 'general';

  process.stderr.write(
    `[ocr] GitLab: не удалось опубликовать комментарий к ${c.path}: HTTP ${resp.status} ${await safeText(resp)}\n`,
  );
  return 'failed';
}

function badge(c: LlmComment): string {
  const parts = [c.category, c.severity].filter((x): x is string => !!x);
  return parts.length > 0 ? `**[${parts.join(' · ')}]** ` : '';
}

/** Inline body: badge + text + native GitLab suggestion block. */
function buildInlineBody(c: LlmComment): string {
  let body = badge(c) + c.content;
  if (c.suggestion_code) {
    // ```suggestion:-0+N replaces lines start_line..end_line right in the UI
    // ("Apply suggestion" button).
    const extra = c.end_line > c.start_line ? c.end_line - c.start_line : 0;
    body += `\n\n\`\`\`suggestion:-0+${extra}\n${c.suggestion_code}\n\`\`\``;
  }
  return body;
}

/**
 * General-note body: names the intended location and explains why the
 * comment is not inline; suggestion becomes a plain code block (GitLab
 * suggestion syntax only works in inline diff discussions).
 */
function buildGeneralBody(c: LlmComment): string {
  const loc = c.start_line > 0 ? `\`${c.path}:${c.start_line}\`` : `\`${c.path}\``;
  const reason =
    c.start_line > 0
      ? `не удалось привязать комментарий к строке ${c.start_line} в диффе MR, публикую как общий`
      : 'не удалось определить точную строку, публикую как общий';
  let body = `> 📍 ${loc} — ${reason}.\n\n${badge(c)}${c.content}`;
  if (c.existing_code) {
    body += `\n\nФрагмент, о котором речь:\n\`\`\`\n${c.existing_code}\n\`\`\``;
  }
  if (c.suggestion_code) {
    body += `\n\nПредлагаемая замена:\n\`\`\`\n${c.suggestion_code}\n\`\`\``;
  }
  return body;
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 300);
  } catch {
    return '';
  }
}
