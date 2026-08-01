// Stuck-submission recovery (US-495 → US-569).
//
// Grading is kicked fire-and-forget (grade.ts → processSubmission().catch).
// If the container crashes or is redeployed mid-grade, a submission can be
// stranded in status='processing' — the paying user never gets a grade. This
// scheduled job sweeps those orphans:
//
//   1. Find submissions stuck in 'processing' whose grading LEASE has expired
//      (the holder is presumed dead) past a stale threshold (default 20 min,
//      comfortably beyond the worst-case grade wall-time + the 15-min lease).
//   2. RESUME each by re-kicking the pipeline — grading is now durable +
//      idempotent (US-569): the lease re-claim picks the work back up, and a
//      crash that landed after the grade_report was written finalizes without
//      re-billing Claude. This is the change from US-495's original behavior,
//      which could only FAIL + REFUND orphans because re-running wasn't safe yet.
//   3. POISON GUARD: a submission that has already burned its attempt budget
//      (GRADING_MAX_ATTEMPTS crashed runs — e.g. an input that OOMs the
//      container every time) is NOT resumed again; it's failed + refunded so it
//      can't crash-loop forever.
//   4. Emit metrics + report to the error tracker so a spike of orphans (a bad
//      deploy, an Anthropic outage) is visible, not silent.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import {
  gradingMaxAttempts,
  processSubmission,
  reverseChargeForUngradedSubmission,
} from "./grading-pipeline.ts";
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

/**
 * Fail a submission that is stuck in 'processing' and never produced a grade,
 * reverse the charge taken for it, and mirror the failure into the FlipDesk
 * bridge link so its UI doesn't hang at "processing" forever.
 *
 * Re-asserts status='processing' in the UPDATE, so a grade that completed in
 * the race window can't be double-refunded — returns false when it did NOT own
 * the transition, and the caller should leave the row alone.
 *
 * US-2376: extracted from the poison-orphan sweep so the admin "mark as failed"
 * button runs the SAME three steps. The old browser-side version set the status
 * column and nothing else: the customer kept being charged for a grade they
 * never got, and FlipDesk stayed stuck. (It also silently did nothing at all —
 * there is no admin UPDATE policy on public.submissions, so RLS matched zero
 * rows and PostgREST returned success.)
 */
export async function failUngradedSubmission(
  submissionId: string,
  /** Reason recorded against the charge reversal. */
  reason: string,
  /** Message written to the FlipDesk link's `error` column. */
  flipdeskNote: string,
): Promise<boolean> {
  const { data: claimed } = await supabaseAdmin
    .from("submissions")
    .update({ status: "failed", grading_lease_until: null })
    .eq("id", submissionId)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (!claimed) return false;

  await reverseChargeForUngradedSubmission(submissionId, reason);
  await supabaseAdmin
    .from("flipdesk_grading_submissions")
    .update({ status: "failed", error: flipdeskNote.slice(0, 500) })
    .eq("submission_id", submissionId);
  return true;
}

export interface StuckSweepResult {
  scanned: number;
  /** Re-kicked (resumed) — grading will be picked back up. */
  resumed: number;
  /** Failed + refunded because the attempt budget was exhausted (poison). */
  refunded: number;
  /** Recovery errors (left for the next sweep). */
  failed: number;
}

// Injectable data access so the resume/poison-guard orchestration is unit-
// testable without a DB or a live Claude call (mirrors AbandonedSweepStore).
export interface StuckSweepStore {
  /**
   * Processing orphans whose grading lease has expired (holder presumed dead),
   * older than the stale threshold. grading_attempts drives the poison guard.
   */
  findStuck: (
    staleBeforeIso: string,
    nowIso: string,
    limit: number,
  ) => Promise<Array<{ id: string; grading_attempts: number }>>;
  /** Re-kick the grading pipeline (fire-and-forget) to resume the orphan. */
  resume: (id: string) => void;
  /**
   * Fail a poison orphan + reverse its charge, re-asserting status='processing'
   * in the UPDATE. Returns true only if it actually owned the transition (a
   * concurrent completion fails the match and is left alone).
   */
  failAndRefund: (id: string) => Promise<boolean>;
}

const defaultStuckStore: StuckSweepStore = {
  findStuck: async (staleBeforeIso, nowIso, limit) => {
    const { data, error } = await supabaseAdmin
      .from("submissions")
      .select("id, grading_attempts")
      .eq("status", "processing")
      // Only orphans whose lease has lapsed (or legacy rows with no lease). A
      // live worker still holding the lease is skipped.
      .or(`grading_lease_until.is.null,grading_lease_until.lt.${nowIso}`)
      .lt("updated_at", staleBeforeIso)
      .limit(limit);
    if (error) {
      captureException(error, { route: "stuck-submissions.scan" });
      throw new Error(`stuck-submission scan failed: ${error.message}`);
    }
    return ((data ?? []) as Array<{ id: string; grading_attempts: number | null }>).map(
      (r) => ({ id: r.id, grading_attempts: r.grading_attempts ?? 0 }),
    );
  },
  resume: (id) => {
    // Fire-and-forget; processSubmission's lease re-claim guards a concurrent
    // kick and finalizes idempotently if the grade was actually already done.
    processSubmission(id).catch((err) => {
      captureException(err, {
        route: "stuck-submissions.resume",
        extra: { submissionId: id },
      });
    });
  },
  failAndRefund: (id) =>
    failUngradedSubmission(
      id,
      "stuck in processing — attempt budget exhausted (orphan recovery)",
      "Grading repeatedly stalled; auto-failed and charge reversed.",
    ),
};

export async function recoverStuckSubmissions(
  store: StuckSweepStore = defaultStuckStore,
): Promise<StuckSweepResult> {
  const now = Date.now();
  const staleBefore = new Date(now - staleThresholdMs()).toISOString();
  const nowIso = new Date(now).toISOString();

  const stuck = await store.findStuck(staleBefore, nowIso, BATCH_LIMIT);
  if (stuck.length === 0) {
    return { scanned: 0, resumed: 0, refunded: 0, failed: 0 };
  }

  // A non-zero count is itself the alert signal (US-495 AC#3): orphans mean a
  // crash/redeploy stranded a grade run.
  recordMetric("submissions.stuck", stuck.length, {});
  captureException(
    new Error(`${stuck.length} submission(s) stuck in 'processing' beyond ${staleThresholdMs() / 60_000}m`),
    { level: "warn", route: "stuck-submissions", tags: { count: String(stuck.length) } },
  );

  const maxAttempts = gradingMaxAttempts();
  let resumed = 0;
  let refunded = 0;
  let failed = 0;
  for (const s of stuck) {
    try {
      if (s.grading_attempts < maxAttempts) {
        // Still within budget → resume (US-569). The pipeline re-claims the lease
        // and either finishes the grade or finalizes an already-written report.
        store.resume(s.id);
        resumed += 1;
        logEvent("info", "submission.resumed", { submissionId: s.id });
      } else if (await store.failAndRefund(s.id)) {
        // Poison: burned the attempt budget. Fail + refund so it can't crash-loop.
        refunded += 1;
        logEvent("warn", "submission.poison_failed", { submissionId: s.id });
      }
    } catch (err) {
      failed += 1;
      captureException(err, { route: "stuck-submissions.recover", extra: { submissionId: s.id } });
    }
  }

  if (refunded > 0) {
    recordMetric("submissions.poison_failed", refunded, {});
    captureException(
      new Error(`${refunded} submission(s) exhausted the grading attempt budget and were failed + refunded`),
      { level: "warn", route: "stuck-submissions.poison", tags: { count: String(refunded) } },
    );
  }

  return { scanned: stuck.length, resumed, refunded, failed };
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
