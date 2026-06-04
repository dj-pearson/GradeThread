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

const { deriveBatchStatus, withTimeout } = await import(
  "../routes/flipdesk-autolister.ts"
);

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
