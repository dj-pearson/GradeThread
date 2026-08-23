// US-2824. The finding is a ratio between two venues, so the cases that matter
// are the ones where a ratio should not be produced at all: one venue, a
// suppressed venue, and a zero-cost venue that would divide into everything.

import { describe, expect, it } from "vitest";
import {
  EMPTY_SOURCE_YIELD,
  rankedByCostPerGradePoint,
  sourceFinding,
  type SourceYieldReport,
  type SourceYieldRow,
} from "@/lib/source-yield";

function row(over: Partial<SourceYieldRow> & { source: string }): SourceYieldRow {
  return {
    itemsSourced: 40,
    itemsWithPrice: 40,
    gradedCount: 30,
    gradedShare: 0.75,
    listed: 35,
    sold: 20,
    avgPurchasePrice: 4.2,
    medianGrade: 7.8,
    costPerGradePoint: 0.54,
    medianNetProfit: 21,
    medianDaysToSell: 18,
    sellThrough: 0.57,
    thin: false,
    ...over,
  };
}

function report(rows: SourceYieldRow[]): SourceYieldReport {
  return { ...EMPTY_SOURCE_YIELD, rows };
}

describe("rankedByCostPerGradePoint", () => {
  it("puts the cheapest grade point first and drops unquotable venues", () => {
    const r = report([
      row({ source: "Curated rack", costPerGradePoint: 0.54 }),
      row({ source: "Thin venue", costPerGradePoint: null, thin: true }),
      row({ source: "The bins", costPerGradePoint: 0.17 }),
    ]);
    expect(rankedByCostPerGradePoint(r).map((x) => x.source)).toEqual([
      "The bins",
      "Curated rack",
    ]);
  });

  it("breaks ties on name so the order is stable", () => {
    const r = report([
      row({ source: "Zed", costPerGradePoint: 0.5 }),
      row({ source: "Ace", costPerGradePoint: 0.5 }),
    ]);
    expect(rankedByCostPerGradePoint(r).map((x) => x.source)).toEqual([
      "Ace",
      "Zed",
    ]);
  });
});

describe("sourceFinding", () => {
  it("compares the cheapest grade point to the dearest", () => {
    const f = sourceFinding(
      report([
        row({ source: "The bins", costPerGradePoint: 0.17 }),
        row({ source: "Curated rack", costPerGradePoint: 0.68 }),
      ]),
    );
    expect(f?.best.source).toBe("The bins");
    expect(f?.worst.source).toBe("Curated rack");
    expect(f?.ratio).toBeCloseTo(4, 6);
  });

  it("is null with only one quotable venue", () => {
    // "Your only source is also your best source" is not a finding.
    expect(
      sourceFinding(
        report([
          row({ source: "The bins" }),
          row({ source: "Thin", costPerGradePoint: null, thin: true }),
        ]),
      ),
    ).toBeNull();
  });

  it("refuses to divide by a zero cost", () => {
    expect(
      sourceFinding(
        report([
          row({ source: "Free pile", costPerGradePoint: 0 }),
          row({ source: "Curated rack", costPerGradePoint: 0.68 }),
        ]),
      ),
    ).toBeNull();
  });

  it("is null when every venue costs the same", () => {
    expect(
      sourceFinding(
        report([
          row({ source: "A", costPerGradePoint: 0.5 }),
          row({ source: "B", costPerGradePoint: 0.5 }),
        ]),
      ),
    ).toBeNull();
  });

  it("is null on an empty report", () => {
    expect(sourceFinding(EMPTY_SOURCE_YIELD)).toBeNull();
  });
});
