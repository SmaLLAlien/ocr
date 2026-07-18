// Review-rule resolution with layered priority. Port of
// internal/config/rules/system_rules.go.
//
// Layer precedence (highest→lowest), first match wins within each layer:
//   1. custom  — file passed via --rule flag
//   2. project — <repoDir>/.opencodereview/rule.json
//   3. global  — ~/.opencodereview/rule.json
//   4. system  — bundled defaults (assets/system_rules.json + rule_docs/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAsset } from '../util/assets.js';
import { expandBraces, globMatch } from '../util/glob.js';

/** Resolves a review rule for a file path. */
export interface RuleResolver {
  resolve(p: string): string;
  resolveDetail(p: string): RuleDetail;
}

/** A single pattern→rule entry preserving declaration order. */
export interface PathRule {
  pattern: string;
  rule: string;
}

/** Review rules loaded from the bundled JSON config. */
export interface SystemRule {
  defaultRule: string;
  pathRules: PathRule[]; // ordered; first match wins
}

/** The resolved rule along with metadata about its source. */
export interface RuleDetail {
  rule: string;
  source: 'custom' | 'project' | 'global' | 'system';
  pattern: string; // glob pattern that matched, or "default" for fallback
}

/**
 * Parses the bundled system_rules.json and resolves rule file references.
 * JSON.parse preserves object key order in JS, so path_rule_map ordering
 * (first match wins) survives without the Go streaming decoder.
 */
export function loadSystemDefault(): SystemRule {
  const raw = JSON.parse(readAsset('system_rules.json')) as {
    default_rule: string;
    path_rule_map?: Record<string, string>;
  };
  const readDoc = (name: string): string =>
    readAsset('rule_docs', name).replace(/\n+$/, '');

  return {
    defaultRule: readDoc(raw.default_rule),
    pathRules: Object.entries(raw.path_rule_map ?? {}).map(([pattern, file]) => ({
      pattern,
      rule: readDoc(file),
    })),
  };
}

function systemResolve(r: SystemRule, p: string): string {
  return systemResolveDetail(r, p).rule;
}

function systemResolveDetail(r: SystemRule, p: string): RuleDetail {
  const lowerPath = p.toLowerCase();
  for (const pr of r.pathRules) {
    for (const pat of expandBraces(pr.pattern)) {
      if (globMatch(pat.toLowerCase(), lowerPath)) {
        return { rule: pr.rule, source: 'system', pattern: pr.pattern };
      }
    }
  }
  return { rule: r.defaultRule, source: 'system', pattern: 'default' };
}

/** A single entry in .opencodereview/rule.json. */
export interface ProjectRuleEntry {
  path: string;
  rule: string;
  merge_system_rule?: boolean;
}

/** Rules loaded from a rule.json layer. */
export interface ProjectRule {
  rules?: ProjectRuleEntry[];
  include?: string[];
  exclude?: string[];
}

/** Merged user-configured include/exclude glob patterns. */
export class FileFilter {
  include: string[] = [];
  exclude: string[] = [];

  hasInclude(): boolean {
    return this.include.length > 0;
  }

  isUserExcluded(p: string): boolean {
    const lowerPath = p.toLowerCase();
    return this.exclude.some((pattern) =>
      expandBraces(pattern).some((pat) => globMatch(pat, lowerPath)),
    );
  }

  isUserIncluded(p: string): boolean {
    if (!this.hasInclude()) return false;
    const lowerPath = p.toLowerCase();
    return this.include.some((pattern) =>
      expandBraces(pattern).some((pat) => globMatch(pat, lowerPath)),
    );
  }
}

/**
 * Builds the layered resolver plus the merged FileFilter (highest-priority
 * layer with any include/exclude wins: custom > project > global).
 */
export function newResolver(
  repoDir: string,
  customRulePath: string,
): { resolver: RuleResolver; fileFilter: FileFilter | undefined } {
  const sysRule = loadSystemDefault();

  let customRule: ProjectRule | undefined;
  if (customRulePath !== '') {
    customRule = loadRuleFile(customRulePath);
  }

  let projectRule: ProjectRule | undefined;
  if (repoDir !== '') {
    projectRule = loadProjectRule(repoDir);
  }

  const globalRule = loadGlobalRule();

  const fileFilter = buildFileFilter(customRule, projectRule, globalRule);

  return {
    resolver: new ComposedResolver(customRule, projectRule, globalRule, sysRule),
    fileFilter,
  };
}

function buildFileFilter(...layers: Array<ProjectRule | undefined>): FileFilter | undefined {
  for (const pr of layers) {
    if (!pr) continue;
    if ((pr.include?.length ?? 0) === 0 && (pr.exclude?.length ?? 0) === 0) continue;
    const f = new FileFilter();
    f.include = (pr.include ?? []).map((p) => p.toLowerCase());
    f.exclude = (pr.exclude ?? []).map((p) => p.toLowerCase());
    return f;
  }
  return undefined;
}

function loadGlobalRule(): ProjectRule | undefined {
  const p = path.join(os.homedir(), '.opencodereview', 'rule.json');
  return readProjectRuleFile(p, path.dirname(p), `read global rule ${p}`, true);
}

function loadRuleFile(rulePath: string): ProjectRule {
  const pr = readProjectRuleFile(
    rulePath,
    path.dirname(rulePath),
    `read rule file ${rulePath}`,
    false,
  );
  if (!pr) throw new Error(`read rule file ${rulePath}: file not found`);
  return pr;
}

function loadProjectRule(repoDir: string): ProjectRule | undefined {
  const p = path.join(repoDir, '.opencodereview', 'rule.json');
  return readProjectRuleFile(p, repoDir, `read project rule ${p}`, true);
}

function readProjectRuleFile(
  filePath: string,
  ruleBaseDir: string,
  errPrefix: string,
  missingOk: boolean,
): ProjectRule | undefined {
  let data: string;
  try {
    data = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && missingOk) return undefined;
    throw new Error(`${errPrefix}: ${(err as Error).message}`);
  }
  let pr: ProjectRule;
  try {
    pr = JSON.parse(data) as ProjectRule;
  } catch (err) {
    throw new Error(`unmarshal rule file ${filePath}: ${(err as Error).message}`);
  }
  resolveRuleEntries(pr.rules ?? [], ruleBaseDir);
  return pr;
}

class ComposedResolver implements RuleResolver {
  constructor(
    private readonly custom: ProjectRule | undefined,
    private readonly project: ProjectRule | undefined,
    private readonly global: ProjectRule | undefined,
    private readonly system: SystemRule,
  ) {}

  resolve(p: string): string {
    for (const layer of [this.custom, this.project, this.global]) {
      const entry = matchProjectRuleEntry(layer, p);
      if (entry) {
        if (entry.merge_system_rule) return this.mergeWithSystemRule(p, entry.rule);
        return entry.rule;
      }
    }
    return systemResolve(this.system, p);
  }

  resolveDetail(p: string): RuleDetail {
    const layers: Array<[ProjectRule | undefined, RuleDetail['source']]> = [
      [this.custom, 'custom'],
      [this.project, 'project'],
      [this.global, 'global'],
    ];
    for (const [layer, source] of layers) {
      const entry = matchProjectRuleEntry(layer, p);
      if (entry) {
        let rule = entry.rule;
        if (entry.merge_system_rule) rule = this.mergeWithSystemRule(p, rule);
        return { rule, source, pattern: entry.path };
      }
    }
    return systemResolveDetail(this.system, p);
  }

  private mergeWithSystemRule(p: string, rule: string): string {
    const systemRule = systemResolve(this.system, p);
    if (systemRule === '') return rule;
    if (rule === '') return systemRule;
    return (
      '## System-Specific Rules (Mandatory)\n\n' +
      systemRule +
      '\n\n---\n\n' +
      '## User-Specific Rules (Mandatory)\n\n' +
      rule
    );
  }
}

function matchProjectRuleEntry(
  pr: ProjectRule | undefined,
  p: string,
): ProjectRuleEntry | undefined {
  if (!pr) return undefined;
  const lowerPath = p.toLowerCase();
  for (const entry of pr.rules ?? []) {
    if (entry.rule === '' && !entry.merge_system_rule) continue;
    for (const pat of expandBraces(entry.path)) {
      if (globMatch(pat.toLowerCase(), lowerPath)) return entry;
    }
  }
  return undefined;
}

// --- rule-file reference resolution (rule value may be a path to .md/.txt) ---

const allowedRuleExts = new Set(['.md', '.txt', '.markdown']);

/**
 * True when s is likely a file path (not inline content): single-line, no
 * spaces, ends in an allowed extension.
 */
function looksLikeFilePath(s: string): boolean {
  if (s.includes('\n')) return false;
  if (s.includes(' ')) return false;
  return allowedRuleExts.has(path.extname(s).toLowerCase());
}

function resolveRuleEntries(entries: ProjectRuleEntry[], repoDir: string): void {
  for (const e of entries) {
    if ((e.rule ?? '').trim() === '' || !looksLikeFilePath(e.rule)) {
      if (e.rule === undefined) e.rule = '';
      continue;
    }
    const content = tryReadRuleFile(e.rule, repoDir);
    e.rule = content ?? '';
  }
}

function tryReadRuleFile(rule: string, repoDir: string): string | undefined {
  const warn = (msg: string): void => {
    process.stderr.write(`[ocr] WARNING: ${msg}\n`);
  };

  if (repoDir === '' && !path.isAbsolute(rule)) {
    warn(`cannot resolve relative rule path ${JSON.stringify(rule)} without a repo dir`);
    return undefined;
  }
  if (path.isAbsolute(rule)) {
    return readSafeOrWarn(rule, rule, warn);
  }

  // Relative path: resolve against repoDir, validate no traversal.
  const resolved = path.normalize(path.join(repoDir, rule));
  const cleanRepo = path.normalize(repoDir);
  if (!resolved.startsWith(cleanRepo + path.sep)) {
    warn(`rule file path escapes repo dir: ${rule}`);
    return undefined;
  }
  return readSafeOrWarn(resolved, resolved, warn);
}

function readSafeOrWarn(
  p: string,
  displayPath: string,
  warn: (msg: string) => void,
): string | undefined {
  try {
    return readRuleFileSafe(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      warn(`rule file not found: ${displayPath}`);
    } else {
      warn(`cannot read rule file ${displayPath}: ${(err as Error).message}`);
    }
    return undefined;
  }
}

/**
 * Reads and validates a rule file: symlinks resolved first, extension
 * whitelist (.md/.txt/.markdown), 512 KB size cap. Returns trimmed content.
 */
function readRuleFileSafe(p: string): string {
  const resolved = fs.realpathSync(p);

  const ext = path.extname(resolved);
  if (!allowedRuleExts.has(ext.toLowerCase())) {
    throw new Error(`unsupported extension ${JSON.stringify(ext)}, only .md/.txt/.markdown allowed`);
  }

  const maxSize = 512 * 1024;
  const info = fs.statSync(resolved);
  if (info.size > maxSize) {
    throw new Error(`file too large (${info.size} bytes, max ${maxSize})`);
  }

  return fs.readFileSync(resolved, 'utf8').replace(/\n+$/, '');
}
