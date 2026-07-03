// US-1558: active-learning review-queue routing.
//
// Every human review is a label; labels are not equally valuable. This module
// scores each pending review by INFORMATION VALUE — how much reviewing it
// would improve the system — so reviewer hours grow the golden set, the
// exemplar pool, and the US-1557 calibration curves fastest. Three factors:
//
//   • category novelty   — categories the golden set + exemplar pool barely
//                          cover teach the most per label;
//   • calibration gap    — confidence NEAR the category's review threshold is
//                          exactly where the calibration curve is uncertain
//                          (a label far from the boundary refines nothing);
//   • defect-combo rarity — unseen defect combinations are future misread
//                          exemplars and golden-set candidates.
//
// FIFO never disappears: rankReviews floats SLA-overdue items to the top
// regardless of score, and the UI keeps oldest-first one click away. Pure —
// the route supplies the counts; everything here is unit-tested math.

export interface ReviewInfoFactors {
  novelty: number; // 0..1
  calibrationGap: number; // 0..1
  rarity: number; // 0..1
}

export interface ReviewInfoValue {
  score: number; // 0..1 weighted sum
  factors: ReviewInfoFactors;
  /** Short reviewer-facing reasons for the ranking (dominant factors). */
  reasons: string[];
}

export interface ReviewInfoContext {
  /** Golden-set cases per garment_category (grading_eval_cases). */
  goldenByCategory: Record<string, number>;
  /** Active exemplar-pool exemplars per garment_category. */
  exemplarsByCategory: Record<string, number>;
  /** Recent occurrences per defect-combination key (see defectComboKey). */
  comboCounts: Record<string, number>;
  /** Per-category review threshold resolver output (US-1557), flat fallback. */
  thresholdForCategory: (category: string | null) => number;
}

export interface ReviewInfoItem {
  garmentCategory: string | null;
  confidence: number;
  defectTypes: readonly string[];
}

// Weights: novelty leads (coverage holes starve the flywheel), the
// calibration-gap band second, rarity third. Sum = 1.
const W_NOVELTY = 0.4;
const W_GAP = 0.35;
const W_RARITY = 0.25;
// Confidence within ±GAP_BAND of the threshold counts as the gap region.
const GAP_BAND = 0.15;
// A factor above this contributes a reviewer-facing reason chip.
const REASON_FLOOR = 0.5;

/** Canonical key for a defect combination: sorted unique types, "clean" for none. */
export function defectComboKey(defectTypes: readonly string[]): string {
  const uniq = [...new Set(defectTypes.map((t) => t.trim()).filter(Boolean))].sort();
  return uniq.length === 0 ? "clean" : uniq.join("+");
}

/** Coverage → novelty: 0 coverage = 1.0, decaying toward 0 as labels pile up. */
function noveltyFromCoverage(coverage: number): number {
  return 1 / (1 + Math.max(0, coverage) / 4);
}

/** Compute one review's information value. Pure + deterministic. */
export function informationValue(
  item: ReviewInfoItem,
  ctx: ReviewInfoContext,
): ReviewInfoValue {
  const category = item.garmentCategory?.trim().toLowerCase() ?? "";

  const coverage = (ctx.goldenByCategory[category] ?? 0) +
    (ctx.exemplarsByCategory[category] ?? 0);
  const novelty = noveltyFromCoverage(coverage);

  const threshold = ctx.thresholdForCategory(category || null);
  const distance = Math.abs(item.confidence - threshold);
  const calibrationGap = Math.max(0, 1 - distance / GAP_BAND);

  const combo = defectComboKey(item.defectTypes);
  const rarity = 1 / (1 + (ctx.comboCounts[combo] ?? 0));

  const score = W_NOVELTY * novelty + W_GAP * calibrationGap + W_RARITY * rarity;
  const reasons: string[] = [];
  if (novelty >= REASON_FLOOR) reasons.push("novel category");
  if (calibrationGap >= REASON_FLOOR) reasons.push("near review threshold");
  if (rarity >= REASON_FLOOR) {
    reasons.push(combo === "clean" ? "rare clean grade" : "rare defect combo");
  }

  return {
    score: Number(score.toFixed(3)),
    factors: {
      novelty: Number(novelty.toFixed(3)),
      calibrationGap: Number(calibrationGap.toFixed(3)),
      rarity: Number(rarity.toFixed(3)),
    },
    reasons,
  };
}

export interface RankableReview {
  waitingMs: number;
  infoScore: number;
}

/**
 * Queue ordering with the SLA guard: items waiting longer than `slaAgeMs`
 * ALWAYS sort first (oldest-first among themselves — nobody starves), then
 * the rest by information value descending, waiting time as tiebreak. Returns
 * ordered indices. Pure.
 */
export function rankReviews<T extends RankableReview>(
  items: readonly T[],
  slaAgeMs: number,
): number[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aOver = a.item.waitingMs >= slaAgeMs;
      const bOver = b.item.waitingMs >= slaAgeMs;
      if (aOver !== bOver) return aOver ? -1 : 1;
      if (aOver && bOver) return b.item.waitingMs - a.item.waitingMs;
      if (b.item.infoScore !== a.item.infoScore) {
        return b.item.infoScore - a.item.infoScore;
      }
      return b.item.waitingMs - a.item.waitingMs;
    })
    .map((entry) => entry.index);
}
