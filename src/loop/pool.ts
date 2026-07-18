// Async comment post-processing pool. Port of internal/llmloop/pool.go.
import type { LlmComment } from '../model/index.js';
import { Semaphore } from '../util/semaphore.js';
import { out } from '../util/logger.js';

/** A non-fatal warning recorded during a per-file review/scan. */
export interface AgentWarning {
  file: string;
  message: string;
  type: string;
}

/**
 * Fixed-size pool of workers for code-review comment post-steps (line-range
 * tracking, re-location) run off the main tool-use loop. Errors and thrown
 * exceptions are contained per unit of work.
 */
export class CommentWorkerPool {
  private readonly sem: Semaphore;
  private readonly pending: Array<Promise<void>> = [];
  private results: LlmComment[] = [];

  constructor(workerCount: number) {
    this.sem = new Semaphore(workerCount <= 0 ? 8 : workerCount);
  }

  submit(f: () => Promise<LlmComment[]>): void {
    const task = this.sem.with(async () => {
      try {
        const comments = await f();
        this.results.push(...comments);
      } catch (err) {
        out(`[ocr] CommentWorkerPool error: ${(err as Error).message}`);
      }
    });
    this.pending.push(task);
  }

  /** Waits for all submitted work and returns aggregated results. */
  async await(): Promise<LlmComment[]> {
    await Promise.allSettled(this.pending);
    return this.results;
  }
}
