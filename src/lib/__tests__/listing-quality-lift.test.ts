// US-2826. The finding this produces is one sentence a seller will act on, so
// the two ways it can mislead are pinned: drawing it from the pooled buckets
// (which mostly measure what the seller sells), and phrasing it causally.

import { describe, expect, it } from "vitest";
import {
  categories,
  comparisonLabel,
  DIMENSION_LABEL,
  EMPTY_LIFT,
  strongestAssociation,
  UNCONTROLLED_WARNING,
  type CategoryLiftBucket,
  type LiftDimension,
  type ListingQualityLift,
} from "@/lib/listing-quality-lift";

function bucket(
  over: Partial<CategoryLiftBucket> & {
    category: string;
    dimension: LiftDimension;
    bucket: string;
  },
): CategoryLiftBucket {
  return {
    listings: 20,
    medianImpressions: 900,
    medianViews: 60,
    medianWatchers: 3,
    medianCtr: 0.05,
    ...over,
  };
}

function report(over: Partial<ListingQualityLift> = {}): ListingQualityLift {
  return { ...EMPTY_LIFT, ...over };
}

describe("strongestAssociation", () => {
  it("finds the widest spread within one category and dimension", () => {
    const r = report({
      byCategory: [
        bucket({ category: "Outerwear", dimension: "photos", bucket: "1 to 3", medianCtr: 0.02 }),
        bucket({ category: "Outerwear", dimension: "photos", bucket: "8 or more", medianCtr: 0.08 }),
        bucket({ category: "Tees", dimension: "photos", bucket: "1 to 3", medianCtr: 0.04 }),
        bucket({ category: "Tees", dimension: "photos", bucket: "8 or more", medianCtr: 0.05 }),
      ],
    });
    const f = strongestAssociation(r);
    expect(f?.category).toBe("Outerwear");
    expect(f?.bestBucket).toBe("8 or more");
    expect(f?.ratio).toBeCloseTo(4, 6);
  });

  it("NEVER draws a finding from the pooled buckets", () => {
    // The pooled numbers exist in the payload and are enormous here. A finding
    // built from them would mostly say outerwear outsells tees.
    const r = report({
      byCategory: [],
      uncontrolled: [
        { dimension: "photos", bucket: "1 to 3", listings: 40, medianImpressions: 10, medianViews: 1, medianWatchers: 0, medianCtr: 0.001 },
        { dimension: "photos", bucket: "8 or more", listings: 40, medianImpressions: 9000, medianViews: 900, medianWatchers: 90, medianCtr: 0.9 },
      ],
    });
    expect(strongestAssociation(r)).toBeNull();
  });

  it("needs two buckets with a real value in the same group", () => {
    const r = report({
      byCategory: [
        bucket({ category: "Tees", dimension: "photos", bucket: "8 or more" }),
        // Suppressed by the listing floor, so the RPC sent nulls.
        bucket({
          category: "Tees", dimension: "photos", bucket: "1 to 3",
          listings: 2, medianCtr: null, medianViews: null, medianWatchers: null,
        }),
      ],
    });
    expect(strongestAssociation(r)).toBeNull();
  });

  it("refuses to divide by a zero low bucket", () => {
    const r = report({
      byCategory: [
        bucket({ category: "Tees", dimension: "quality", bucket: "Under 60", medianCtr: 0 }),
        bucket({ category: "Tees", dimension: "quality", bucket: "80 or more", medianCtr: 0.06 }),
      ],
    });
    expect(strongestAssociation(r)).toBeNull();
  });

  it("compares on the requested metric", () => {
    const r = report({
      byCategory: [
        bucket({ category: "Tees", dimension: "graded", bucket: "Ungraded", medianCtr: 0.05, medianWatchers: 1 }),
        bucket({ category: "Tees", dimension: "graded", bucket: "Graded", medianCtr: 0.05, medianWatchers: 6 }),
      ],
    });
    expect(strongestAssociation(r, "medianCtr")).toBeNull();
    const w = strongestAssociation(r, "medianWatchers");
    expect(w?.bestBucket).toBe("Graded");
    expect(w?.ratio).toBeCloseTo(6, 6);
  });

  it("is null on an empty report", () => {
    expect(strongestAssociation(EMPTY_LIFT)).toBeNull();
  });
});

describe("the copy never claims cause", () => {
  it("comparisonLabel says 'sit alongside', not 'lead to'", () => {
    const s = comparisonLabel("photos", "8 or more", "1 to 3");
    expect(s).toContain("sit alongside");
    expect(s).not.toMatch(/\bcause|\bcauses|\bcaused|leads to|results in|because/i);
  });

  it("no dimension label smuggles a causal verb in", () => {
    for (const v of Object.values(DIMENSION_LABEL)) {
      expect(v).not.toMatch(/\bcause|\bboost|\bimprove|\blift\b/i);
    }
  });

  it("the pooled warning says it is pooled", () => {
    expect(UNCONTROLLED_WARNING).toMatch(/pooled/i);
  });
});

describe("categories", () => {
  it("lists each category once, sorted", () => {
    const r = report({
      byCategory: [
        bucket({ category: "Tees", dimension: "photos", bucket: "a" }),
        bucket({ category: "Outerwear", dimension: "photos", bucket: "b" }),
        bucket({ category: "Tees", dimension: "graded", bucket: "Graded" }),
      ],
    });
    expect(categories(r)).toEqual(["Outerwear", "Tees"]);
  });
});
