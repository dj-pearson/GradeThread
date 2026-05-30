// Condition-aware dynamic repricing engine.
//
// The novel idea: a used-clothing grade is a precise condition signal that
// nobody else has, so we (1) pull CONDITION-MATCHED comps (eBay conditionId
// derived from the grade) and (2) POSITION the suggested price within the comp
// distribution by grade — a grade-8.5 sits near the top of the band, a grade-5
// near the bottom. That stops a high-grade item from being "priced like a
// grade-6", and flags stale listings for a markdown.
//
// Pure module (no I/O) — unit-testable, used by the on-demand scan + the cron.

export type ReasonCode =
  | "UNDERPRICED"
  | "OVERPRICED"
  | "STALE"
  | "OK"
  | "NO_COMPS";

export interface CompStats {
  count: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
}

export interface RepriceInput {
  currentPriceCents: number;
  gradeValue: number | null;
  stats: CompStats;
  listingAgeDays: number;
  watchers: number;
  views: number;
}

export interface RepriceSuggestion {
  suggestedPriceCents: number;
  compMedianCents: number | null;
  compCount: number;
  deltaPct: number; // (suggested - current) / current
  reasonCode: ReasonCode;
  message: string;
  confidence: number; // 0..1
}

// eBay conditionId buckets for clothing. The grade picks which bucket we comp
// against, so a near-new item isn't compared to beat-up ones.
export function gradeToConditionId(gradeValue: number | null): string {
  if (gradeValue == null) return "3000"; // Used (safe default)
  if (gradeValue >= 9.5) return "1000"; // New with tags
  if (gradeValue >= 8.5) return "1500"; // New without tags / new other
  if (gradeValue < 3.0) return "7000"; // For parts / not working
  return "3000"; // Used
}

function dollarsToCents(d: number): number {
  return Math.round(d * 100);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Suggested price (cents) positioned within the comp distribution by grade.
 * New-condition buckets just take the median; the "used" band is interpolated
 * across [p25, p75] (and below toward min for low grades) by the grade.
 */
export function positionPriceByGrade(
  stats: CompStats,
  gradeValue: number | null,
): number | null {
  const { median, p25, p75, min } = stats;
  if (median == null) return null;

  const conditionId = gradeToConditionId(gradeValue);
  // New-with/without-tags: the comp set is already condition-matched; median is
  // the honest middle. (We don't push these higher than the market.)
  if (conditionId === "1000" || conditionId === "1500") {
    return dollarsToCents(median);
  }

  const grade = gradeValue ?? 6.0;
  const lo = p25 ?? median;
  const hi = p75 ?? median;

  // Within the "used" band, map grade 5.0..8.5 → p25..p75.
  if (grade >= 5.0) {
    const frac = clamp01((grade - 5.0) / (8.5 - 5.0));
    return dollarsToCents(lo + (hi - lo) * frac);
  }
  // Below grade 5: interpolate min..p25 over grade 3..5.
  const floor = min ?? lo;
  const frac = clamp01((grade - 3.0) / (5.0 - 3.0));
  return dollarsToCents(floor + (lo - floor) * frac);
}

// Thresholds — deliberately conservative so nudges feel earned, not noisy.
const UNDERPRICED_RATIO = 1.12; // suggested ≥ 112% of current
const OVERPRICED_RATIO = 0.88; // suggested ≤ 88% of current
const STALE_AGE_DAYS = 30;
const STALE_MAX_WATCHERS = 1;
const STALE_DROP = 0.08; // 8% markdown on stale listings
const MIN_COMPS = 3;

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function confidenceFromCount(count: number): number {
  // 3 comps → 0.45, 12+ comps → 0.9.
  return Math.max(0, Math.min(0.9, 0.3 + count * 0.05));
}

export function computeSuggestion(input: RepriceInput): RepriceSuggestion {
  const { currentPriceCents, gradeValue, stats, listingAgeDays, watchers } = input;
  const compMedianCents = stats.median != null ? dollarsToCents(stats.median) : null;

  if (stats.count < MIN_COMPS || compMedianCents == null) {
    return {
      suggestedPriceCents: currentPriceCents,
      compMedianCents,
      compCount: stats.count,
      deltaPct: 0,
      reasonCode: "NO_COMPS",
      message:
        "Not enough comparable active listings to price confidently. Add brand/size or check the category.",
      confidence: 0.2,
    };
  }

  const positioned =
    positionPriceByGrade(stats, gradeValue) ?? compMedianCents;
  const deltaPct =
    currentPriceCents > 0 ? (positioned - currentPriceCents) / currentPriceCents : 0;
  const confidence = confidenceFromCount(stats.count);
  const gradeLabel = gradeValue != null ? `grade-${gradeValue.toFixed(1)}` : "this condition";

  // Underpriced for its condition — the headline win.
  if (positioned >= currentPriceCents * UNDERPRICED_RATIO) {
    return {
      suggestedPriceCents: positioned,
      compMedianCents,
      compCount: stats.count,
      deltaPct,
      reasonCode: "UNDERPRICED",
      message: `Your ${gradeLabel} item is priced like a lower-grade one. Comparable items support ${fmt(positioned)} (now ${fmt(currentPriceCents)}) — raise it.`,
      confidence,
    };
  }

  // Stale: been up a while with little interest → markdown nudge. Checked
  // before OVERPRICED so a long-stale-but-only-slightly-high listing still
  // reads as "drop to move it".
  if (listingAgeDays >= STALE_AGE_DAYS && watchers <= STALE_MAX_WATCHERS) {
    const dropTarget = Math.min(
      positioned,
      Math.round(currentPriceCents * (1 - STALE_DROP)),
    );
    if (dropTarget < currentPriceCents) {
      return {
        suggestedPriceCents: dropTarget,
        compMedianCents,
        compCount: stats.count,
        deltaPct: (dropTarget - currentPriceCents) / currentPriceCents,
        reasonCode: "STALE",
        message: `Listed ${listingAgeDays} days with little interest. Drop ~${Math.round(STALE_DROP * 100)}% to ${fmt(dropTarget)} to move it.`,
        confidence: Math.min(confidence, 0.6),
      };
    }
  }

  // Overpriced vs. condition-matched comps.
  if (positioned <= currentPriceCents * OVERPRICED_RATIO) {
    return {
      suggestedPriceCents: positioned,
      compMedianCents,
      compCount: stats.count,
      deltaPct,
      reasonCode: "OVERPRICED",
      message: `Priced above comparable ${gradeLabel} items. Comps suggest ${fmt(positioned)} (now ${fmt(currentPriceCents)}).`,
      confidence,
    };
  }

  return {
    suggestedPriceCents: positioned,
    compMedianCents,
    compCount: stats.count,
    deltaPct,
    reasonCode: "OK",
    message: `Priced in line with comparable ${gradeLabel} items (${fmt(positioned)}).`,
    confidence,
  };
}
