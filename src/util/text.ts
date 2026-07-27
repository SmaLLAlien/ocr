// Text helpers for user-editable files.

/**
 * Strips a leading UTF-8 BOM. Windows editors (Notepad) and PowerShell's
 * default utf8 encoding prepend it, and JSON.parse rejects it with a cryptic
 * "Unexpected token" error — so every reader of user-editable JSON goes
 * through this.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
