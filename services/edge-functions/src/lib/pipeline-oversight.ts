// US-899: cross-tenant listing/AutoLister pipeline oversight — pure logic.
//
// The admin route (routes/admin-marketplace-pipeline.ts) does the I/O against the
// durable batch/job tables (listing_generation_batches/_jobs, listing_publish_
// batches/_jobs) and the listings table; this module turns the raw rows into the
// derived "stuck / failed / actionable" view the cockpit needs. Kept pure (no
// I/O) so it's unit-tested without a DB.
//
// "Stuck" matches the AutoLister worker's own staleness windows so the admin view
// agrees with the reclaim sweepers: a batch is stuck when it's been 'running'
// longer than BATCH_STALE_MS, and a publish-claimed listing is stuck "sending"
// when the claim is older than the same window but the listing never went live.

// Mirrors BATCH_STALE_MS / PUBLISH_BATCH_STALE_MS in flipdesk-autolister.ts.
export const STUCK_BATCH_MS = 15 * 60_000;
// Mirrors the publish-claim stale-reclaim window (US-528): a draft claimed for
// publishing that never synced is considered stuck once the claim ages out.
export const STUCK_LISTING_MS = 15 * 60_000;

// Batch lifecycle statuses (listing_generation_status enum).
const TERMINAL_BATCH = new Set(["completed", "failed", "partial"]);

export function ageMs(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = now.getTime() - t;
  return d >= 0 ? d : 0;
}

// A batch is "stuck" when it's still claimed as running but hasn't rolled up
// progress (updated_at) within the staleness window — i.e. its worker died.
export function isStuckBatch(
  status: string,
  updatedAt: string | null | undefined,
  now: Date,
  thresholdMs: number = STUCK_BATCH_MS,
): boolean {
  if (status !== "running" && status !== "pending") return false;
  const age = ageMs(updatedAt, now);
  return age != null && age >= thresholdMs;
}

// What the operator can do with a batch row.
//   • retry  — there are incomplete (failed/pending/running) jobs to re-run AND
//              the batch is in a terminal-or-stuck state (re-running a healthy
//              live batch would race the worker).
//   • cancel — the batch is still open (pending/running) so failing its open
//              jobs actually stops queued work.
export function batchActions(
  status: string,
  itemCount: number,
  succeededCount: number,
  failedCount: number,
  stuck: boolean,
): { canRetry: boolean; canCancel: boolean } {
  const incomplete = Math.max(0, itemCount - succeededCount);
  const hasWork = incomplete > 0 || failedCount > 0;
  const canRetry = hasWork && (TERMINAL_BATCH.has(status) || stuck);
  const canCancel = status === "pending" || status === "running";
  return { canRetry, canCancel };
}

// Should this batch surface in the pipeline-issue view at all? Failed/partial
// batches always; running/pending only once they're stuck.
export function isBatchIssue(status: string, stuck: boolean): boolean {
  if (status === "failed" || status === "partial") return true;
  return stuck;
}

export interface ListingPublishRow {
  listing_status: string;
  publish_error: string | null;
  publish_claimed_at: string | null;
  synced_to_ebay_at: string | null;
}

// Classify a not-yet-live listing's publish state:
//   • "failed"  — a publish attempt recorded an error (publish_error set).
//   • "sending" — claimed for publishing but never synced, and the claim has
//                 aged past the stale window (the publish stalled mid-flight).
//   • null      — healthy (live, or a fresh/scheduled draft not yet attempted).
// A recorded error takes precedence over a stale claim.
export function listingPublishState(
  row: ListingPublishRow,
  now: Date,
  thresholdMs: number = STUCK_LISTING_MS,
): "failed" | "sending" | null {
  // Already live → not a pipeline problem.
  if (row.synced_to_ebay_at) return null;
  if (row.publish_error) return "failed";
  const age = ageMs(row.publish_claimed_at, now);
  if (row.listing_status === "draft" && age != null && age >= thresholdMs) {
    return "sending";
  }
  return null;
}

// Aggregate backlog count for the ops-health tile (US-883). Sum of every
// distinct pipeline problem so a single number reflects system-wide backlog.
export function pipelineBacklog(counts: {
  failedGenerationBatches: number;
  stuckGenerationBatches: number;
  failedGenerationJobs: number;
  failedPublishBatches: number;
  stuckPublishBatches: number;
  failedListings: number;
  stuckListings: number;
}): number {
  return (
    counts.failedGenerationBatches +
    counts.stuckGenerationBatches +
    counts.failedGenerationJobs +
    counts.failedPublishBatches +
    counts.stuckPublishBatches +
    counts.failedListings +
    counts.stuckListings
  );
}
