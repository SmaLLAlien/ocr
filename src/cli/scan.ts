// ocr scan. Port of cmd/opencodereview/scan_cmd.go.
import {
  applyScanTemplateLanguage,
  loadScanDefault,
  validateScanTemplate,
  type ScanTemplate,
} from '../config/template.js';
import { ScanAgent } from '../scan/agent.js';
import { CommentCollector } from '../tools/collector.js';
import { FileReader, ReviewMode } from '../tools/fileReader.js';
import { ToolRegistry } from '../tools/registry.js';
import { FileReadProvider } from '../tools/fileRead.js';
import { FileFindProvider } from '../tools/fileFind.js';
import { FileReadDiffProvider } from '../tools/fileReadDiff.js';
import { CodeSearchProvider } from '../tools/codeSearch.js';
import { CodeCommentProvider } from '../tools/codeComment.js';
import { CommentWorkerPool } from '../loop/pool.js';
import { OcrFlagSet, splitPaths } from './flags.js';
import {
  QuietHandle,
  applyCLIExcludes,
  emitRunResult,
  excludeToolDef,
  loadCommonContext,
  loadLLMRuntime,
  type CommonContext,
} from './shared.js';
import { outputPreviewText } from './output.js';

interface ScanOptions {
  toolConfigPath: string;
  rulePath: string;
  repoDir: string;
  paths: string;
  excludes: string;
  outputFormat: string;
  audience: string;
  background: string;
  concurrency: number;
  perFileTimeout: number;
  maxTools: number;
  maxGitProcs: number;
  preview: boolean;
  noPlan: boolean;
  noDedup: boolean;
  noSummary: boolean;
  batch: string;
  maxTokensBudget: number;
  model: string;
  showHelp: boolean;
}

function parseScanFlags(args: string[]): ScanOptions {
  const a = new OcrFlagSet('ocr scan');

  a.string('tools', '');
  a.string('rule', '');
  a.string('repo', '');
  a.string('path', '');
  a.string('exclude', '');
  a.string('format', 'text', 'f');
  a.int('concurrency', 8);
  a.int('timeout', 10);
  a.string('audience', 'human');
  a.string('background', '', 'b');
  a.int('max-tools', 0);
  a.int('max-git-procs', 16);
  a.bool('preview', false, 'p');
  a.bool('no-plan', false);
  a.bool('no-dedup', false);
  a.bool('no-summary', false);
  a.string('batch', '');
  a.int('max-tokens-budget', 0);
  a.string('model', '');

  try {
    a.parse(args);
  } catch (err) {
    throw new Error(`parse flags: ${(err as Error).message}`);
  }

  const opts: ScanOptions = {
    toolConfigPath: a.getString('tools'),
    rulePath: a.getString('rule'),
    repoDir: a.getString('repo'),
    paths: a.getString('path'),
    excludes: a.getString('exclude'),
    outputFormat: a.getString('format'),
    audience: a.getString('audience'),
    background: a.getString('background'),
    concurrency: a.getInt('concurrency'),
    perFileTimeout: a.getInt('timeout'),
    maxTools: a.getInt('max-tools'),
    maxGitProcs: a.getInt('max-git-procs'),
    preview: a.getBool('preview'),
    noPlan: a.getBool('no-plan'),
    noDedup: a.getBool('no-dedup'),
    noSummary: a.getBool('no-summary'),
    batch: a.getString('batch'),
    maxTokensBudget: a.getInt('max-tokens-budget'),
    model: a.getString('model'),
    showHelp: a.showHelp,
  };

  if (opts.showHelp) return opts;

  if (opts.audience !== 'human' && opts.audience !== 'agent') {
    throw new Error(`invalid --audience value ${JSON.stringify(opts.audience)}: must be 'human' or 'agent'`);
  }
  if (opts.maxTools < 0) {
    throw new Error('--max-tools must be a non-negative integer (0 means use template default)');
  }
  if (opts.maxGitProcs < 0) {
    throw new Error('--max-git-procs must be a non-negative integer (0 means use default 16)');
  }
  if (opts.maxTokensBudget < 0) {
    throw new Error('--max-tokens-budget must be a non-negative integer (0 means unlimited)');
  }
  return opts;
}

export async function runScan(args: string[]): Promise<void> {
  const opts = parseScanFlags(args);
  if (opts.showHelp) {
    printScanUsage();
    return;
  }

  // scan path: git preferred but not required; provider falls back to a walk.
  const cc = loadCommonContext(opts.repoDir, opts.rulePath, opts.maxTools, opts.maxGitProcs, false);
  applyCLIExcludes(cc, splitPaths(opts.excludes));

  // scan owns its own template independent from the diff-review one.
  let scanTpl: ScanTemplate;
  try {
    scanTpl = loadScanDefault();
  } catch (err) {
    throw new Error(`load scan template: ${(err as Error).message}`);
  }
  try {
    validateScanTemplate(scanTpl);
  } catch (err) {
    throw new Error(`invalid scan template: ${(err as Error).message}`);
  }
  if (opts.maxTools > scanTpl.maxToolRequestTimes) {
    scanTpl.maxToolRequestTimes = opts.maxTools;
  }
  if (opts.batch !== '') {
    scanTpl.batchStrategy = opts.batch;
  }
  let budget = scanTpl.maxTokensBudget;
  if (opts.maxTokensBudget > 0) budget = opts.maxTokensBudget;

  const scanPaths = splitPaths(opts.paths);

  if (opts.preview) {
    return runScanPreview(cc, scanTpl, scanPaths);
  }

  const rt = loadLLMRuntime(cc.template, opts.toolConfigPath, opts.model);
  // Apply language to the scan template too (loadLLMRuntime only mutates
  // the diff-review template it was handed).
  applyScanTemplateLanguage(scanTpl, rt.appCfg?.language);

  // file_read_diff is meaningless in scan mode (no diff exists).
  const scanToolDefs = excludeToolDef(rt.mainToolDefs, 'file_read_diff');

  // Scan mode always reads file contents from the working tree.
  const fileReader = new FileReader(cc.repoDir, ReviewMode.Workspace, '', cc.gitRunner);
  const tools = buildToolRegistry(rt.collector, fileReader);

  const ag = new ScanAgent({
    repoDir: cc.repoDir,
    paths: scanPaths,
    template: scanTpl,
    systemRule: cc.resolver,
    fileFilter: cc.fileFilter,
    llmClient: rt.client,
    tools,
    mainToolDefs: scanToolDefs,
    commentCollector: rt.collector,
    commentWorkerPool: new CommentWorkerPool(opts.concurrency),
    maxConcurrency: opts.concurrency,
    concurrentTaskTimeout: opts.perFileTimeout,
    model: rt.model,
    background: opts.background,
    gitRunner: cc.gitRunner,
    maxFileSizeBytes: scanTpl.maxFileSizeBytes,
    maxTokensBudget: budget,
    skipPlan: opts.noPlan,
    skipDedup: opts.noDedup,
    skipSummary: opts.noSummary,
  });

  const q = new QuietHandle(opts.outputFormat, opts.audience);
  const startTime = Date.now();

  let comments;
  try {
    comments = await ag.run();
  } catch (err) {
    q.restore();
    const id = ag.sessionID();
    if (id !== '') process.stderr.write(`[ocr] Session: ${id}\n`);
    throw new Error(`scan failed: ${(err as Error).message}`);
  }

  try {
    emitRunResult(ag, comments, startTime, opts.outputFormat, opts.audience, q);
  } finally {
    q.restore();
  }
}

async function runScanPreview(
  cc: CommonContext,
  scanTpl: ScanTemplate,
  scanPaths: string[],
): Promise<void> {
  const ag = new ScanAgent({
    repoDir: cc.repoDir,
    paths: scanPaths,
    fileFilter: cc.fileFilter,
    gitRunner: cc.gitRunner,
    maxFileSizeBytes: scanTpl.maxFileSizeBytes,
    template: scanTpl,
  });

  let preview;
  try {
    preview = await ag.preview();
  } catch (err) {
    throw new Error(`scan preview failed: ${(err as Error).message}`);
  }
  outputPreviewText(preview);
}

function buildToolRegistry(collector: CommentCollector, fr: FileReader): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(new FileReadProvider(fr));
  reg.register(new FileFindProvider(fr));
  reg.register(new FileReadDiffProvider());
  reg.register(new CodeSearchProvider(fr));
  reg.register(new CodeCommentProvider(collector));
  return reg;
}

function printScanUsage(): void {
  console.log(`OpenCodeReview - Full-File Scan

Usage:
  ocr scan [flags]
  ocr s    [flags]                (alias)

Examples:
  # Scan the entire repository (default when no --path is given)
  ocr scan

  # Scan a single directory
  ocr scan --path internal/agent

  # Scan multiple files
  ocr scan --path internal/agent/agent.go,internal/diff/scan.go

  # Exclude generated files / fixtures
  ocr scan --exclude '**/generated/*,**/testdata/*'

  # Preview which files would be scanned without calling the LLM
  ocr scan --preview

  # Skip the per-file PLAN_TASK pre-pass (saves ~1 LLM call per file, may
  # reduce review focus)
  ocr scan --no-plan

Flags:
  --path string           comma-separated repo-relative dirs/files to scan (default: whole repo)
  --exclude string        comma-separated gitignore-style patterns to exclude (merged with rule.json)
  --no-plan               skip the per-file PLAN_TASK pre-pass (faster, less focused)
  --no-dedup              skip the per-batch DEDUP_TASK (keeps raw comments)
  --no-summary            skip the post-run PROJECT_SUMMARY_TASK
  --batch string          override BATCH_STRATEGY: none | by-language | by-directory
  --max-tokens-budget int cap total token usage; dispatch stops once exceeded (0 = unlimited)
  --model string          override LLM model for this scan (e.g., claude-opus-4-6)
  --audience string       output audience: human (show progress) or agent (summary only) (default "human")
  -b, --background string optional requirement/business context for the scan
  -f, --format string     output format: text or json (default "text")
  --concurrency int       max concurrent file scans (default 8)
  --max-git-procs int     max concurrent git subprocesses (default 16)
  --max-tools int         max tool call rounds per file; only takes effect when greater than template default
  -p, --preview           preview which files will be scanned without running the LLM
  --repo string           root directory of the git repository (default: current dir)
  --rule string           path to JSON file with system review rules
  --timeout int           concurrent task timeout in minutes (default 10)
  --tools string          path to JSON tools config file (default: embedded)`);
}
