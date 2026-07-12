// US-525/526: AutoLister generation reliability.
//   - deriveBatchStatus: a batch terminalizes correctly (and only) once no jobs
//     are open, so a run always reaches a terminal status.
//   - withTimeout: a hung per-item generation is capped with a clear error.
//
// flipdesk-autolister.ts imports the service-role supabase client at load, so
// set dummy env BEFORE the dynamic import (same pattern as the other tests).
//   deno test --allow-env src/tests/autolister-reliability_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  deriveBatchStatus,
  insufficientAiActionsBody,
  isHaltedBatchStatus,
  MAX_BATCH_ITEMS,
  MAX_PUBLISH_BATCH_ITEMS,
  settleAfterGeneration,
  withTimeout,
} = await import("../routes/flipdesk-autolister.ts");

Deno.test("deriveBatchStatus: still running while any job is open", () => {
  assertEquals(deriveBatchStatus(5, 2, 1), null);
  assertEquals(deriveBatchStatus(0, 0, 10), null);
});

Deno.test("deriveBatchStatus: completed when all succeeded", () => {
  assertEquals(deriveBatchStatus(10, 0, 0), "completed");
});

Deno.test("deriveBatchStatus: failed when none succeeded", () => {
  assertEquals(deriveBatchStatus(0, 10, 0), "failed");
});

Deno.test("deriveBatchStatus: partial on a mix", () => {
  assertEquals(deriveBatchStatus(7, 3, 0), "partial");
});

// ── US-1923: batch cancel can't be reverted by an in-flight worker ────

Deno.test("US-1923: isHaltedBatchStatus true only for terminal statuses", () => {
  // Terminal (an operator cancel flips every open job to failed → terminal).
  assert(isHaltedBatchStatus("completed"));
  assert(isHaltedBatchStatus("failed"));
  assert(isHaltedBatchStatus("partial"));
  // Non-terminal / unknown → keep working.
  assert(!isHaltedBatchStatus("running"));
  assert(!isHaltedBatchStatus("pending"));
  assert(!isHaltedBatchStatus(null));
  assert(!isHaltedBatchStatus(undefined));
});

Deno.test("US-1923: a cancelled batch stays terminal (all open jobs → failed)", () => {
  // adminCancelGenerationBatch flips pending+running jobs to 'failed', then
  // finalizeBatch re-derives from the rows. With N succeeded already and the
  // rest cancelled, the batch is 'partial'; with none succeeded, 'failed'.
  assertEquals(deriveBatchStatus(0, 10, 0), "failed"); // cancelled before any success
  assertEquals(deriveBatchStatus(3, 7, 0), "partial"); // 3 done, 7 cancelled
  // And the worker's own finalize after cancel re-derives the SAME terminal
  // status (no open jobs remain), so it can't flip the batch back to completed.
});

Deno.test("US-1923: settleAfterGeneration — cancelled job refunds and skips item advance", () => {
  // Conditional success write won (job was still 'running'): advance + keep spend.
  assertEquals(settleAfterGeneration(true), { advanceItem: true, refundReservation: false });
  // Write matched nothing (cancel flipped the job to 'failed' mid-generation):
  // don't advance the item, refund the reserved AI action (reconcile the cap).
  assertEquals(settleAfterGeneration(false), { advanceItem: false, refundReservation: true });
});

// ── US-1545: 300-item batches + count-aware quota pre-check ─────────

Deno.test("US-1545: batch ceilings raised to 300 (generation + publish in lockstep)", () => {
  assertEquals(MAX_BATCH_ITEMS, 300);
  assertEquals(MAX_PUBLISH_BATCH_ITEMS, MAX_BATCH_ITEMS);
});

Deno.test("US-1545: a full-size 300-job batch terminalizes exactly like a small one", () => {
  // Synthetic large batch: the terminalization rule the worker + reclaim cron
  // roll up on must behave identically at the new ceiling.
  const n = MAX_BATCH_ITEMS;
  assertEquals(deriveBatchStatus(0, 0, n), null); // all open → running
  assertEquals(deriveBatchStatus(n - 1, 0, 1), null); // one job left → running
  assertEquals(deriveBatchStatus(n, 0, 0), "completed");
  assertEquals(deriveBatchStatus(0, n, 0), "failed");
  assertEquals(deriveBatchStatus(n - 40, 40, 0), "partial");
});

Deno.test("US-1545: insufficientAiActionsBody refuses only when the batch can't fit", () => {
  // Fits exactly → null (the per-item reservation still guards races).
  assertEquals(insufficientAiActionsBody(142, 750, 608), null);
  // Unlimited plan → null regardless.
  assertEquals(insufficientAiActionsBody(300, -1, 999_999), null);
  // One short → 402 body with the numbers the UI needs.
  const body = insufficientAiActionsBody(143, 750, 608);
  assert(body !== null);
  assertEquals(body.code, "INSUFFICIENT_AI_ACTIONS");
  assertEquals(body.needed, 143);
  assertEquals(body.remaining, 142);
  assertEquals(body.cap, 750);
  assert(body.error.includes("143"));
  assert(body.error.includes("142"));
});

Deno.test("US-1545: an already-over-cap month reports remaining 0, never negative", () => {
  const body = insufficientAiActionsBody(10, 200, 230);
  assert(body !== null);
  assertEquals(body.remaining, 0);
});

Deno.test("withTimeout: resolves when the work finishes in time", async () => {
  const fast = new Promise<string>((r) => setTimeout(() => r("ok"), 5));
  assertEquals(await withTimeout(fast, 1000, "work"), "ok");
});

Deno.test("withTimeout: rejects with a labeled error when too slow", async () => {
  const slow = new Promise<string>((r) => setTimeout(() => r("late"), 1000));
  const err = await assertRejects(
    () => withTimeout(slow, 10, "Listing generation"),
    Error,
    "Listing generation timed out",
  );
  assert(err instanceof Error);
});
