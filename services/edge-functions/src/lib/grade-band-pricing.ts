// Sold-comp, grade-banded pricing engine (US-594).
//
// The differentiation: price from ACTUAL realized sales — not active asking
// prices — banded by the item's condition grade and tempered by sell-through
// velocity, and ALWAYS surface the comp set + confidence behind the number.
//
// The pieces existed in isolation:
//   - sold-comps.ts (US-542)  → realized comps (eBay Insights → private sales),
//                                but condition-blind / not grade-positioned.
//   - condition-value.ts (US-610) → grade-banded range, but off ACTIVE asks.
//   - sell-through.ts (US-623) → velocity heuristic from a value range.
// This module unifies them: realized comps are the primary basis, grade-
// positioned within the realized band; active asks are only a clearly-flagged
// fallback when no sold data exists; sell-through is folded in; provenance
// (source, count, range) + confidence ride along on every recommendation.
//
// The assembly + grade-positioning are PURE (assembleRecommendation /
// positionRealizedByGrade) so they unit-test without eBay or the database; the
// thin I/O wrapper (recommendGradeBandedPrice) fetches the comps first.

import {
  getRealizedComps,
  type RealizedComps,
  type RealizedCompsArgs,
} from "./sold-comps.ts";
import {
  type ItemKey,
  valueAtGrade,
  type ValueRange,
} from "./condition-value.ts";
import {
  forecastSellThrough,
  type SellThroughForecast,
} from "./sell-through.ts";
import { describeValueBasis, type ValueBasis } from "./value-disclosure.ts";

// What backs a recommendation, best → weakest. The first two are realized
// sales; "active_estimated" means we fell back to active asking prices and the
// price is an estimate (price_is_estimated stays true downstream).
export type PricingBasis = "ebay_sold" | "private_sales" | "active_estimated";

export interface CompSet {
  source: PricingBasis;
  count: number;
  currency: string;
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
}

export interface GradeBandedPrice {
  /** Grade-positioned recommended price (cents); null when comps are too thin. */
  recommendedCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  currency: string;
  gradeValue: number | null;
  basis: PricingBasis;
  /** true only when backed by realized sales — false on the active-ask fallback. */
  soldBacked: boolean;
  /** false when no comp set (realized OR active) was strong enough to price. */
  sufficient: boolean;
  confidence: number; // 0..1
  compSet: CompSet;
  sellThrough: SellThroughForecast;
  /**
   * US-2850: the same provenance line every other value surface renders.
   *
   * SEPARATE FROM `basis` ABOVE, which is this module's own realized-vs-active
   * ladder and predates it by a year. That one answers "where did the comps
   * come from"; this one answers "what is this number and how much sample is
   * behind it", including whether condition was measured at all. Merging them
   * would force one field to mean two things.
   */
  valueBasis?: ValueBasis;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// Active asks systematically skew high, so a price derived from them is less
// trustworthy than the same-shaped realized number — dampen its confidence.
const ACTIVE_CONFIDENCE_FACTOR = 0.85;

/**
 * Position a recommended price within a realized [low, median, high] band by
 * grade. The realized set fed by getRealizedComps is already condition-matched
 * (the eBay path filters by the grade's conditionId), so this sharpens within
 * the band by the exact grade rather than re-bucketing:
 *   - grade ≥ 8.5 (new-ish): the median — we never push above the realized market.
 *   - grade 5.0..8.5: interpolate low(p25)..high(p75).
 *   - grade 3.0..5.0: interpolate a soft floor (60% of low) .. low.
 * Pure; returns null when there's no median to anchor on.
 */
export function positionRealizedByGrade(
  realized: RealizedComps,
  gradeValue: number | null,
): number | null {
  const med = realized.medianCents;
  if (med == null) return null;
  const low = realized.lowCents ?? med;
  const high = realized.highCents ?? med;

  if (gradeValue != null && gradeValue >= 8.5) return med;

  const grade = gradeValue ?? 6.0;
  if (grade >= 5.0) {
    const frac = clamp01((grade - 5.0) / (8.5 - 5.0));
    return Math.round(low + (high - low) * frac);
  }
  // Below grade 5 there's no realized `min`, so floor at 60% of the low quartile
  // and interpolate up to it across grade 3..5.
  const floor = Math.round(low * 0.6);
  const frac = clamp01((grade - 3.0) / (5.0 - 3.0));
  return Math.round(floor + (low - floor) * frac);
}

function fromRealized(
  realized: RealizedComps,
  gradeValue: number | null,
): GradeBandedPrice {
  const recommendedCents = positionRealizedByGrade(realized, gradeValue);
  const lowCents = realized.lowCents;
  const highCents = realized.highCents;
  const currency = realized.currency;

  // Build a value range around the grade-positioned center so sell-through reads
  // the same band the price came from.
  const range: ValueRange = {
    lowCents: recommendedCents != null && lowCents != null
      ? Math.min(lowCents, recommendedCents)
      : lowCents,
    medianCents: recommendedCents ?? realized.medianCents,
    highCents: recommendedCents != null && highCents != null
      ? Math.max(highCents, recommendedCents)
      : highCents,
    sampleSize: realized.count,
    confidence: realized.confidence,
    sufficient: true,
    currency,
  };
  const sellThrough = forecastSellThrough(range, recommendedCents ?? 0);

  return {
    recommendedCents,
    lowCents: range.lowCents,
    highCents: range.highCents,
    currency,
    gradeValue,
    basis: realized.source,
    soldBacked: true,
    // The one path in the product where "sold" is true, so it is the one path
    // allowed to say so.
    valueBasis: describeValueBasis({
      source: "comp_median",
      sufficient: recommendedCents != null,
      sampleSize: realized.count,
      medianCents: recommendedCents ?? realized.medianCents,
      soldPrices: true,
      currency,
    }),
    sufficient: recommendedCents != null,
    confidence: realized.confidence,
    compSet: {
      source: realized.source,
      count: realized.count,
      currency,
      lowCents: realized.lowCents,
      medianCents: realized.medianCents,
      highCents: realized.highCents,
    },
    sellThrough,
  };
}

function fromActive(
  value: ValueRange,
  gradeValue: number | null,
): GradeBandedPrice {
  // valueAtGrade already grade-positions the center within the active band.
  const recommendedCents = value.sufficient ? value.medianCents : null;
  const confidence = value.sufficient
    ? clamp01(value.confidence * ACTIVE_CONFIDENCE_FACTOR)
    : value.confidence;
  const sellThrough = recommendedCents != null
    ? forecastSellThrough(value, recommendedCents)
    : { sellThroughPct: 0, daysLow: 0, daysHigh: 0, label: "unknown" as const, sampleSize: value.sampleSize };

  return {
    recommendedCents,
    lowCents: value.lowCents,
    highCents: value.highCents,
    currency: value.currency,
    gradeValue,
    basis: "active_estimated",
    soldBacked: false,
    sufficient: value.sufficient,
    confidence,
    // Carried straight through from valueAtGrade, which already knows whether
    // it served a measured curve or the plain comp median. Rebuilding it here
    // would be a second opinion on a question that is already answered.
    valueBasis: value.basis,
    compSet: {
      source: "active_estimated",
      count: value.sampleSize,
      currency: value.currency,
      lowCents: value.lowCents,
      medianCents: value.medianCents,
      highCents: value.highCents,
    },
    sellThrough,
  };
}

/**
 * PURE: assemble the final recommendation from already-fetched comps. Realized
 * sales win whenever present; otherwise the active-ask value range is used as a
 * clearly-flagged estimate; when neither is usable, returns an insufficient
 * (recommendedCents=null) recommendation rather than inventing a number.
 */
export function assembleRecommendation(input: {
  realized: RealizedComps | null;
  activeValue: ValueRange | null;
  gradeValue: number | null;
}): GradeBandedPrice {
  const { realized, activeValue, gradeValue } = input;
  if (realized) return fromRealized(realized, gradeValue);
  if (activeValue) return fromActive(activeValue, gradeValue);

  return {
    recommendedCents: null,
    lowCents: null,
    highCents: null,
    currency: "USD",
    gradeValue,
    basis: "active_estimated",
    soldBacked: false,
    sufficient: false,
    confidence: 0,
    valueBasis: describeValueBasis({
      source: "comp_median",
      sufficient: false,
      sampleSize: 0,
      medianCents: null,
    }),
    compSet: {
      source: "active_estimated",
      count: 0,
      currency: "USD",
      lowCents: null,
      medianCents: null,
      highCents: null,
    },
    sellThrough: {
      sellThroughPct: 0,
      daysLow: 0,
      daysHigh: 0,
      label: "unknown",
      sampleSize: 0,
    },
  };
}

export interface RecommendArgs extends ItemKey {
  /** Workspace owner — scopes the private-sales comp set (US-268). */
  ownerId: string;
  conditionId?: string;
}

/**
 * Recommend a sold-comp, grade-banded price for an item. Tries realized comps
 * first (eBay Marketplace Insights → the seller's private sales); only when no
 * sold-backed comp set exists does it fall back to active asks (flagged as an
 * estimate). Never throws — degrades to an insufficient recommendation.
 */
export async function recommendGradeBandedPrice(
  args: RecommendArgs,
  gradeValue: number | null,
): Promise<GradeBandedPrice> {
  const compArgs: RealizedCompsArgs = {
    ownerId: args.ownerId,
    categoryId: args.categoryId,
    brand: args.brand,
    q: args.q,
    size: args.size,
    conditionId: args.conditionId,
  };

  let realized: RealizedComps | null = null;
  try {
    realized = await getRealizedComps(compArgs);
  } catch (err) {
    console.error(
      "[grade-band-pricing] realized comps failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Only spend an active Browse call when there's no realized comp set.
  let activeValue: ValueRange | null = null;
  if (!realized) {
    try {
      activeValue = await valueAtGrade(
        {
          categoryId: args.categoryId,
          q: args.q,
          brand: args.brand,
          size: args.size,
        },
        gradeValue,
      );
    } catch (err) {
      console.error(
        "[grade-band-pricing] active value fallback failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return assembleRecommendation({ realized, activeValue, gradeValue });
}
