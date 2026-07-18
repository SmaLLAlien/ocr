// Entry point. Port of cmd/opencodereview/main.go (hand-rolled dispatch —
// mirrors the Go CLI surface exactly; the "viewer" command is intentionally
// not ported).
import { printVersion } from './version.js';
import { runLLM } from './llm.js';
import { runReview } from './review.js';
import { runRules } from './rules.js';

function notImplemented(cmd: string, milestone: string): never {
  throw new Error(`'ocr ${cmd}' is not implemented yet (${milestone} of the TypeScript port)`);
}

async function dispatch(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printTopLevelUsage();
    return;
  }

  switch (args[0]) {
    case '--version':
    case '-V':
    case 'version':
      printVersion();
      return;
    case 'review':
    case 'r':
      return runReview(args.slice(1));
    case 'scan':
    case 's':
      return notImplemented('scan', 'M5');
    case 'config':
      return notImplemented('config', 'M6');
    case 'llm':
      return runLLM(args.slice(1));
    case 'rules':
      return runRules(args.slice(1));
    case 'session':
    case 'sessions':
      return notImplemented('session', 'M6');
    case '-h':
    case '--help':
      printTopLevelUsage();
      return;
    default:
      throw new Error(`unknown command: ${args[0]}\nRun 'ocr' for usage`);
  }
}

function printTopLevelUsage(): void {
  console.log(`OpenCodeReview - AI-Powered Code Review CLI

Usage:
  ocr [command]

Commands:
  review, r    Start a diff-based code review
  scan, s      Scan entire files (no diff required)
  rules        Inspect and debug review rules
  config       Manage configuration settings
  llm          LLM utility commands
  session, sessions  List and inspect saved review sessions
  version      Show version information

Examples:
  ocr review --from master --to dev        Review diff range
  ocr review --commit abc123               Review a single commit
  ocr scan                                 Scan every reviewable file in the repo
  ocr scan --path internal/agent           Scan a single directory
  ocr config provider                      Interactive provider setup
  ocr config model                         Interactive model selection
  ocr config set llm.model opus-4-6        Set a config value
  ocr llm test                             Test LLM connectivity
  ocr llm providers                        List built-in providers
  ocr session list                         List saved review sessions
  ocr version                              Show version info

Use "ocr review -h" for more information about review.
Use "ocr scan -h" for more information about scan.
Use "ocr rules -h" for more information about rules.
Use "ocr config" for more information about config.
Use "ocr llm" for more information about LLM utilities.
Use "ocr session -h" for more information about session inspection.

GitHub: https://github.com/alibaba/open-code-review`);
}

dispatch().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exitCode = 1;
});
