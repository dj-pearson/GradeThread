// US-1709: retry-with-backoff for transient Ads-API failures (429 / 5xx / network
// blips), so a momentary Google/Apple hiccup doesn't fail a whole sync or apply.
// Only TRANSIENT errors retry; a 4xx (bad request / auth) fails fast. Pure +
// injectable sleep for tests.

/** HTTP statuses worth retrying (rate limit + transient server/network). */
export const TRANSIENT_STATUSES = new Set([0, 429, 500, 502, 503, 504]);

/** True when an error carries a retryable `status` (GoogleAdsError / ASA error). */
export function isTransientAdsError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && TRANSIENT_STATUSES.has(status);
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    baseDelayMs?: number;
    isRetryable?: (e: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 300;
  const retryable = opts.isRetryable ?? isTransientAdsError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !retryable(err)) throw err;
      await sleep(base * 2 ** i);
    }
  }
  throw lastErr;
}
