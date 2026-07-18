// Filesystem-safety primitives. Port of internal/pathutil/path.go.
import fs from 'node:fs';
import path from 'node:path';

/** Returns an absolute path with symlinks resolved. */
export function canonicalPath(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

/** Reports whether target is base itself or contained under base. */
export function withinBase(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || rel === '.' || (rel !== '..' && !rel.startsWith('..' + path.sep));
}
