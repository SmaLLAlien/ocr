// Console progress output. Port of internal/stdout (quiet switch) plus the
// human-facing printers from internal/telemetry/events.go (the OpenTelemetry
// half of that package is intentionally not ported).

let quiet = false;

/** Writes a line to stdout unless quiet mode is active. */
export function out(line: string): void {
  if (!quiet) process.stdout.write(line + '\n');
}

/**
 * Silences stdout progress output (json/agent audience). Returns a restore
 * function.
 */
export function setQuiet(): () => void {
  const old = quiet;
  quiet = true;
  return () => {
    quiet = old;
  };
}

/** Go time.Duration-style rounded-to-ms formatting (e.g. "1.234s", "12ms"). */
export function formatDuration(ms: number): string {
  ms = Math.round(ms);
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    const s = Number(totalSec.toFixed(3));
    return `${s}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = Number((totalSec - min * 60).toFixed(3));
  if (min < 60) return sec > 0 ? `${min}m${sec}s` : `${min}m0s`;
  const h = Math.floor(min / 60);
  const m = min - h * 60;
  return `${h}h${m}m${sec}s`;
}

/** Rounds to whole seconds, Go style ("1m30s", "45s"). */
export function formatDurationSeconds(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    return `${h}h${min - h * 60}m${sec}s`;
  }
  if (min > 0) return `${min}m${sec}s`;
  return `${sec}s`;
}

/** One-line review summary. */
export function printTraceSummary(
  filesReviewed: number,
  commentsGenerated: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  durationMs: number,
): void {
  const elapsed = formatDurationSeconds(durationMs);
  if (inputTokens > 0 || outputTokens > 0) {
    let base = `[ocr] Summary: ${filesReviewed} file(s) reviewed, ${commentsGenerated} comment(s), ~${totalTokens} token(s) used (input: ~${inputTokens}, output: ~${outputTokens})`;
    if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
      base += `, cache(read: ~${cacheReadTokens}, write: ~${cacheWriteTokens})`;
    }
    out(`${base}, ${elapsed} elapsed`);
  } else {
    out(
      `[ocr] Summary: ${filesReviewed} file(s) reviewed, ${commentsGenerated} comment(s), ~${totalTokens} token(s) used, ${elapsed} elapsed`,
    );
  }
}

export function printToolCallStarted(toolName: string, args: Record<string, unknown>): void {
  const summary = summarizeArgs(args);
  if (summary !== '') out(`[ocr]   ▶ ${toolName} ${summary}`);
  else out(`[ocr]   ▶ ${toolName}`);
}

export function printToolCallFinished(toolName: string, durMs: number): void {
  out(`[ocr]   ✔ ${toolName} (${formatDuration(durMs)})`);
}

export function printToolCallError(toolName: string, err: Error): void {
  process.stderr.write(`[ocr]   ✘ ${toolName} failed: ${err.message}\n`);
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = String(v);
    switch (k) {
      case 'path':
      case 'search':
      case 'query':
      case 'pattern':
        return JSON.stringify(s);
      default:
        if (s.length <= 50) parts.push(`${k}=${s}`);
    }
  }
  return parts.join(' ');
}
