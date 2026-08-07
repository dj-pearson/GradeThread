import { describe, it, expect } from "vitest";
import { byTheNumbers, type ResaleConditionReport } from "@/lib/resale-report";

// US-1691: the "by the numbers" block is the quotable layer of the data report,
// so its ONE hard rule is that a line may not exist unless the figure behind it
// does. These tests are about small-n honesty, not formatting.

function report(overrides: Partial<ResaleConditionReport> = {}): ResaleConditionReport {
  return {
    generated_at: "2026-08-01T00:00:00Z",
    scale: { min: 1, max: 10, increment: 0.5 },
    sample: { fulfilled_sales: 1000, listed_items: 2000, priced_sales: 900 },
    coverage: { sales_from: null, sales_to: null, listings_from: null, listings_to: null },
    return_rollup: {
      graded: { fulfilled_sales: 600, returns: 12, return_rate: null },
      ungraded: { fulfilled_sales: 400, returns: 40, return_rate: null },
      overall: { fulfilled_sales: 1000, returns: 52, return_rate: null },
    },
    bands: [],
    ...overrides,
  };
}

const BAND_DEFAULTS = {
  fulfilled_sales: 0,
  returns: 0,
  return_rate: null,
  listed: 0,
  sold: 0,
  sell_through: null,
  median_days_to_sell: null,
  median_sale_price: null,
};

describe("byTheNumbers", () => {
  it("returns nothing at all with no report", () => {
    expect(byTheNumbers(undefined)).toEqual([]);
  });

  it("emits no line for a statistic the data does not support", () => {
    // Every rate is null (thin sample) and there is no grading half at all.
    expect(byTheNumbers(report())).toEqual([]);
  });

  it("quotes the graded-vs-ungraded return gap once both rates are published", () => {
    const entries = byTheNumbers(
      report({
        return_rollup: {
          graded: { fulfilled_sales: 600, returns: 12, return_rate: 0.02 },
          ungraded: { fulfilled_sales: 400, returns: 40, return_rate: 0.1 },
          overall: { fulfilled_sales: 1000, returns: 52, return_rate: 0.052 },
        },
      }),
    );
    const line = entries.find((e) => e.id === "graded-vs-ungraded-returns");
    expect(line?.stat).toContain("2.0%");
    expect(line?.stat).toContain("10.0%");
    expect(line?.sample).toBe("1,000 fulfilled sales");
  });

  it("withholds the return gap when only one side clears the sample bar", () => {
    const entries = byTheNumbers(
      report({
        return_rollup: {
          graded: { fulfilled_sales: 600, returns: 12, return_rate: 0.02 },
          ungraded: { fulfilled_sales: 4, returns: 1, return_rate: null },
          overall: { fulfilled_sales: 604, returns: 13, return_rate: 0.021 },
        },
      }),
    );
    expect(entries.some((e) => e.id === "graded-vs-ungraded-returns")).toBe(false);
  });

  it("quotes the value premium from the high and low bands", () => {
    const entries = byTheNumbers(
      report({
        bands: [
          { ...BAND_DEFAULTS, key: "high", label: "Graded 8.5 – 10.0", median_sale_price: 60 },
          { ...BAND_DEFAULTS, key: "low", label: "Graded 6.0 or lower", median_sale_price: 20 },
        ],
      }),
    );
    expect(entries.find((e) => e.id === "value-premium")?.stat).toContain("200%");
  });

  it("quotes the grading half: average grade, top flaw, best vs worst type", () => {
    const entries = byTheNumbers(
      report({
        grading: {
          min_sample: 25,
          sample: { graded_items: 4200, items_with_flaws: 3100, flaw_observations: 5000 },
          average_grade: 7.8,
          by_garment_type: [
            {
              key: "tops",
              label: "Tops",
              graded_items: 2000,
              average_grade: 7.4,
              flaw_rate: 0.8,
              most_common_flaw: { defect_type: "pilling", label: "Pilling", items: 900, share: 0.45 },
            },
            {
              key: "outerwear",
              label: "Outerwear",
              graded_items: 1200,
              average_grade: 8.6,
              flaw_rate: 0.5,
              most_common_flaw: { defect_type: "fading", label: "Fading", items: 300, share: 0.25 },
            },
            // Thin type: no average, so it must not become "the worst type".
            { key: "dresses", label: "Dresses", graded_items: 9, average_grade: null, flaw_rate: null, most_common_flaw: null },
          ],
          common_flaws: [
            { defect_type: "other", label: "Other (unclassified)", items: 1500, share: 0.357 },
            { defect_type: "stain", label: "Stains", items: 1200, share: 0.2857 },
          ],
        },
      }),
    );

    expect(entries.find((e) => e.id === "average-grade")?.stat).toContain("7.8 out of 10.0");
    // `other` is never the headline flaw — the first NAMED flaw is.
    const flaw = entries.find((e) => e.id === "top-flaw");
    expect(flaw?.stat).toContain("stains");
    expect(flaw?.stat).not.toContain("Other");
    const byType = entries.find((e) => e.id === "grade-by-type");
    expect(byType?.stat).toContain("Outerwear");
    expect(byType?.stat).toContain("8.6");
    expect(byType?.stat).toContain("7.4");
    // The 9-garment dresses cohort is invisible to the claim.
    expect(byType?.stat).not.toContain("resses");
  });

  it("makes no best-vs-worst claim when only one garment type qualifies", () => {
    const entries = byTheNumbers(
      report({
        grading: {
          min_sample: 25,
          sample: { graded_items: 100, items_with_flaws: 40, flaw_observations: 60 },
          average_grade: 8,
          by_garment_type: [
            { key: "tops", label: "Tops", graded_items: 100, average_grade: 8, flaw_rate: 0.4, most_common_flaw: null },
            { key: "dresses", label: "Dresses", graded_items: 3, average_grade: null, flaw_rate: null, most_common_flaw: null },
          ],
          common_flaws: [],
        },
      }),
    );
    expect(entries.some((e) => e.id === "grade-by-type")).toBe(false);
    expect(entries.some((e) => e.id === "average-grade")).toBe(true);
  });
});
