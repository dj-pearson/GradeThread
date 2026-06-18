// US-1068: golden-set growth from corrections.
//
// isHighSignalCorrection decides whether a human review is worth promoting into
// a candidate golden eval case. grading-eval.ts transitively imports the
// service-role supabase client (reads env at module load), so set dummy env
// FIRST then dynamic-import — the selector itself is pure and touches no DB.
//
//   deno test --allow-env src/tests/grading-golden-growth_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isHighSignalCorrection } = await import("../lib/grading-eval.ts");

Deno.test("intentional-design misread is always high-signal", () => {
  // Even with zero score change, a flagged misread is a failure mode the golden
  // set should defend against.
  assert(
    isHighSignalCorrection(
      { original_score: 7, adjusted_score: 7, intentional_misread: true },
      1.0,
    ),
  );
});

Deno.test("a score moved by >= min_delta is high-signal", () => {
  assert(
    isHighSignalCorrection(
      { original_score: 6, adjusted_score: 8, intentional_misread: false },
      1.0,
    ),
  );
  // Direction doesn't matter — magnitude does.
  assert(
    isHighSignalCorrection(
      { original_score: 9, adjusted_score: 7.5, intentional_misread: null },
      1.0,
    ),
  );
});

Deno.test("a small correction below min_delta is NOT high-signal", () => {
  assertEquals(
    isHighSignalCorrection(
      { original_score: 7, adjusted_score: 7.5, intentional_misread: false },
      1.0,
    ),
    false,
  );
});

Deno.test("an approved-as-is review (no adjusted score, no misread) is NOT high-signal", () => {
  assertEquals(
    isHighSignalCorrection(
      { original_score: 7, adjusted_score: null, intentional_misread: null },
      1.0,
    ),
    false,
  );
});

Deno.test("min_delta is the inclusive boundary", () => {
  assert(
    isHighSignalCorrection(
      { original_score: 7, adjusted_score: 8, intentional_misread: false },
      1.0,
    ),
  );
});
