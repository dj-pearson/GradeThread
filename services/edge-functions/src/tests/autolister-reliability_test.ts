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
  MAX_BATCH_ITEMS,
  MAX_PUBLISH_BATCH_ITEMS,
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
