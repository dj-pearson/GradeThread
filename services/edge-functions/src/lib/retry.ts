// Exponential-backoff retry for transient upstream failures (US-325).
//
// eBay (Sell/Browse/Taxonomy) and Anthropic both return 429 (rate limit) and
// 5xx under load. A whole AutoLister batch shouldn't fail because one call hit
// a momentary limit. withRetry wraps a single async call with bounded
// exponential backoff + jitter; isRetryableError decides what's worth retrying.
//
// Retries are INTERNAL to one attempt — they don't bump the job-level
// `attempts` counter (that tracks user-initiated re-enqueues). `sleep` is
// injectable so unit tests run instantly without real timers.

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff delay; doubles each retry. Default 500ms. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. Default 8000ms. */
  maxDelayMs?: number;
  /** Decide whether an error is worth retrying. Default isRetryableError. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable sleep (tests pass a no-op). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter, [0,1). Injectable for deterministic tests. */
  random?: () => number;
  /** Observability hook fired before each backoff wait. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_MESSAGE =
  /\b(429|500|502|503|504)\b|rate.?limit|overloaded|too many requests|timeout|timed out|temporarily unavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|connection (reset|closed)/i;

/**
 * True for errors that are likely transient: HTTP 408/429/5xx (via a numeric
 * `status` on the error, as Anthropic's APIError and our eBay errors carry) or
 * a message matching known rate-limit / overload / network-blip patterns.
 */
export function isRetryableError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && RETRYABLE_STATUS.has(status)) return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return RETRYABLE_MESSAGE.test(message);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying on retryable errors with exponential backoff + full
 * jitter. Re-throws the last error once attempts are exhausted or the error is
 * non-retryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const isRetryable = opts.isRetryable ?? isRetryableError;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryable(err)) break;
      // Full jitter: random point in [0, exponential cap]. Spreads retries so
      // a batch's parallel jobs don't all hammer the upstream in lockstep.
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.floor(random() * cap);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
