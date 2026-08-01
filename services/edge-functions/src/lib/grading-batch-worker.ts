// US-1790: B2B batch grading — the background worker + reclaim sweeper.
//
// Wires the queue core (grading-batch.ts) to the actual per-garment grade. Each
// garment is graded via the SAME path as a single API grade: create submission →
// ingestGradeImages (SSRF/magic-byte/EXIF/phash, shared with POST /grades) →
// runPaymentPrecedence (included → credits) → processSubmission. The worker
// AWAITS the pipeline (bounded by GRADE_ITEM_TIMEOUT_MS) so a job's status
// reflects true completion, and the batch status is DERIVED from its job rows so
// a container death / redeploy never strands work — a reclaim cron resumes it.
//
// ⚠️ Tenant scope (US-268): the service-role client bypasses RLS. Every job row
// carries its owner's user_id; the worker uses THAT (never a request field) to
// scope the submission + payment, and the status endpoint scopes by the caller.

import type { Context } from "hono";
import { supabaseAdmin } from "./supabase.ts";
import { redactError } from "./log-redact.ts";
import { isPaidSubmissionStatus } from "./paid-submission.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";
import { recordApiUsage } from "./api-usage-log.ts";
import { processSubmission } from "./grading-pipeline.ts";
import { type GradeTier, isGradeTier, runPaymentPrecedence } from "./grade-billing.ts";
import {
  type GradeGarmentInput,
  ingestGradeImages,
} from "./api-grade-ingest.ts";
import {
  claimGradingJob,
  finalizeGradingBatch,
  GRADE_BATCH_STALE_MS,
  GRADE_ITEM_TIMEOUT_MS,
  GRADING_BATCH_CONCURRENCY,
  markGradingJobCompleted,
  markGradingJobFailed,
  MAX_GRADE_JOB_ATTEMPTS,
} from "./grading-batch.ts";

/** Reject if `p` hasn't settled within `ms`. The underlying work isn't
 *  cancellable (it may still finish + update its submission), but the worker's
 *  WAIT is bounded so one hung garment can't stall the whole batch. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Grade one garment end to end, charging the job's owner. Returns the created
 * submission id on success. On a PRE-payment failure (bad image, unpaid) it
 * deletes the submission it created and throws — nothing was charged. Once
 * payment succeeds it NEVER deletes the submission: money was taken, so a later
 * pipeline failure/timeout leaves the paid submission for the existing
 * stuck-submission + refund machinery, and only the job row is marked failed.
 */
async function gradeBatchItem(
  userId: string,
  apiKeyId: string | null,
  payload: GradeGarmentInput,
  jobId: string,
  existingSubmissionId: string | null,
): Promise<string> {
  const tier: GradeTier = isGradeTier(payload.tier) ? payload.tier : "standard";

  // US-2289: RESUME a submission this job already created and paid for.
  //
  // The bug: this function created a submission and charged unconditionally on
  // every invocation, and the reclaim cron called it again with no reference to
  // the prior attempt. With MAX_GRADE_JOB_ATTEMPTS at 5, one garment could be
  // debited five times and produce five certificates. Nothing detected it —
  // each attempt was individually correct.
  //
  // The fix is not a smarter charge, it is not charging twice: a job carries its
  // submission id, and a resumed job picks that submission back up. Payment is
  // per-submission, so skipping straight to processing skips the charge by
  // construction rather than by a guard someone has to remember.
  if (existingSubmissionId) {
    const resumed = await resumePaidSubmission(userId, existingSubmissionId);
    if (resumed) {
      await supabaseAdmin
        .from("submissions")
        .update({ status: "processing" })
        .eq("id", existingSubmissionId)
        // Scoped to the charged account for the same reason the charging
        // chokepoint scopes its paid-flip: the service-role client bypasses RLS.
        .eq("user_id", userId);
      await withTimeout(
        processSubmission(existingSubmissionId),
        GRADE_ITEM_TIMEOUT_MS,
        "Grade pipeline (resumed)",
      );
      // Counted HERE and not on the abandoned attempt: usage is recorded only
      // after the pipeline succeeds, so a first attempt that timed out never
      // recorded one. A job reaches this line at most once — it is marked
      // completed immediately after, and only pending/running jobs are picked
      // up — so the garment is counted exactly once however many resumes it
      // took.
      recordApiUsage({
        userId,
        apiKeyId,
        endpoint: "/grades",
        method: "POST",
        statusCode: 202,
        sandbox: false,
      });
      return existingSubmissionId;
    }
    // Not resumable (missing, not this user's, or never paid). Fall through and
    // start clean — but only because nothing was charged for it.
  }

  const { data: submission, error: submissionError } = await supabaseAdmin
    .from("submissions")
    .insert({
      user_id: userId,
      garment_type: payload.garment_type,
      garment_category: payload.garment_category,
      title: (payload.title ?? "").trim(),
      brand: payload.brand?.trim() || null,
      description: payload.description?.trim() || null,
      status: "pending",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (submissionError || !submission) {
    throw new Error(`create submission failed: ${submissionError?.message ?? "unknown"}`);
  }
  const submissionId = submission.id as string;

  // US-2289: bind the submission to the job BEFORE any money moves. If the
  // container dies between here and the charge, the reclaim finds an UNPAID
  // submission, declines to resume it, and starts clean — no double charge, no
  // orphan. Writing it after the charge would leave exactly the window this
  // story is about.
  await supabaseAdmin
    .from("grading_batch_jobs")
    .update({ submission_id: submissionId })
    .eq("id", jobId);

  // Images — shared hardening path (identical to a single API grade).
  const ingest = await ingestGradeImages(userId, submissionId, payload.images ?? []);
  if (!ingest.ok) {
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    throw new Error(`${ingest.code}: ${ingest.detail}`);
  }

  // Charge (included → credits). API callers can't complete an interactive
  // Stripe checkout mid-batch, so an uncovered garment fails THIS job (others
  // proceed) — and we remove the unpaid submission we created.
  let paid = false;
  try {
    const precedence = await runPaymentPrecedence(userId, submissionId, tier);
    paid = precedence.paid;
  } catch (err) {
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    throw new Error(`payment error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!paid) {
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    throw new Error("insufficient grading credits for this garment");
  }

  // Paid — from here the submission survives even if grading fails.
  await supabaseAdmin.from("submissions").update({ status: "processing" }).eq("id", submissionId);
  await withTimeout(processSubmission(submissionId), GRADE_ITEM_TIMEOUT_MS, "Grade pipeline");

  // Count this garment as one grade against API usage/quota (the batch envelope
  // itself is logged once by the api-usage middleware under /grades:batch).
  recordApiUsage({
    userId,
    apiKeyId,
    endpoint: "/grades",
    method: "POST",
    statusCode: 202,
    sandbox: false,
  });

  return submissionId;
}

/**
 * Can this job's existing submission be picked back up instead of re-created?
 *
 * Three conditions, and all three are about not charging twice or acting on
 * something that isn't ours:
 *   • the submission exists;
 *   • it belongs to the job's owner (the service-role client bypasses RLS, so
 *     this is checked explicitly — US-268); and
 *   • it was actually PAID. An unpaid submission cost nothing, so re-creating
 *     it is free; a paid one must never be paid for again.
 *
 * A terminal submission (already graded) is also resumable: processSubmission is
 * the idempotent step, and re-running it beats leaving a paid grade unfinished.
 */
async function resumePaidSubmission(
  userId: string,
  submissionId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, payment_status")
    .eq("id", submissionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return isPaidSubmissionStatus((data as { payment_status: string | null }).payment_status);
}

/**
 * Background worker for a batch: grade every open (pending/stale-running) job
 * with bounded concurrency. Self-contained — loads the batch + its jobs by id,
 * so the initial dispatch and the reclaim sweeper both just call
 * processGradeBatch(batchId). Partial failures never abort the batch; each job
 * records its own status/error/attempts, and the batch terminalizes from the
 * job rows.
 */
export async function processGradeBatch(batchId: string): Promise<void> {
  const { data: batch } = await supabaseAdmin
    .from("grading_batches")
    .select("user_id, api_key_id")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) {
    console.error(`[grading-batch] batch ${batchId} not found; nothing to process`);
    return;
  }
  const apiKeyId = (batch.api_key_id as string | null) ?? null;

  const { data: jobRows } = await supabaseAdmin
    .from("grading_batch_jobs")
    // US-2289: submission_id comes along, so a reclaimed job can resume the
    // submission a prior attempt already paid for instead of buying another.
    .select("id, user_id, payload, attempts, submission_id")
    .eq("batch_id", batchId)
    .in("status", ["pending", "running"]);
  const jobs = (jobRows ?? []) as Array<
    {
      id: string;
      user_id: string;
      payload: GradeGarmentInput;
      attempts: number;
      submission_id: string | null;
    }
  >;

  async function runJob(
    job: {
      id: string;
      user_id: string;
      payload: GradeGarmentInput;
      attempts: number;
      submission_id: string | null;
    },
  ): Promise<void> {
    const attempts = job.attempts ?? 0;
    if (attempts >= MAX_GRADE_JOB_ATTEMPTS) {
      await markGradingJobFailed(
        job.id,
        "Grading abandoned after repeated interruptions. Retry from the queue if needed.",
      );
      return;
    }
    // Atomic claim (two conditional updates; never .or() on a mutation).
    const claimed = await claimGradingJob(job.id, attempts);
    if (!claimed) return;

    try {
      const submissionId = await gradeBatchItem(
        job.user_id,
        apiKeyId,
        job.payload,
        job.id,
        job.submission_id ?? null,
      );
      await markGradingJobCompleted(job.id, submissionId);
    } catch (err) {
      await markGradingJobFailed(job.id, err instanceof Error ? err.message : "Grading failed");
    }
  }

  try {
    console.log(`[grading-batch] batch ${batchId}: worker started, ${jobs.length} job(s)`);
    for (let i = 0; i < jobs.length; i += GRADING_BATCH_CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + GRADING_BATCH_CONCURRENCY).map((j) => runJob(j)));
      await finalizeGradingBatch(batchId); // live roll-up + heartbeat
    }
  } catch (err) {
    console.error(`[grading-batch] batch ${batchId} worker crashed:`, redactError(err));
  } finally {
    await finalizeGradingBatch(batchId).catch((e) =>
      console.error(`[grading-batch] finalize ${batchId} failed:`, redactError(e))
    );
    console.log(`[grading-batch] batch ${batchId}: worker finished`);
  }
}

/**
 * US-1790: reclaim sweeper. A Coolify cron hits POST /api/jobs/grading-batch-
 * reclaim (job-secret gated, job-locked). Resumes batches left 'running' by a
 * dead worker and terminalizes any with no open jobs left. Idempotent — the
 * per-batch claim UPDATE bumps updated_at so a concurrent tick skips it.
 */
export async function handleGradingBatchReclaimCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("grading-batch-reclaim", 300);
  if (!lock.acquired) {
    return c.json({ scanned: 0, resumed: 0, finalized: 0, skipped: true, reason: lock.reason });
  }
  try {
    const staleBefore = new Date(Date.now() - GRADE_BATCH_STALE_MS).toISOString();
    const { data: staleRows, error } = await supabaseAdmin
      .from("grading_batches")
      .select("id")
      .eq("status", "running")
      .lt("updated_at", staleBefore)
      .limit(20);
    if (error) {
      console.error("[grading-batch] reclaim scan failed:", error.message);
      return c.json({ error: "Scan failed" }, 500);
    }
    const stale = (staleRows ?? []) as Array<{ id: string }>;

    let resumed = 0;
    let finalized = 0;
    for (const b of stale) {
      // Claim the batch (any UPDATE bumps updated_at → a concurrent tick skips).
      const { data: claimedBatch } = await supabaseAdmin
        .from("grading_batches")
        .update({ error: null })
        .eq("id", b.id)
        .eq("status", "running")
        .lt("updated_at", staleBefore)
        .select("id")
        .maybeSingle();
      if (!claimedBatch) continue;

      const { data: openJobs } = await supabaseAdmin
        .from("grading_batch_jobs")
        .select("id")
        .eq("batch_id", b.id)
        .in("status", ["pending", "running"]);
      if (((openJobs ?? []) as unknown[]).length === 0) {
        await finalizeGradingBatch(b.id);
        finalized += 1;
        continue;
      }
      void processGradeBatch(b.id).catch((err) =>
        console.error("[grading-batch] reclaim resume crashed:", redactError(err))
      );
      resumed += 1;
    }
    return c.json({ scanned: stale.length, resumed, finalized });
  } finally {
    await lock.release();
  }
}
