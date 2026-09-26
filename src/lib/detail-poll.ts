// SUB-11: how often the submission detail page re-reads while nothing has
// told it (over realtime) that the grade changed.
//
// Grading itself takes a minute or two, so a 5s fallback is right while the
// AI is running. A grade in human review can take 12 to 48 hours, and polling
// every 5s for all of it is 30,000 reads a day per open tab. Back off: 5s for
// the first minute, 30s for the next ten, then every 2 minutes.

export type PollableStatus = "pending" | "processing" | "pending_review";

export function isPollableStatus(status: string | null | undefined): status is PollableStatus {
  return status === "pending" || status === "processing" || status === "pending_review";
}

/**
 * Delay before poll number `n` (0-based) for a submission in `status`.
 *
 * US-3533: `pending` (waiting on payment) backs off like `pending_review`.
 * Nothing changes until the seller pays, and an open checkout tab used to
 * poll every 5 seconds forever.
 */
export function detailPollDelay(status: PollableStatus, n: number): number {
  if (status === "processing") return 5_000;
  if (n < 12) return 5_000; // first minute
  if (n < 32) return 30_000; // next ten minutes
  return 120_000;
}

/**
 * One refetch just after a held grade's release time. Null when the time has
 * no meaning. Clamped to setTimeout's 24.8-day ceiling.
 */
export function releaseRefetchDelay(releaseAtIso: string | null, now = Date.now()): number | null {
  if (!releaseAtIso) return null;
  const at = Date.parse(releaseAtIso);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at + 30_000 - now), 2_147_483_647);
}
