// Condition-aware sell-through forecast (US-623).
//
// Given a candidate price and the condition-adjusted value range for an item at
// its grade, estimate how likely + how fast it sells. We don't have a separate
// sale-velocity feed yet, so this is a TRANSPARENT heuristic from where the
// price sits in the condition-matched comp range: priced at/below the low end →
// likely + fast; near the median → moderate; above the high end → slow. Always
// surfaced as an estimate with the sample size that backs the range.

import type { ValueRange } from "./condition-value.ts";

export interface SellThroughForecast {
  /** Estimated probability of selling within [daysLow, daysHigh]. 0 when unknown. */
  sellThroughPct: number;
  daysLow: number;
  daysHigh: number;
  label: "fast" | "moderate" | "slow" | "unknown";
  sampleSize: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function forecastSellThrough(
  value: ValueRange,
  priceCents: number,
): SellThroughForecast {
  if (!value.sufficient || value.medianCents == null || priceCents <= 0) {
    return { sellThroughPct: 0, daysLow: 0, daysHigh: 0, label: "unknown", sampleSize: value.sampleSize };
  }

  const median = value.medianCents;
  const low = value.lowCents ?? median;
  const high = value.highCents ?? median;

  // Position of the price in the range: 0 at/below low, 0.5 at median, 1 at/above
  // high, and >1 when overpriced beyond the high end.
  let pos: number;
  if (priceCents <= low) {
    pos = 0;
  } else if (priceCents >= high) {
    pos = 1 + Math.min(1, (priceCents - high) / Math.max(1, high));
  } else if (priceCents <= median) {
    pos = 0.5 * (priceCents - low) / Math.max(1, median - low);
  } else {
    pos = 0.5 + 0.5 * (priceCents - median) / Math.max(1, high - median);
  }

  // Sell-through falls as the price climbs the range. Scale slightly by how much
  // comp support there is (thin ranges get a more cautious estimate).
  const support = clamp01(0.6 + value.confidence * 0.4);
  const sellThroughPct = clamp01((0.9 - pos * 0.55) * support);
  const daysLow = Math.round(3 + pos * 18);
  const daysHigh = Math.round(10 + pos * 50);
  const label = sellThroughPct >= 0.7 ? "fast" : sellThroughPct >= 0.45 ? "moderate" : "slow";

  return { sellThroughPct, daysLow, daysHigh, label, sampleSize: value.sampleSize };
}
