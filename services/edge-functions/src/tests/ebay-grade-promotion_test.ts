import { assertEquals } from "@std/assert";

// flipdesk-ebay.ts (and its ebay-client import) read the service-role supabase
// client + env at load, so set dummy env BEFORE the dynamic import (same pattern
// as offer-already-ended_test / publish-idempotency_test).
//   deno test --allow-env src/tests/ebay-grade-promotion_test.ts
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { applyGradeListingPromotion } = await import("../routes/flipdesk-ebay.ts");

// US-1502: the grade item specific value is "GradeThread <n.n>" under the
// "Condition Grade" key. certificate_url:null keeps the test DB-free (the cert
// branch that lazily backfills a number is skipped).
const GRADE_KEY = "Condition Grade";

Deno.test("promotion: injects the Condition Grade specific when absent", async () => {
  const aspects: Record<string, string[]> = {};
  const desc = await applyGradeListingPromotion(
    { grade_value: 9, certificate_url: null },
    aspects,
    "A nice jacket.",
  );
  assertEquals(aspects[GRADE_KEY], ["GradeThread 9.0"]);
  assertEquals(desc, "A nice jacket."); // no cert url → description unchanged
});

Deno.test("promotion: non-force PRESERVES an existing grade specific", async () => {
  const aspects: Record<string, string[]> = { [GRADE_KEY]: ["GradeThread 5.0"] };
  await applyGradeListingPromotion(
    { grade_value: 9, certificate_url: null },
    aspects,
    "desc",
  );
  assertEquals(aspects[GRADE_KEY], ["GradeThread 5.0"]);
});

Deno.test("promotion: force OVERWRITES a stale/overstated grade specific (downgrade)", async () => {
  const aspects: Record<string, string[]> = { [GRADE_KEY]: ["GradeThread 9.0"] };
  await applyGradeListingPromotion(
    { grade_value: 6.5, certificate_url: null },
    aspects,
    "desc",
    { force: true },
  );
  assertEquals(aspects[GRADE_KEY], ["GradeThread 6.5"]);
});

Deno.test("promotion: no grade value is a no-op on the aspect map", async () => {
  const aspects: Record<string, string[]> = {};
  const desc = await applyGradeListingPromotion(
    { grade_value: null, certificate_url: null },
    aspects,
    "keep me",
  );
  assertEquals(aspects[GRADE_KEY], undefined);
  assertEquals(desc, "keep me");
});
