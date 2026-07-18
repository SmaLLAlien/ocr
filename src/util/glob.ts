// Glob helpers replacing Go's doublestar.Match and filepath.Match.
import picomatch from 'picomatch';

const matcherCache = new Map<string, (s: string) => boolean>();

/**
 * doublestar.Match equivalent: `**` crosses separators, `*` does not,
 * `{a,b}` braces supported, dotfiles matched. Callers handle case folding
 * themselves (the Go code lowercases both sides).
 */
export function globMatch(pattern: string, p: string): boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    try {
      m = picomatch(pattern, { dot: true, windows: false }) as (s: string) => boolean;
    } catch {
      m = () => false;
    }
    matcherCache.set(pattern, m);
  }
  return m(p);
}

const simpleCache = new Map<string, (s: string) => boolean>();

/**
 * Go filepath.Match equivalent: single-level matching where `*` does not
 * cross `/` and there is no `**` or brace expansion.
 */
export function simpleMatch(pattern: string, p: string): boolean {
  let m = simpleCache.get(pattern);
  if (!m) {
    try {
      m = picomatch(pattern, {
        dot: true,
        windows: false,
        noglobstar: true,
        nobrace: true,
        noextglob: true,
      }) as (s: string) => boolean;
    } catch {
      m = () => false;
    }
    simpleCache.set(pattern, m);
  }
  return m(p);
}

/**
 * Expands "{a,b,c}" style patterns into individual strings (first brace pair
 * only, mirroring the Go helper). Port of rules.expandBraces.
 */
export function expandBraces(s: string): string[] {
  const openIdx = s.indexOf('{');
  if (openIdx < 0) return [s];
  const closeRel = s.slice(openIdx).indexOf('}');
  if (closeRel < 0) return [s];
  const closeIdx = closeRel + openIdx;

  const prefix = s.slice(0, openIdx);
  const suffix = s.slice(closeIdx + 1);
  return s
    .slice(openIdx + 1, closeIdx)
    .split(',')
    .map((opt) => prefix + opt + suffix);
}
