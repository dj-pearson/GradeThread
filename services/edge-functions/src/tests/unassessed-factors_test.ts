// US-3535: a factor no photo could judge forces review instead of shipping a
// neutral 7.0 as if it were a reading. Inert behind a flag.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { applyGradingConfidencePolicy } from "../lib/ai-grading.ts";
import { computeWeightedOverall, scoreToGradeTier } from "../lib/human-review.ts";
import {
  UNASSESSED_FACTOR_CONFIDENCE_CAP,
  unassessedFactorReviewEnabled,
  unassessedFactors,
} from "../lib/unassessed-factors.ts";

const TEE = [
  { unassessable_factors: ["functional_elements", "odor_cleanliness"] },
  { unassessable_factors: ["functional_elements", "odor_cleanliness"] },
  { unassessable_factors: ["functional_elements", "odor_cleanliness"] },
];

Deno.test("US-3535: a factor every photo marked unassessable is found; odor is not", () => {
  assertEquals(unassessedFactors(TEE), ["functional_elements"]);
});

Deno.test("US-3535: one photo that could judge the factor clears it", () => {
  assertEquals(
    unassessedFactors([...TEE, { unassessable_factors: ["odor_cleanliness"] }]),
    [],
  );
  assertEquals(unassessedFactors([]), []);
  assertEquals(unassessedFactors([{}, null]), []);
});

Deno.test("US-3535: a pristine tee does not drop to NWOT without review", () => {
  // What the composite writes today: everything 10, the placeholder 7.0.
  const overall = computeWeightedOverall({
    fabric_condition_score: 10,
    structural_integrity_score: 10,
    cosmetic_appearance_score: 10,
    functional_elements_score: 7,
    odor_cleanliness_score: 10,
  });
  assertEquals(scoreToGradeTier(overall), "NWOT");
  const policy = applyGradingConfidencePolicy({
    confidenceScore: 0.95,
    authenticityFlagged: false,
    defaultedFactorCount: 0,
    reviewThreshold: 0.5, // even a permissive threshold
    unassessedFactors: unassessedFactors(TEE),
  });
  assert(policy.needsHumanReview);
  assertEquals(policy.finalConfidence, UNASSESSED_FACTOR_CONFIDENCE_CAP);
  assertEquals(policy.confidenceCeiling, UNASSESSED_FACTOR_CONFIDENCE_CAP);
});

Deno.test("US-3535: absent or empty is byte-identical to before", () => {
  const base = {
    confidenceScore: 0.95,
    authenticityFlagged: false,
    defaultedFactorCount: 0,
    reviewThreshold: 0.75,
  };
  const before = applyGradingConfidencePolicy(base);
  assertEquals(applyGradingConfidencePolicy({ ...base, unassessedFactors: [] }), before);
  assertEquals(before, { finalConfidence: 0.95, needsHumanReview: false, confidenceCeiling: 1 });
});

Deno.test("US-3535: the flag is off unless set", () => {
  const prior = Deno.env.get("GRADING_UNASSESSED_FACTOR_REVIEW");
  try {
    Deno.env.delete("GRADING_UNASSESSED_FACTOR_REVIEW");
    assertEquals(unassessedFactorReviewEnabled(), false);
    Deno.env.set("GRADING_UNASSESSED_FACTOR_REVIEW", "on");
    assertEquals(unassessedFactorReviewEnabled(), true);
  } finally {
    if (prior === undefined) Deno.env.delete("GRADING_UNASSESSED_FACTOR_REVIEW");
    else Deno.env.set("GRADING_UNASSESSED_FACTOR_REVIEW", prior);
  }
});
