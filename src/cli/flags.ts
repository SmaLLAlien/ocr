// Flag parsing with short-flag expansion. Port of the ocrFlagSet half of
// cmd/opencodereview/flags.go (Go stdlib `flag` semantics: --name and -name
// both accepted, --name=value or --name value, parsing stops at the first
// non-flag argument).

type FlagKind = 'string' | 'bool' | 'int';

interface FlagDef {
  kind: FlagKind;
  value: string | boolean | number;
}

export class OcrFlagSet {
  private readonly flags = new Map<string, FlagDef>();
  private readonly shortMap = new Map<string, string>();
  showHelp = false;
  /** Positional arguments left after parsing. */
  rest: string[] = [];

  constructor(private readonly name: string) {}

  string(name: string, def: string, shorthand = ''): void {
    if (shorthand !== '') this.shortMap.set(shorthand, name);
    this.flags.set(name, { kind: 'string', value: def });
  }

  bool(name: string, def: boolean, shorthand = ''): void {
    if (shorthand !== '') this.shortMap.set(shorthand, name);
    this.flags.set(name, { kind: 'bool', value: def });
  }

  int(name: string, def: number, shorthand = ''): void {
    if (shorthand !== '') this.shortMap.set(shorthand, name);
    this.flags.set(name, { kind: 'int', value: def });
  }

  getString(name: string): string {
    return this.flags.get(name)!.value as string;
  }

  getBool(name: string): boolean {
    return this.flags.get(name)!.value as boolean;
  }

  getInt(name: string): number {
    return this.flags.get(name)!.value as number;
  }

  parse(args: string[]): void {
    const expanded = expandShortFlags(args, this.shortMap);

    for (const arg of expanded) {
      if (arg === '-h' || arg === '--help') {
        this.showHelp = true;
        return;
      }
    }

    let i = 0;
    while (i < expanded.length) {
      const arg = expanded[i]!;
      if (arg === '--') {
        i++;
        break;
      }
      if (!arg.startsWith('-') || arg === '-') break; // first non-flag stops parsing

      let body = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
      let inlineValue: string | undefined;
      const eq = body.indexOf('=');
      if (eq >= 0) {
        inlineValue = body.slice(eq + 1);
        body = body.slice(0, eq);
      }

      const def = this.flags.get(body);
      if (!def) {
        throw new Error(`flag provided but not defined: -${body}`);
      }

      if (def.kind === 'bool') {
        if (inlineValue !== undefined) {
          const lower = inlineValue.toLowerCase();
          if (!['true', 'false', '1', '0', 't', 'f'].includes(lower)) {
            throw new Error(`invalid boolean value ${JSON.stringify(inlineValue)} for -${body}`);
          }
          def.value = lower === 'true' || lower === '1' || lower === 't';
        } else {
          def.value = true;
        }
        i++;
        continue;
      }

      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
        i++;
      } else {
        if (i + 1 >= expanded.length) {
          throw new Error(`flag needs an argument: -${body}`);
        }
        value = expanded[i + 1]!;
        i += 2;
      }

      if (def.kind === 'int') {
        if (!/^-?\d+$/.test(value)) {
          throw new Error(`invalid value ${JSON.stringify(value)} for flag -${body}: parse error`);
        }
        def.value = Number(value);
      } else {
        def.value = value;
      }
    }

    this.rest = expanded.slice(i);
  }
}

/**
 * Replaces standalone -X args with their long equivalents. Only triggers when
 * the arg is exactly -N (single char after dash).
 */
export function expandShortFlags(args: string[], shortMap: Map<string, string>): string[] {
  return args.map((arg) => {
    if (arg.length === 2 && arg[0] === '-' && arg[1] !== '-') {
      const full = shortMap.get(arg[1]!);
      if (full) return `--${full}`;
    }
    return arg;
  });
}

/** Splits a comma-separated list, trimming and dropping empties. */
export function splitPaths(raw: string): string[] {
  if (raw === '') return [];
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

// --- review subcommand options ---

export interface ReviewOptions {
  toolConfigPath: string;
  rulePath: string;
  repoDir: string;
  from: string;
  to: string;
  commit: string;
  resume: string;
  excludes: string;
  outputFormat: string;
  audience: string;
  background: string;
  backgroundFile: string;
  model: string;
  concurrency: number;
  perFileTimeout: number;
  maxTools: number;
  maxGitProcs: number;
  preview: boolean;
  showHelp: boolean;
}

export function parseReviewFlags(args: string[]): ReviewOptions {
  const a = new OcrFlagSet('ocr review');

  a.string('tools', '');
  a.string('rule', '');
  a.string('repo', '');
  a.string('from', '');
  a.string('to', '');
  a.string('commit', '', 'c');
  a.string('resume', '');
  a.string('exclude', '');
  a.string('format', 'text', 'f');
  a.int('concurrency', 8);
  a.int('timeout', 10);
  a.string('audience', 'human');
  a.string('background', '', 'b');
  a.string('background-file', '', 'B');
  a.string('model', '');
  a.int('max-tools', 0);
  a.int('max-git-procs', 16);
  a.bool('preview', false, 'p');

  try {
    a.parse(args);
  } catch (err) {
    throw new Error(`parse flags: ${(err as Error).message}`);
  }

  const opts: ReviewOptions = {
    toolConfigPath: a.getString('tools'),
    rulePath: a.getString('rule'),
    repoDir: a.getString('repo'),
    from: a.getString('from'),
    to: a.getString('to'),
    commit: a.getString('commit'),
    resume: a.getString('resume'),
    excludes: a.getString('exclude'),
    outputFormat: a.getString('format'),
    audience: a.getString('audience'),
    background: a.getString('background'),
    backgroundFile: a.getString('background-file'),
    model: a.getString('model'),
    concurrency: a.getInt('concurrency'),
    perFileTimeout: a.getInt('timeout'),
    maxTools: a.getInt('max-tools'),
    maxGitProcs: a.getInt('max-git-procs'),
    preview: a.getBool('preview'),
    showHelp: a.showHelp,
  };

  if (opts.showHelp) return opts;

  let modeCount = 0;
  if (opts.from !== '' || opts.to !== '') modeCount++;
  if (opts.commit !== '') modeCount++;
  // modeCount == 0 → workspace mode (allowed)
  if (modeCount > 1) {
    throw new Error('only one review mode allowed (--from/--to or --commit)');
  }
  if (opts.from !== '' && opts.to === '') {
    throw new Error('--to is required when --from is specified');
  }
  if (opts.to !== '' && opts.from === '') {
    throw new Error('--from is required when --to is specified');
  }
  if (opts.preview && opts.resume !== '') {
    throw new Error('--preview and --resume cannot be used together');
  }

  if (opts.audience !== 'human' && opts.audience !== 'agent') {
    throw new Error(`invalid --audience value ${JSON.stringify(opts.audience)}: must be 'human' or 'agent'`);
  }

  const minMaxTools = 10;
  if (opts.maxTools < 0) {
    throw new Error('--max-tools must be a non-negative integer (0 means use template default)');
  }
  if (opts.maxTools > 0 && opts.maxTools < minMaxTools) {
    process.stderr.write(
      `[ocr] --max-tools ${opts.maxTools} is below minimum ${minMaxTools}, using ${minMaxTools}\n`,
    );
    opts.maxTools = minMaxTools;
  }

  if (opts.maxGitProcs < 0) {
    throw new Error('--max-git-procs must be a non-negative integer (0 means use default 16)');
  }

  return opts;
}

export function printReviewUsage(): void {
  console.log(`OpenCodeReview - AI-Powered Code Review CLI

Usage:
  ocr review [flags]
  ocr r [flags]                (alias)

Examples:
  # Review staged + unstaged + untracked changes in current workspace
  ocr review

  # Review a branch against its base (merge-base mode)
  ocr review --from master --to dev-ref

  # Review a specific commit
  ocr review --commit abc123
  ocr review -c abc123

  # Resume a previous range review
  ocr review --from master --to dev-ref --resume <session-id>

  # Output JSON format
  ocr review --format json
  ocr review -f json

  # Agent mode (summary only, no progress lines)
  ocr review --audience agent

  # Preview which files will be reviewed
  ocr review --preview
  ocr review -c abc123 -p

  # Provide requirement/business context inline, from a Markdown file, or both
  ocr review --background "Adding rate limiting to the login API"
  ocr review --background-file ./docs/requirements.md
  ocr review --background "Focus on auth" --background-file ./docs/requirements.md

Flags:
  --audience string             output audience: human (show progress) or agent (summary only) (default "human")
  -b, --background string       optional requirement/business context for the review
  -B, --background-file string  path to a Markdown file used as review background (combined with --background; inline value appears first when both are set)
  -c, --commit string           single commit hash or tag to review (vs its parent)
  -f, --format string           output format: text or json (default "text")
  --concurrency int             max concurrent file reviews (default 8)
  --max-git-procs int           max concurrent git subprocesses (default 16)
  --from string                 source ref to start diff from (e.g., 'main')
  --max-tools int               max tool call rounds per file (0 = template default; min 10)
  --model string                override LLM model for this review (e.g., claude-opus-4-6)
  -p, --preview                 preview which files will be reviewed without running the LLM
  --repo string                 root directory of the git repository (default: current dir)
  --resume string               resume from a previous review session id
  --rule string                 path to JSON file with system review rules
  --timeout int                 concurrent task timeout in minutes (default 10)
  --to string                   target ref to end diff at (e.g., 'feature-branch')
  --tools string                path to JSON tools config file (default: embedded)`);
}
