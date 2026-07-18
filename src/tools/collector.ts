// Per-agent comment store. Port of internal/tool/comment_collector.go
// (mutex dropped — single-threaded event loop).
import type { LlmComment } from '../model/index.js';

export class CommentCollector {
  private comments: LlmComment[] = [];

  add(cm: LlmComment): void {
    this.comments.push(cm);
  }

  all(): LlmComment[] {
    return [...this.comments];
  }

  forPath(path: string): LlmComment[] {
    return this.comments.filter((cm) => cm.path === path);
  }

  /** Current count; pair with since/replaceSince for batch windows. */
  snapshot(): number {
    return this.comments.length;
  }

  since(start: number): LlmComment[] {
    if (start < 0) start = 0;
    if (start >= this.comments.length) return [];
    return this.comments.slice(start);
  }

  /** Replaces comments[start:] with replacements (batch-level dedup). */
  replaceSince(start: number, replacements: LlmComment[]): void {
    if (start < 0) start = 0;
    if (start > this.comments.length) return;
    this.comments = [...this.comments.slice(0, start), ...replacements];
  }

  /**
   * Removes comments for a given path whose per-path index (0-based position
   * among all comments with that path) is in the indices set.
   */
  removeByPathAndIndices(path: string, indices: Set<number>): void {
    const kept: LlmComment[] = [];
    let pathIdx = 0;
    for (const cm of this.comments) {
      if (cm.path === path) {
        if (indices.has(pathIdx)) {
          pathIdx++;
          continue;
        }
        pathIdx++;
      }
      kept.push(cm);
    }
    this.comments = kept;
  }
}
