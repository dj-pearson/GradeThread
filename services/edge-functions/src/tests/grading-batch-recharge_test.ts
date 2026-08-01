// US-2289 [P0]: one garment, one charge — however many times the job is
// reclaimed.
//
// The bug: gradeBatchItem created a submission and called runPaymentPrecedence
// unconditionally on EVERY invocation, and the reclaim cron called it again
// with no reference to the submission a prior attempt had already created and
// paid for. With MAX_GRADE_JOB_ATTEMPTS at 5, one garment could be debited five
// times and produce five certificates.
//
// Nothing detected it, and that is the part worth remembering: every individual
// attempt was correct. Create a submission — correct. Charge for it — correct.
// Grade it — correct. The defect only exists in the relationship BETWEEN
// attempts, which is exactly the kind a per-attempt test cannot see.
//
// Two windows made it reachable rather than theoretical:
//   • the item lease was 240s while one garment's worst case is already
//     (AI_MAX_RETRIES + 1) x AI_TIMEOUT_MS = 360s, so the worker gave up on a
//     pipeline that was still running; and
//   • the stale threshold was 360s — EQUAL to that worst case — so the reclaim
//     cron could pick up a job nobody had abandoned.
//
// Both are now derived from the AI budget instead of written down beside it.

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

import { assertEquals } from "@std/assert";

const { GRADE_ITEM_TIMEOUT_MS, GRADE_JOB_STALE_MS, GRADE_BATCH_STALE_MS } = await import(
  "../lib/grading-batch.ts"
);
const { isPaidSubmissionStatus } = await import("../lib/paid-submission.ts");
const { getAiMaxRetries, getAiTimeoutMs } = await import("../lib/ai-config.ts");

Deno.test("the item lease exceeds one garment's true worst case", () => {
  // The number that made the race reachable. If the lease is shorter than the
  // work, the worker abandons a pipeline that is still running and may still
  // write a valid grade.
  const worstCaseAi = (getAiMaxRetries() + 1) * getAiTimeoutMs();
  assertEquals(
    GRADE_ITEM_TIMEOUT_MS > worstCaseAi,
    true,
    `lease ${GRADE_ITEM_TIMEOUT_MS}ms must exceed AI worst case ${worstCaseAi}ms`,
  );
});

Deno.test("the stale window sits comfortably above the lease", () => {
  // Reclaiming inside a live worker's own lease is not reclaiming, it is
  // racing. The old values were EQUAL, which is the same as racing.
  assertEquals(GRADE_JOB_STALE_MS > GRADE_ITEM_TIMEOUT_MS, true);
  // A margin, not a hair: at 1.5x, a worker that is merely slow is never
  // mistaken for a dead one.
  assertEquals(GRADE_JOB_STALE_MS >= GRADE_ITEM_TIMEOUT_MS * 1.4, true);
});

Deno.test("the batch sweeper never fires before its jobs are reclaimable", () => {
  // Otherwise the batch sweep runs, finds no reclaimable job, and does nothing
  // — a cron that looks alive and accomplishes nothing.
  assertEquals(GRADE_BATCH_STALE_MS > GRADE_JOB_STALE_MS, true);
});

Deno.test("the windows are DERIVED from the AI budget, not written beside it", () => {
  // Two hardcoded numbers that must follow a third are two numbers that drift —
  // which is how the lease ended up shorter than the work it was leasing. This
  // asserts the arithmetic rather than the literal, so raising AI_TIMEOUT_MS or
  // AI_MAX_RETRIES moves the windows with it and this test still passes.
  const worstCaseAi = (getAiMaxRetries() + 1) * getAiTimeoutMs();
  const headroom = GRADE_ITEM_TIMEOUT_MS - worstCaseAi;
  // Real headroom for composite scoring, image ingest and DB writes — not a
  // rounding artefact.
  assertEquals(headroom >= 60_000, true, `headroom ${headroom}ms is too thin`);
  assertEquals(GRADE_JOB_STALE_MS, Math.round(GRADE_ITEM_TIMEOUT_MS * 1.5));
});

Deno.test("only a genuinely paid submission is resumable", () => {
  // The hinge of the whole fix. Resuming an UNPAID submission would skip a
  // charge that never happened; refusing to resume a PAID one charges twice.
  for (const paid of ["included", "credits", "paid_stripe"]) {
    assertEquals(isPaidSubmissionStatus(paid), true, `${paid} must be resumable`);
  }
});

Deno.test("an unpaid, missing or unknown status fails CLOSED", () => {
  // Failing closed here re-creates a submission nothing was charged for, which
  // is free. Failing open charges the customer a second time.
  for (const notPaid of ["unpaid", "refunded", "", "PAID", null, undefined]) {
    assertEquals(
      isPaidSubmissionStatus(notPaid as string | null | undefined),
      false,
      `${String(notPaid)} must NOT be treated as paid`,
    );
  }
});
