// US-1997 AC4: the client rubric definitions must stay in sync with the server
// (services/edge-functions/src/lib/rubric.ts). Both suites assert against the
// shared fixture; the edge mirror is services/edge-functions/src/tests/
// rubric-parity_test.ts. See the fixture's _readme.
import { describe, expect, it } from "vitest";
import {
  RUBRICS,
  RUBRIC_WEIGHT_SUM_TOLERANCE,
  computeRubricWeightedOverall,
  rubricForKey,
  rubricWeightSum,
} from "../rubrics";
import { computeWeightedOverall, type WeightedFactorScores } from "../weighted-grade";
import fixture from "../../test/fixtures/rubric-factors.json";
import weightedFixture from "../../test/fixtures/weighted-grade-cases.json";

const expected = fixture.rubrics as Record<
  string,
  { label: string; factors: { key: string; label: string; weight: number }[] }
>;

describe("rubrics parity with the shared fixture", () => {
  it("defines exactly the fixture's rubric keys (no drift in either direction)", () => {
    expect(Object.keys(RUBRICS).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [key, want] of Object.entries(expected)) {
    it(`${key}: label + factors (key/label/weight, in order) match the fixture`, () => {
      const rubric = RUBRICS[key];
      expect(rubric, `RUBRICS is missing "${key}"`).toBeDefined();
      expect(rubric!.key).toBe(key);
      expect(rubric!.label).toBe(want.label);
      expect(
        rubric!.factors.map((f) => ({ key: f.key, label: f.label, weight: f.weight })),
      ).toEqual(want.factors);
    });
  }
});

describe("rubric invariants", () => {
  for (const [key, want] of Object.entries(expected)) {
    it(`${key}: weights sum to 1.0`, () => {
      const sum = want.factors.reduce((a, f) => a + f.weight, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    });
  }

  it("rubricForKey falls back to clothing for null/unknown keys", () => {
    expect(rubricForKey(null).key).toBe("clothing");
    expect(rubricForKey(undefined).key).toBe("clothing");
    expect(rubricForKey("not_a_category").key).toBe("clothing");
    expect(rubricForKey("sports_cards").key).toBe("sports_cards");
  });

  it("rubricWeightSum reports 1.0 for every shipped rubric", () => {
    for (const key of Object.keys(RUBRICS)) {
      expect(Math.abs(rubricWeightSum(RUBRICS[key]!) - 1)).toBeLessThan(
        RUBRIC_WEIGHT_SUM_TOLERANCE,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// US-1997 activation step 2 — the generalized weighted overall.
// ---------------------------------------------------------------------------

/** JSON has no NaN literal; the fixture carries the sentinel string instead. */
function decodeSentinels(scores: Record<string, unknown>): Record<string, number> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scores)) out[k] = v === "__NaN__" ? NaN : v;
  return out as Record<string, number>;
}

// `as unknown as` because TS widens each JSON case to its own literal shape with
// the OTHER rubrics' keys as `?: undefined`, which is not comparable to
// Record<string, number>. `tsc -b` rejects the single-step cast (`--noEmit`
// lets it slide), and the build runs `-b`.
const weightedCases = fixture.weighted_cases as unknown as {
  rubric: string;
  scores: Record<string, number>;
  expected_overall: number;
}[];

const refusalCases = fixture.refusal_cases as unknown as {
  why: string;
  rubric: string;
  scores: Record<string, unknown>;
}[];

describe("computeRubricWeightedOverall against the shared fixture", () => {
  it("the fixture actually carries cases (a silently-empty table proves nothing)", () => {
    expect(weightedCases.length).toBeGreaterThan(0);
    expect(refusalCases.length).toBeGreaterThan(0);
  });

  for (const [i, c] of weightedCases.entries()) {
    it(`case ${i} (${c.rubric}) → ${c.expected_overall}`, () => {
      expect(computeRubricWeightedOverall(RUBRICS[c.rubric]!, c.scores)).toBe(
        c.expected_overall,
      );
    });
  }

  for (const [i, c] of refusalCases.entries()) {
    it(`refusal ${i}: ${c.why}`, () => {
      expect(() =>
        computeRubricWeightedOverall(RUBRICS[c.rubric]!, decodeSentinels(c.scores)),
      ).toThrow(/Refusing to compute a weighted overall/);
    });
  }

  it("translates the NaN sentinel rather than asserting on a string", () => {
    // Without this, a runner that forgot to decode would still see a throw (a
    // string factor also refuses) and pass for the wrong reason.
    const withSentinel = refusalCases.find((c) =>
      Object.values(c.scores).includes("__NaN__"),
    );
    expect(withSentinel, "fixture lost its NaN sentinel case").toBeDefined();
    const decoded = decodeSentinels(withSentinel!.scores);
    expect(Object.values(decoded).some((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("clothing is byte-identical to the clothing-only implementation", () => {
  // The strongest available guard, and it invents no data: every case in the
  // fixture that ALREADY pins weighted-grade.ts against the edge's
  // human-review.ts (US-2034/US-2386) is replayed through the generalized
  // function under the clothing rubric. If the generalization ever drifts from
  // the formula it generalizes, these fail.
  const cases = weightedFixture.cases as {
    factors: WeightedFactorScores;
    expected_overall: number;
  }[];

  for (const [i, c] of cases.entries()) {
    it(`weighted-grade case ${i} agrees (${c.expected_overall})`, () => {
      // Column names (fabric_condition_score) → rubric factor keys
      // (fabric_condition). Derived, not a second hardcoded map.
      const byFactorKey = Object.fromEntries(
        Object.entries(c.factors).map(([k, v]) => [k.replace(/_score$/, ""), v]),
      );
      expect(computeRubricWeightedOverall(RUBRICS.clothing!, byFactorKey)).toBe(
        computeWeightedOverall(c.factors),
      );
      expect(computeRubricWeightedOverall(RUBRICS.clothing!, byFactorKey)).toBe(
        c.expected_overall,
      );
    });
  }
});
