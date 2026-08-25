// Condition-adjusted value RANGE math (US-610) — the PURE half.
//
// Split out of condition-value.ts so the range maths can be type-checked and
// unit-tested without the eBay client (and, through it, supabase and the whole
// network graph) coming with it. condition-value.ts re-exports everything here,
// so every existing importer is unaffected; only the dependency weight changed.
//
// The moat this serves: a GradeThread grade is an objective condition signal, so
// we can ask a question nobody else can — "what is THIS item worth AT THIS
// condition?" — by positioning a value range within a condition-matched comp
// distribution by grade.

import { type CompStats, positionPriceByGrade } from "./repricing.ts";
import { describeValueBasis, type ValueBasis } from "./value-disclosure.ts";
export { type ValueBasis } from "./value-disclosure.ts";

// Below this many condition-matched comps the range is statistically meaningless
// — we return sufficient:false so callers show "insufficient data", never a
// falsely-precise number (mirrors the repricing MIN_COMPS + transparency rule).
export const MIN_VALUE_COMPS = 3;

export interface ValueRange {
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
  confidence: number; // 0..1
  /** false when there aren't enough comps to price honestly. */
  sufficient: boolean;
  currency: string;
  /**
   * US-2850: what this number is, in words, and how much sample is behind it.
   *
   * Rides ON the range rather than beside it so a surface cannot render the
   * dollars and forget the provenance. Optional only because a range built by
   * hand in a test does not have to carry one.
   */
  basis?: ValueBasis;
}

function dollarsToCents(d: number | null): number | null {
  return d == null ? null : Math.round(d * 100);
}

function confidenceFromCount(count: number): number {
  // 3 comps → ~0.45, 13+ comps → 0.95 (slightly more generous than repricing's
  // nudge confidence because a range tolerates more spread than a point price).
  return Math.max(0, Math.min(0.95, 0.3 + count * 0.05));
}

/**
 * Build a condition-adjusted value RANGE from a condition-matched comp
 * distribution + a grade. Pure: the comps MUST already be filtered to the
 * grade's conditionId (valueAtGrade does that). The median is the grade-
 * positioned center (a grade-8.5 sits high in the band, a grade-5 low); the
 * low/high bracket it using the comp interquartile spread.
 */
export function valueRangeFromStats(
  stats: CompStats,
  gradeValue: number | null,
  currency = "USD",
): ValueRange {
  const sampleSize = stats.count;
  const medianCents = dollarsToCents(stats.median);

  if (sampleSize < MIN_VALUE_COMPS || medianCents == null) {
    return {
      lowCents: null,
      medianCents: null,
      highCents: null,
      sampleSize,
      confidence: Math.min(0.2, confidenceFromCount(sampleSize)),
      sufficient: false,
      currency,
      basis: describeValueBasis({
        source: "comp_median",
        sufficient: false,
        sampleSize,
        medianCents: null,
        currency,
      }),
    };
  }

  // Grade-positioned center within the condition-matched band.
  const center = positionPriceByGrade(stats, gradeValue) ?? medianCents;
  const p25 = dollarsToCents(stats.p25);
  const p75 = dollarsToCents(stats.p75);
  const min = dollarsToCents(stats.min);
  const max = dollarsToCents(stats.max);

  // Bracket the center with the comp spread, guaranteeing low ≤ center ≤ high
  // and never escaping the observed [min, max].
  let low = Math.min(center, p25 ?? center);
  let high = Math.max(center, p75 ?? center);
  if (min != null) low = Math.max(min, low);
  if (max != null) high = Math.min(max, high);
  if (low > center) low = center;
  if (high < center) high = center;

  return {
    lowCents: low,
    medianCents: center,
    highCents: high,
    sampleSize,
    confidence: confidenceFromCount(sampleSize),
    sufficient: true,
    currency,
    // A comp median is the UNADJUSTED middle of listings matched on the
    // condition label their sellers chose. Positioning it by grade inside that
    // band, which is what happens above, is not the same thing as measuring
    // condition, and this line is what keeps the two from being confused.
    basis: describeValueBasis({
      source: "comp_median",
      sufficient: true,
      sampleSize,
      medianCents: center,
      currency,
    }),
  };
}

