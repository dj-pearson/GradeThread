// US-3531: keep a running grade's lease alive.
//
// The lease (claim_grade_lease, 00640) is taken once, lasts gradingLeaseSeconds
// (900s default) and was never renewed. It is taken BEFORE the wait for an
// image-buffer slot, so under a burst, or when the reaper resumes a backlog at
// once, a grade could wait past its lease. The reaper then saw an expired
// lease and a stale updated_at, resumed it, and a second copy paid for the
// same vision calls. A heartbeat extends the lease (and, through the
// updated_at trigger, the staleness clock) every third of a lease while the
// run is alive. It stops the moment the run ends, so a crashed container
// still lets the lease lapse and the reaper still recovers the grade.

import { supabaseAdmin } from "./supabase.ts";

export type LeaseRenewer = (
  submissionId: string,
  untilIso: string,
) => Promise<void>;

const defaultRenew: LeaseRenewer = async (submissionId, untilIso) => {
  // Only while still processing; a finished grade clears its lease and must
  // not get one back.
  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ grading_lease_until: untilIso })
    .eq("id", submissionId)
    .eq("status", "processing");
  if (error) {
    console.warn(`[lease] renew failed for ${submissionId}: ${error.message}`);
  }
};

/**
 * Start renewing. Returns a stop function; call it exactly when the run ends.
 * Renewal failures are logged and never thrown into the grade.
 */
export function startLeaseHeartbeat(
  submissionId: string,
  leaseSeconds: number,
  renew: LeaseRenewer = defaultRenew,
  schedule: (fn: () => void, ms: number) => number = (fn, ms) =>
    setInterval(fn, ms) as unknown as number,
  cancel: (id: number) => void = (id) => clearInterval(id),
  now: () => number = Date.now,
): () => void {
  const everyMs = Math.max(30_000, Math.floor((leaseSeconds * 1000) / 3));
  const id = schedule(() => {
    const until = new Date(now() + leaseSeconds * 1000).toISOString();
    renew(submissionId, until).catch(() => {});
  }, everyMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(id);
  };
}
