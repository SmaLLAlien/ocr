// File-level filtering: extension allowlist + default path excludes.
// Port of internal/config/allowlist/allowed_ext.go.
import { readAsset } from '../util/assets.js';
import { globMatch } from '../util/glob.js';

let supported: Set<string> | undefined;
let excludePatterns: string[] | undefined;

function initMap(): Set<string> {
  if (!supported) {
    const exts = JSON.parse(readAsset('supported_file_types.json')) as string[];
    supported = new Set(exts.map((e) => e.toLowerCase()));
  }
  return supported;
}

function initExclude(): string[] {
  if (!excludePatterns) {
    const pats = JSON.parse(readAsset('default_exclude_patterns.json')) as string[];
    excludePatterns = pats.map((p) => p.toLowerCase());
  }
  return excludePatterns;
}

/** True when the file extension is in the supported types list (case-insensitive). */
export function isAllowedExt(ext: string): boolean {
  return initMap().has(ext.toLowerCase());
}

/**
 * True when the path matches any default exclude pattern. Patterns support
 * `**`, `*`, and `{a,b,c}`; the check is case-insensitive.
 */
export function isExcludedPath(p: string): boolean {
  const lower = p.toLowerCase();
  return initExclude().some((pattern) => globMatch(pattern, lower));
}
