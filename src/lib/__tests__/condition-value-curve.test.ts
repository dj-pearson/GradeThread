import { describe, it, expect } from "vitest";
import {
  CONDITION_CURVE_SOURCE_COMPS,
  CONDITION_CURVE_SOURCE_CURVES,
  CONDITION_VALUE_CURVE,
  MAX_GRADE,
  MIN_GRADE,
  adjustForCondition,
  conditionRatio,
  ratioFromCurve,
  tierLabelForGrade,
} from "../condition-value-curve";

describe("the derived curve", () => {
  it("matches what scripts/seo/derive-condition-value-curve.mjs produced", () => {
    // Sentinels. Re-run the script before editing any of these.
    expect(CONDITION_CURVE_SOURCE_CURVES).toBe(53);
    expect(CONDITION_CURVE_SOURCE_COMPS).toBe(3811);
    expect(CONDITION_VALUE_CURVE.find((p) => p.grade === 9)?.ratio).toBe(0.837);
    expect(CONDITION_VALUE_CURVE.find((p) => p.grade === 7)?.ratio).toBe(0.649);
    expect(CONDITION_VALUE_CURVE.find((p) => p.grade === 3)?.ratio).toBe(0.204);
  });

  it("never rises as condition falls", () => {
    const asc = [...CONDITION_VALUE_CURVE].sort((a, b) => a.grade - b.grade);
    for (let i = 1; i < asc.length; i++) {
      expect(asc[i]!.ratio).toBeGreaterThanOrEqual(asc[i - 1]!.ratio);
    }
  });

  it("keeps every ratio inside its own observed range", () => {
    for (const p of CONDITION_VALUE_CURVE) {
      expect(p.ratio).toBeGreaterThanOrEqual(p.low);
      expect(p.ratio).toBeLessThanOrEqual(p.high);
    }
  });

  it("interpolates between the published points", () => {
    // 7.5 sits between 0.649 at 7.0 and 0.737 at 8.0.
    const mid = conditionRatio(7.5);
    expect(mid).toBeGreaterThan(0.649);
    expect(mid).toBeLessThan(0.737);
    expect(mid).toBeCloseTo(0.693, 3);
  });

  it("clamps rather than extrapolating past where the comps stop", () => {
    expect(conditionRatio(1)).toBe(conditionRatio(MIN_GRADE));
    expect(conditionRatio(12)).toBe(conditionRatio(MAX_GRADE));
  });
});

describe("the condition adjustment", () => {
  it("two identical items differing only in grade get different prices", () => {
    const good = adjustForCondition(100, 9, 9);
    const worn = adjustForCondition(100, 9, 6);
    expect(good.adjustedPrice).not.toBe(worn.adjustedPrice);
    expect(worn.adjustedPrice).toBeLessThan(good.adjustedPrice);
    // 0.562 / 0.837 = 0.6714 -> $67.14
    expect(worn.adjustedPrice).toBeCloseTo(67.14, 2);
  });

  it("a 10.0 applies no downward adjustment when the comp is also a 10.0", () => {
    const a = adjustForCondition(100, 10, 10);
    expect(a.multiplier).toBe(1);
    expect(a.adjustedPrice).toBe(100);
    expect(a.delta).toBe(0);
  });

  it("a 10.0 item against a worn comp adjusts UPWARD, which most calculators cannot do", () => {
    const a = adjustForCondition(100, 6, 10);
    expect(a.multiplier).toBeGreaterThan(1);
    expect(a.adjustedPrice).toBeGreaterThan(100);
    expect(a.delta).toBeGreaterThan(0);
  });

  it("says where its ratios came from", () => {
    expect(adjustForCondition(100, 9, 7).source).toBe("condition-index-default");
    const live = ratioFromCurve([
      { grade: 10, medianCents: 10000 },
      { grade: 8, medianCents: 8000 },
      { grade: 5, medianCents: 4000 },
    ])!;
    const a = adjustForCondition(100, 10, 8, live, "condition-index-item");
    expect(a.source).toBe("condition-index-item");
    expect(a.adjustedPrice).toBe(80);
  });
});

describe("a live per-item curve", () => {
  it("beats the default when the item holds its value differently", () => {
    // Carhartt double knee, the real shape: flat from 10 down to 8.
    const carhartt = ratioFromCurve([
      { grade: 10, medianCents: 10285 },
      { grade: 8, medianCents: 10285 },
      { grade: 5, medianCents: 5999 },
      { grade: 3, medianCents: 2200 },
    ])!;
    const withCurve = adjustForCondition(100, 10, 8, carhartt, "condition-index-item");
    const withDefault = adjustForCondition(100, 10, 8);
    expect(withCurve.adjustedPrice).toBe(100);
    expect(withDefault.adjustedPrice).toBeCloseTo(73.7, 1);
    // A 26% difference on one item. This is why the page prefers the live curve.
    expect(withCurve.adjustedPrice - withDefault.adjustedPrice).toBeGreaterThan(25);
  });

  it("refuses a curve too thin to mean anything", () => {
    expect(ratioFromCurve([{ grade: 10, medianCents: 100 }])).toBeNull();
    expect(
      ratioFromCurve([
        { grade: 10, medianCents: null },
        { grade: 8, medianCents: null },
        { grade: 5, medianCents: 100 },
      ]),
    ).toBeNull();
  });
});

describe("tier labels", () => {
  it("bands by integer floor on the published seven-tier scale", () => {
    expect(tierLabelForGrade(10)).toBe("New with Tags (NWT)");
    // 9.5 is NOT rounded up into NWT. US-1947.
    expect(tierLabelForGrade(9.5)).toBe("New without Tags (NWOT)");
    expect(tierLabelForGrade(8.5)).toBe("Excellent");
    expect(tierLabelForGrade(7)).toBe("Very Good");
    expect(tierLabelForGrade(6)).toBe("Good");
    expect(tierLabelForGrade(5)).toBe("Fair");
    expect(tierLabelForGrade(4)).toBe("Poor");
    expect(tierLabelForGrade(1)).toBe("Poor");
  });
});
