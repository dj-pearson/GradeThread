import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatSnapScore,
  isLowConfidence,
  snapFileProblem,
  usageLine,
  valueDisplay,
  weakestFirst,
} from "@/lib/snap-format";
import type { SnapValue } from "@/hooks/use-snap";

const value = (over: Partial<SnapValue> = {}): SnapValue => ({
  lowCents: 1800,
  medianCents: 3200,
  highCents: 6400,
  sampleSize: 12,
  confidence: 0.6,
  sufficient: true,
  currency: "USD",
  ...over,
});

describe("formatMoney (SNAP-11)", () => {
  it("formats in the comp currency, dropping .00", () => {
    expect(formatMoney(3200, "USD")).toBe("$32");
    expect(formatMoney(3250, "USD")).toBe("$32.50");
    expect(formatMoney(3200, "EUR")).toBe("€32");
    expect(formatMoney(3200, "GBP")).toBe("£32");
  });

  it("falls back plainly on an unknown currency code", () => {
    expect(formatMoney(3200, "not-a-code")).toBe("32.00 not-a-code");
  });
});

describe("valueDisplay (SNAP-11)", () => {
  it("leads with the median and names the comp count", () => {
    const v = valueDisplay(value({ category_name: "Coats & Jackets" }));
    expect(v).toEqual({
      kind: "priced",
      headline: "$32",
      range: "$18 to $64",
      comps: "from 12 sold comps",
      category: "Coats & Jackets",
    });
  });

  it("says one comp in the singular, and nothing when there are none", () => {
    expect(valueDisplay(value({ sampleSize: 1 }))).toMatchObject({ comps: "from 1 sold comp" });
    expect(valueDisplay(value({ sampleSize: 0 }))).toMatchObject({ comps: null });
  });

  it("an open range is not a price", () => {
    expect(valueDisplay(value({ lowCents: null }))).toEqual({ kind: "insufficient", text: "not enough sales to price" });
    expect(valueDisplay(value({ highCents: null }))).toMatchObject({ kind: "insufficient" });
    expect(valueDisplay(value({ sufficient: false }))).toMatchObject({ kind: "insufficient" });
    expect(valueDisplay(null)).toEqual({ kind: "none" });
  });

  it("non-USD comps render in their own currency with no dash range", () => {
    const v = valueDisplay(value({ currency: "EUR" }));
    expect(v).toMatchObject({ headline: "€32", range: "€18 to €64" });
    expect(JSON.stringify(v)).not.toMatch(/[–—]/);
  });

  it("uses the midpoint when the median is missing", () => {
    expect(valueDisplay(value({ medianCents: null }))).toMatchObject({ headline: "$41" });
  });
});

describe("confidence (SNAP-11)", () => {
  const g = (confidence: number, needs_review = false) => ({
    overall_score: 7.4,
    grade_tier: "very_good",
    confidence,
    factor_scores: {},
    needs_review,
  });

  it("marks a grade under the human-review bar with a tilde", () => {
    expect(isLowConfidence(g(0.6))).toBe(true);
    expect(formatSnapScore(g(0.6))).toBe("~7.4");
    expect(formatSnapScore(g(0.9))).toBe("7.4");
    expect(isLowConfidence(g(0.75))).toBe(false);
    expect(isLowConfidence(g(0.9, true))).toBe(true);
  });
});

describe("weakestFirst (SNAP-11)", () => {
  it("labels known factors and sorts weakest first", () => {
    const rows = weakestFirst({
      fabric_condition: 8,
      structural_integrity: 6.5,
      cosmetic_appearance: 7,
      functional_elements: 9,
      odor_cleanliness: 7.5,
      bogus: 1,
    });
    expect(rows.map((r) => r.key)).toEqual([
      "structural_integrity",
      "cosmetic_appearance",
      "odor_cleanliness",
      "fabric_condition",
      "functional_elements",
    ]);
    expect(rows[0]?.label).toBe("Structural Integrity");
  });
});

describe("usageLine (SNAP-11)", () => {
  it("counts down and turns amber at three or fewer", () => {
    expect(usageLine({ used: 3, cap: 15, resets_at: "" })).toEqual({ text: "12 of 15 checks left this month", low: false });
    expect(usageLine({ used: 12, cap: 15, resets_at: "" })).toMatchObject({ low: true });
    expect(usageLine({ used: 20, cap: 15, resets_at: "" })).toMatchObject({ text: "0 of 15 checks left this month" });
  });

  it("says nothing for an unlimited plan or no usage yet", () => {
    expect(usageLine({ used: 400, cap: null, resets_at: "" })).toBeNull();
    expect(usageLine(null)).toBeNull();
  });
});

describe("snapFileProblem (SNAP-08)", () => {
  it("names HEIC by type or extension", () => {
    expect(snapFileProblem(new File(["x"], "a.jpg", { type: "image/heic" }))).toMatch(/HEIC/);
    expect(snapFileProblem(new File(["x"], "IMG_1.HEIF", { type: "" }))).toMatch(/HEIC/);
    expect(snapFileProblem(new File(["x"], "a.jpg", { type: "image/jpeg" }))).toBeNull();
  });
});
