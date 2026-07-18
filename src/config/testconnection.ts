// LLM connectivity-test conversation. Port of internal/config/testconnection.
import { readAsset } from '../util/assets.js';

export interface ChatMessage {
  role: string;
  content: string;
}

/** A single conversation preset for testing. */
export interface LlmConversation {
  timeout: number;
  messages: ChatMessage[];
}

interface TestTaskFile {
  TEST_TASK: LlmConversation;
}

/** Parses the bundled testconnection task and returns the TEST_TASK conversation. */
export function loadTestConnectionDefault(): LlmConversation {
  let parsed: TestTaskFile;
  try {
    parsed = JSON.parse(readAsset('testconnection.json')) as TestTaskFile;
  } catch (err) {
    throw new Error(`unmarshal test task config: ${(err as Error).message}`);
  }
  return parsed.TEST_TASK;
}

function resolveLang(lang: string | undefined): string {
  return lang || 'English';
}

/** Injects a language directive into all system-role messages. */
export function applyLanguage(c: LlmConversation, lang: string | undefined): void {
  const instruction = `\n\nAlways respond in ${resolveLang(lang)}.`;
  for (const m of c.messages) {
    if (m.role === 'system') m.content += instruction;
  }
}
