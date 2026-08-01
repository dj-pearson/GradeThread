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

// ── US-2299: the ceiling the caps established travels with the grade ────────
//
// The bug: the pipeline's running confidenceCeiling was seeded from
// `partialSuccess ? PARTIAL_IMAGE_CONFIDENCE_CAP : 1`, so it knew nothing about
// the caps applied in here. A grade held to 0.5 for a hallucinated (defaulted)
// factor could then be lifted by a provenance boost — verified capture, live
// capture, verified 360 — and STORED at up to 1.0.
//
// The review gate itself held, which is why this survived: the grade still went
// to a human. What did not hold is the stored number, and that number feeds the
// public confidence label a buyer reads and the calibration miner that derives
// future thresholds. A wrong-but-confident number there is exactly what the
// contract's "never raise confidence post-composite" rule exists to prevent.
//
// The ceiling is reported SEPARATELY from finalConfidence on purpose. Clamping
// later boosts to finalConfidence would freeze confidence and disable the
// boosts entirely; clamping to the ceiling lets an uncapped grade earn its
// boost while a capped one cannot be lifted past its cap.

const CLEAN = {
  confidenceScore: 0.9,
  authenticityFlagged: false,
  defaultedFactorCount: 0,
  reviewThreshold: 0.75,
};

Deno.test("US-2299: no cap fired → ceiling 1, so a boost is still allowed", () => {
  const r = applyGradingConfidencePolicy(CLEAN);
  assertEquals(r.confidenceCeiling, 1);
  assertEquals(r.finalConfidence, 0.9);
});

Deno.test("US-2299: a defaulted factor caps the ceiling, not just the value", () => {
  // The headline case. Before, the value was capped and the ceiling was not, so
  // the cap was erased by the next boost.
  const r = applyGradingConfidencePolicy({ ...CLEAN, defaultedFactorCount: 1 });
  assertEquals(r.confidenceCeiling, DEFAULTED_FACTOR_CONFIDENCE_CAP);
  assertEquals(r.finalConfidence, DEFAULTED_FACTOR_CONFIDENCE_CAP);
  assert(r.needsHumanReview);
});

Deno.test("US-2299: an authenticity flag caps the ceiling", () => {
  const r = applyGradingConfidencePolicy({ ...CLEAN, authenticityFlagged: true });
  assertEquals(r.confidenceCeiling, AUTHENTICITY_FLAG_CONFIDENCE_CAP);
});

Deno.test("US-2299: suspected injection caps the ceiling", () => {
  const r = applyGradingConfidencePolicy({ ...CLEAN, injectionSuspected: true });
  assert(r.confidenceCeiling <= 0.5);
});

Deno.test("US-2299: caps COMPOSE by min — the tightest one wins", () => {
  // The contract's rule. An authenticity flag (0.6) plus a defaulted factor
  // (0.5) must land on 0.5, not on whichever was checked last.
  const r = applyGradingConfidencePolicy({
    ...CLEAN,
    authenticityFlagged: true,
    defaultedFactorCount: 1,
  });
  assertEquals(
    r.confidenceCeiling,
    Math.min(AUTHENTICITY_FLAG_CONFIDENCE_CAP, DEFAULTED_FACTOR_CONFIDENCE_CAP),
  );
});

Deno.test("US-2299: the ceiling never RAISES a low-confidence grade", () => {
  // A grade the model itself scored at 0.2 stays at 0.2. The ceiling is a
  // maximum, never a target — reading it as one would be the same contract
  // violation pointing the other way.
  const r = applyGradingConfidencePolicy({ ...CLEAN, confidenceScore: 0.2 });
  assertEquals(r.finalConfidence, 0.2);
  assertEquals(r.confidenceCeiling, 1);
});

Deno.test("US-2299: finalConfidence never exceeds the ceiling it reports", () => {
  // The invariant the pipeline relies on, asserted across the whole grid rather
  // than case by case.
  for (const confidenceScore of [0, 0.3, 0.55, 0.75, 0.95, 1]) {
    for (const authenticityFlagged of [false, true]) {
      for (const defaultedFactorCount of [0, 1, 3]) {
        for (const injectionSuspected of [false, true]) {
          const r = applyGradingConfidencePolicy({
            confidenceScore,
            authenticityFlagged,
            defaultedFactorCount,
            injectionSuspected,
            reviewThreshold: 0.75,
          });
          assert(
            r.finalConfidence <= r.confidenceCeiling,
            `confidence ${r.finalConfidence} exceeded ceiling ${r.confidenceCeiling}`,
          );
          assert(r.confidenceCeiling <= 1 && r.confidenceCeiling > 0);
        }
      }
    }
  }
});

Deno.test("US-2299: the pipeline seeds its running ceiling from the composite", () => {
  // A source assertion because the defect was a SEEDING value, and a seeding
  // value has no runtime symptom the pipeline can observe — every later clamp
  // did exactly what it was told, against a ceiling that was simply too high.
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  assert(
    src.includes("compositeResult.confidence_ceiling"),
    "confidenceCeiling must be seeded from the ceiling compositeGrade applied",
  );
  // And the three provenance boosts must still clamp to that running ceiling.
  assertEquals(src.split("const ceiling = confidenceCeiling;").length - 1, 3);
});
