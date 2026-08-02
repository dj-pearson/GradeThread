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

// US-2305: 529 is Anthropic's "overloaded_error". The SDK surfaces it as a
// numeric `status` on an APIError like any other 5xx, so it belongs in the
// status set — before this it retried ONLY because the message happened to
// contain "overloaded", a coupling to a vendor error string that breaks the
// moment Anthropic rewords it.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
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
 * Parse an HTTP `Retry-After` value to milliseconds. Servers send either a
 * delay in whole seconds ("120") or an HTTP-date; both are honored. Returns
 * null for a missing/garbage header so the caller falls back to jitter. (US-406)
 */
export function parseRetryAfterHeader(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

// US-2305: read `retry-after` off whatever response headers the error carries.
// The Anthropic SDK attaches a real `Headers` object to APIError; other clients
// hand back a plain record. Neither shape is our own `retryAfterMs` property,
// which is why an Anthropic 429's Retry-After used to be silently ignored.
function headerRetryAfter(err: object): number | null {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    try {
      return parseRetryAfterHeader(
        (get as (n: string) => string | null).call(headers, "retry-after"),
      );
    } catch {
      return null;
    }
  }
  const rec = headers as Record<string, unknown>;
  const raw = rec["retry-after"] ?? rec["Retry-After"];
  return typeof raw === "string" ? parseRetryAfterHeader(raw) : null;
}

/**
 * The upstream-specified retry delay in ms. Prefers a numeric `retryAfterMs`
 * the caller attached to the error, and otherwise reads the `Retry-After`
 * response header off the error itself (US-2305) — so an upstream that throws a
 * header-carrying error, like the Anthropic SDK, is honored without every call
 * site having to remember to parse it. Null when absent or not a finite
 * positive number. (US-406)
 */
export function retryAfterMs(err: unknown): number | null {
  if (err && typeof err === "object") {
    const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    const fromHeader = headerRetryAfter(err);
    if (fromHeader !== null && fromHeader > 0) return fromHeader;
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
