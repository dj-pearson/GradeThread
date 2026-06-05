// Condition-adjusted value engine (US-610).
//
// The moat: a GradeThread grade is an objective condition signal, so we can ask
// a question nobody else can — "what is THIS item worth AT THIS CONDITION?" —
// by pulling condition-matched eBay comps (conditionId derived from the grade)
// and positioning a value range within that distribution by grade.
//
// This is the shared foundation for Snap-to-Value (US-612), ScoutAI margin
// ranking (US-617), and the public Condition Index (US-621). The range math is
// a PURE function (valueRangeFromStats) so it's unit-tested without eBay; the
// thin I/O wrapper (valueAtGrade) fetches the condition-matched comps first.

import {
  type CompStats,
  gradeToConditionId,
  positionPriceByGrade,
} from "./repricing.ts";
import { searchBrowseComps } from "./ebay-client.ts";

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
  };
}

// Identifies the item to comp against. categoryId is required by eBay Browse;
// brand + a keyword query sharpen the match.
export interface ItemKey {
  categoryId: string;
  q?: string;
  brand?: string;
  size?: string;
}

export interface ValueAtGradeOptions {
  /** Comp sample size to request from eBay Browse (capped 1..50). Default 25. */
  limit?: number;
}

/**
 * Fetch condition-matched comps for an item at a given grade and return the
 * condition-adjusted value range. The single eBay Browse call already runs
 * through the timeout + circuit breaker (ebay-client). Returns a sufficient:false
 * range rather than throwing when comps are too thin.
 */
export async function valueAtGrade(
  item: ItemKey,
  gradeValue: number | null,
  opts: ValueAtGradeOptions = {},
): Promise<ValueRange> {
  const result = await searchBrowseComps({
    categoryId: item.categoryId,
    q: item.q,
    brand: item.brand,
    size: item.size,
    conditionId: gradeToConditionId(gradeValue),
    limit: Math.min(Math.max(opts.limit ?? 25, 1), 50),
  });
  return valueRangeFromStats(result.stats, gradeValue, result.stats.currency);
}
