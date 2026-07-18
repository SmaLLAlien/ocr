// Shared setup/teardown for review/scan. Port of cmd/opencodereview/shared.go.
import fs from 'node:fs';
import path from 'node:path';
import { FileFilter, newResolver, type RuleResolver } from '../config/rules.js';
import {
  applyTemplateLanguage,
  loadDefaultTemplate,
  validateTemplate,
  type Template,
} from '../config/template.js';
import { buildToolDefs, loadToolsConfig } from '../config/toolsconfig.js';
import { defaultConfigPath, loadAppConfig, type AppConfig } from '../config/appConfig.js';
import { resolveEndpointWithModelOverride } from '../llm/resolver.js';
import { newLLMClient } from '../llm/client.js';
import type { LLMClient, ToolDef } from '../llm/types.js';
import type { Diff, LlmComment } from '../model/index.js';
import type { AgentWarning } from '../loop/pool.js';
import type { ResumeInfo } from '../agent/agent.js';
import { CommentCollector } from '../tools/collector.js';
import { GitRunner } from '../git/runner.js';
import { resolveLineNumbers } from '../diff/resolver.js';
import { printTraceSummary, setQuiet } from '../util/logger.js';
import { runGitCmd, runGitCmdStdout } from './git.js';
import { outputJSONNoFiles, outputJSONWithWarnings, outputTextWithWarnings } from './output.js';

/**
 * State both `ocr review` and `ocr scan` need before deciding whether to
 * dispatch a preview or a real LLM session.
 */
export interface CommonContext {
  template: Template;
  repoDir: string;
  resolver: RuleResolver;
  fileFilter: FileFilter | undefined;
  gitRunner: GitRunner;
  /** Whether repoDir is inside a git repository (always true when requireGit). */
  isGitRepo: boolean;
}

/**
 * Validates the working directory, loads the bundled template (raising
 * MaxToolRequestTimes when maxTools exceeds the default), resolves the
 * absolute repo path, loads review rules, and creates the git subprocess
 * limiter.
 */
export function loadCommonContext(
  repoDirInput: string,
  rulePath: string,
  maxTools: number,
  maxGitProcs: number,
  requireGit: boolean,
): CommonContext {
  let tpl: Template;
  try {
    tpl = loadDefaultTemplate();
  } catch (err) {
    throw new Error(`load default template: ${(err as Error).message}`);
  }
  if (maxTools > tpl.maxToolRequestTimes) {
    tpl.maxToolRequestTimes = maxTools;
  }
  try {
    validateTemplate(tpl);
  } catch (err) {
    throw new Error(`invalid config: ${(err as Error).message}`);
  }

  const { repoDir, isGit } = resolveWorkingDir(repoDirInput, requireGit);

  let resolved;
  try {
    resolved = newResolver(repoDir, rulePath);
  } catch (err) {
    throw new Error(`load rules: ${(err as Error).message}`);
  }

  return {
    template: tpl,
    repoDir,
    resolver: resolved.resolver,
    fileFilter: resolved.fileFilter,
    gitRunner: new GitRunner(maxGitProcs),
    isGitRepo: isGit,
  };
}

/**
 * Returns (absPath, isGitRepo). When requireGit is true, errors if the
 * directory is not a git repo. #287: for the review path the repo dir is
 * anchored at the git top-level so root-relative diff paths resolve from
 * monorepo subdirectories; scan keeps the CWD.
 */
export function resolveWorkingDir(
  input: string,
  requireGit: boolean,
): { repoDir: string; isGit: boolean } {
  if (input === '') input = process.cwd();
  const absPath = path.resolve(input);
  if (!fs.existsSync(absPath)) {
    throw new Error(`stat ${absPath}: no such file or directory`);
  }
  const gitDir = runGitCmd(absPath, 'rev-parse', '--git-dir');
  const isGit = gitDir.ok && gitDir.out.length > 0;
  if (!isGit && requireGit) {
    throw new Error(`${absPath} is not a git repository`);
  }
  if (isGit && requireGit) {
    const top = runGitCmdStdout(absPath, 'rev-parse', '--show-toplevel');
    const t = top.out.trim();
    if (!top.ok || t === '') {
      throw new Error(
        `${absPath} is a git repository without a work tree (bare repo?); cannot resolve its top level for review`,
      );
    }
    return { repoDir: t, isGit };
  }
  return { repoDir: absPath, isGit };
}

/** Resolves the repo dir for commands that require a git repository. */
export function resolveRepoDir(input: string): string {
  return resolveWorkingDir(input, true).repoDir;
}

/**
 * Appends user-supplied --exclude patterns onto the FileFilter, creating it
 * if no rule.json layer produced one.
 */
export function applyCLIExcludes(cc: CommonContext, patterns: string[]): void {
  if (patterns.length === 0) return;
  if (!cc.fileFilter) cc.fileFilter = new FileFilter();
  cc.fileFilter.exclude.push(...patterns);
}

/** Removes tool defs whose function name matches name (scan hides file_read_diff). */
export function excludeToolDef(defs: ToolDef[], name: string): ToolDef[] {
  return defs.filter((d) => d.function.name !== name);
}

/**
 * LLM-side state both subcommands need once they decide to run a session.
 */
export interface LlmRuntime {
  client: LLMClient;
  model: string;
  planToolDefs: ToolDef[];
  mainToolDefs: ToolDef[];
  collector: CommentCollector;
  appCfg: AppConfig | undefined;
}

/**
 * Loads tool defs, reads the app config from the default config path
 * (applying the configured language to tpl in place), resolves the LLM
 * endpoint (honoring --model), and returns the runtime bundle.
 */
export function loadLLMRuntime(
  tpl: Template,
  toolConfigPath: string,
  modelOverride: string,
): LlmRuntime {
  let toolEntries;
  try {
    toolEntries = loadToolsConfig(toolConfigPath);
  } catch (err) {
    throw new Error(`load tools: ${(err as Error).message}`);
  }
  const planToolDefs = buildToolDefs(toolEntries, true);
  const mainToolDefs = buildToolDefs(toolEntries, false);

  const cfgPath = defaultConfigPath();
  let appCfg: AppConfig | undefined;
  try {
    appCfg = loadAppConfig(cfgPath);
  } catch (err) {
    throw new Error(`load app config: ${(err as Error).message}`);
  }
  applyTemplateLanguage(tpl, appCfg?.language);

  let ep;
  try {
    ep = resolveEndpointWithModelOverride(cfgPath, modelOverride);
  } catch (err) {
    throw new Error(`resolve LLM endpoint: ${(err as Error).message}`);
  }

  return {
    client: newLLMClient(ep),
    model: ep.model,
    planToolDefs,
    mainToolDefs,
    collector: new CommentCollector(),
    appCfg,
  };
}

/**
 * Idempotent stdout-silencing handle: active when outputFormat=="json" or
 * audience=="agent"; restored early by emitRunResult for agent-text mode.
 */
export class QuietHandle {
  private fn: (() => void) | undefined;

  constructor(outputFormat: string, audience: string) {
    if (outputFormat === 'json' || audience === 'agent') {
      this.fn = setQuiet();
    }
  }

  restore(): void {
    if (this.fn) {
      this.fn();
      this.fn = undefined;
    }
  }
}

/**
 * Post-run metadata both ReviewAgent and (later) ScanAgent expose, so
 * emitRunResult can finalize either.
 */
export interface ResultProvider {
  diffs: Diff[];
  filesReviewed(): number;
  totalInputTokens(): number;
  totalOutputTokens(): number;
  totalTokensUsed(): number;
  totalCacheReadTokens(): number;
  totalCacheWriteTokens(): number;
  warnings(): AgentWarning[];
  projectSummary(): string;
  toolCalls(): Map<string, number>;
  sessionID(): string;
  resumeInfo?(): ResumeInfo | undefined;
}

/**
 * Post-LLM-run finalization shared by review and scan: resolves comment line
 * numbers, restores stdout for agent-text audiences, prints the trace
 * summary, and writes the result in the requested format.
 */
export function emitRunResult(
  ag: ResultProvider,
  comments: LlmComment[],
  startTimeMs: number,
  outputFormat: string,
  audience: string,
  q: QuietHandle | undefined,
): void {
  comments = resolveLineNumbers(comments, ag.diffs);

  const durationMs = Date.now() - startTimeMs;
  const traceID = '';

  if (outputFormat === 'json' && comments.length === 0 && ag.filesReviewed() === 0) {
    outputJSONNoFiles(traceID);
    return;
  }

  // Agent-text audiences need stdout back before the summary line.
  if (audience === 'agent' && outputFormat !== 'json') {
    q?.restore();
  }

  if (outputFormat !== 'json') {
    printTraceSummary(
      ag.filesReviewed(),
      comments.length,
      ag.totalInputTokens(),
      ag.totalOutputTokens(),
      ag.totalTokensUsed(),
      ag.totalCacheReadTokens(),
      ag.totalCacheWriteTokens(),
      durationMs,
    );
  }

  if (outputFormat === 'json') {
    outputJSONWithWarnings({
      comments,
      warnings: ag.warnings(),
      filesReviewed: ag.filesReviewed(),
      inputTokens: ag.totalInputTokens(),
      outputTokens: ag.totalOutputTokens(),
      totalTokens: ag.totalTokensUsed(),
      cacheReadTokens: ag.totalCacheReadTokens(),
      cacheWriteTokens: ag.totalCacheWriteTokens(),
      durationMs,
      projectSummary: ag.projectSummary(),
      toolCalls: ag.toolCalls(),
      traceID,
      resumeInfo: ag.resumeInfo?.(),
      sessionID: ag.sessionID(),
    });
    return;
  }
  outputTextWithWarnings(comments, ag.warnings());
  const summary = ag.projectSummary();
  if (summary !== '') {
    console.log(`\n\n──────── Project Summary ────────\n\n${summary}`);
  }
}
