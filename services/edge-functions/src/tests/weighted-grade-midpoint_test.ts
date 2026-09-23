// Grading-plan action 1: exact .x5 midpoints in the weighted overall.
//
// The overall used to be Math.round(floatSum * 10) / 10. A float sum of
// 0.30/0.25/0.20/0.15/0.10 products cannot hold an exact .x5, so some
// midpoints landed a hair LOW and rounded down while others landed high and
// rounded up. 9/6/8/9/8 is exactly 7.95; the float sum is 7.949999999999998,
// and the certificate read 7.9 Very Good instead of 8.0 Excellent. All three
// edge sites agreed with each other, so the lockstep guard stayed green.
//
// This checks EVERY 0.5-step factor set (19^5 = 2,476,099) through every edge
// implementation against an integer reference. The web half is
// src/lib/__tests__/weighted-grade-midpoint.test.ts.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  computeWeightedOverall,
  FACTOR_KEYS as REVIEW_KEYS,
  FACTOR_WEIGHTS as REVIEW_WEIGHTS,
  type FactorScores as ReviewFactors,
} from "../lib/human-review.ts";
import { computeRubricWeightedOverall, rubricForKey } from "../lib/rubric.ts";

const { computeAiWeightedOverall } = await import("../lib/ai-grading.ts");

// Weights as whole percents, in human-review's key order. Pinned to the real
// table below so a weight change fails here rather than passing on a stale copy.
const PERCENT = [30, 25, 20, 15, 10];

Deno.test("reference percents match human-review's FACTOR_WEIGHTS", () => {
  assertEquals(REVIEW_KEYS.map((k) => REVIEW_WEIGHTS[k] * 100), PERCENT);
});

// Integer reference. h[i] is the factor in half-points (factor * 2), so
// sum(h * pct) is the overall in units of 1/200. One tenth is 20 units; round
// half up by adding 10 and taking the integer quotient.
function referenceTenths(h: number[]): number {
  let units = 0;
  for (let i = 0; i < 5; i++) units += h[i] * PERCENT[i];
  const shifted = units + 10;
  return (shifted - (shifted % 20)) / 20;
}

function forEveryHalfStepSet(fn: (h: number[]) => void): number {
  let n = 0;
  const h = [0, 0, 0, 0, 0];
  for (h[0] = 2; h[0] <= 20; h[0]++) {
    for (h[1] = 2; h[1] <= 20; h[1]++) {
      for (h[2] = 2; h[2] <= 20; h[2]++) {
        for (h[3] = 2; h[3] <= 20; h[3]++) {
          for (h[4] = 2; h[4] <= 20; h[4]++) {
            fn(h);
            n++;
          }
        }
      }
    }
  }
  return n;
}

function reviewFactors(h: number[]): ReviewFactors {
  return {
    fabric_condition_score: h[0] / 2,
    structural_integrity_score: h[1] / 2,
    cosmetic_appearance_score: h[2] / 2,
    functional_elements_score: h[3] / 2,
    odor_cleanliness_score: h[4] / 2,
  };
}

// AI response / rubric key names (no _score suffix).
function aiFactors(h: number[]) {
  return {
    fabric_condition: h[0] / 2,
    structural_integrity: h[1] / 2,
    cosmetic_appearance: h[2] / 2,
    functional_elements: h[3] / 2,
    odor_cleanliness: h[4] / 2,
  };
}

function exhaustive(
  label: string,
  impl: (h: number[]) => number,
): void {
  let wrong = 0;
  let first = "";
  const n = forEveryHalfStepSet((h) => {
    const expected = referenceTenths(h) / 10;
    const got = impl(h);
    if (got !== expected) {
      if (wrong === 0) {
        first = `${h.map((x) => x / 2).join("/")}: ${got} != ${expected}`;
      }
      wrong++;
    }
  });
  assertEquals(n, 19 ** 5);
  assertEquals(
    wrong,
    0,
    `${label}: ${wrong} factor sets wrong, first ${first}`,
  );
}

Deno.test("the old float rounding really was wrong (the loop can see the bug)", () => {
  let wrong = 0;
  forEveryHalfStepSet((h) => {
    let total = 0;
    for (let i = 0; i < 5; i++) total += (h[i] / 2) * (PERCENT[i] / 100);
    if (Math.round(total * 10) / 10 !== referenceTenths(h) / 10) wrong++;
  });
  assert(wrong > 0, "legacy float rounding matched the reference everywhere");
});

Deno.test("human-review.computeWeightedOverall matches the integer reference on every 0.5-step set", () => {
  exhaustive("human-review", (h) => computeWeightedOverall(reviewFactors(h)));
});

Deno.test("ai-grading.computeAiWeightedOverall matches the integer reference on every 0.5-step set", () => {
  exhaustive("ai-grading", (h) => computeAiWeightedOverall(aiFactors(h)));
});

Deno.test("rubric.computeRubricWeightedOverall(clothing) matches the integer reference on every 0.5-step set", () => {
  const clothing = rubricForKey("clothing");
  exhaustive(
    "rubric clothing",
    (h) => computeRubricWeightedOverall(clothing, aiFactors(h)),
  );
});

Deno.test("the tier-crossing example: 9/6/8/9/8 is 8.0 Excellent, not 7.9", () => {
  const f = reviewFactors([18, 12, 16, 18, 16]);
  assertEquals(computeWeightedOverall(f), 8.0);
});
