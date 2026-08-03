// A retry wrapper for marketplace HTTP clients (US-2324 AC4).
//
// WHY THIS EXISTS AS A SHARED MODULE. The Etsy, Depop and Whatnot clients each
// had the same gap: a `fetchWithTimeout` (so no hang) followed by
// `if (!res.ok) throw`, with no special handling for 429 at all. A rate-limit
// response was therefore treated as a permanent failure — the sync gave up
// mid-pass on the one error that is guaranteed to succeed if you simply wait,
// and ignored the `Retry-After` the server had just told it to wait for.
//
// eBay already solved this, in `fetchWithEbayRetry` (ebay-client.ts). Copying
// that into three more clients would make four implementations of one policy,
// which is how they drift — so this is the shared form. It is deliberately NOT
// wired into the eBay path in the same change: that path is live and carries
// its own breaker composition, and collapsing it here is a refactor to make
// deliberately rather than as a side effect of fixing three other clients.
//
// The contract, and the part worth getting right: ONLY 429 and 5xx are retried.
// Every other response — 2xx, 204, 404, and every other 4xx — is RETURNED
// UNCHANGED so each client keeps its own status-specific handling. A 404 is an
// answer, not a failure, and retrying it wastes the caller's quota on a
// question already answered.

import { parseRetryAfterHeader, type RetryOptions, withRetry } from "./retry.ts";

/** An error carrying the status and, when the server sent one, its Retry-After. */
export interface HttpRetryableError extends Error {
  status: number;
  retryAfterMs?: number;
}

/**
 * Run a single fetch attempt under {@link withRetry}, converting 429/5xx into a
 * retryable error that honours `Retry-After`.
 *
 * `doFetch` is a thunk rather than a URL so the caller keeps ownership of
 * headers, auth and timeout — the retry policy is the only thing shared.
 */
export async function fetchWithRateLimitRetry(
  doFetch: () => Promise<Response>,
  opts: { label?: string } & RetryOptions = {},
): Promise<Response> {
  const { label, ...retry } = opts;
  return await withRetry(async () => {
    const res = await doFetch();
    if (res.status !== 429 && res.status < 500) return res;

    // Free the socket, and keep the body for the error message. Safe to consume
    // here precisely because these two families are never matched on their body
    // by the callers — a 429 or a 502 carries no field they branch on.
    const text = await res.text().catch(() => "");
    const err = new Error(
      `${label ?? "request"} failed (${res.status}): ${text.slice(0, 400)}`,
    ) as HttpRetryableError;
    err.status = res.status;
    const ra = parseRetryAfterHeader(res.headers.get("retry-after"));
    if (ra !== null) err.retryAfterMs = ra;
    throw err;
  }, retry);
}
