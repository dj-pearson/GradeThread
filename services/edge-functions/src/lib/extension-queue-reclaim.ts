// Server-side reclaim for extension_work_queue claims a browser never finished.
//
// WHY. `/claim` stamps a row `claimed` and `/claim` only ever reads `queued`.
// The extension's US-3061 fixes cover a lost `/complete` POST (the unsent
// results store) and over-claiming, but not a tab or browser that dies mid-job
// before any result exists. Nothing moved such a row back to `queued`, so it sat
// `claimed` until `expires_at`, seven days later. For a sold-elsewhere delist
// that is a sibling listing live on Poshmark or Mercari for a week.
//
// WHAT. A claim older than its kind's TTL is taken back: `attempts` counts the
// claims that went stale, the row goes back to `queued`, and once
// MAX_STALE_CLAIMS claims have gone stale it fails terminally with a result the
// delist log shows. The DB half is `reclaimStaleClaims` in extension-enqueue.ts;
// this file is the pure decision so it can be tested without a database.

/**
 * How long a claim may run before it is presumed dead, per kind.
 *
 * Every TTL sits well above what the extension will spend on one job: the job
 * timeout is 120 s, a login wall adds 5 min and a seller-wait 3 min
 * (lister/job-store.js), and an unsent result is retried at 0/30 s/1/2/5 min
 * before the backoff reaches 15 min (queue/worker-state.js). A live job must
 * never look stale, so the numbers err long.
 *
 * `list` and `relist` get the longest window on purpose: re-running one of those
 * after a browser that DID fill the form went quiet makes a duplicate listing,
 * while re-running a delist on an already-ended listing does no harm.
 */
export const CLAIM_TTL_MS: Readonly<Record<string, number>> = {
  delist: 15 * 60 * 1000,
  revise: 15 * 60 * 1000,
  list: 60 * 60 * 1000,
  relist: 60 * 60 * 1000,
};

/** A kind this table does not name gets the most cautious window. */
export const DEFAULT_CLAIM_TTL_MS = 60 * 60 * 1000;

/** The shortest TTL, which bounds the DB read to rows that could be stale. */
export const MIN_CLAIM_TTL_MS = Math.min(...Object.values(CLAIM_TTL_MS));

/**
 * Claims that may go stale before the row fails for good. Three dead browsers
 * in a row is a job that will not run unattended, and the seller has to hear
 * that rather than watch it cycle until expires_at.
 */
export const MAX_STALE_CLAIMS = 3;

/** The sentence the delist log (and the queue UI) shows for a row given up on. */
export const STALE_CLAIM_ERROR =
  "A browser picked this up and stopped responding, " +
  `${MAX_STALE_CLAIMS} times. GradeThread stopped retrying it. ` +
  "Open your desktop browser and do it by hand, or queue it again.";

export function claimTtlMs(kind: string): number {
  return CLAIM_TTL_MS[kind] ?? DEFAULT_CLAIM_TTL_MS;
}

export interface StaleClaimCandidate {
  id: string;
  kind: string;
  attempts: number | null;
  claimed_at: string | null;
}

export type StaleClaimAction =
  | { id: string; claimed_at: string; action: "requeue"; attempts: number }
  | { id: string; claimed_at: string; action: "fail"; attempts: number };

/**
 * Which `claimed` rows to take back, and how. Pure.
 *
 * A row with no `claimed_at` or an unparseable one is left alone: it cannot be
 * shown to be stale, and the 7-day expiry still backstops it. `claimed_at` is
 * carried into the plan so the write can compare-and-set on it, which is what
 * stops two replicas both counting the same stale claim.
 */
export function planStaleClaimReclaim(
  rows: readonly StaleClaimCandidate[],
  nowMs: number,
): StaleClaimAction[] {
  const out: StaleClaimAction[] = [];
  for (const r of rows) {
    if (!r.claimed_at) continue;
    const at = Date.parse(r.claimed_at);
    if (!Number.isFinite(at)) continue;
    if (nowMs - at <= claimTtlMs(r.kind)) continue;
    const attempts = Math.max(0, Number(r.attempts) || 0) + 1;
    out.push({
      id: r.id,
      claimed_at: r.claimed_at,
      action: attempts >= MAX_STALE_CLAIMS ? "fail" : "requeue",
      attempts,
    });
  }
  return out;
}

/**
 * What `/complete` does with a report, given the row as it stands now. Pure.
 *
 * A reclaim means the browser that reports may no longer own the row, so a
 * report is not always a write:
 *
 * - `done` is final. A duplicate report (the unsent-results store replaying)
 *   or a late failure must not flip it or re-run the side effects.
 * - A success is recorded from any other state. The work happened, and a row
 *   requeued after its browser went quiet would otherwise run a second time.
 * - A failure on a requeued (`queued`) row is dropped: a retry is already
 *   scheduled, and recording the stale failure would cancel it.
 * - A failure from a different install than the one now holding the claim is
 *   dropped for the same reason. The install id is a label, not a credential;
 *   the tenant scope in the route is what protects the row.
 */
export function decideQueueCompletion(
  row: { status: string; claimed_by: string | null },
  report: { ok: boolean; installId: string | null },
): "apply" | "ignore" {
  if (row.status === "done") return "ignore";
  if (report.ok) return "apply";
  if (row.status === "queued") return "ignore";
  if (
    row.status === "claimed" && report.installId && row.claimed_by &&
    report.installId !== row.claimed_by
  ) {
    return "ignore";
  }
  return "apply";
}

/**
 * The row update for one reclaim step. Pure.
 *
 * A requeue leaves `claimed_at` exactly as it was. That timestamp is the only
 * proof a browser ever drained this seller's queue: `lastDrainedAt` in
 * routes/flipdesk-extension-queue.ts and the US-3198 stale-queue cron both read
 * max(claimed_at) over every status. Clearing it on a seller whose first-ever
 * drain died mid-job made the tray say no extension had ever run and made the
 * cron answer `never_drained` and skip its push. Keeping it is safe for the
 * compare-and-set: the reclaim reads only `claimed` rows and /claim reads only
 * `queued` ones and restamps `claimed_at` when it takes the row again.
 */
export function staleClaimPatch(
  step: StaleClaimAction,
  nowIso: string,
): Record<string, unknown> {
  if (step.action === "requeue") {
    return { status: "queued", attempts: step.attempts, claimed_by: null };
  }
  return {
    status: "failed",
    attempts: step.attempts,
    completed_at: nowIso,
    result: { ok: false, stale: true, error: STALE_CLAIM_ERROR },
  };
}
