// Port of cmd/opencodereview/llm_cmd.go.
import { listProviders } from '../llm/providers.js';
import { renderTable } from './table.js';

export async function runLLM(args: string[]): Promise<void> {
  if (args.length === 0) {
    printLLMUsage();
    return;
  }
  switch (args[0]) {
    case 'test':
      return runLLMTest();
    case 'providers':
      runLLMProviders();
      return;
    default:
      throw new Error(`unknown llm sub-command: ${args[0]}\nRun 'ocr llm' for usage`);
  }
}

async function runLLMTest(): Promise<void> {
  // M2: resolver + clients + test-connection task.
  throw new Error('llm test is not implemented yet (M2)');
}

function runLLMProviders(): void {
  const providers = listProviders();
  console.log('\nBuilt-in providers:');
  const rows: string[][] = [
    ['NAME', 'PROTOCOL', 'BASE URL'],
    ['----', '--------', '--------'],
    ...providers.map((p) => [p.name, p.protocol, p.baseUrl]),
  ];
  console.log(renderTable(rows));
  console.log("\nUse 'ocr config provider' to configure a provider interactively.");
  console.log("Use 'ocr config set provider <name>' to switch providers non-interactively.");
}

function printLLMUsage(): void {
  console.log(`LLM utility commands.

Usage:
  ocr llm <sub-command>

Sub-commands:
  test         Send a test conversation to the configured LLM model
  providers    List all built-in LLM providers

Examples:
  ocr llm test                   Verify LLM connectivity and configuration
  ocr llm providers              List available built-in providers`);
}
