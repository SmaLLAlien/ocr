// file_read tool. Port of internal/tool/file_read.go.
import type { ToolArgs, ToolProvider } from './registry.js';
import { TOOL_FILE_READ } from './registry.js';
import type { FileReader } from './fileReader.js';

const FILE_READ_MAX_LINES = 500;

/** Reads file content at a given path and optional line range. */
export class FileReadProvider implements ToolProvider {
  constructor(private readonly fileReader: FileReader) {}

  toolName(): string {
    return TOOL_FILE_READ;
  }

  async execute(args: ToolArgs, signal?: AbortSignal): Promise<string> {
    const filePath = typeof args['file_path'] === 'string' ? args['file_path'] : '';
    if (filePath === '') return 'Error: file_path is required';

    let startLine = typeof args['start_line'] === 'number' ? args['start_line'] : 0;
    let endLine = typeof args['end_line'] === 'number' ? args['end_line'] : 0;
    if (startLine <= 0) startLine = 1;
    if (endLine <= 0) endLine = 0;
    startLine = Math.trunc(startLine);
    endLine = Math.trunc(endLine);

    let maxLines = FILE_READ_MAX_LINES;
    if (endLine > 0) {
      const requested = endLine - startLine + 1;
      if (requested <= 0) {
        throw new Error(`invalid line range: start_line ${startLine} is greater than end_line ${endLine}`);
      }
      if (requested < maxLines) maxLines = requested;
    }

    let lines: string[];
    let totalLines: number;
    try {
      ({ lines, totalLines } = await this.fileReader.readLines(filePath, startLine, maxLines, signal));
    } catch (err) {
      throw new Error(`file ${JSON.stringify(filePath)} not found: ${(err as Error).message}`);
    }

    if (totalLines > 0 && startLine - 1 >= totalLines) {
      throw new Error(
        `file ${JSON.stringify(filePath)} has only ${totalLines} lines, requested range ${startLine}-${endLine}`,
      );
    }

    let effectiveEnd = totalLines;
    if (endLine > 0 && endLine < effectiveEnd) effectiveEnd = endLine;
    const fullRange = effectiveEnd - (startLine - 1);
    const truncated = fullRange > FILE_READ_MAX_LINES;

    const displayEnd = startLine - 1 + lines.length;

    let sb = `File: ${filePath} (Total lines: ${totalLines})\n`;
    sb += `IS_TRUNCATED: ${truncated}\n`;
    sb += `LINE_RANGE: ${startLine}-${displayEnd}\n`;
    lines.forEach((line, i) => {
      sb += `${startLine + i}|${line}\n`;
    });
    if (truncated) {
      sb += `\nNote: Results truncated to ${FILE_READ_MAX_LINES} lines. Please narrow your line range.\n`;
    }
    return sb;
  }
}
