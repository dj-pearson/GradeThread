// IMP-02: how the Import page polls a server-side import run.
//
// It used to poll every 2 seconds for the whole run, which is about 31 requests
// a minute against a 30/min limiter, and a 429 was swallowed so progress froze.
// The edge now gives polls their own bucket; this keeps the page well under it
// as well.

/** Fast for the first 10 seconds (small runs finish there), then relaxed. */
export function nextPollDelay(elapsedMs: number): number {
  return elapsedMs < 10_000 ? 2_000 : 5_000;
}

export type PollDecision =
  | { kind: "ok" }
  | { kind: "retry"; delayMs: number }
  | { kind: "stop"; message: string };

/**
 * What to do after a non-2xx poll. A 429 waits for Retry-After (seconds). A 403
 * or 404 will never turn into a 200 by asking again, so polling stops and the
 * seller is told why instead of watching a frozen bar.
 */
export function decidePoll(
  status: number,
  retryAfter: string | null,
  normalDelayMs: number,
): PollDecision {
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 429) {
    const secs = Number(retryAfter);
    const delayMs = Number.isFinite(secs) && secs > 0 ? Math.min(secs, 120) * 1000 : 10_000;
    return { kind: "retry", delayMs: Math.max(delayMs, normalDelayMs) };
  }
  if (status === 403) {
    return {
      kind: "stop",
      message: "You no longer have access to this import in this workspace.",
    };
  }
  if (status === 404) {
    return { kind: "stop", message: "This import could not be found. It may have been removed." };
  }
  return { kind: "retry", delayMs: normalDelayMs };
}
