// Port of cmd/opencodereview/llm_cmd.go.
import { listProviders } from '../llm/providers.js';
import { resolveEndpoint } from '../llm/resolver.js';
import { newLLMClient } from '../llm/client.js';
import { responseContent, type Message } from '../llm/types.js';
import { loadAppConfig, resolveConfigPath } from '../config/appConfig.js';
import { applyLanguage, loadTestConnectionDefault } from '../config/testconnection.js';
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

export async function runLLMTest(): Promise<void> {
  const cfgPath = resolveConfigPath();

  let appCfg;
  try {
    appCfg = loadAppConfig(cfgPath);
  } catch (err) {
    throw new Error(`load config: ${(err as Error).message}`);
  }

  let ep;
  try {
    ep = resolveEndpoint(cfgPath);
  } catch (err) {
    throw new Error(`resolve LLM endpoint: ${(err as Error).message}`);
  }

  let task;
  try {
    task = loadTestConnectionDefault();
  } catch (err) {
    throw new Error(`load test task config: ${(err as Error).message}`);
  }
  applyLanguage(task, appCfg?.language);

  let timeoutMs = 30_000;
  if (task.timeout > 0) timeoutMs = task.timeout * 1000;

  const llmClient = newLLMClient(ep);

  const messages: Message[] = task.messages.map((m) => ({ role: m.role, content: m.content }));

  let resp;
  try {
    resp = await llmClient.completions(
      { model: ep.model, messages, maxTokens: 2048 },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (err) {
    throw new Error(`llm request failed: ${(err as Error).message}`);
  }

  const model = resp.model !== '' ? resp.model : ep.model;
  console.log(`Source: ${ep.source}`);
  console.log(`URL:    ${ep.url}`);
  console.log(`Model:  ${model}`);

  let content = responseContent(resp);
  if (content === '') content = '(empty response)';
  console.log(content);
  console.log('✓ Connection test successful');
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
