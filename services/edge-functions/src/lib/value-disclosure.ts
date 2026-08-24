// US-2850: say what the number is, in words a seller can check.
//
// A price with no provenance is a claim. The same dollar amount can be a slope
// fitted from listings we read for condition, or the plain middle of a pile of
// listings sorted by a label the seller typed. Those deserve different amounts
// of trust, and only the product knows which one it just handed over.
//
// ONE VOCABULARY, ONE PLACE. Every surface that shows a condition-adjusted
// value reads its wording from here: the grade result, scout's scan and
// appraisal, FlipDesk pricing, the composer hint, and the public Condition
// Index. Copy written per surface drifts, and drifted copy about provenance is
// how "listings matched on condition label" quietly becomes "graded sales".
//
// THREE THINGS THIS REFUSES TO SAY.
//
// 1. "SOLD". While EBAY_MARKETPLACE_INSIGHTS is ungranted, every price behind
//    every number here is what a seller is ASKING today. Asking prices are the
//    right input for a sourcing ceiling and the wrong one for how fast
//    something sells, and the difference is the seller's to know.
//
// 2. "GRADE", about somebody else's listing. We read comp listings for
//    condition; we do not grade them. A grade is a certificate with a number on
//    it that a buyer can look up. Calling a read a grade would inflate what we
//    are claiming and devalue the thing customers pay for.
//
// 3. A SLOPE THAT ISN'T THERE. When condition barely moves price for an item,
//    that gets said in plain words rather than dressed up. It is the most
//    useful thing we can tell a seller about that garment: do not pay to grade
//    this one.
//
// PURE. No env, no I/O. The caller passes the facts, including whether sold
// prices are in play, so this file can be tested without a network.

export type ValueSource = "measured_curve" | "comp_median";
export type PriceBasis = "active_asking" | "sold_realized";
export type SlopeShape = "rises_with_condition" | "flat" | "falls_with_condition";

export interface ValueBasis {
  source: ValueSource;
  prices: PriceBasis;
  /** Listings behind THIS number. Reads near this grade, or matched comps. */
  sampleSize: number;
  slopeCentsPerPoint: number | null;
  slopeShape: SlopeShape | null;
  measuredAt: string | null;
  /** One short line: what the number is, and how much sample is behind it. */
  headline: string;
  /** Plain sentences: what the prices are, and what condition does here. */
  detail: string;
}

/**
 * How small a slope counts as flat.
 *
 * Two percent of the median per grade point, with a 25c floor so a cheap item
 * does not get called flat over rounding. Below that, a full point of grade
 * moves the price by less than the spread of any comp set we have ever seen,
 * so calling it a slope would be reading noise out loud.
 */
export const FLAT_SLOPE_PCT_OF_MEDIAN = 0.02;
export const FLAT_SLOPE_FLOOR_CENTS = 25;

export interface ValueBasisInput {
  source: ValueSource;
  sufficient: boolean;
  sampleSize: number;
  medianCents: number | null;
  slopeCentsPerPoint?: number | null;
  measuredAt?: string | null;
  /** True only where the underlying prices really are realized sales. */
  soldPrices?: boolean;
  currency?: string;
}

const SYMBOLS: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", CAD: "$", AUD: "$" };

/** Whole dollars, because a slope quoted to the cent implies precision it has not got. */
export function money(cents: number, currency = "USD"): string {
  const code = (currency || "USD").toUpperCase();
  const sym = SYMBOLS[code];
  const whole = Math.abs(cents) / 100;
  const shown = whole >= 10 ? whole.toFixed(0) : whole.toFixed(2);
  return sym ? `${sym}${shown}` : `${shown} ${code}`;
}

/** Is this slope real, or is it noise wearing a slope's clothes? */
export function classifySlope(
  slopeCentsPerPoint: number | null | undefined,
  medianCents: number | null,
): SlopeShape | null {
  if (slopeCentsPerPoint == null || !Number.isFinite(slopeCentsPerPoint)) return null;
  const scale = medianCents != null && medianCents > 0
    ? Math.max(FLAT_SLOPE_FLOOR_CENTS, medianCents * FLAT_SLOPE_PCT_OF_MEDIAN)
    : FLAT_SLOPE_FLOOR_CENTS;
  if (Math.abs(slopeCentsPerPoint) < scale) return "flat";
  return slopeCentsPerPoint > 0 ? "rises_with_condition" : "falls_with_condition";
}

function listings(n: number): string {
  return `${n} listing${n === 1 ? "" : "s"}`;
}

function priceSentence(prices: PriceBasis): string {
  return prices === "sold_realized"
    ? "The prices behind it are what these items actually sold for."
    : "The prices behind it are what sellers are asking right now, not what anything sold for.";
}

function slopeSentence(shape: SlopeShape | null, slopeCents: number | null, currency: string): string {
  if (shape === "flat") {
    return "For this item condition barely moves the price, so a better grade is unlikely to raise what you can ask.";
  }
  if (shape === "falls_with_condition") {
    return "For this item the better-condition listings ask less, not more, so a higher grade does not lift the price here.";
  }
  if (shape === "rises_with_condition" && slopeCents != null) {
    return `Each full grade point is worth about ${money(slopeCents, currency)} more on this item.`;
  }
  return "";
}

/**
 * Turn the facts into the two lines a surface renders.
 *
 * The headline names the number. The detail says what the prices are and what
 * condition does to them. Neither ever calls a comp read a grade, and neither
 * says "sold" unless sold prices really are what is underneath.
 */
export function describeValueBasis(input: ValueBasisInput): ValueBasis {
  const currency = input.currency || "USD";
  const prices: PriceBasis = input.soldPrices ? "sold_realized" : "active_asking";
  const slope = input.source === "measured_curve" ? (input.slopeCentsPerPoint ?? null) : null;
  const slopeShape = input.source === "measured_curve"
    ? classifySlope(slope, input.medianCents)
    : null;

  if (!input.sufficient) {
    return {
      source: input.source,
      prices,
      sampleSize: input.sampleSize,
      slopeCentsPerPoint: slope,
      slopeShape,
      measuredAt: input.measuredAt ?? null,
      headline: "Not enough listings to put a price on this.",
      detail:
        "We found too few matching listings to quote a range you could rely on, so we are not going to invent one.",
    };
  }

  if (input.source === "measured_curve") {
    const parts = [
      priceSentence(prices),
      slopeSentence(slopeShape, slope, currency),
    ].filter((s) => s.length > 0);
    return {
      source: "measured_curve",
      prices,
      sampleSize: input.sampleSize,
      slopeCentsPerPoint: slope,
      slopeShape,
      measuredAt: input.measuredAt ?? null,
      headline:
        `Condition-adjusted, from ${listings(input.sampleSize)} we read for condition near this grade.`,
      detail: parts.join(" "),
    };
  }

  return {
    source: "comp_median",
    prices,
    sampleSize: input.sampleSize,
    slopeCentsPerPoint: null,
    slopeShape: null,
    measuredAt: null,
    headline: `Unadjusted market median, from ${listings(input.sampleSize)}.`,
    detail: [
      priceSentence(prices),
      "It is the middle of listings matched on the condition label their sellers chose, so it is not adjusted for condition. We have not read enough listings for this item to do better yet.",
    ].join(" "),
  };
}
