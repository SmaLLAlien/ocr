// Result rendering. M3 scope: preview renderer + terminal sanitization
// (port of the corresponding parts of cmd/opencodereview/output.go; the
// comment/JSON renderers arrive with M4).
import type { Preview } from '../model/index.js';

/** Strips terminal control characters (keeps \t and \n). */
export function sanitizeTerminal(s: string): string {
  let b = '';
  for (const r of s) {
    if (r === '\t' || r === '\n' || !isControl(r)) b += r;
  }
  return b;
}

function isControl(r: string): boolean {
  const code = r.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function outputPreviewText(p: Preview): void {
  if (p.total_files === 0) {
    console.log('No files changed.');
    return;
  }

  let maxPathLen = 0;
  for (const e of p.files) {
    const n = sanitizeTerminal(e.path).length;
    if (n > maxPathLen) maxPathLen = n;
  }
  if (maxPathLen < 20) maxPathLen = 20;

  console.log(
    `\nPreview: ${p.total_files} file(s) changed  |  \x1b[32m+${p.total_insertions}\x1b[0m  \x1b[31m-${p.total_deletions}\x1b[0m`,
  );

  if (p.reviewable_count > 0) {
    console.log(`\n\x1b[1mWill review (${p.reviewable_count}):\x1b[0m`);
    for (const e of p.files) {
      if (!e.will_review) continue;
      console.log(
        `  ${statusBadge(e.status)}  ${sanitizeTerminal(e.path).padEnd(maxPathLen)} \x1b[32m+${String(e.insertions).padEnd(4)}\x1b[0m \x1b[31m-${String(e.deletions).padEnd(4)}\x1b[0m`,
      );
    }
  }

  if (p.excluded_count > 0) {
    console.log(`\n\x1b[1mExcluded from review (${p.excluded_count}):\x1b[0m`);
    for (const e of p.files) {
      if (e.will_review) continue;
      console.log(
        `  ${statusBadge(e.status)}  ${sanitizeTerminal(e.path).padEnd(maxPathLen)} \x1b[2m(${sanitizeTerminal(e.exclude_reason ?? '')})\x1b[0m`,
      );
    }
  }

  console.log();
}

export function statusBadge(status: string): string {
  switch (status) {
    case 'added':
      return '\x1b[32m[A]\x1b[0m';
    case 'modified':
      return '\x1b[33m[M]\x1b[0m';
    case 'deleted':
      return '\x1b[31m[D]\x1b[0m';
    case 'renamed':
      return '\x1b[36m[R]\x1b[0m';
    case 'binary':
      return '\x1b[35m[B]\x1b[0m';
    case 'scan':
      return '\x1b[34m[S]\x1b[0m';
    default:
      return '[?]';
  }
}
