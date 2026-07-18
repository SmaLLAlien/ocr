// --background-file handling. Port of cmd/opencodereview/background_file.go.
import fs from 'node:fs';

const BACKGROUND_SOFT_LIMIT = 2000;
const BACKGROUND_HARD_LIMIT = 8000;
const BACKGROUND_OPEN_TAG = '<ocr_user_background>';
const BACKGROUND_CLOSE_TAG = '</ocr_user_background>';
const MAX_BACKGROUND_FILE_BYTES = 1 << 20; // 1 MB

/**
 * Combines the inline --background value (or auto-populated commit message)
 * with --background-file content, separated by a blank line. The inline
 * value is sanitised the same way for consistency.
 */
export function mergeBackground(inline: string, fromFile: string): string {
  inline = sanitizeMarkdown(inline);
  if (inline === '') return fromFile;
  if (fromFile === '') return inline;
  return inline + '\n\n' + fromFile;
}

export function loadBackgroundFile(p: string): string {
  let info: fs.Stats;
  try {
    info = fs.statSync(p);
  } catch (err) {
    throw new Error(`read background file ${JSON.stringify(p)}: ${(err as Error).message}`);
  }
  if (info.isDirectory()) {
    throw new Error(`background file ${JSON.stringify(p)} is a directory, not a file`);
  }
  if (info.size > MAX_BACKGROUND_FILE_BYTES) {
    throw new Error(
      `background file ${JSON.stringify(p)} is ${info.size} bytes, exceeding the maximum of ${MAX_BACKGROUND_FILE_BYTES} bytes; please provide a smaller file`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`read background file ${JSON.stringify(p)}: ${(err as Error).message}`);
  }

  const cleaned = sanitizeMarkdown(raw);
  if (cleaned === '') {
    throw new Error(`background file ${JSON.stringify(p)} is empty after sanitisation`);
  }

  if (cleaned.includes(BACKGROUND_OPEN_TAG) || cleaned.includes(BACKGROUND_CLOSE_TAG)) {
    throw new Error(
      `background file ${JSON.stringify(p)} must not contain the reserved delimiters ${JSON.stringify(BACKGROUND_OPEN_TAG)} or ${JSON.stringify(BACKGROUND_CLOSE_TAG)}`,
    );
  }

  // Limits apply to the cleaned content only (wrapper overhead excluded).
  const n = [...cleaned].length;
  if (n > BACKGROUND_HARD_LIMIT) {
    throw new Error(
      `background content is ${n} characters, exceeding the hard limit of ${BACKGROUND_HARD_LIMIT} (aborting)`,
    );
  }
  if (n > BACKGROUND_SOFT_LIMIT) {
    process.stderr.write(
      `[ocr] --background-file content is ${n} characters, exceeding the recommended ${BACKGROUND_SOFT_LIMIT} (continuing but review quality might be impacted)\n`,
    );
  }

  return BACKGROUND_OPEN_TAG + '\n' + cleaned + '\n' + BACKGROUND_CLOSE_TAG;
}

export function sanitizeMarkdown(s: string): string {
  let b = '';
  for (const r of s) {
    if (r === '\n' || r === '\t') {
      b += r;
      continue;
    }
    if (r === '\r') continue;
    if (isForbiddenChar(r)) continue;
    b += r;
  }
  return b.replace(/\n{3,}/g, '\n\n').trim();
}

// Cf (format) category chars — invisible/bidi/joiner characters.
const cfRegex = /\p{Cf}/u;

function isForbiddenChar(r: string): boolean {
  const code = r.codePointAt(0)!;
  if (code <= 0x1f) return true; // C0 control characters (includes NUL)
  if (code >= 0x7f && code <= 0x9f) return true; // DEL and C1 controls
  return cfRegex.test(r);
}
