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
  /**
   * Hard cap on a server-specified `Retry-After` wait (US-406). A hostile or
   * misconfigured upstream could send `Retry-After: 3600`; we honor the header
   * as a floor over our own jitter but never block a sync longer than this.
   * Default 30000ms.
   */
  maxRetryAfterMs?: number;
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
const RATE_LIMIT_MESSAGE = /\b429\b|rate.?limit|too many requests|call limit/i;

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

/**
 * True specifically for rate-limit / quota errors (HTTP 429 or a message naming
 * a rate/call limit), as opposed to a generic 5xx/network blip (US-406). Callers
 * use this to surface a rate-limit-specific "partial sync" error and to stop
 * fanning out further requests once the quota is hit, instead of hammering on.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 429) return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return RATE_LIMIT_MESSAGE.test(message);
}

/**
 * The upstream-specified retry delay in ms, read from a numeric `retryAfterMs`
 * the caller attached to the error (parsed from the HTTP `Retry-After` header).
 * Null when absent or not a finite positive number. (US-406)
 */
export function retryAfterMs(err: unknown): number | null {
  if (err && typeof err === "object") {
    const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
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
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 30_000;
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
      // US-406: when the upstream told us exactly how long to wait (Retry-After),
      // honor it — capped so a hostile/misconfigured header can't stall a sync.
      // Otherwise full jitter: a random point in [0, exponential cap], which
      // spreads a batch's parallel jobs so they don't hammer eBay in lockstep.
      const after = retryAfterMs(err);
      const delayMs = after !== null
        ? Math.min(after, maxRetryAfterMs)
        : Math.floor(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
