// US-2819. The four cases the story names, plus the ones that make the
// suppression rule mean something.
//
// Everything under test is pure over the RPC payload, so none of this needs a
// database. What it is really guarding is the reading rule: a suppressed cohort
// is NOT a zero, and a one-sale bucket is NOT a market rate.

import { describe, expect, it } from "vitest";
import {
  bucketFor,
  bucketGrade,
  CURVE_GRADES,
  curveHeadline,
  effectivePrice,
  gradeStepValue,
  isCurveEmpty,
  MIN_CURVE_SAMPLE,
  quotableBuckets,
  suppressedBuckets,
  type ConditionPriceCurve,
  type CurveBucket,
} from "@/lib/condition-price-curve";

function bucket(over: Partial<CurveBucket> & { grade: number }): CurveBucket {
  return {
    ownCount: 0,
    ownMedianPrice: null,
    ownMedianDays: null,
    cohortCount: 0,
    cohortSellers: 0,
    cohortSuppressed: true,
    cohortMedianPrice: null,
    cohortP25Price: null,
    cohortP75Price: null,
    cohortMedianDays: null,
    ...over,
  };
}

function curve(buckets: CurveBucket[]): ConditionPriceCurve {
  return {
    brand: "Carhartt",
    category: null,
    periodStart: null,
    minSellers: 5,
    ownTotal: buckets.reduce((s, b) => s + b.ownCount, 0),
    cohortTotal: buckets.reduce((s, b) => s + b.cohortCount, 0),
    cohortSellersTotal: Math.max(0, ...buckets.map((b) => b.cohortSellers)),
    buckets,
  };
}

/** A healthy cohort bucket: past the seller floor and past the sample floor. */
function cohortBucket(grade: number, price: number, n = 40): CurveBucket {
  return bucket({
    grade,
    cohortCount: n,
    cohortSellers: 12,
    cohortSuppressed: false,
    cohortMedianPrice: price,
    cohortP25Price: price * 0.8,
    cohortP75Price: price * 1.2,
    cohortMedianDays: 14,
  });
}

describe("bucketGrade", () => {
  it("rounds a 0.1-step grade to its half point", () => {
    expect(bucketGrade(8.4)).toBe(8.5);
    expect(bucketGrade(8.2)).toBe(8);
    expect(bucketGrade(7.75)).toBe(8);
    expect(bucketGrade(10)).toBe(10);
  });

  it("CURVE_GRADES is the 19 half points from 1.0 to 10.0", () => {
    expect(CURVE_GRADES).toHaveLength(19);
    expect(CURVE_GRADES[0]).toBe(1);
    expect(CURVE_GRADES[18]).toBe(10);
    // 7 tiers is what every other grade report in this codebase uses. The whole
    // point of the curve is that it does not.
    expect(CURVE_GRADES.length).toBeGreaterThan(7);
  });
});

describe("bucketFor", () => {
  const c = curve([cohortBucket(8, 90), cohortBucket(8.5, 112)]);

  it("finds the bucket a raw grade rounds into", () => {
    expect(bucketFor(c, 8.4)?.grade).toBe(8.5);
    expect(bucketFor(c, 8.1)?.grade).toBe(8);
  });

  it("returns null off the scale or on a non-number", () => {
    expect(bucketFor(c, 0.5)).toBeNull();
    expect(bucketFor(c, 11)).toBeNull();
    expect(bucketFor(c, Number.NaN)).toBeNull();
  });

  it("returns null for a grade the curve has no bucket for", () => {
    expect(bucketFor(c, 3)).toBeNull();
  });
});

describe("effectivePrice", () => {
  it("prefers the cohort when it survived suppression", () => {
    const b = bucket({
      grade: 8.5,
      ownCount: 3,
      ownMedianPrice: 130,
      cohortCount: 40,
      cohortSellers: 12,
      cohortSuppressed: false,
      cohortMedianPrice: 112,
    });
    // THE CASE THE STORY NAMES: own median differs from cohort median. The
    // cohort wins, and the number reported is 112, not 130 and not an average.
    expect(effectivePrice(b)).toEqual({
      price: 112,
      source: "cohort",
      count: 40,
    });
  });

  it("falls back to own data when the cohort is suppressed", () => {
    const b = bucket({
      grade: 8.5,
      ownCount: 6,
      ownMedianPrice: 130,
      cohortCount: 9,
      cohortSellers: 3,
      cohortSuppressed: true,
      cohortMedianPrice: null,
    });
    expect(effectivePrice(b)).toEqual({ price: 130, source: "own", count: 6 });
  });

  it("own-data-only: no cohort observations at all", () => {
    const b = bucket({ grade: 7, ownCount: 8, ownMedianPrice: 55 });
    expect(effectivePrice(b)).toEqual({ price: 55, source: "own", count: 8 });
  });

  it("empty cohort and no own sales yields null, never zero", () => {
    const e = effectivePrice(bucket({ grade: 4 }));
    expect(e.price).toBeNull();
    expect(e.source).toBeNull();
    // The whole reason this returns null: a suppressed or absent cohort read as
    // 0 would price a garment at nothing.
    expect(e.price).not.toBe(0);
  });

  it("returns null for a missing bucket", () => {
    expect(effectivePrice(null)).toEqual({
      price: null,
      source: null,
      count: 0,
    });
  });

  it("never quotes a suppressed cohort median even if the RPC sent one", () => {
    // Defense against a future RPC change that forgets to null the measures.
    const b = bucket({
      grade: 6,
      cohortCount: 4,
      cohortSellers: 2,
      cohortSuppressed: true,
      cohortMedianPrice: 41,
    });
    expect(effectivePrice(b).price).toBeNull();
  });
});

describe("gradeStepValue", () => {
  it("prices the span between two healthy buckets", () => {
    const c = curve([cohortBucket(7, 71), cohortBucket(8.5, 112)]);
    expect(gradeStepValue(c, 7, 8.5)).toBe(41);
  });

  it("is null when either end is under the sample floor", () => {
    const thin = bucket({
      grade: 8.5,
      ownCount: MIN_CURVE_SAMPLE - 1,
      ownMedianPrice: 300,
    });
    const c = curve([cohortBucket(7, 71), thin]);
    expect(gradeStepValue(c, 7, 8.5)).toBeNull();
  });

  it("is null when either end has no price", () => {
    const c = curve([cohortBucket(7, 71), bucket({ grade: 8.5 })]);
    expect(gradeStepValue(c, 7, 8.5)).toBeNull();
  });

  it("is negative when the higher grade sold for less", () => {
    // Real and worth surfacing rather than clamping: it usually means the
    // higher-graded items were priced badly.
    const c = curve([cohortBucket(7, 90), cohortBucket(8.5, 80)]);
    expect(gradeStepValue(c, 7, 8.5)).toBe(-10);
  });
});

describe("quotableBuckets", () => {
  it("keeps only buckets past the sample floor, low grade first", () => {
    const c = curve([
      cohortBucket(8.5, 112),
      bucket({ grade: 6, ownCount: 2, ownMedianPrice: 30 }),
      cohortBucket(7, 71),
    ]);
    expect(quotableBuckets(c).map((b) => b.grade)).toEqual([7, 8.5]);
  });
});

describe("curveHeadline", () => {
  it("spans the widest quotable pair and prices a half point", () => {
    const c = curve([
      cohortBucket(7, 71),
      cohortBucket(8, 90),
      cohortBucket(8.5, 112),
    ]);
    const h = curveHeadline(c);
    expect(h).not.toBeNull();
    expect(h!.lowGrade).toBe(7);
    expect(h!.highGrade).toBe(8.5);
    // 41 dollars over three half points.
    expect(h!.perHalfPoint).toBeCloseTo(41 / 3, 6);
    expect(h!.source).toBe("cohort");
  });

  it("reports the weaker side when one end is own-data-only", () => {
    const c = curve([
      cohortBucket(7, 71),
      bucket({ grade: 8.5, ownCount: 9, ownMedianPrice: 112 }),
    ]);
    expect(curveHeadline(c)!.source).toBe("own");
  });

  it("is null with fewer than two quotable buckets", () => {
    expect(curveHeadline(curve([cohortBucket(8, 90)]))).toBeNull();
    expect(curveHeadline(curve([]))).toBeNull();
  });
});

describe("suppression is visible, not silent", () => {
  it("separates 'not enough sellers' from 'no market'", () => {
    const c = curve([
      // Nine sales behind three sellers: held back by the floor.
      bucket({ grade: 6, cohortCount: 9, cohortSellers: 3, cohortSuppressed: true }),
      // Nothing at all: not suppressed, just absent.
      bucket({ grade: 5 }),
      cohortBucket(8, 90),
    ]);
    expect(suppressedBuckets(c).map((b) => b.grade)).toEqual([6]);
  });
});

describe("isCurveEmpty", () => {
  it("is true only when both sides are empty", () => {
    expect(isCurveEmpty(curve([]))).toBe(true);
    expect(isCurveEmpty(curve([cohortBucket(8, 90)]))).toBe(false);
    expect(
      isCurveEmpty(curve([bucket({ grade: 8, ownCount: 1, ownMedianPrice: 9 })])),
    ).toBe(false);
  });
});
