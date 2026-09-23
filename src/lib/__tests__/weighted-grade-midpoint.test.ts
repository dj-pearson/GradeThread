// Grading-plan action 1: exact .x5 midpoints in the weighted overall.
//
// The overall used to be Math.round(floatSum * 10) / 10. A float sum of
// 0.30/0.25/0.20/0.15/0.10 products cannot hold an exact .x5, so some
// midpoints landed a hair LOW and rounded down while others landed high and
// rounded up. 9/6/8/9/8 is exactly 7.95; the float sum is 7.949999999999998,
// and it showed 7.9 Very Good instead of 8.0 Excellent. Every site agreed with
// every other, so the lockstep fixture stayed green.
//
// This checks EVERY 0.5-step factor set (19^5 = 2,476,099) through every web
// implementation against an integer reference. The edge half is
// services/edge-functions/src/tests/weighted-grade-midpoint_test.ts.

import { describe, expect, it } from "vitest";
import {
  computeWeightedOverall,
  WEIGHTED_FACTOR_KEYS,
  WEIGHTED_FACTOR_WEIGHTS,
  type WeightedFactorScores,
} from "@/lib/weighted-grade";
import { computeRubricWeightedOverall, rubricForKey } from "@/lib/rubrics";

// Weights as whole percents, in WEIGHTED_FACTOR_KEYS order. Pinned to the real
// table below so a weight change fails here rather than passing on a stale copy.
const PERCENT = [30, 25, 20, 15, 10];

// Half-point factor tuple, in WEIGHTED_FACTOR_KEYS order.
type Halves = [number, number, number, number, number];

// Integer reference. h[i] is the factor in half-points (factor * 2), so
// sum(h * pct) is the overall in units of 1/200. One tenth is 20 units; round
// half up by adding 10 and taking the integer quotient.
function referenceTenths(h: Halves): number {
  const units = h.reduce((sum, x, i) => sum + x * (PERCENT[i] ?? 0), 0);
  const shifted = units + 10;
  return (shifted - (shifted % 20)) / 20;
}

function forEveryHalfStepSet(fn: (h: Halves) => void): number {
  let n = 0;
  const h: Halves = [0, 0, 0, 0, 0];
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

function columnFactors(h: Halves): WeightedFactorScores {
  return {
    fabric_condition_score: h[0] / 2,
    structural_integrity_score: h[1] / 2,
    cosmetic_appearance_score: h[2] / 2,
    functional_elements_score: h[3] / 2,
    odor_cleanliness_score: h[4] / 2,
  };
}

function rubricFactors(h: Halves): Record<string, number> {
  return {
    fabric_condition: h[0] / 2,
    structural_integrity: h[1] / 2,
    cosmetic_appearance: h[2] / 2,
    functional_elements: h[3] / 2,
    odor_cleanliness: h[4] / 2,
  };
}

function countWrong(impl: (h: Halves) => number): {
  n: number;
  wrong: number;
  first: string;
} {
  let wrong = 0;
  let first = "";
  const n = forEveryHalfStepSet((h) => {
    const expected = referenceTenths(h) / 10;
    const got = impl(h);
    if (got !== expected) {
      if (wrong === 0) first = `${h.map((x) => x / 2).join("/")}: ${got} != ${expected}`;
      wrong++;
    }
  });
  return { n, wrong, first };
}

describe("weighted overall: exact midpoints round half up", () => {
  it("reference percents match WEIGHTED_FACTOR_WEIGHTS", () => {
    expect(WEIGHTED_FACTOR_KEYS.map((k) => WEIGHTED_FACTOR_WEIGHTS[k] * 100)).toEqual(PERCENT);
  });

  it("the old float rounding really was wrong (the loop can see the bug)", () => {
    const { wrong } = countWrong((h) => {
      const total = h.reduce((sum, x, i) => sum + (x / 2) * ((PERCENT[i] ?? 0) / 100), 0);
      return Math.round(total * 10) / 10;
    });
    expect(wrong).toBeGreaterThan(0);
  });

  it("computeWeightedOverall matches the integer reference on every 0.5-step set", () => {
    const r = countWrong((h) => computeWeightedOverall(columnFactors(h)));
    expect(r.n).toBe(19 ** 5);
    expect(r.wrong, r.first).toBe(0);
  });

  it("computeRubricWeightedOverall(clothing) matches the integer reference on every 0.5-step set", () => {
    const clothing = rubricForKey("clothing");
    const r = countWrong((h) => computeRubricWeightedOverall(clothing, rubricFactors(h)));
    expect(r.n).toBe(19 ** 5);
    expect(r.wrong, r.first).toBe(0);
  });

  it("the tier-crossing example: 9/6/8/9/8 is 8.0 Excellent, not 7.9", () => {
    expect(computeWeightedOverall(columnFactors([18, 12, 16, 18, 16]))).toBe(8.0);
  });
});
