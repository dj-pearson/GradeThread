// US-483: factor-sanitizing + confidence-policy unit tests.
//
// sanitizeFactorScores + applyGradingConfidencePolicy are pure. ai-grading.ts
// imports the service-role supabase client at load, so set dummy env BEFORE the
// dynamic import (mirrors authenticity_test.ts).
//
//   deno test --allow-env src/tests/grading-confidence_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  sanitizeFactorScores,
  applyGradingConfidencePolicy,
  DEFAULTED_FACTOR_VALUE,
  DEFAULTED_FACTOR_CONFIDENCE_CAP,
  AUTHENTICITY_FLAG_CONFIDENCE_CAP,
} = await import("../lib/ai-grading.ts");

const VALID = {
  fabric_condition: 8,
  structural_integrity: 7.5,
  cosmetic_appearance: 9,
  functional_elements: 6,
  odor_cleanliness: 10,
};

// ── sanitizeFactorScores ─────────────────────────────────────────────────────

Deno.test("sanitizeFactorScores: all valid → no defaults, clamped to [1,10]", () => {
  const r = sanitizeFactorScores({ ...VALID, cosmetic_appearance: 12, functional_elements: -3 });
  assertEquals(r.defaultedCount, 0);
  assertEquals(r.scores.cosmetic_appearance, 10); // clamped down
  assertEquals(r.scores.functional_elements, 1); // clamped up
  assertEquals(r.scores.fabric_condition, 8);
});

Deno.test("sanitizeFactorScores: malformed factor response → defaults + counts", () => {
  // A partially-hallucinated response: two factors are non-numeric/NaN.
  const r = sanitizeFactorScores({
    fabric_condition: "great", // string
    structural_integrity: NaN,
    cosmetic_appearance: 9,
    functional_elements: 6,
    odor_cleanliness: 10,
  } as Record<string, unknown>);
  assertEquals(r.defaultedCount, 2);
  assertEquals(r.scores.fabric_condition, DEFAULTED_FACTOR_VALUE);
  assertEquals(r.scores.structural_integrity, DEFAULTED_FACTOR_VALUE);
  assertEquals(r.scores.cosmetic_appearance, 9);
});

Deno.test("sanitizeFactorScores: missing keys all default (count = 5)", () => {
  const r = sanitizeFactorScores({});
  assertEquals(r.defaultedCount, 5);
  for (const v of Object.values(r.scores)) assertEquals(v, DEFAULTED_FACTOR_VALUE);
});

// ── applyGradingConfidencePolicy ─────────────────────────────────────────────

Deno.test("policy: clean high-confidence grade ships without review", () => {
  const r = applyGradingConfidencePolicy({
    confidenceScore: 0.92,
    authenticityFlagged: false,
    defaultedFactorCount: 0,
    reviewThreshold: 0.75,
  });
  assertEquals(r.finalConfidence, 0.92);
  assert(!r.needsHumanReview);
});

Deno.test("policy: a defaulted factor caps confidence below threshold AND forces review", () => {
  const r = applyGradingConfidencePolicy({
    confidenceScore: 0.95, // model claimed high confidence
    authenticityFlagged: false,
    defaultedFactorCount: 1,
    reviewThreshold: 0.75,
  });
  assertEquals(r.finalConfidence, DEFAULTED_FACTOR_CONFIDENCE_CAP);
  assert(r.finalConfidence < 0.75);
  assert(r.needsHumanReview);
});

Deno.test("policy: defaulted factor forces review even if threshold is permissive", () => {
  // Threshold lowered to 0.1 — the explicit flag must still route to a human.
  const r = applyGradingConfidencePolicy({
    confidenceScore: 0.95,
    authenticityFlagged: false,
    defaultedFactorCount: 2,
    reviewThreshold: 0.1,
  });
  assert(r.needsHumanReview);
});

Deno.test("policy: authenticity flag caps confidence to 0.6 and forces review", () => {
  const r = applyGradingConfidencePolicy({
    confidenceScore: 0.9,
    authenticityFlagged: true,
    defaultedFactorCount: 0,
    reviewThreshold: 0.75,
  });
  assertEquals(r.finalConfidence, AUTHENTICITY_FLAG_CONFIDENCE_CAP);
  assert(r.needsHumanReview);
});

Deno.test("policy: both signals → the lower (defaulted) cap wins", () => {
  const r = applyGradingConfidencePolicy({
    confidenceScore: 0.9,
    authenticityFlagged: true,
    defaultedFactorCount: 1,
    reviewThreshold: 0.75,
  });
  assertEquals(r.finalConfidence, DEFAULTED_FACTOR_CONFIDENCE_CAP); // 0.5 < 0.6
  assert(r.needsHumanReview);
});

Deno.test("policy: low model confidence alone still routes to review", () => {
  const r = applyGradingConfidencePolicy({
    confidenceScore: 0.4,
    authenticityFlagged: false,
    defaultedFactorCount: 0,
    reviewThreshold: 0.75,
  });
  assertEquals(r.finalConfidence, 0.4);
  assert(r.needsHumanReview);
});

// US-1622 / C9: the review-gate re-derivation after post-composite adjustments.
Deno.test("reconcileNeedsReview: below-threshold forces review; boosts never un-gate", async () => {
  const { reconcileNeedsReview } = await import("../lib/ai-config.ts");
  const T = 0.75;
  // Effective confidence below threshold → review, even with no prior flag
  // (e.g. a lone verification-discrepancy shave that didn't itself set the flag).
  assertEquals(reconcileNeedsReview(false, 0.70, T), true);
  // At/above threshold and not previously flagged → no forced review.
  assertEquals(reconcileNeedsReview(false, 0.75, T), false);
  assertEquals(reconcileNeedsReview(false, 0.92, T), false);
  // A prior flag is sticky — a provenance boost that lifted confidence back over
  // the threshold must NOT un-gate an already-flagged grade.
  assertEquals(reconcileNeedsReview(true, 0.92, T), true);
});
