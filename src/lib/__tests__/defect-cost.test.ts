// US-2821. The scale-invariance case is the one that matters: it is the
// property that stops the ledger from ranking flaws by how expensive their
// garments happened to be, and it is invisible in the output (a dollar-ranked
// ledger and a ratio-ranked one both look like a sorted table).

import { describe, expect, it } from "vitest";
import {
  costPercent,
  defectImpact,
  defectLabel,
  EMPTY_DEFECT_COST,
  median,
  medianRatio,
  quotableRows,
  topCostForSeller,
  type DefectCostReport,
  type DefectCostRow,
} from "@/lib/defect-cost";

function row(over: Partial<DefectCostRow> & { defect: string }): DefectCostRow {
  return {
    severity: "moderate",
    ownCount: 0,
    ownPriceRatio: null,
    ownDaysDelta: null,
    cohortCount: 0,
    cohortSellers: 0,
    cohortSuppressed: true,
    cohortPriceRatio: null,
    cohortDaysDelta: null,
    ...over,
  };
}

function cohortRow(
  defect: string,
  ratio: number,
  over: Partial<DefectCostRow> = {},
): DefectCostRow {
  return row({
    defect,
    cohortCount: 40,
    cohortSellers: 11,
    cohortSuppressed: false,
    cohortPriceRatio: ratio,
    cohortDaysDelta: 4,
    ...over,
  });
}

function report(over: Partial<DefectCostReport> = {}): DefectCostReport {
  return { ...EMPTY_DEFECT_COST, ...over };
}

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("ignores non-finite values rather than producing NaN", () => {
    expect(median([1, Number.NaN, 3])).toBe(2);
  });
});

describe("medianRatio is scale invariant", () => {
  const prices = [80, 95, 110, 60, 130];
  const band = 100;

  it("returns the same number when every price and the band scale together", () => {
    const base = medianRatio(prices, band);
    expect(base).not.toBeNull();
    for (const factor of [10, 0.01, 3.7, 1000]) {
      expect(
        medianRatio(
          prices.map((p) => p * factor),
          band * factor,
        ),
      ).toBeCloseTo(base!, 12);
    }
  });

  it("the story's case: times ten changes nothing", () => {
    // A ledger built on dollar averages WOULD change here, by 10x, and would
    // then rank an outerwear flaw above a t-shirt flaw for no reason but price.
    expect(medianRatio([80, 95, 110, 60, 130], 100)).toBe(
      medianRatio([800, 950, 1100, 600, 1300], 1000),
    );
  });

  it("refuses a zero or negative band instead of dividing by it", () => {
    expect(medianRatio(prices, 0)).toBeNull();
    expect(medianRatio(prices, -5)).toBeNull();
    expect(medianRatio(prices, Number.NaN)).toBeNull();
  });

  it("is null on no observations", () => {
    expect(medianRatio([], 100)).toBeNull();
  });
});

describe("defectImpact", () => {
  it("prefers the cohort when it survived suppression", () => {
    const r = cohortRow("pilling", 0.89, {
      ownCount: 3,
      ownPriceRatio: 0.5,
      ownDaysDelta: 20,
    });
    expect(defectImpact(r)).toEqual({
      ratio: 0.89,
      daysDelta: 4,
      source: "cohort",
      count: 40,
    });
  });

  it("falls back to own data when the cohort is suppressed", () => {
    const r = row({
      defect: "pilling",
      ownCount: 7,
      ownPriceRatio: 0.8,
      ownDaysDelta: 11,
      cohortCount: 6,
      cohortSellers: 2,
      cohortSuppressed: true,
    });
    expect(defectImpact(r).source).toBe("own");
    expect(defectImpact(r).ratio).toBe(0.8);
  });

  it("never quotes a suppressed cohort ratio even if one arrived", () => {
    const r = row({
      defect: "hole",
      cohortSuppressed: true,
      cohortPriceRatio: 0.4,
      cohortSellers: 2,
      cohortCount: 3,
    });
    expect(defectImpact(r).ratio).toBeNull();
  });

  it("is null, not zero, when there is nothing to quote", () => {
    expect(defectImpact(row({ defect: "stain" })).ratio).toBeNull();
  });
});

describe("costPercent", () => {
  it("turns a ratio into what the flaw costs", () => {
    expect(costPercent(cohortRow("pilling", 0.89))).toBeCloseTo(11, 10);
    expect(costPercent(cohortRow("missing_button", 0.76))).toBeCloseTo(24, 10);
  });

  it("does NOT clamp a flaw that beats its band", () => {
    // Real and useful: it usually means the flaw is being disclosed well.
    // Clamping to zero would delete the ledger's most actionable finding.
    expect(costPercent(cohortRow("small_stain", 1.03))).toBeCloseTo(-3, 10);
  });

  it("is null when nothing is quotable", () => {
    expect(costPercent(row({ defect: "fade" }))).toBeNull();
  });
});

describe("quotableRows", () => {
  it("drops unquotable rows and sorts most expensive first", () => {
    const r = report({
      rows: [
        cohortRow("pilling", 0.89),
        row({ defect: "fade" }),
        cohortRow("missing_button", 0.76),
        cohortRow("small_stain", 1.03),
      ],
    });
    expect(quotableRows(r).map((x) => x.defect)).toEqual([
      "missing_button",
      "pilling",
      "small_stain",
    ]);
  });
});

describe("topCostForSeller", () => {
  it("names the worst flaw the seller actually has", () => {
    const r = report({
      rows: [
        // Worse, but the seller has never had one. Market trivia.
        cohortRow("missing_button", 0.6, { ownCount: 0 }),
        cohortRow("pilling", 0.89, { ownCount: 12 }),
      ],
    });
    expect(topCostForSeller(r)?.defect).toBe("pilling");
  });

  it("is null when the seller's worst flaw costs nothing", () => {
    const r = report({ rows: [cohortRow("small_stain", 1.02, { ownCount: 9 })] });
    expect(topCostForSeller(r)).toBeNull();
  });

  it("is null when the seller has no quotable flaw at all", () => {
    expect(topCostForSeller(report())).toBeNull();
    expect(
      topCostForSeller(report({ rows: [row({ defect: "fade", ownCount: 4 })] })),
    ).toBeNull();
  });
});

describe("defectLabel", () => {
  it("reads a taxonomy key as English", () => {
    expect(defectLabel("pilling")).toBe("Pilling");
    expect(defectLabel("seam_separation")).toBe("Seam separation");
    expect(defectLabel("missing-button")).toBe("Missing button");
    expect(defectLabel("")).toBe("Unspecified");
  });
});
