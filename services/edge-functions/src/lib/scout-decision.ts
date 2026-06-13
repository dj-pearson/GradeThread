// Scout buy-decision engine (US-592).
//
// The reseller's highest-leverage moment is BEFORE they buy: standing in a
// thrift aisle holding an item, "should I buy this?". ScoutAI (US-615..620)
// answers the inverse — scan eBay listings you DON'T own for arbitrage. This
// module is the in-field, single-item side: given a private shadow grade (from
// the item's own photo), the condition-adjusted value range, a sell-through
// forecast, and the price you'd PAY, return an instant buy / maybe / skip with
// ROI + breakeven. PURE (no I/O) so the decision math is fully unit-tested.

import type { ValueRange } from "./condition-value.ts";
import type { SellThroughForecast } from "./sell-through.ts";

// eBay final-value-fee approximation for apparel (~13%), same basis as ScoutAI
// arbitrage scoring. Net proceeds = resale * (1 - fee).
export const DECISION_FEE_RATE = 0.13;
// Below this shadow-grade confidence we never issue a strong "buy" — a graded
// item we're unsure about is at best a "maybe".
export const DECISION_MIN_GRADE_CONFIDENCE = 0.6;
// ROI (margin / cost) thresholds that separate buy / maybe / skip.
export const DECISION_BUY_ROI = 1.0; // ≥100% return on cost → strong buy
export const DECISION_MAYBE_ROI = 0.3; // ≥30% → worth a look

export type BuyRecommendation = "buy" | "maybe" | "skip";

export interface BuyDecisionInput {
  /** Shadow grade 0..10, or null when no photo was graded (barcode-only). */
  shadowGrade: number | null;
  /** Grade confidence 0..1. Ignored for the recommendation when shadowGrade is null. */
  gradeConfidence: number;
  value: ValueRange;
  sellThrough: SellThroughForecast;
  /** What the reseller would PAY for the item (cents). null = not entered yet. */
  costCents: number | null;
}

export interface BuyDecision {
  recommendation: BuyRecommendation;
  /** Net-of-fees resale proceeds at the condition-adjusted median (cents). */
  estProceedsCents: number | null;
  /** estProceeds - cost (cents). null until a cost is entered. */
  estMarginCents: number | null;
  /** estMargin / cost. null until a cost is entered. */
  roiPct: number | null;
  /** Highest price you can PAY and still break even, net of fees (cents). */
  breakevenCents: number | null;
  reason: string;
  /** Whether the shadow grade was confident enough to act on. */
  confident: boolean;
}

export interface DecisionOptions {
  feeRate?: number;
  minGradeConfidence?: number;
  buyRoi?: number;
  maybeRoi?: number;
}

function fmt(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Decide buy / maybe / skip for a single in-field item. Pure: the caller supplies
 * the shadow grade + confidence, the condition-adjusted value range, the
 * sell-through forecast, and the candidate cost.
 */
export function decideBuy(
  input: BuyDecisionInput,
  opts: DecisionOptions = {},
): BuyDecision {
  const feeRate = opts.feeRate ?? DECISION_FEE_RATE;
  const minConf = opts.minGradeConfidence ?? DECISION_MIN_GRADE_CONFIDENCE;
  const buyRoi = opts.buyRoi ?? DECISION_BUY_ROI;
  const maybeRoi = opts.maybeRoi ?? DECISION_MAYBE_ROI;

  const value = input.value;
  // A graded item only counts as "confident" above the threshold; a barcode-only
  // lookup (no shadowGrade) isn't gated on grade confidence.
  const confident = input.shadowGrade == null
    ? true
    : input.gradeConfidence >= minConf;

  const base: BuyDecision = {
    recommendation: "skip",
    estProceedsCents: null,
    estMarginCents: null,
    roiPct: null,
    breakevenCents: null,
    reason: "",
    confident,
  };

  if (!value.sufficient || value.medianCents == null) {
    return {
      ...base,
      reason:
        "Not enough condition-matched comps to value this item — verify manually before buying.",
    };
  }

  // Net-of-fees resale at the grade-positioned median. Breakeven is the highest
  // cost that still clears (margin ≥ 0), which equals net proceeds.
  const estProceeds = Math.round(value.medianCents * (1 - feeRate));
  const breakeven = estProceeds;

  if (input.costCents == null || input.costCents <= 0) {
    return {
      ...base,
      recommendation: "maybe",
      estProceedsCents: estProceeds,
      breakevenCents: breakeven,
      reason:
        `At this condition it resells around ${fmt(estProceeds)} net of fees. ` +
        `Buy under ${fmt(breakeven)} to profit — enter your cost for a verdict.`,
    };
  }

  const margin = estProceeds - input.costCents;
  const roi = margin / input.costCents;
  const slow = input.sellThrough.label === "slow";

  let recommendation: BuyRecommendation;
  let reason: string;
  if (input.shadowGrade != null && !confident) {
    recommendation = "maybe";
    reason =
      "Shadow-grade confidence is low — treat the condition as uncertain and inspect closely before buying.";
  } else if (margin <= 0) {
    recommendation = "skip";
    reason =
      `At ${fmt(input.costCents)} you'd lose money — estimated net resale is only ${fmt(estProceeds)}.`;
  } else if (roi >= buyRoi && !slow) {
    recommendation = "buy";
    reason =
      `Strong buy — about ${Math.round(roi * 100)}% ROI (net ${fmt(margin)}) with ${input.sellThrough.label} expected sell-through.`;
  } else if (roi >= maybeRoi) {
    recommendation = "maybe";
    reason = slow
      ? `Decent margin (~${Math.round(roi * 100)}% ROI) but slow expected sell-through — buy only if you can wait.`
      : `Fair flip (~${Math.round(roi * 100)}% ROI, net ${fmt(margin)}) — not a standout.`;
  } else {
    recommendation = "skip";
    reason =
      `Thin margin (~${Math.round(roi * 100)}% ROI, net ${fmt(margin)}) — likely not worth the risk.`;
  }

  return {
    recommendation,
    estProceedsCents: estProceeds,
    estMarginCents: margin,
    roiPct: roi,
    breakevenCents: breakeven,
    reason,
    confident,
  };
}
