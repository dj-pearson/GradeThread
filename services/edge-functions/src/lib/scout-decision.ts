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
import { EBAY_FEE_RATE, ebayNetProceedsCents } from "./ebay-fees.ts";

// US-2325: from lib/ebay-fees.ts, the same model the composer's profit estimate
// uses. Was a local 0.13 with no fixed fee — the buy/skip verdict and the
// profit screen the seller landed on afterwards did not agree on any item.
export const DECISION_FEE_RATE = EBAY_FEE_RATE;
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

/**
 * US-2851: the sourcing ceiling, and why it is not the breakeven.
 *
 * `breakevenCents` above is the highest price at which you do not LOSE money.
 * Nobody stands in a thrift aisle to break even. The ceiling is the highest
 * price at which the item still clears the margin the seller is actually
 * working to, which is a different and much lower number: at a 30% target on an
 * item that nets $40, breakeven says $40 and the ceiling says $30.
 *
 * IT IS ABSENT, NOT GUESSED, WITHOUT A MEASURED CURVE. A ceiling is the most
 * committal number the product gives a seller: they hand over cash on the
 * strength of it. Derived from the plain comp median it would be a ceiling on a
 * price that was never adjusted for the condition of the thing in their hand,
 * which is the exact error US-2841 exists to fix. So it appears only for cells
 * with a publishable measured curve, and the surface says nothing rather than
 * something shakier.
 */
export interface SourcingCeilingInput {
  value: ValueRange;
  /** Target return on cost, as a fraction. 0.3 = 30%. */
  targetRoi: number;
  feeRate?: number;
}

export interface SourcingCeiling {
  /** Highest price to pay and still clear the target. Null when unavailable. */
  maxPriceCents: number | null;
  /** The target actually applied, echoed so a surface can name it. */
  targetRoi: number;
  /** Net-of-fees resale at the condition-adjusted median. */
  netResaleCents: number | null;
  /** Why there is no ceiling, when there isn't one. Null when there is. */
  absentReason: "no_measured_curve" | "insufficient_comps" | "no_headroom" | null;
}

/**
 * Highest price to pay for this garment at the grade in your hand.
 *
 * net = proceeds after fees at the condition-adjusted median.
 * ceiling = net / (1 + targetRoi), the price at which (net - price) / price
 * equals the target exactly. Rounded DOWN: a ceiling rounded up is a ceiling
 * that can be paid and missed.
 */
export function sourcingCeiling(
  input: SourcingCeilingInput,
): SourcingCeiling {
  const feeRate = input.feeRate ?? DECISION_FEE_RATE;
  const target = Number.isFinite(input.targetRoi) ? Math.max(0, input.targetRoi) : 0;
  const value = input.value;

  const absent = (reason: SourcingCeiling["absentReason"]): SourcingCeiling => ({
    maxPriceCents: null,
    targetRoi: target,
    netResaleCents: null,
    absentReason: reason,
  });

  if (!value.sufficient || value.medianCents == null) {
    return absent("insufficient_comps");
  }
  // The gate. A seeded curve or a plain comp median does not get to set a
  // ceiling, however sufficient its sample looks.
  if (value.basis?.source !== "measured_curve") {
    return absent("no_measured_curve");
  }

  const net = ebayNetProceedsCents(value.medianCents, { feeRate });
  if (net <= 0) return absent("no_headroom");

  const max = Math.floor(net / (1 + target));
  if (max <= 0) return absent("no_headroom");

  return {
    maxPriceCents: max,
    targetRoi: target,
    netResaleCents: net,
    absentReason: null,
  };
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
  const estProceeds = ebayNetProceedsCents(value.medianCents, { feeRate });
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
