// US-844: tier-eligibility policy tests for the single launch/eligibility config
// (support-assistant-config.ts). The plan/phase decision is pure, so no DB or
// model is needed; the launch flag (isSupportAssistantLaunched) is exercised by
// the engine route, not here.

import { assert, assertEquals } from "@std/assert";

// support-* libs import supabase.ts at module load, which throws if these aren't
// set — mirror support-assistant-engine_test.ts.
Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const C = await import("../lib/support-assistant-config.ts");

Deno.test("free is never eligible at any phase", () => {
  for (const phase of ["off", "internal", "business", "paid"] as const) {
    assertEquals(
      C.isPlanEligibleForAssistant("free", { phase }),
      false,
      `free should be ineligible at phase ${phase}`,
    );
  }
});

Deno.test("paid phase: all paid tiers eligible, free not", () => {
  assert(C.isPlanEligibleForAssistant("starter", { phase: "paid" }));
  assert(C.isPlanEligibleForAssistant("pro", { phase: "paid" }));
  assert(C.isPlanEligibleForAssistant("business", { phase: "paid" }));
  assert(!C.isPlanEligibleForAssistant("free", { phase: "paid" }));
});

Deno.test("business phase: only Business tier eligible by plan", () => {
  assert(C.isPlanEligibleForAssistant("business", { phase: "business" }));
  assert(!C.isPlanEligibleForAssistant("pro", { phase: "business" }));
  assert(!C.isPlanEligibleForAssistant("starter", { phase: "business" }));
});

Deno.test("internal phase: no plan is eligible, but admins always are", () => {
  for (const plan of ["free", "starter", "pro", "business"] as const) {
    assertEquals(
      C.isPlanEligibleForAssistant(plan, { phase: "internal" }),
      false,
    );
    assert(C.isPlanEligibleForAssistant(plan, { phase: "internal", isAdmin: true }));
  }
});

Deno.test("admins are eligible even when the phase is off", () => {
  assert(C.isPlanEligibleForAssistant("free", { phase: "off", isAdmin: true }));
  assert(!C.isPlanEligibleForAssistant("business", { phase: "off" }));
});

Deno.test("eligiblePlansForPhase reflects the phase->plan map", () => {
  assertEquals([...C.eligiblePlansForPhase("off")], []);
  assertEquals([...C.eligiblePlansForPhase("business")], ["business"]);
  assertEquals(
    [...C.eligiblePlansForPhase("paid")].sort(),
    ["business", "pro", "starter"],
  );
});
