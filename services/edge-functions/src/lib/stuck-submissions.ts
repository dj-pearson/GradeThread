// Stuck-submission recovery (US-495).
//
// Grading is kicked fire-and-forget (grade.ts → processSubmission().catch).
// If the container crashes or is redeployed mid-grade, a submission can be
// stranded in status='processing' forever — the paying user never gets a grade
// OR a refund. This scheduled job sweeps those orphans:
//
//   1. Find submissions stuck in 'processing' past a threshold (default 20 min,
//      comfortably beyond the worst-case grade wall-time).
//   2. Mark each 'failed' and reverse its charge (refund credit, or flag a
//      Stripe-paid one for manual refund) via the same path the pipeline's own
//      error handler uses.
//   3. Emit a metric + report to the error tracker so a spike of orphans (a bad
//      deploy, an Anthropic outage) is visible, not silent.
//
// We intentionally FAIL the orphan + refund rather than re-enqueue: re-running
// processSubmission is not yet idempotent (it can double-bill Claude — that's
// US-569), so a guaranteed refund is the safe, correct recovery today.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { reverseChargeForUngradedSubmission } from "./grading-pipeline.ts";
import { acquireJobLock } from "./job-lock.ts";
import { captureException, logEvent, recordMetric } from "./observability.ts";

// A 'processing' submission older than this is presumed orphaned. Must exceed
// the worst-case grade time (the AI pipeline timeout is ~120s + retries).
function staleThresholdMs(): number {
  const raw = Number(Deno.env.get("STUCK_SUBMISSION_MINUTES"));
  return (Number.isFinite(raw) && raw > 0 ? raw : 20) * 60_000;
}

const BATCH_LIMIT = 100;

export interface StuckSweepResult {
  scanned: number;
  recovered: number;
  failed: number;
}

export async function recoverStuckSubmissions(): Promise<StuckSweepResult> {
  const staleBefore = new Date(Date.now() - staleThresholdMs()).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, updated_at")
    .eq("status", "processing")
    .lt("updated_at", staleBefore)
    .limit(BATCH_LIMIT);

  if (error) {
    captureException(error, { route: "stuck-submissions.scan" });
    throw new Error(`stuck-submission scan failed: ${error.message}`);
  }

  const stuck = (rows ?? []) as Array<{ id: string; user_id: string; updated_at: string }>;
  if (stuck.length === 0) {
    return { scanned: 0, recovered: 0, failed: 0 };
  }

  // A non-zero count is itself the alert signal (US-495 AC#3): orphans mean a
  // crash/redeploy stranded paid work.
  recordMetric("submissions.stuck", stuck.length, {});
  captureException(
    new Error(`${stuck.length} submission(s) stuck in 'processing' beyond ${staleThresholdMs() / 60_000}m`),
    { level: "warn", route: "stuck-submissions", tags: { count: String(stuck.length) } },
  );

  let recovered = 0;
  let failed = 0;
  for (const s of stuck) {
    try {
      // Mark failed FIRST (so a concurrent grade that somehow completes can't be
      // double-refunded — the refund RPC is keyed on payment_status, and a
      // completed grade would have flipped status away from 'processing').
      const { data: claimed } = await supabaseAdmin
        .from("submissions")
        .update({ status: "failed" })
        .eq("id", s.id)
        .eq("status", "processing") // still stuck? only then do we own the recovery
        .select("id")
        .maybeSingle();
      if (!claimed) continue; // it completed or another sweep took it

      await reverseChargeForUngradedSubmission(s.id, "stuck in processing (orphan recovery)");

      // Mirror into the FlipDesk bridge link so its UI doesn't hang forever.
      await supabaseAdmin
        .from("flipdesk_grading_submissions")
        .update({ status: "failed", error: "Grading stalled and was auto-failed; charge reversed." })
        .eq("submission_id", s.id);

      recovered += 1;
      logEvent("info", "submission.recovered", { submissionId: s.id });
    } catch (err) {
      failed += 1;
      captureException(err, { route: "stuck-submissions.recover", extra: { submissionId: s.id } });
    }
  }

  return { scanned: stuck.length, recovered, failed };
}

// Cron entry point. Mounted OUTSIDE /api/* JWT groups; guards with the shared
// internal-job secret (mirrors the other crons). Wrapped in an overlap lock so
// two ticks can't contend over the same orphan set.
export async function handleStuckSubmissionsCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("stuck-submissions", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await recoverStuckSubmissions();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "stuck-submissions.cron" });
    return c.json(
      { error: "Stuck-submission sweep failed", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  } finally {
    await lock.release();
  }
}
