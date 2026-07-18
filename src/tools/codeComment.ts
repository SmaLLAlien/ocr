// code_comment tool. Port of internal/tool/code_comment.go.
import type { LlmComment } from '../model/index.js';
import type { ToolArgs, ToolProvider } from './registry.js';
import { COMMENT_SUCCEED, TOOL_CODE_COMMENT } from './registry.js';
import type { CommentCollector } from './collector.js';

/** Submits review comments to the per-agent CommentCollector. */
export class CodeCommentProvider implements ToolProvider {
  constructor(private readonly collector: CommentCollector | undefined) {}

  toolName(): string {
    return TOOL_CODE_COMMENT;
  }

  async execute(args: ToolArgs): Promise<string> {
    if (!this.collector) return 'Error: comment collector is not configured';

    const { comments, errMsg } = parseComments(args);
    if (errMsg !== '') return errMsg;

    for (const cm of comments) this.collector.add(cm);
    return COMMENT_SUCCEED;
  }
}

/**
 * Extracts LlmComment entries from tool call arguments without writing to
 * the collector. Returns parsed comments and an error message ('' on success).
 */
export function parseComments(args: ToolArgs): { comments: LlmComment[]; errMsg: string } {
  let rawComments: unknown[] = [];
  const c = args['comments'];
  if (Array.isArray(c) && c.length > 0) {
    rawComments = c;
  } else if (typeof c === 'string' && c !== '') {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (Array.isArray(parsed)) rawComments = parsed;
    } catch (err) {
      return { comments: [], errMsg: `Error: failed to parse 'comments' JSON string: ${(err as Error).message}` };
    }
  }
  if (rawComments.length === 0) {
    return {
      comments: [],
      errMsg: `Error: 'comments' array is required. Got args: ${JSON.stringify(args)}`,
    };
  }

  const comments: LlmComment[] = [];
  for (const raw of rawComments) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;

    const cm: LlmComment = {
      path: typeof args['path'] === 'string' ? args['path'] : '',
      content: typeof obj['content'] === 'string' ? obj['content'] : '',
      start_line: 0,
      end_line: 0,
    };
    if (typeof obj['suggestion_code'] === 'string') cm.suggestion_code = obj['suggestion_code'];
    if (typeof obj['existing_code'] === 'string') cm.existing_code = obj['existing_code'];
    if (typeof obj['thinking'] === 'string') cm.thinking = obj['thinking'];
    if (typeof obj['category'] === 'string') cm.category = obj['category'];
    if (typeof obj['severity'] === 'string') cm.severity = obj['severity'];

    if (cm.path === '' || cm.content === '') continue;
    comments.push(cm);
  }
  return { comments, errMsg: '' };
}
