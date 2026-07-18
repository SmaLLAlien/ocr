// Tool names, provider contract and registry. Port of
// internal/tool/definitions.go, stub.go, response_message.go.

export const TOOL_UNKNOWN = 'unknown';
export const TOOL_TASK_DONE = 'task_done';
export const TOOL_CODE_COMMENT = 'code_comment';
export const TOOL_FILE_READ = 'file_read';
export const TOOL_FILE_FIND = 'file_find';
export const TOOL_FILE_READ_DIFF = 'file_read_diff';
export const TOOL_CODE_SEARCH = 'code_search';

const allTools = [
  TOOL_UNKNOWN,
  TOOL_TASK_DONE,
  TOOL_CODE_COMMENT,
  TOOL_FILE_READ,
  TOOL_FILE_FIND,
  TOOL_FILE_READ_DIFF,
  TOOL_CODE_SEARCH,
];

/** Whether name matches any built-in tool name (including "unknown"). */
export function isReserved(name: string): boolean {
  return allTools.includes(name);
}

/** Validates a dynamically discovered (e.g. MCP) tool name. */
export function dynamicToolName(name: string): string {
  if (name === '') throw new Error('tool: Dynamic called with empty name');
  if (isReserved(name)) {
    throw new Error(`tool: Dynamic called with reserved tool name ${JSON.stringify(name)}`);
  }
  return name;
}

export type ToolArgs = Record<string, unknown>;

/** The interface all concrete tool implementations satisfy. */
export interface ToolProvider {
  toolName(): string;
  execute(args: ToolArgs, signal?: AbortSignal): Promise<string>;
}

/** Holds tool providers; safe for concurrent reads after freeze(). */
export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>();
  private frozen = false;

  register(p: ToolProvider): void {
    if (this.frozen) throw new Error('tool: Register called on frozen registry');
    this.providers.set(p.toolName(), p);
  }

  get(name: string): ToolProvider | undefined {
    return this.providers.get(name);
  }

  freeze(): void {
    this.frozen = true;
  }
}

/** Signals completion or carries data back to the LLM. */
export interface TaskCheckpoint {
  data: string;
  completed: boolean;
}

export function checkpointComplete(): TaskCheckpoint {
  return { data: '', completed: true };
}

export function checkpointOf(data: string): TaskCheckpoint {
  return { data, completed: false };
}

/** A single tool call and its execution result. */
export interface ToolCallResult {
  toolCallID: string;
  name: string;
  result: string;
}

export const COMMENT_SUCCEED = 'Successfully commented.';
export const TOOL_NOT_FOUND_MSG =
  'Error: Tool not found. The tool you attempted to call does not exist or is not available. Please check the tool name and try again with a valid tool.';
