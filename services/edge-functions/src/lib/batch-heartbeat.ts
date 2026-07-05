// US-1644: shared staleness predicate for user-triggered batch resumes.
//
// A batch's `updated_at` is a heartbeat — bumped on every progress roll-up while
// a worker owns it. A user "resume" must NOT reset a batch's jobs to 'pending'
// while that heartbeat is fresh, or a second worker would claim and double-run
// them (double AI-quota spend). Pure (clock injected) so it's unit-testable.

/**
 * True iff the batch is actively 'running' AND its heartbeat is within
 * `staleMs` of `nowMs` — i.e. a live worker still owns it, so an on-demand
 * resume must be refused. A non-'running' status, a missing/unparseable
 * heartbeat, or a stale one all return false (safe to resume).
 */
export function isBatchHeartbeatFresh(
  status: string | null | undefined,
  updatedAt: string | null | undefined,
  staleMs: number,
  nowMs: number,
): boolean {
  if (status !== "running") return false;
  if (updatedAt == null) return false;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return false;
  return t > nowMs - staleMs;
}
