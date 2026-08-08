// US-1541: client-side pacing + 429 backoff for the AutoLister staging-upload
// lane.
//
// The edge caps POST /api/flipdesk/autolister/staging/upload at 120 requests
// per 60s (main.ts rateLimiter). A 600-photo dump at UPLOAD_CONCURRENCY=5 can
// exceed that on a fast connection, and the client previously had NO 429
// handling — each rejected file surfaced as a terminal-looking error. Two
// halves, both pure and unit-tested:
//
//   • SlidingWindowLimiter — paces request STARTS so any 60s window carries at
//     most `maxRequests`, sitting safely under the server budget instead of
//     provoking 429s and burning retries.
//   • backoffDelayMs — when a 429 still happens (another tab, shared IP, an
//     op-tightened override), honor Retry-After when present, else exponential
//     backoff, always with jitter so parallel lanes don't retry in lockstep.

/** The server allows 120/60s; stay under it with headroom for retries. */
const STAGING_UPLOAD_MAX_PER_WINDOW = 100;
const STAGING_UPLOAD_WINDOW_MS = 60_000;

/** Max automatic attempts per file for rate-limited uploads (1 + retries). */
export const RATE_LIMIT_MAX_ATTEMPTS = 4;

/**
 * Thrown by the upload call on HTTP 429 so the pipeline can back off + retry
 * instead of surfacing a terminal-looking failure.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super("The server asked us to slow down — retrying automatically.");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Paces request starts so any `windowMs` window contains at most `maxRequests`
 * of them. `acquireDelayMs()` RESERVES a slot and returns how long the caller
 * must wait before starting (0 = go now) — concurrent callers each get
 * strictly later slots, so N parallel lanes can share one instance. Pure
 * given the injected clock.
 */
export class SlidingWindowLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** Scheduled start times, ascending. Pruned as they age out of the window. */
  private starts: number[] = [];

  constructor(
    maxRequests: number = STAGING_UPLOAD_MAX_PER_WINDOW,
    windowMs: number = STAGING_UPLOAD_WINDOW_MS,
    now: () => number = Date.now,
  ) {
    this.maxRequests = Math.max(1, maxRequests);
    this.windowMs = Math.max(1, windowMs);
    this.now = now;
  }

  acquireDelayMs(): number {
    const now = this.now();
    // Drop starts old enough that they can no longer constrain a new slot.
    const horizon = now - this.windowMs;
    while (this.starts.length > 0 && this.starts[0]! <= horizon) {
      this.starts.shift();
    }
    const scheduled =
      this.starts.length < this.maxRequests
        ? now
        : Math.max(now, this.starts[this.starts.length - this.maxRequests]! + this.windowMs);
    this.starts.push(scheduled);
    // Keep the array sorted even if a burst of same-ms acquisitions interleaves
    // with reserved future slots (push order is already non-decreasing because
    // `scheduled` is monotone for a fixed clock, but don't rely on it).
    if (
      this.starts.length > 1 &&
      scheduled < this.starts[this.starts.length - 2]!
    ) {
      this.starts.sort((a, b) => a - b);
    }
    return scheduled - now;
  }
}

/**
 * Delay before retrying a 429: the server's Retry-After (seconds) when given,
 * else exponential (1s, 2s, 4s, … capped at 30s), plus 0–25% jitter so
 * parallel upload lanes don't stampede back in lockstep.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number {
  const base =
    retryAfterSeconds != null && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base + base * 0.25 * random());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
