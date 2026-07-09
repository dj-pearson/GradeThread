// US-1790: B2B batch grading — durable-jobs queue core.
//
// Mirrors the flipdesk-autolister processBatch contract (claim → bounded work →
// job-row write → roll-up/heartbeat → finalize-from-rows) so a container death,
// a timeout, or a redeploy never strands work: the batch status is DERIVED from
// its job rows, and a reclaim cron resumes stale jobs. This module owns the
// tenant-scoped table access + the pure status derivation; the per-item grade
// (submission + runPaymentPrecedence + processSubmission) and the worker pool /
// endpoints / reclaim cron wire it together (grading-batch-worker.ts, US-1790
// part 2). Nothing here is mounted until that wiring lands — the queue is inert.
//
// ⚠️ Every claim/read/write is scoped by user_id (US-268): the service-role
// client bypasses RLS, so tenancy is the explicit filter, not the policy.

import { supabaseAdmin } from "./supabase.ts";

// Vision calls are heavy; keep the pool small (mirror flipdesk bulk-extract).
export const GRADING_BATCH_CONCURRENCY = 3;
// A hung single grade is capped here; must stay under JOB_STALE so a live job
// never looks stale.
export const GRADE_ITEM_TIMEOUT_MS = 240_000;
// A job started this many times (incl. reclaim resumes) fails TERMINALLY — the
// backstop that stops an unattended reclaim loop from burning AI quota forever.
export const MAX_GRADE_JOB_ATTEMPTS = 5;
// A 'running' job older than this was left by a dead worker → reclaimable.
export const GRADE_JOB_STALE_MS = 6 * 60_000;
// A batch untouched this long is abandoned → swept.
export const GRADE_BATCH_STALE_MS = 15 * 60_000;
// Max garments in one batch request.
export const MAX_BATCH_ITEMS = 50;

export type GradingBatchStatus = "completed" | "failed" | "partial";

/**
 * Terminal batch status from its job-row tallies, or null while any job is still
 * open (pending/running). Pure + exported for tests. Matches the autolister
 * contract: all-succeeded → completed, all-failed → failed, mixed → partial.
 */
export function deriveGradingBatchStatus(
  succeeded: number,
  failed: number,
  open: number,
): GradingBatchStatus | null {
  if (open > 0) return null;
  return failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial";
}

/** Re-count job rows and update the batch counters + terminal status. Idempotent
 *  (derived from the authoritative job rows, never in-memory tallies). */
export async function finalizeGradingBatch(batchId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("grading_batch_jobs")
    .select("status")
    .eq("batch_id", batchId);
  const rows = (data ?? []) as Array<{ status: string }>;
  const succeeded = rows.filter((r) => r.status === "completed").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const open = rows.filter((r) => r.status === "pending" || r.status === "running").length;
  const patch: Record<string, unknown> = { succeeded_count: succeeded, failed_count: failed };
  const terminal = deriveGradingBatchStatus(succeeded, failed, open);
  if (terminal) patch.status = terminal;
  await supabaseAdmin.from("grading_batches").update(patch).eq("id", batchId);
}

/**
 * Atomically claim a job for this worker. Eligible = still 'pending', OR a
 * 'running' job left stale by a dead worker. Returns true if claimed. Uses TWO
 * sequential conditional UPDATEs (never `.or()` on a mutation — the self-hosted
 * PostgREST rejects it, US-1552). Never swallows the claim error (US-1552): logs
 * it and returns false so the job is left for the reclaim cron, not lost.
 */
export async function claimGradingJob(
  jobId: string,
  attempts: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const claimPatch = { status: "running", attempts: attempts + 1, error: null };
  const staleBefore = new Date(nowMs - GRADE_JOB_STALE_MS).toISOString();

  let { data: claimed, error } = await supabaseAdmin
    .from("grading_batch_jobs")
    .update(claimPatch)
    .eq("id", jobId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (!error && !claimed) {
    ({ data: claimed, error } = await supabaseAdmin
      .from("grading_batch_jobs")
      .update(claimPatch)
      .eq("id", jobId)
      .eq("status", "running")
      .lt("updated_at", staleBefore)
      .select("id")
      .maybeSingle());
  }

  if (error) {
    console.error(`[grading-batch] job ${jobId} claim failed (left for reclaim): ${error.message}`);
    return false;
  }
  return Boolean(claimed);
}

/** Mark a job completed with its submission id. */
export async function markGradingJobCompleted(jobId: string, submissionId: string): Promise<void> {
  await supabaseAdmin
    .from("grading_batch_jobs")
    .update({ status: "completed", submission_id: submissionId, error: null })
    .eq("id", jobId);
}

/** Mark a job failed with a reason (surfaced in the batch-status response). */
export async function markGradingJobFailed(jobId: string, reason: string): Promise<void> {
  await supabaseAdmin
    .from("grading_batch_jobs")
    .update({ status: "failed", error: reason.slice(0, 500) })
    .eq("id", jobId);
}
