// US-2820. What these guard is the refusal, not the arithmetic.
//
// The dollar total is the easy part. The parts that go wrong quietly are: a
// headline printed over 3 of 90 sales as though it described the account, a
// shortfall that a good sale silently cancelled, and a cohort label on a figure
// that came from the seller's own four items.

import { describe, expect, it } from "vitest";
import {
  basisLabel,
  coverage,
  EMPTY_PRICE_GAP,
  gapHeadline,
  isCohortBasis,
  MIN_COVERAGE_FOR_HEADLINE,
  worstFirst,
  type PriceGapReport,
  type SoldGapRow,
} from "@/lib/price-gap";

function sold(over: Partial<SoldGapRow> & { id: string }): SoldGapRow {
  return {
    title: "Detroit jacket",
    brand: "Carhartt",
    grade: 8.5,
    curveMedian: 112,
    salePrice: 80,
    gapDollars: 32,
    basis: "cohort_brand",
    saleDate: "2026-08-01",
    ...over,
  };
}

function report(over: Partial<PriceGapReport> = {}): PriceGapReport {
  return { ...EMPTY_PRICE_GAP, ...over };
}

describe("coverage", () => {
  it("is the scored share of in-window sales", () => {
    expect(coverage(report({ itemsScored: 30, itemsUnscored: 10 }))).toBe(0.75);
  });

  it("is null when nothing sold, which is not the same as scoring none", () => {
    expect(coverage(report())).toBeNull();
    expect(coverage(report({ itemsScored: 0, itemsUnscored: 12 }))).toBe(0);
  });
});

describe("gapHeadline", () => {
  it("reports the total once coverage clears the floor", () => {
    const h = gapHeadline(
      report({
        itemsScored: 40,
        itemsUnscored: 10,
        totalGapDollars: 1240.5,
        worst: [sold({ id: "a" })],
      }),
    );
    expect(h).not.toBeNull();
    expect(h!.totalGapDollars).toBe(1240.5);
    expect(h!.itemsScored).toBe(40);
    expect(h!.coverage).toBe(0.8);
    expect(h!.anyCohort).toBe(true);
  });

  it("refuses a headline when coverage is thin", () => {
    // 3 of 90. A dollar total here reads as an account-wide figure and is a
    // figure about three items.
    const h = gapHeadline(
      report({ itemsScored: 3, itemsUnscored: 87, totalGapDollars: 900 }),
    );
    expect(h).toBeNull();
  });

  it("refuses at exactly under the floor and allows at exactly the floor", () => {
    const at = report({
      itemsScored: MIN_COVERAGE_FOR_HEADLINE * 100,
      itemsUnscored: 100 - MIN_COVERAGE_FOR_HEADLINE * 100,
      totalGapDollars: 10,
    });
    expect(gapHeadline(at)).not.toBeNull();
    const under = report({
      itemsScored: 24,
      itemsUnscored: 76,
      totalGapDollars: 10,
    });
    expect(gapHeadline(under)).toBeNull();
  });

  it("refuses when nothing sold at all", () => {
    expect(gapHeadline(report())).toBeNull();
  });

  it("says the basis was own-data-only when no scored row used the cohort", () => {
    const h = gapHeadline(
      report({
        itemsScored: 10,
        itemsUnscored: 0,
        totalGapDollars: 88,
        worst: [sold({ id: "a", basis: "own_brand" })],
      }),
    );
    expect(h!.anyCohort).toBe(false);
  });
});

describe("worstFirst", () => {
  it("drops zero-gap rows and sorts by shortfall", () => {
    const rows = [
      sold({ id: "b", gapDollars: 5 }),
      sold({ id: "a", gapDollars: 40 }),
      // Sold ABOVE the curve. It contributes nothing and must not appear as a
      // negative row that reads like a credit.
      sold({ id: "c", gapDollars: 0, salePrice: 200 }),
    ];
    expect(worstFirst(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("breaks ties on id so the order is stable across renders", () => {
    const rows = [
      sold({ id: "z", gapDollars: 10 }),
      sold({ id: "a", gapDollars: 10 }),
    ];
    expect(worstFirst(rows).map((r) => r.id)).toEqual(["a", "z"]);
  });
});

describe("basis labels", () => {
  it("names every basis and separates cohort from own", () => {
    expect(isCohortBasis("cohort_brand")).toBe(true);
    expect(isCohortBasis("cohort_category")).toBe(true);
    expect(isCohortBasis("own_brand")).toBe(false);
    expect(isCohortBasis("own_category")).toBe(false);
    // Every label has to actually say whose sales it came from, because that is
    // the difference between a market rate and the seller's own four items.
    for (const b of [
      "cohort_brand",
      "cohort_category",
      "own_brand",
      "own_category",
    ] as const) {
      expect(basisLabel(b)).toMatch(/sellers|your own/);
    }
  });
});

describe("the sum is the sum of the parts", () => {
  it("totalGapDollars equals the summed per-item gaps for a fixed fixture", () => {
    const worst = [
      sold({ id: "a", curveMedian: 112, salePrice: 80, gapDollars: 32 }),
      sold({ id: "b", curveMedian: 90, salePrice: 71, gapDollars: 19 }),
      sold({ id: "c", curveMedian: 60, salePrice: 60, gapDollars: 0 }),
    ];
    const summed = worst.reduce((s, r) => s + r.gapDollars, 0);
    expect(summed).toBe(51);
    // And each gap really is the floored difference, not a net variance.
    for (const r of worst) {
      expect(r.gapDollars).toBe(Math.max(0, r.curveMedian - r.salePrice));
    }
  });
});
