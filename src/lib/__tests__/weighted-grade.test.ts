// US-2034 — web half of the shared weighted-overall guard.
//
// The edge asserts the SAME fixture (services/edge-functions/src/tests/
// weighted-grade-parity_test.ts). Two projects that cannot import each other
// both checking one table is the only thing that keeps their mirrors honest —
// a comment saying "keep in lockstep" demonstrably does not, since this exact
// drift shipped twice (US-1557 on admin/grading.tsx, then US-2034 on
// admin/disputes.tsx).

import { describe, expect, it } from "vitest";
import {
  computeWeightedOverall,
  WEIGHTED_FACTOR_KEYS,
  WEIGHTED_FACTOR_WEIGHTS,
  type WeightedFactorScores,
} from "@/lib/weighted-grade";
import fixture from "../../test/fixtures/weighted-grade-cases.json";

describe("weighted overall (shared fixture)", () => {
  it("matches every case in the cross-project fixture", () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
    for (const c of fixture.cases) {
      expect(
        computeWeightedOverall(c.factors as WeightedFactorScores),
        `factors ${JSON.stringify(c.factors)}`,
      ).toBe(c.expected_overall);
    }
  });

  it("rounds to 0.1, NOT 0.5 — the drift that shipped twice", () => {
    // This exact vector is what exposed it: 0.5-rounding shows 8.5 while the
    // server stores 8.3. Grade tier is a pricing input, so the two numbers
    // disagreeing is money, not cosmetics.
    const factors: WeightedFactorScores = {
      fabric_condition_score: 8.5,
      structural_integrity_score: 8.5,
      cosmetic_appearance_score: 8.0,
      functional_elements_score: 8.0,
      odor_cleanliness_score: 8.5,
    };
    expect(computeWeightedOverall(factors)).toBe(8.3);
    expect(computeWeightedOverall(factors)).not.toBe(8.5);

    // And in the other direction — the drift was not one-sided.
    const other: WeightedFactorScores = {
      fabric_condition_score: 9.0,
      structural_integrity_score: 8.5,
      cosmetic_appearance_score: 9.0,
      functional_elements_score: 8.5,
      odor_cleanliness_score: 8.0,
    };
    expect(computeWeightedOverall(other)).toBe(8.7);
    expect(computeWeightedOverall(other)).not.toBe(8.5);
  });

  it("weights sum to exactly 1.0", () => {
    // Asserted, not just claimed in a comment. If this ever fails, every grade
    // in the product is scaled wrong — and nothing else would catch it.
    const sum = WEIGHTED_FACTOR_KEYS.reduce(
      (acc, k) => acc + WEIGHTED_FACTOR_WEIGHTS[k],
      0,
    );
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("an all-equal input returns that value (weights are a true average)", () => {
    for (const v of [1, 5.5, 7, 10]) {
      const factors = Object.fromEntries(
        WEIGHTED_FACTOR_KEYS.map((k) => [k, v]),
      ) as unknown as WeightedFactorScores;
      expect(computeWeightedOverall(factors)).toBe(v);
    }
  });

  it("stays within the 1.0–10.0 scale at both extremes", () => {
    const all = (v: number) =>
      Object.fromEntries(
        WEIGHTED_FACTOR_KEYS.map((k) => [k, v]),
      ) as unknown as WeightedFactorScores;
    expect(computeWeightedOverall(all(10))).toBe(10);
    expect(computeWeightedOverall(all(1))).toBe(1);
  });
});

// US-2386 — the refusal half of the shared fixture.
//
// The two mirrors disagreed on the one input neither suite covered: the web
// coalesced a missing factor to 0, the edge let it fall out as NaN. Coalescing
// is the worse half. Fabric alone is 30% of the blend, so a missing fabric
// score drags a genuine 8.4 to a plausible ~5.4 — a real-looking "Fair" grade
// that nothing flags, which an operator then reseals into a tamper-evident
// certificate hash. All five columns are NOT NULL on grade_reports, so a
// missing key can only be a bug, and refusing is the only option that does not
// produce a confident wrong grade.
describe("refuses an incomplete factor set (US-2386)", () => {
  // JSON has no NaN literal, so the fixture carries the sentinel "__NaN__".
  // Translating it is the runner's job; see hydrate's own assertion below.
  function hydrate(factors: Record<string, unknown>): WeightedFactorScores {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(factors)) {
      out[k] = v === "__NaN__" ? Number.NaN : v;
    }
    return out as unknown as WeightedFactorScores;
  }

  it("throws on every refusal case in the cross-project fixture", () => {
    expect(fixture.refusal_cases.length).toBeGreaterThan(4);
    for (const c of fixture.refusal_cases) {
      expect(
        () => computeWeightedOverall(hydrate(c.factors)),
        `should refuse: ${c.why}`,
      ).toThrow(/missing or not finite/);
    }
  });

  it("translates the NaN sentinel rather than asserting on a string", () => {
    // Without this, a runner that forgot to hydrate would still see a throw --
    // a string factor is also refused -- and the NaN case would pass for the
    // wrong reason, pinning nothing.
    const raw = fixture.refusal_cases.find((c) =>
      Object.values(c.factors).includes("__NaN__"),
    );
    expect(raw, "fixture should carry a NaN sentinel case").toBeDefined();
    const values = Object.values(
      hydrate(raw!.factors) as unknown as Record<string, unknown>,
    );
    expect(values.some((v) => typeof v === "number" && Number.isNaN(v))).toBe(true);
    expect(values).not.toContain("__NaN__");
  });

  it("still computes normally when every factor is present", () => {
    // The guard must not have made the happy path stricter than the scale.
    // 1.0 and 10.0 are the ends of the scale, and 0 is NOT a valid factor but
    // IS finite, so it must still compute rather than being caught by accident.
    const all = (v: number) =>
      Object.fromEntries(
        WEIGHTED_FACTOR_KEYS.map((k) => [k, v]),
      ) as unknown as WeightedFactorScores;
    expect(computeWeightedOverall(all(1))).toBe(1);
    expect(computeWeightedOverall(all(10))).toBe(10);
    expect(computeWeightedOverall(all(0))).toBe(0);
  });
});
