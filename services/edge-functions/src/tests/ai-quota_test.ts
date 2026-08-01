// US-386: the AI-action quota must read the FlipDesk plan (not the deprecated
// `plan` column) and honor the user's self-cap. These tests pin two invariants
// that, if broken, recreate the original bug:
//   1. AI_ACTION_LIMITS (the table checkQuota uses) agrees with plan-gate's
//      PLAN_MATRIX.aiActionsPerMonth — a single per-plan budget, no drift.
//   2. effectiveAiCap applies min(planLimit, userLimit) so a self-cap blocks
//      below the plan limit.
// Pure imports only (the cap table + helper), so no DB fixture is needed.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { AI_ACTION_LIMITS } from "../routes/flipdesk-ai.ts";
import { effectiveAiCap, __testing } from "../lib/plan-gate.ts";

Deno.test("AI_ACTION_LIMITS mirrors PLAN_MATRIX.aiActionsPerMonth (keyed by flipdesk_plan)", () => {
  const matrix = __testing.PLAN_MATRIX;
  for (const plan of ["free", "starter", "pro", "business"] as const) {
    assertEquals(
      AI_ACTION_LIMITS[plan],
      matrix[plan].aiActionsPerMonth,
      `AI_ACTION_LIMITS.${plan} drifted from PLAN_MATRIX`,
    );
  }
  // The deprecated user_plan keys must NOT be the source of truth anymore.
  assertEquals(AI_ACTION_LIMITS.professional, undefined);
  assertEquals(AI_ACTION_LIMITS.enterprise, undefined);
});

Deno.test("self-cap blocks below the plan limit (US-386/US-224)", () => {
  // Pro plan = 750 actions; a user self-cap of 100 wins.
  assertEquals(effectiveAiCap(AI_ACTION_LIMITS.pro, 100), 100);
  // No self-cap → full plan limit.
  assertEquals(effectiveAiCap(AI_ACTION_LIMITS.pro, null), 750);
  // A self-cap above the plan limit can't raise it.
  assertEquals(effectiveAiCap(AI_ACTION_LIMITS.free, 9999), 25);
});
