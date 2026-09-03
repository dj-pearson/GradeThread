// ScoutAI arbitrage scoring (US-617) — the novel "underpriced for its condition"
// math. PURE module (no I/O) so the margin logic is fully unit-tested.
//
// For each candidate listing we have: an asking price, a private shadow grade
// (from quick-grade on the listing's own photos), and a condition-adjusted value
// range (from the condition-value engine at that grade). We estimate the flip
// margin net of marketplace fees and flag the candidate as actionable only when
// the comps are sufficient AND the shadow grade is confident enough — so the
// feed never surfaces a false signal.

import type { ValueRange } from "./condition-value.ts";
import type { ValueBasis } from "./value-disclosure.ts";
import { EBAY_FEE_RATE, ebayNetProceedsCents } from "./ebay-fees.ts";
import { sourcingCeiling, type SourcingCeiling } from "./scout-decision.ts";

// US-2325: the fee model now comes from lib/ebay-fees.ts, shared with the
// composer's profit estimate. This used to be a local 0.13 with no fixed fee,
// which made ScoutAI the OPTIMISTIC one of the two — it told a seller to buy on
// numbers the composer would then contradict. Still excludes promoted-listing
// ad rate and shipping.
export const SCOUT_FEE_RATE = EBAY_FEE_RATE;
// A candidate is only "actionable" above this shadow-grade confidence.
export const SCOUT_MIN_GRADE_CONFIDENCE = 0.7;
// Flag "underpriced for its condition" when net resale value clears asking by
// this multiple (a real flip, not noise).
export const SCOUT_UNDERPRICED_RATIO = 1.25;

export interface ScoutCandidate {
  itemId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  askingCents: number | null;
  /**
   * US-3098: cheapest advertised shipping, in cents. 0 for free shipping,
   * null when eBay's summary carried no shipping at all.
   */
  shippingCents?: number | null;
}

// ── US-3098: what the buyer actually pays ───────────────────────────────────
//
// A sourcing filter that compares on the asking price alone is wrong in the one
// direction that costs money: a $12 tee with $9 shipping is a $21 item, and it
// passes a "$15 maximum" that a $20 free-shipping listing fails. Every price a
// seller reasons about while sourcing is the total.
//
// The rule is stated ONCE here and imported by both the manual scan and the
// Standing Scout sweep (US-3081), because a trigger that fires on a different
// definition of "under $80" than the scan the seller tuned it with is a trigger
// they stop trusting after the first surprise.
//
// **Absent shipping is UNKNOWN, never free.** eBay omits shippingOptions on
// plenty of summaries — local pickup, calculated shipping that needs a postcode,
// and auctions among them. Treating that as 0 would quietly pass a listing whose
// real total is anything at all, which is the expensive direction to be wrong in.
// Such a listing is compared on its asking price instead, and the row says so.

export interface TotalPrice {
  /** Asking plus shipping when both are known; else the asking price. */
  cents: number | null;
  /** False when shipping was unknown and the total is the asking price alone. */
  includesShipping: boolean;
}

export function totalPriceCents(
  askingCents: number | null,
  shippingCents: number | null | undefined,
): TotalPrice {
  if (askingCents == null || askingCents <= 0) {
    return { cents: null, includesShipping: false };
  }
  if (shippingCents == null || !Number.isFinite(shippingCents) || shippingCents < 0) {
    return { cents: askingCents, includesShipping: false };
  }
  return { cents: askingCents + shippingCents, includesShipping: true };
}

export interface ScoutScored extends ScoutCandidate {
  shadowGrade: number | null;
  gradeConfidence: number;
  valueLowCents: number | null;
  valueMedianCents: number | null;
  valueHighCents: number | null;
  /** Net-of-fees estimated profit vs asking (cents). null when not computable. */
  estMarginCents: number | null;
  /** estMarginCents / askingCents. */
  estMarginPct: number | null;
  underpriced: boolean;
  /** Surfaced as a real buy signal: sufficient comps + confident grade + profit. */
  actionable: boolean;
  reason: string;
  /** US-3098: what the buyer pays, shipping included when eBay stated it. */
  totalCents: number | null;
  /** False when shipping was unknown, so `totalCents` is asking alone. */
  totalIncludesShipping: boolean;
  /**
   * US-3098: the most to pay and still clear the seller's target return.
   *
   * The SAME shape /prospect returns (SourcingCeiling, lib/scout-decision.ts),
   * deliberately. US-3098's AC named a bare `maxBuyCents` field; one concept
   * wearing two names across two routes is how a client ends up decoding the
   * wrong one, and iOS already decodes this shape.
   */
  ceiling?: SourcingCeiling;
  /**
   * US-2850: what the value behind this row actually is.
   *
   * The scan is the one value surface that does not return the ValueRange
   * itself, so without this the row would show a dollar figure with no way to
   * tell a measured number from an unadjusted median.
   */
  valueBasis?: ValueBasis;
}

export interface ScoreOptions {
  feeRate?: number;
  minGradeConfidence?: number;
  underpricedRatio?: number;
  /** US-3098: the seller's target return, for the per-row ceiling. */
  targetRoi?: number;
}

/**
 * Target return used for a row's ceiling when the caller names none.
 *
 * 30% matches DECISION_MAYBE_ROI in lib/scout-decision.ts — the point at which
 * the buy/maybe/skip verdict stops saying skip. Two different defaults for
 * "worth it" across two surfaces of one feature would be a contradiction the
 * seller has to reconcile themselves.
 */
export const DEFAULT_TARGET_ROI = 0.3;

/**
 * Score a single candidate. Pure: callers supply the shadow grade + its
 * confidence and the condition-adjusted value range.
 */
export function scoreCandidate(
  candidate: ScoutCandidate,
  shadowGrade: number | null,
  gradeConfidence: number,
  value: ValueRange,
  opts: ScoreOptions = {},
): ScoutScored {
  const feeRate = opts.feeRate ?? SCOUT_FEE_RATE;
  const minConf = opts.minGradeConfidence ?? SCOUT_MIN_GRADE_CONFIDENCE;
  const ratio = opts.underpricedRatio ?? SCOUT_UNDERPRICED_RATIO;

  const total = totalPriceCents(candidate.askingCents, candidate.shippingCents);

  const base: ScoutScored = {
    ...candidate,
    shadowGrade,
    gradeConfidence,
    valueLowCents: value.lowCents,
    valueMedianCents: value.medianCents,
    valueHighCents: value.highCents,
    valueBasis: value.basis,
    estMarginCents: null,
    estMarginPct: null,
    underpriced: false,
    actionable: false,
    reason: "",
    totalCents: total.cents,
    totalIncludesShipping: total.includesShipping,
    // Absent, never guessed: sourcingCeiling refuses without a measured curve
    // and says which of the three reasons applies.
    ceiling: sourcingCeiling({ value, targetRoi: opts.targetRoi ?? DEFAULT_TARGET_ROI, feeRate }),
  };

  if (candidate.askingCents == null || candidate.askingCents <= 0) {
    return { ...base, reason: "No asking price available." };
  }
  if (!value.sufficient || value.medianCents == null) {
    return { ...base, reason: "Not enough condition-matched comps to value this item." };
  }

  // Fixed per-order fee included (US-2325). Omitting it overstated every
  // margin, and by the largest proportion on exactly the cheap items a
  // sourcing tool surfaces most.
  const netResale = ebayNetProceedsCents(value.medianCents, { feeRate });
  const margin = netResale - candidate.askingCents;
  const marginPct = margin / candidate.askingCents;
  const underpriced = value.medianCents >= candidate.askingCents * ratio;
  const confident = gradeConfidence >= minConf;
  const actionable = confident && margin > 0 && value.sufficient;

  let reason: string;
  if (!confident) {
    reason = "Shadow grade confidence too low to act on — treat as uncertain.";
  } else if (margin <= 0) {
    reason = "Priced at or above its condition-adjusted value — no margin.";
  } else if (underpriced) {
    reason = "Underpriced for its condition — strong flip candidate.";
  } else {
    reason = "Some margin, but not a standout deal.";
  }

  return {
    ...base,
    estMarginCents: margin,
    estMarginPct: marginPct,
    underpriced,
    actionable,
    reason,
  };
}

/**
 * Rank scored candidates: actionable first, then by absolute estimated margin
 * (cents) descending. Non-actionable candidates keep their order after.
 */
export function rankCandidates(scored: ScoutScored[]): ScoutScored[] {
  return [...scored].sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    return (b.estMarginCents ?? -Infinity) - (a.estMarginCents ?? -Infinity);
  });
}
