// file_read_diff tool. Port of internal/tool/file_read_diff.go.
import type { ToolArgs, ToolProvider } from './registry.js';
import { TOOL_FILE_READ_DIFF } from './registry.js';

/** Read-only snapshot of parsed diffs, keyed by file path. */
export class DiffMap {
  private readonly m: Map<string, string>;

  constructor(m: Record<string, string> | Map<string, string> = {}) {
    this.m = m instanceof Map ? new Map(m) : new Map(Object.entries(m));
  }

  get(path: string): string | undefined {
    return this.m.get(path);
  }
}

/** Retrieves diff content by file path from an already-parsed diff set. */
export class FileReadDiffProvider implements ToolProvider {
  private diffMap: DiffMap;

  constructor(dm: DiffMap = new DiffMap()) {
    this.diffMap = dm;
  }

  /** Replaces the diff snapshot. Call before concurrent access begins. */
  setDiffMap(dm: DiffMap): void {
    this.diffMap = dm;
  }

  toolName(): string {
    return TOOL_FILE_READ_DIFF;
  }

  async execute(args: ToolArgs): Promise<string> {
    const pathArray = Array.isArray(args['path_array']) ? args['path_array'] : [];
    if (pathArray.length === 0) return 'Error: no files found';

    let sb = '';
    for (const item of pathArray) {
      if (typeof item !== 'string') continue;
      const d = this.diffMap.get(item);
      if (d !== undefined) {
        sb += `==== FILE: ${item} ====\n${d}\n`;
      }
    }

    if (sb === '') return 'Error: diff not found for the requested paths';
    return sb;
  }
}
