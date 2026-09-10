// US-553: forward profit/margin estimate for a draft at a given list price, so
// pricing is a margin decision instead of a guess. (computePnl in lib/pnl.ts is
// BACKWARD-looking — it needs a recorded sale's actual fees; this estimates
// them up front from the price.)
//
// US-2325: the fee numbers moved to lib/ebay-fees.ts, the single source of
// truth now shared with ScoutAI's scoring and buy/skip decision. Those two used
// to carry their own flat 13% with no fixed fee, so the estimate a seller saw
// here disagreed with the recommendation that sent them to the item.
//
// Re-exported under the original names because they are part of this module's
// public surface (listing-profit.test.ts and callers import them from here);
// the VALUES have one home.
export { EBAY_FEE_RATE as DEFAULT_EBAY_FEE_RATE, EBAY_FIXED_FEE as DEFAULT_EBAY_FIXED_FEE } from "./ebay-fees";
import { EBAY_FEE_RATE, EBAY_FIXED_FEE } from "./ebay-fees";

export interface ProfitInputs {
  /** The list price being considered (USD). */
  price: number;
  /** Cost of goods (acquired_price). */
  costBasis?: number | null;
  /** Grading cost already incurred. */
  gradingCost?: number | null;
  /** Seller-paid shipping label, if known. */
  shippingCost?: number | null;
  /**
   * US-3193: mailer, tape and label for one parcel, if known.
   *
   * THE THIRD LINE, ADDED SO THE TWO COST SETS MATCH. sourcingCeiling in the
   * edge's scout-decision.ts subtracts shipping + supplies + grading; this
   * function subtracted cost basis + grading + shipping and had no supplies
   * line at all. The ceiling was therefore stricter than the profit screen by
   * one mailer — the safe direction, and still two numbers disagreeing when a
   * seller reads them a minute apart.
   *
   * ⚠ THE DEFAULTS STILL DIFFER, DELIBERATELY, and the difference is not
   * drift. Every cost line here defaults to ZERO when the caller passes
   * nothing, because this function reports on ONE listing whose costs the
   * caller is expected to know and a guessed figure would be presented as that
   * listing's fact. The ceiling defaults each line to a real lower-bound
   * figure instead, because it hands a seller a spending limit for a garment
   * nobody has measured yet and an unset line there means "we do not know",
   * not "it is free". Under-estimating on a ceiling is the failure US-3193
   * exists to fix.
   *
   * ⚠ AND NO CALLER PASSES IT YET, which is the same gap `shippingCost` has:
   * the header of src/lib/parcel-estimate.ts names it — a shippingCost "if
   * known" is almost never known, so the bulk margin floor prices postage at
   * zero. Wiring the predicted parcel into these callers is US-2790's remit,
   * not this story's. What this story owed was the matching cost SET, so that
   * the wiring has all three lines to fill when it arrives.
   */
  suppliesCost?: number | null;
  /** eBay final-value fee fraction (default 13.6%, from EBAY_FEE_RATE). */
  feeRate?: number;
  /** Fixed per-order fee (default $0.40). */
  fixedFee?: number;
}

export interface ProfitEstimate {
  /** Estimated marketplace fees (FVF + fixed). */
  fees: number;
  /** Your costs: cost basis + grading + shipping + supplies (US-3193). */
  costs: number;
  /** price − fees − costs (can be negative). */
  net: number;
  /** net / price * 100; 0 when price is 0. */
  marginPct: number;
}

/** Inputs for the inverse calc: the smallest list price hitting a target margin. */
export interface MarginFloorInputs {
  /** Desired net margin as a percentage (e.g. 25 for 25%). */
  targetMarginPct: number;
  costBasis?: number | null;
  gradingCost?: number | null;
  shippingCost?: number | null;
  /** US-3193: the same third line ProfitInputs carries — see the note there. */
  suppliesCost?: number | null;
  feeRate?: number;
  fixedFee?: number;
}

// US-553: invert estimateListingProfit — the lowest list price whose forward
// margin is at least targetMarginPct. Lets the bulk grid "floor at X% margin"
// without trial-and-error.
//
//   margin = (price·(1−feeRate) − fixedFee − costs) / price ≥ m
//   ⟹ price ≥ (fixedFee + costs) / (1 − feeRate − m)
//
// Returns null when the target is unreachable at any finite price — i.e. the
// fee rate plus the margin meet or exceed 100% (denominator ≤ 0).
export function priceForMargin(input: MarginFloorInputs): number | null {
  const feeRate = input.feeRate ?? EBAY_FEE_RATE;
  const fixedFee = input.fixedFee ?? EBAY_FIXED_FEE;
  const costs =
    Math.max(0, input.costBasis ?? 0) +
    Math.max(0, input.gradingCost ?? 0) +
    Math.max(0, input.shippingCost ?? 0) +
    Math.max(0, input.suppliesCost ?? 0);
  const m = input.targetMarginPct / 100;
  const denom = 1 - feeRate - m;
  if (denom <= 0) return null;
  return (fixedFee + costs) / denom;
}

export function estimateListingProfit(input: ProfitInputs): ProfitEstimate {
  const price = Math.max(0, input.price || 0);
  const feeRate = input.feeRate ?? EBAY_FEE_RATE;
  const fixedFee = input.fixedFee ?? EBAY_FIXED_FEE;
  const costBasis = Math.max(0, input.costBasis ?? 0);
  const grading = Math.max(0, input.gradingCost ?? 0);
  const shipping = Math.max(0, input.shippingCost ?? 0);
  const supplies = Math.max(0, input.suppliesCost ?? 0);

  const fees = price > 0 ? price * feeRate + fixedFee : 0;
  const costs = costBasis + grading + shipping + supplies;
  const net = price - fees - costs;
  const marginPct = price > 0 ? (net / price) * 100 : 0;
  return { fees, costs, net, marginPct };
}
