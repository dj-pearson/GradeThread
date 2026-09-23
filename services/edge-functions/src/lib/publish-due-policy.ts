// Scheduled publish (POST /api/flipdesk/ebay/jobs/publish-due) retry policy.
//
// Before this, a scheduled draft that failed to publish kept its
// scheduled_publish_at and its claim, so it became eligible again once the
// claim went stale (10 min) and retried forever: about 144 eBay publish
// attempts a day for a draft with a permanent blocker. The route now counts
// attempts in listings.publish_attempts (migration 00827) and gives up after
// MAX_SCHEDULED_PUBLISH_ATTEMPTS, the same cap AutoLister's bulk publish uses.
//
// Kept out of the route file so the decisions are testable without loading
// flipdesk-ebay.ts and its service-role client.

/** A scheduled draft is published at most this many times before giving up. */
export const MAX_SCHEDULED_PUBLISH_ATTEMPTS = 5;

/** The publish-due job-lock lease, in seconds (acquireJobLock). */
export const PUBLISH_DUE_LEASE_SECONDS = 240;

/**
 * Stop claiming new rows once this much of the lease is left. One publish is
 * several sequential eBay calls; a claim taken with less than this remaining
 * could still be running when the lock expires and the next tick starts.
 */
export const PUBLISH_DUE_DEADLINE_RESERVE_MS = 60_000;

/** Normalizes a publish_attempts value read from the row (null/junk -> 0). */
export function publishAttemptsOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** May a row with this many prior attempts be claimed for another publish? */
export function canClaimScheduledPublish(attempts: unknown): boolean {
  return publishAttemptsOf(attempts) < MAX_SCHEDULED_PUBLISH_ATTEMPTS;
}

/**
 * Has the tick used enough of its lease that it must stop claiming? Rows not
 * reached stay due and the next tick picks them up.
 */
export function publishDueDeadlineReached(
  startedAtMs: number,
  nowMs: number,
  leaseMs: number = PUBLISH_DUE_LEASE_SECONDS * 1000,
  reserveMs: number = PUBLISH_DUE_DEADLINE_RESERVE_MS,
): boolean {
  return nowMs - startedAtMs >= leaseMs - reserveMs;
}

export interface ScheduledPublishFailurePlan {
  /** True when this failure used the last attempt: the schedule is dropped. */
  terminal: boolean;
  /** The listings patch to write for this failure. */
  patch: Record<string, string | number | null>;
}

/**
 * What to write when a claimed scheduled publish fails.
 *
 * `attemptsAfterClaim` is the publish_attempts value the claim wrote (the
 * prior count plus one). `failedAt` is the moment the publish failed, not the
 * scan time, which can be minutes older on a long tick.
 *
 * On the last attempt the schedule is cleared so the row stops being due, the
 * error stays for the seller to read, and publish_attempts goes back to 0 so a
 * seller who fixes the draft and schedules it again gets a fresh budget
 * (the scheduler writes only scheduled_publish_at and would otherwise leave
 * the row at the cap, unclaimable, forever).
 */
export function planScheduledPublishFailure(
  attemptsAfterClaim: number,
  message: string,
  failedAt: Date,
): ScheduledPublishFailurePlan {
  const terminal = publishAttemptsOf(attemptsAfterClaim) >= MAX_SCHEDULED_PUBLISH_ATTEMPTS;
  const patch: Record<string, string | number | null> = {
    publish_error: message.slice(0, 1000),
    publish_failed_at: failedAt.toISOString(),
  };
  if (terminal) {
    patch.scheduled_publish_at = null;
    patch.publish_attempts = 0;
  }
  return { terminal, patch };
}
