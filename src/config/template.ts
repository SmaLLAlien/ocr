// Task prompt templates for the review agent. Port of
// internal/config/template/template.go (assets replace go:embed).
import { readAsset } from '../util/assets.js';

/** A preset prompt with settings (mirrors the Java-side LlmConversation). */
export interface LlmConversation {
  timeout: number;
  messages: ChatMessage[];
}

export interface ChatMessage {
  role: string;
  content: string;
}

/** The diff-review task template configuration. */
export interface Template {
  mainTask: LlmConversation;
  planTask?: LlmConversation;
  memoryCompressionTask: LlmConversation;
  maxTokens: number;
  maxToolRequestTimes: number;
  planModeLineThreshold: number;
  reLocationTask?: LlmConversation;
  reviewFilterTask?: LlmConversation;
}

/** The full-file scan template configuration (fully separate pipeline). */
export interface ScanTemplate {
  mainTask: LlmConversation;
  planTask?: LlmConversation;
  memoryCompressionTask: LlmConversation;
  reLocationTask?: LlmConversation;
  maxTokens: number;
  toolRequestWaitTimeMs: number;
  maxToolRequestTimes: number;
  maxSubtaskExecMinutes: number;
  maxFileSizeBytes: number;
  maxTokensBudget: number;
  batchStrategy: string;
  batchSize: number;
  dedupTask?: LlmConversation;
  dedupMinComments: number;
  projectSummaryTask?: LlmConversation;
}

interface ManifestMessage {
  role: string;
  prompt_file: string;
}

interface ManifestConversation {
  timeout: number;
  messages: ManifestMessage[];
}

interface RawConversation {
  timeout?: number;
  messages?: Array<{ role: string; content: string }>;
}

function resolveConversation(m: ManifestConversation): LlmConversation {
  return {
    timeout: m.timeout ?? 0,
    messages: (m.messages ?? []).map((mm) => {
      let data: string;
      try {
        data = readAsset('prompts', mm.prompt_file);
      } catch (err) {
        throw new Error(`read prompt file ${JSON.stringify(mm.prompt_file)}: ${(err as Error).message}`);
      }
      return { role: mm.role, content: data.replace(/[\r\n]+$/, '') };
    }),
  };
}

function resolveOptional(
  m: ManifestConversation | undefined,
  name: string,
): LlmConversation | undefined {
  if (!m) return undefined;
  try {
    return resolveConversation(m);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

/** Parses the bundled task_template.json and resolves prompt file references. */
export function loadDefaultTemplate(): Template {
  interface Manifest {
    MAIN_TASK: ManifestConversation;
    PLAN_TASK?: ManifestConversation;
    MEMORY_COMPRESSION_TASK: ManifestConversation;
    MAX_TOKENS: number;
    MAX_TOOL_REQUEST_TIMES: number;
    PLAN_MODE_LINE_THRESHOLD: number;
    RE_LOCATION_TASK?: ManifestConversation;
    REVIEW_FILTER_TASK?: ManifestConversation;
  }
  let m: Manifest;
  try {
    m = JSON.parse(readAsset('task_template.json')) as Manifest;
  } catch (err) {
    throw new Error(`unmarshal task_template manifest: ${(err as Error).message}`);
  }

  let mainTask: LlmConversation;
  try {
    mainTask = resolveConversation(m.MAIN_TASK);
  } catch (err) {
    throw new Error(`MAIN_TASK: ${(err as Error).message}`);
  }
  let memoryCompressionTask: LlmConversation;
  try {
    memoryCompressionTask = resolveConversation(m.MEMORY_COMPRESSION_TASK);
  } catch (err) {
    throw new Error(`MEMORY_COMPRESSION_TASK: ${(err as Error).message}`);
  }

  return {
    mainTask,
    planTask: resolveOptional(m.PLAN_TASK, 'PLAN_TASK'),
    memoryCompressionTask,
    maxTokens: m.MAX_TOKENS,
    maxToolRequestTimes: m.MAX_TOOL_REQUEST_TIMES,
    planModeLineThreshold: m.PLAN_MODE_LINE_THRESHOLD,
    reLocationTask: resolveOptional(m.RE_LOCATION_TASK, 'RE_LOCATION_TASK'),
    reviewFilterTask: resolveOptional(m.REVIEW_FILTER_TASK, 'REVIEW_FILTER_TASK'),
  };
}

/** Parses the bundled scan_template.json (prompts are inline). */
export function loadScanDefault(): ScanTemplate {
  interface RawScan {
    MAIN_TASK: RawConversation;
    PLAN_TASK?: RawConversation;
    MEMORY_COMPRESSION_TASK: RawConversation;
    RE_LOCATION_TASK?: RawConversation;
    MAX_TOKENS: number;
    TOOL_REQUEST_WAIT_TIME_MS?: number;
    MAX_TOOL_REQUEST_TIMES: number;
    MAX_SUBTASK_EXECUTION_TIME_MINUTES?: number;
    MAX_FILE_SIZE_BYTES?: number;
    MAX_TOKENS_BUDGET?: number;
    BATCH_STRATEGY?: string;
    BATCH_SIZE?: number;
    DEDUP_TASK?: RawConversation;
    DEDUP_MIN_COMMENTS?: number;
    PROJECT_SUMMARY_TASK?: RawConversation;
  }
  let raw: RawScan;
  try {
    raw = JSON.parse(readAsset('scan_template.json')) as RawScan;
  } catch (err) {
    throw new Error(`unmarshal default scan template: ${(err as Error).message}`);
  }
  const conv = (c: RawConversation | undefined): LlmConversation | undefined =>
    c ? { timeout: c.timeout ?? 0, messages: c.messages ?? [] } : undefined;

  return {
    mainTask: conv(raw.MAIN_TASK)!,
    planTask: conv(raw.PLAN_TASK),
    memoryCompressionTask: conv(raw.MEMORY_COMPRESSION_TASK)!,
    reLocationTask: conv(raw.RE_LOCATION_TASK),
    maxTokens: raw.MAX_TOKENS,
    toolRequestWaitTimeMs: raw.TOOL_REQUEST_WAIT_TIME_MS ?? 0,
    maxToolRequestTimes: raw.MAX_TOOL_REQUEST_TIMES,
    maxSubtaskExecMinutes: raw.MAX_SUBTASK_EXECUTION_TIME_MINUTES ?? 0,
    maxFileSizeBytes: raw.MAX_FILE_SIZE_BYTES ?? 0,
    maxTokensBudget: raw.MAX_TOKENS_BUDGET ?? 0,
    batchStrategy: raw.BATCH_STRATEGY ?? '',
    batchSize: raw.BATCH_SIZE ?? 0,
    dedupTask: conv(raw.DEDUP_TASK),
    dedupMinComments: raw.DEDUP_MIN_COMMENTS ?? 0,
    projectSummaryTask: conv(raw.PROJECT_SUMMARY_TASK),
  };
}

function applyLanguageTo(conv: LlmConversation, instruction: string): void {
  for (const m of conv.messages) {
    if (m.role === 'system') m.content += instruction;
  }
}

function resolveLang(lang: string | undefined): string {
  return lang || 'English';
}

/** Injects a language directive into all system-role messages of the template. */
export function applyTemplateLanguage(t: Template, lang: string | undefined): void {
  const instruction = `\n\nAlways respond in ${resolveLang(lang)}.`;
  applyLanguageTo(t.mainTask, instruction);
  if (t.planTask) applyLanguageTo(t.planTask, instruction);
  applyLanguageTo(t.memoryCompressionTask, instruction);
}

export function applyScanTemplateLanguage(t: ScanTemplate, lang: string | undefined): void {
  const instruction = `\n\nAlways respond in ${resolveLang(lang)}.`;
  applyLanguageTo(t.mainTask, instruction);
  if (t.planTask) applyLanguageTo(t.planTask, instruction);
  if (t.dedupTask) applyLanguageTo(t.dedupTask, instruction);
  if (t.projectSummaryTask) applyLanguageTo(t.projectSummaryTask, instruction);
  applyLanguageTo(t.memoryCompressionTask, instruction);
}

export function validateTemplate(t: Template): void {
  if (t.maxTokens <= 0) throw new Error('max_tokens must be positive');
  if (t.maxToolRequestTimes <= 0) throw new Error('max_tool_request_times must be positive');
  if (t.mainTask.messages.length === 0) throw new Error('main_task.messages must not be empty');
}

export function validateScanTemplate(t: ScanTemplate): void {
  if (t.maxTokens <= 0) throw new Error('scan: max_tokens must be positive');
  if (t.maxToolRequestTimes <= 0) throw new Error('scan: max_tool_request_times must be positive');
  if (t.mainTask.messages.length === 0) throw new Error('scan: main_task.messages must not be empty');
}
