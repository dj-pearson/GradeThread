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
import { processSubmission, reverseChargeForUngradedSubmission } from "./grading-pipeline.ts";
import { acquireJobLock } from "./job-lock.ts";
import { captureException, logEvent, recordMetric } from "./observability.ts";

// A 'processing' submission older than this is presumed orphaned. Must exceed
// the worst-case grade time (the AI pipeline timeout is ~120s + retries).
function staleThresholdMs(): number {
  const raw = Number(Deno.env.get("STUCK_SUBMISSION_MINUTES"));
  return (Number.isFinite(raw) && raw > 0 ? raw : 20) * 60_000;
}

// A 'pending' + 'unpaid' submission older than this is a closed-tab checkout —
// the user started a per-grade Checkout and never paid. We expire it (no charge).
function abandonedThresholdMs(): number {
  const raw = Number(Deno.env.get("ABANDONED_CHECKOUT_HOURS"));
  return (Number.isFinite(raw) && raw > 0 ? raw : 24) * 3_600_000;
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

// US-773: sweep abandoned-checkout submissions (closed the Checkout tab, never
// paid) and recover stranded-paid ones (paid, but the grade kick never landed —
// a crash between the webhook's paid flip and processSubmission). Distinct from
// recoverStuckSubmissions (which handles 'processing' orphans):
//
//   • ABANDONED  — status='pending' + payment_status='unpaid' + older than 24h →
//                  mark 'expired'. NO charge is attempted; the UI shows "payment
//                  not completed — resubmit" instead of a stale pending row.
//   • STRANDED-PAID — status='pending' + payment satisfied + grading never
//                  claimed + older than the processing-stale threshold → re-kick
//                  the pipeline. The grading_started_at claim makes the re-kick
//                  idempotent, so a concurrent kick can't double-grade.
export interface AbandonedSweepResult {
  expired: number;
  rekicked: number;
}

// Injectable data access so the sweep's orchestration is unit-testable without a
// DB (mirrors the injectable-deps idiom used in webhook-idempotency / rate-limit).
export interface AbandonedSweepStore {
  /** Ids of pending+unpaid submissions older than the abandon threshold. */
  findAbandonedUnpaid: (beforeIso: string, limit: number) => Promise<string[]>;
  /**
   * Expire a row, re-asserting pending+unpaid in the UPDATE. Returns true only
   * when it actually transitioned — a row paid in the race window fails the
   * match and is left alone.
   */
  expireIfStillAbandoned: (id: string) => Promise<boolean>;
  /** Ids of pending + paid + unclaimed submissions older than the stale threshold. */
  findStrandedPaid: (beforeIso: string, limit: number) => Promise<string[]>;
  /** Re-kick the grading pipeline (fire-and-forget). */
  rekick: (id: string) => void;
}

const defaultAbandonedStore: AbandonedSweepStore = {
  findAbandonedUnpaid: async (beforeIso, limit) => {
    const { data, error } = await supabaseAdmin
      .from("submissions")
      .select("id")
      .eq("status", "pending")
      .eq("payment_status", "unpaid")
      .lt("updated_at", beforeIso)
      .limit(limit);
    if (error) {
      captureException(error, { route: "abandoned-checkouts.scan_unpaid" });
      throw new Error(`abandoned-checkout unpaid scan failed: ${error.message}`);
    }
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  },
  expireIfStillAbandoned: async (id) => {
    // Re-assert pending+unpaid in the UPDATE so we never expire a row that just
    // got paid in the race window (a concurrent webhook flip fails the match).
    const { data } = await supabaseAdmin
      .from("submissions")
      .update({ status: "expired" })
      .eq("id", id)
      .eq("status", "pending")
      .eq("payment_status", "unpaid")
      .select("id")
      .maybeSingle();
    return Boolean(data);
  },
  findStrandedPaid: async (beforeIso, limit) => {
    const { data, error } = await supabaseAdmin
      .from("submissions")
      .select("id")
      .eq("status", "pending")
      .neq("payment_status", "unpaid")
      .is("grading_started_at", null)
      .lt("updated_at", beforeIso)
      .limit(limit);
    if (error) {
      captureException(error, { route: "abandoned-checkouts.scan_paid" });
      throw new Error(`abandoned-checkout paid scan failed: ${error.message}`);
    }
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  },
  rekick: (id) => {
    // Fire-and-forget; processSubmission's atomic claim guards a concurrent kick.
    processSubmission(id).catch((err) => {
      captureException(err, {
        route: "abandoned-checkouts.rekick",
        extra: { submissionId: id },
      });
    });
  },
};

export async function recoverAbandonedCheckouts(
  store: AbandonedSweepStore = defaultAbandonedStore,
): Promise<AbandonedSweepResult> {
  const now = Date.now();
  const abandonedBefore = new Date(now - abandonedThresholdMs()).toISOString();
  const strandedBefore = new Date(now - staleThresholdMs()).toISOString();

  // ── 1) Abandoned unpaid checkouts → expire (no charge) ──
  const abandoned = await store.findAbandonedUnpaid(abandonedBefore, BATCH_LIMIT);
  let expired = 0;
  for (const id of abandoned) {
    if (await store.expireIfStillAbandoned(id)) {
      expired += 1;
      logEvent("info", "submission.expired", { submissionId: id });
    }
  }

  // ── 2) Stranded-paid submissions → re-kick the pipeline ──
  const stranded = await store.findStrandedPaid(strandedBefore, BATCH_LIMIT);
  let rekicked = 0;
  for (const id of stranded) {
    rekicked += 1;
    store.rekick(id);
  }

  if (expired > 0) recordMetric("submissions.expired", expired, {});
  if (rekicked > 0) {
    // A non-zero count means paid grades had to be rescued — surface it.
    recordMetric("submissions.paid_rekicked", rekicked, {});
    captureException(
      new Error(`${rekicked} paid submission(s) were stranded pending and re-kicked`),
      { level: "warn", route: "abandoned-checkouts", tags: { count: String(rekicked) } },
    );
  }

  return { expired, rekicked };
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
    // US-773: same tick also sweeps abandoned checkouts + stranded-paid grades.
    const abandoned = await recoverAbandonedCheckouts();
    return c.json({ ok: true, ...result, ...abandoned });
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
