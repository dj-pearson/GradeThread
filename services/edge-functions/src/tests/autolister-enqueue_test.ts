// US-9115: the enqueue guards, and the seam that runs the batch.
//
// The guards moved out of POST /api/flipdesk/autolister/batch so the
// connector's create-draft tool applies the same ones. The worker did NOT move:
// the route registers it at module load and the lib calls it through that seam.
//
// A seam that is never wired does not error. It degrades: the batch is written
// as 'running' with pending jobs, the reclaim cron picks it up BATCH_STALE_MS
// later, and the only symptom is fifteen minutes of nothing. So the wiring
// itself is what this file asserts, alongside the pure pre-check.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { hasBatchRunner, insufficientAiActionsBody } = await import(
  "../lib/autolister-enqueue.ts"
);

Deno.test("importing the route registers a batch runner", async () => {
  // Before the route module is loaded nothing is wired; loading it wires it.
  // Written this way round on purpose: asserting only the after-state would
  // still pass if some other import had happened to register one.
  await import("../routes/flipdesk-autolister.ts");
  assert(
    hasBatchRunner(),
    "routes/flipdesk-autolister.ts no longer calls registerBatchRunner, so every " +
      "generation batch now waits for the reclaim cron instead of starting — which " +
      "looks like slowness, not like a break",
  );
});

Deno.test("the lib does not import a route", async () => {
  // The whole reason the seam exists. A direct import would work and would
  // quietly recreate the cycle this replaced.
  const src = await Deno.readTextFile(
    new URL("../lib/autolister-enqueue.ts", import.meta.url),
  );
  assert(
    !/from\s+["']\.\.\/routes\//.test(src),
    "lib/autolister-enqueue.ts imports a route module",
  );
});

// ── The count-aware pre-check (US-1545), which moved with the guards ───────

Deno.test("a batch that fits the remaining allowance is not refused", () => {
  assertEquals(insufficientAiActionsBody(10, 100, 50), null);
});

Deno.test("an unlimited plan is never refused", () => {
  assertEquals(insufficientAiActionsBody(10_000, -1, 999_999), null);
});

Deno.test("a batch larger than the remainder is refused WITH the numbers", () => {
  // "Trim or upgrade" is only actionable if the seller can see by how much.
  const body = insufficientAiActionsBody(30, 100, 90);
  assert(body !== null);
  assertEquals(body.needed, 30);
  assertEquals(body.remaining, 10);
  assertEquals(body.cap, 100);
  assertEquals(body.code, "INSUFFICIENT_AI_ACTIONS");
});

Deno.test("a batch exactly filling the remainder is allowed", () => {
  // The boundary, both sides: 10 of 10 fits, 11 does not.
  assertEquals(insufficientAiActionsBody(10, 100, 90), null);
  assert(insufficientAiActionsBody(11, 100, 90) !== null);
});

Deno.test("an over-used counter does not report a negative remainder", () => {
  const body = insufficientAiActionsBody(1, 100, 150);
  assert(body !== null);
  assertEquals(body.remaining, 0);
});
