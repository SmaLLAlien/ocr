// LLM fallback for comment re-location. Port of internal/diff/relocation.go.
import type { Diff, LlmComment } from '../model/index.js';
import type { LlmConversation } from '../config/template.js';
import type { ChatResponse, LLMClient, Message } from '../llm/types.js';
import { newTextMessage, responseContent } from '../llm/types.js';
import { resolveComment } from './resolver.js';

export interface ReLocateResult {
  success: boolean;
  response?: ChatResponse;
  messages?: Message[];
}

/**
 * Calls the LLM to regenerate a precise existing_code snippet when
 * text-based matching fails, then retries resolveComment with the new
 * snippet. Returns response + request messages so the caller can record
 * session history and token usage.
 */
export async function reLocateComment(
  cm: LlmComment,
  d: Diff,
  client: LLMClient,
  task: LlmConversation | undefined,
  modelName: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<ReLocateResult> {
  if (!task || task.messages.length === 0) return { success: false };

  let combined = signal;
  if (task.timeout > 0) {
    const timeout = AbortSignal.timeout(task.timeout * 1000);
    combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  const messages: Message[] = task.messages.map((m) => {
    let content = m.content;
    content = content.replaceAll('{diff}', d.diff);
    content = content.replaceAll('{existing_code}', cm.existing_code ?? '');
    content = content.replaceAll('{suggestion_content}', cm.content);
    return newTextMessage(m.role, content);
  });

  let resp: ChatResponse;
  try {
    resp = await client.completions(
      { model: modelName, messages, maxTokens },
      { signal: combined },
    );
  } catch (err) {
    process.stderr.write(
      `[ocr] Re-location LLM call failed for ${cm.path}: ${(err as Error).message}\n`,
    );
    return { success: false, messages };
  }

  const code = extractCodeBlock(responseContent(resp));
  if (code === '') return { success: false, response: resp, messages };

  const original = cm.existing_code;
  cm.existing_code = code;
  if (resolveComment(cm, d)) {
    return { success: true, response: resp, messages };
  }
  cm.existing_code = original;
  return { success: false, response: resp, messages };
}

/** Extracts the content of the first fenced code block ("" when none). */
export function extractCodeBlock(text: string): string {
  text = text.trim();
  const start = text.indexOf('```');
  if (start < 0) return '';
  let afterOpen = start + 3;
  // Skip optional language tag on the opening fence line.
  const nl = text.slice(afterOpen).indexOf('\n');
  if (nl >= 0) afterOpen += nl + 1;
  else return '';
  const end = text.slice(afterOpen).indexOf('```');
  if (end < 0) return '';
  return text.slice(afterOpen, afterOpen + end).trim();
}
