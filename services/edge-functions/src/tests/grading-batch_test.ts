// US-1790: batch grading queue — pure status derivation.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { deriveGradingBatchStatus, MAX_GRADE_JOB_ATTEMPTS, GRADE_ITEM_TIMEOUT_MS, GRADE_JOB_STALE_MS } =
  await import("../lib/grading-batch.ts");

Deno.test("deriveGradingBatchStatus: null while any job is open", () => {
  assertEquals(deriveGradingBatchStatus(2, 1, 3), null);
  assertEquals(deriveGradingBatchStatus(0, 0, 1), null);
});

Deno.test("deriveGradingBatchStatus: terminal tallies", () => {
  assertEquals(deriveGradingBatchStatus(5, 0, 0), "completed");
  assertEquals(deriveGradingBatchStatus(0, 5, 0), "failed");
  assertEquals(deriveGradingBatchStatus(3, 2, 0), "partial");
  assertEquals(deriveGradingBatchStatus(0, 0, 0), "completed"); // vacuous empty batch
});

Deno.test("durable-jobs constants: per-item timeout stays under JOB_STALE", () => {
  // Contract: a live job must never look stale.
  if (!(GRADE_ITEM_TIMEOUT_MS < GRADE_JOB_STALE_MS)) throw new Error("timeout must be < stale");
  assertEquals(MAX_GRADE_JOB_ATTEMPTS, 5);
});
