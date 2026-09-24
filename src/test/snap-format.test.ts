import { describe, expect, it } from "vitest";
import {
  BUY_MIN_PROFIT_CENTS,
  buyVerdict,
  maxPayForMargin,
  parsePriceToCents,
  verdictAllowed,
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

describe("buyVerdict (SNAP-14)", () => {
  it("$8 on a $40 median is a buy with profit after eBay fees", () => {
    // 4000 - (ceil(4000 * 0.136) + 40) = 3416 net; minus 800 paid.
    expect(buyVerdict(4000, 800)).toEqual({ profitCents: 2616, multiple: 5, verdict: "buy" });
  });

  it("needs both the 3x multiple and $10 of profit to say buy", () => {
    // Exactly 3x and plenty of profit: buy.
    expect(buyVerdict(6000, 2000)?.verdict).toBe("buy");
    // Just under 3x: maybe.
    expect(buyVerdict(5999, 2000)?.verdict).toBe("maybe");
    // 4x but only a few dollars: maybe, not buy.
    const small = buyVerdict(1200, 300)!;
    expect(small.multiple).toBe(4);
    expect(small.profitCents).toBeLessThan(BUY_MIN_PROFIT_CENTS);
    expect(small.verdict).toBe("maybe");
  });

  it("passes on no profit or under 1.5x", () => {
    expect(buyVerdict(1000, 1000)?.verdict).toBe("pass");
    expect(buyVerdict(2900, 2000)?.verdict).toBe("pass"); // 1.45x
    expect(buyVerdict(3000, 2000)?.verdict).toBe("maybe"); // 1.5x with profit
  });

  it("says nothing without a median or a price", () => {
    expect(buyVerdict(null, 800)).toBeNull();
    expect(buyVerdict(0, 800)).toBeNull();
    expect(buyVerdict(4000, null)).toBeNull();
    expect(buyVerdict(4000, 0)).toBeNull();
  });

  it("offers the most to pay for a 3x margin", () => {
    expect(maxPayForMargin(4000)).toBe(1333);
    expect(maxPayForMargin(null)).toBeNull();
  });

  it("parses what people type on a phone", () => {
    expect(parsePriceToCents("8")).toBe(800);
    expect(parsePriceToCents("$8.50")).toBe(850);
    expect(parsePriceToCents("8,5")).toBe(850);
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents("abc")).toBeNull();
    expect(parsePriceToCents("0")).toBeNull();
  });

  it("is only allowed on a real price and a confident grade", () => {
    const base = {
      grade: { overall_score: 7, grade_tier: "good", confidence: 0.9, factor_scores: {} },
      value: value(),
      estimate: true as const,
      disclaimer: "",
    };
    expect(verdictAllowed(base)).toBe(true);
    expect(verdictAllowed({ ...base, grade: { ...base.grade, confidence: 0.6 } })).toBe(false);
    expect(verdictAllowed({ ...base, value: value({ sufficient: false }) })).toBe(false);
    expect(verdictAllowed({ ...base, value: null })).toBe(false);
  });
});
