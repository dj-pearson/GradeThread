// US-559: durable bulk publish.
//   - publishFailureMessage: a failed publishItemForOwner result is surfaced to
//     the job as a clear, seller-readable message — blockers take precedence,
//     then detail, then error, then a generic fallback.
//   - deriveBatchStatus: the publish batch terminalizes on the same rule the
//     generation batch uses (shared pure helper).
//
// flipdesk-autolister.ts imports the service-role supabase client at load, so
// set dummy env BEFORE the dynamic import (same pattern as the other tests).
//   deno test --allow-env src/tests/publish-batch_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { publishFailureMessage, deriveBatchStatus } = await import(
  "../routes/flipdesk-autolister.ts"
);

Deno.test("publishFailureMessage: blockers win and are joined", () => {
  assertEquals(
    publishFailureMessage({ ok: false, blockers: ["No price set", "No category"] }),
    "No price set • No category",
  );
});

Deno.test("publishFailureMessage: detail beats error when no blockers", () => {
  assertEquals(
    publishFailureMessage({ detail: "eBay rejected the offer", error: "Publish failed" }),
    "eBay rejected the offer",
  );
});

Deno.test("publishFailureMessage: falls back to error, then a generic message", () => {
  assertEquals(publishFailureMessage({ error: "Token expired" }), "Token expired");
  assertEquals(publishFailureMessage({}), "Publish failed.");
  assertEquals(publishFailureMessage({ blockers: [] }), "Publish failed.");
});

Deno.test("deriveBatchStatus: a publish batch terminalizes only once no jobs are open", () => {
  assertEquals(deriveBatchStatus(3, 1, 2), null);
  assertEquals(deriveBatchStatus(4, 0, 0), "completed");
  assertEquals(deriveBatchStatus(0, 4, 0), "failed");
  assertEquals(deriveBatchStatus(2, 2, 0), "partial");
});
