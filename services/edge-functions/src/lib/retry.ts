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
   * Upper bound applied to a server-sent Retry-After when honoring it, so a
   * bogus/huge value can't hang a job. Default 60000ms (US-406).
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

const RATE_LIMIT_MESSAGE = /\b429\b|rate.?limit|too many requests/i;

/**
 * True specifically for rate-limit (HTTP 429) failures — narrower than
 * isRetryableError, which also covers 5xx/network blips. US-406 uses this to
 * STOP an in-flight fan-out (rather than keep hammering eBay) and mark the run
 * partial with a rate-limit-specific reason.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object") {
    if ((err as { status?: unknown }).status === 429) return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return RATE_LIMIT_MESSAGE.test(message);
}

/**
 * Parse an HTTP `Retry-After` header into a delay in milliseconds. Supports
 * both documented forms: delta-seconds ("120") and an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns null when absent/unparseable.
 * `nowMs` is injectable so the date form is deterministic in tests.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/**
 * Extract a server-sent retry delay (ms) from an error, if the caller attached
 * one: `retryAfterMs` (already ms) or `retryAfter` (seconds). Returns null when
 * neither is present. eBay/ Anthropic 429s carry these via fetch wrappers.
 */
export function retryAfterMsFromError(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as { retryAfterMs?: unknown; retryAfter?: unknown };
    if (typeof e.retryAfterMs === "number" && e.retryAfterMs >= 0) {
      return e.retryAfterMs;
    }
    if (typeof e.retryAfter === "number" && e.retryAfter >= 0) {
      return e.retryAfter * 1000;
    }
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
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
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
      // US-406: honor a server-sent Retry-After when present (eBay/Anthropic 429
      // tell us exactly how long to wait). Bound it so a bogus value can't hang
      // the job, and add a touch of jitter so parallel jobs desync. Otherwise
      // fall back to full jitter: a random point in [0, exponential cap], which
      // spreads retries so a batch's jobs don't hammer the upstream in lockstep.
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const retryAfterMs = retryAfterMsFromError(err);
      const delayMs = retryAfterMs != null
        ? Math.min(retryAfterMs, maxRetryAfterMs) + Math.floor(random() * baseDelayMs)
        : Math.floor(random() * cap);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
