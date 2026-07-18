// Counting semaphore for bounding concurrency (replaces Go's buffered-channel
// semaphores). Aborting a pending acquire rejects it.
export class Semaphore {
  private available: number;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(max: number) {
    this.available = Math.max(1, max);
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
    } else {
      this.available++;
    }
  }

  /** Runs fn while holding a slot. */
  async with<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'operation aborted');
}
