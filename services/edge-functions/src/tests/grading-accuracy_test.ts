// Unit tests for the rewritten per-factor accuracy math (US-073 refinement).
//
// calculateReviewAccuracy now uses the reviewer's ACTUAL per-factor
// corrections instead of estimating per-factor error from the overall ratio.
// accuracy-tracking.ts imports the service-role supabase client (which reads
// env at module load), so we set dummy env then dynamic-import — no live DB is
// touched by calculateReviewAccuracy itself (it's pure).
//
//   deno test --allow-env src/tests/grading-accuracy_test.ts

import {
  assert,
  assertEquals,
} from "@std/assert";

// Must be set BEFORE the dynamic import so supabase.ts doesn't throw.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { calculateReviewAccuracy } = await import("../lib/accuracy-tracking.ts");

const AI = {
  overall_score: 6.0,
  fabric_condition_score: 5.0,
  structural_integrity_score: 6.0,
  cosmetic_appearance_score: 7.0,
  functional_elements_score: 8.0,
  odor_cleanliness_score: 9.0,
};

const NO_FACTOR_EDITS = {
  adjusted_fabric_condition: null,
  adjusted_structural_integrity: null,
  adjusted_cosmetic_appearance: null,
  adjusted_functional_elements: null,
  adjusted_odor_cleanliness: null,
};

Deno.test("approved as-is → perfect agreement, zero factor error", () => {
  const r = calculateReviewAccuracy(AI, {
    original_score: 6.0,
    adjusted_score: null,
    ...NO_FACTOR_EDITS,
  });
  assertEquals(r.overall_error, 0);
  assert(r.agreed);
  for (const f of Object.values(r.factor_errors)) {
    assertEquals(f, 0);
  }
});

Deno.test("per-factor correction is measured exactly, not estimated", () => {
  // Reviewer bumped Fabric 5.0 → 8.0 (the classic distressed-denim fix: the AI
  // penalized intentional fabric distressing) and left the rest untouched.
  const r = calculateReviewAccuracy(AI, {
    original_score: 6.0,
    adjusted_score: 7.0,
    ...NO_FACTOR_EDITS,
    adjusted_fabric_condition: 8.0,
  });
  assertEquals(r.overall_error, 1.0);
  assert(!r.agreed); // 1.0 > 0.5
  // The corrected factor reflects the true delta...
  assertEquals(r.factor_errors.fabric_condition, 3.0);
  // ...and untouched factors are null (excluded from MAE), NOT fabricated.
  assertEquals(r.factor_errors.structural_integrity, null);
  assertEquals(r.factor_errors.cosmetic_appearance, null);
});

Deno.test("overall adjusted but no factor edits → factor errors unknown (null)", () => {
  const r = calculateReviewAccuracy(AI, {
    original_score: 6.0,
    adjusted_score: 6.5,
    ...NO_FACTOR_EDITS,
  });
  assertEquals(r.overall_error, 0.5);
  assert(r.agreed); // exactly 0.5 counts as agreement
  // No per-factor data supplied → don't invent it.
  for (const f of Object.values(r.factor_errors)) {
    assertEquals(f, null);
  }
});

Deno.test("agreement boundary is inclusive at 0.5", () => {
  const within = calculateReviewAccuracy(AI, {
    original_score: 6.0,
    adjusted_score: 5.5,
    ...NO_FACTOR_EDITS,
  });
  assert(within.agreed);

  const outside = calculateReviewAccuracy(AI, {
    original_score: 6.0,
    adjusted_score: 5.4,
    ...NO_FACTOR_EDITS,
  });
  assert(!outside.agreed);
});
