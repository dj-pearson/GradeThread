// Unit tests for the pure shadow-grading decision math (US-330). The
// orchestrator (runShadowGrades) needs the DB + composite API and is exercised
// via the pipeline; the sampling/agreement/delta/tag/summary logic here is
// pure and fully covered.
//
// grading-shadow.ts transitively imports the service-role supabase client (via
// ai-grading.ts), which throws at module init without env — set dummy creds
// BEFORE the dynamic import (mirrors ebay-notification-verify_test).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  agreementWithin,
  deltaBucket,
  deriveDivergenceTags,
  roundTenth,
  shouldSample,
  summarizeComparisons,
} = await import("../lib/grading-shadow.ts");

Deno.test("roundTenth: rounds to one decimal", () => {
  assertEquals(roundTenth(0.5 - 0.1), 0.4);
  assertEquals(roundTenth(7.249), 7.2);
  assertEquals(roundTenth(-1.06), -1.1);
});

Deno.test("agreementWithin: half-point band, inclusive of float-noisy edge", () => {
  assert(agreementWithin(8.0, 8.5));
  assert(agreementWithin(8.5, 8.0));
  assert(agreementWithin(8.0, 8.0));
  assert(!agreementWithin(8.0, 8.6));
  // 9.0 - 8.5 = 0.5 but float noise can make it 0.50000001 — must still agree.
  assert(agreementWithin(9.0, 8.5));
});

Deno.test("shouldSample: 0 never, 1 always, fraction honors rng", () => {
  assertEquals(shouldSample(0), false);
  assertEquals(shouldSample(1), true);
  // clamps out-of-range
  assertEquals(shouldSample(-5), false);
  assertEquals(shouldSample(5), true);
  // rng below rate → sampled; at/above → not.
  assertEquals(shouldSample(0.3, () => 0.29), true);
  assertEquals(shouldSample(0.3, () => 0.3), false);
  assertEquals(shouldSample(0.3, () => 0.99), false);
});

Deno.test("deriveDivergenceTags: category + styles + distressed_denim composite", () => {
  const t = deriveDivergenceTags("jeans", ["Distressed", "raw hem"]);
  assert(t.includes("category:jeans"));
  assert(t.includes("distressed"));
  assert(t.includes("raw_hem"));
  assert(t.includes("distressed_denim"), "denim + distress hint => distressed_denim");

  // Non-denim distressed → no distressed_denim composite tag.
  const jacket = deriveDivergenceTags("jacket", ["ripped"]);
  assert(jacket.includes("category:jacket"));
  assert(jacket.includes("ripped"));
  assert(!jacket.includes("distressed_denim"));

  // Denim category inferred from the style attribute too.
  const fromStyle = deriveDivergenceTags(null, ["denim", "frayed"]);
  assert(fromStyle.includes("distressed_denim"));

  // No category, no styles → empty.
  assertEquals(deriveDivergenceTags(null, []), []);
});

Deno.test("deltaBucket: nearest 0.5 with clamped overflow ends", () => {
  assertEquals(deltaBucket(0), "0.0");
  assertEquals(deltaBucket(0.24), "0.0");
  assertEquals(deltaBucket(0.25), "+0.5");
  assertEquals(deltaBucket(-0.5), "-0.5");
  assertEquals(deltaBucket(1.2), "+1.0");
  assertEquals(deltaBucket(3.4), ">=+3.0");
  assertEquals(deltaBucket(-9), "<=-3.0");
});

Deno.test("summarizeComparisons: agreement, deltas, histogram, per-tag, errors", () => {
  const rows = [
    { score_delta: 0.0, agreement: true, tags: ["category:jeans", "distressed_denim"], shadow_overall_score: 8.0, error: null },
    { score_delta: 0.5, agreement: true, tags: ["category:jeans", "distressed_denim"], shadow_overall_score: 8.5, error: null },
    { score_delta: 1.5, agreement: false, tags: ["distressed_denim"], shadow_overall_score: 9.0, error: null },
    { score_delta: -1.0, agreement: false, tags: ["category:tshirt"], shadow_overall_score: 6.0, error: null },
    // errored row: counted in total + errored, excluded from score stats.
    { score_delta: null, agreement: null, tags: ["category:jeans"], shadow_overall_score: null, error: "boom" },
  ];
  const s = summarizeComparisons(rows);
  assertEquals(s.total, 5);
  assertEquals(s.errored, 1);
  assertEquals(s.scored, 4);
  // 2 of 4 scored agree.
  assertEquals(s.agreement_rate, 0.5);
  // mean |delta| = (0 + 0.5 + 1.5 + 1.0) / 4 = 0.75
  assertEquals(s.mean_abs_delta, 0.75);
  // mean signed delta = (0 + 0.5 + 1.5 - 1.0) / 4 = 0.25
  assertEquals(s.mean_delta, 0.25);
  assertEquals(s.delta_histogram["0.0"], 1);
  assertEquals(s.delta_histogram["+0.5"], 1);
  assertEquals(s.delta_histogram["+1.5"], 1);
  assertEquals(s.delta_histogram["-1.0"], 1);
  // distressed_denim slice: 3 scored rows, 2 agree.
  assertEquals(s.per_tag["distressed_denim"].count, 3);
  assertEquals(s.per_tag["distressed_denim"].agreement_rate, 0.6667);
  // mean |delta| over distressed_denim = (0 + 0.5 + 1.5)/3 ≈ 0.67
  assertEquals(s.per_tag["distressed_denim"].mean_abs_delta, 0.67);

  // Empty input → safe nulls.
  const empty = summarizeComparisons([]);
  assertEquals(empty.total, 0);
  assertEquals(empty.agreement_rate, null);
  assertEquals(empty.mean_abs_delta, null);
});
