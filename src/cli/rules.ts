// ocr rules. Port of cmd/opencodereview/rules_cmd.go.
import { newResolver } from '../config/rules.js';
import { OcrFlagSet } from './flags.js';
import { resolveRepoDir } from './shared.js';

export async function runRules(args: string[]): Promise<void> {
  if (args.length === 0) {
    printRulesUsage();
    return;
  }
  switch (args[0]) {
    case 'check':
      return runRulesCheck(args.slice(1));
    case '-h':
    case '--help':
      printRulesUsage();
      return;
    default:
      throw new Error(`unknown rules sub-command: ${args[0]}\nRun 'ocr rules -h' for usage`);
  }
}

async function runRulesCheck(args: string[]): Promise<void> {
  const a = new OcrFlagSet('ocr rules check');
  a.string('repo', '');
  a.string('rule', '');
  a.parse(args);
  if (a.showHelp) {
    printRulesCheckUsage();
    return;
  }

  if (a.rest.length === 0) {
    printRulesCheckUsage();
    return;
  }
  const filePath = a.rest[0]!;

  const resolvedRepo = resolveRepoDir(a.getString('repo'));

  let resolver;
  try {
    resolver = newResolver(resolvedRepo, a.getString('rule')).resolver;
  } catch (err) {
    throw new Error(`load rules: ${(err as Error).message}`);
  }

  const detail = resolver.resolveDetail(filePath.toLowerCase());

  const sourceLabel: Record<string, string> = {
    custom: 'Custom (--rule)',
    project: 'Project (.opencodereview/rule.json)',
    global: 'Global (~/.opencodereview/rule.json)',
    system: 'System built-in',
  };

  console.log(`File: ${filePath}`);
  console.log(`Source: ${sourceLabel[detail.source]}`);
  console.log(`Pattern: ${detail.pattern}`);
  console.log('Rule:');
  console.log('─'.repeat(40));
  console.log(detail.rule);
  console.log('─'.repeat(40));
}

function printRulesUsage(): void {
  console.log(`Usage:
  ocr rules <sub-command>

Sub-commands:
  check <file>   Show which review rule applies to a given file path

Use "ocr rules check -h" for more information.`);
}

function printRulesCheckUsage(): void {
  console.log(`Usage:
  ocr rules check [flags] <file-path>

Show which review rule applies to the given file path, including its source layer and matched pattern.

Flags:
  --repo    Root directory of the git repository (default: current dir)
  --rule    Path to a custom rule JSON file

Examples:
  ocr rules check src/main/java/com/example/Foo.java
  ocr rules check --rule custom.json src/main/resources/mapper/UserMapper.xml`);
}
