// US-553: forward profit/margin estimate for a draft at a given list price, so
// pricing is a margin decision instead of a guess. (computePnl in lib/pnl.ts is
// BACKWARD-looking — it needs a recorded sale's actual fees; this estimates
// them up front from the price.)
//
// eBay Managed Payments: a final-value fee (~13.25% for most categories, which
// already includes payment processing) plus a fixed per-order fee (~$0.40).
// Both are overridable so a category-specific rate can be passed later.

export const DEFAULT_EBAY_FEE_RATE = 0.1325;
export const DEFAULT_EBAY_FIXED_FEE = 0.4;

export interface ProfitInputs {
  /** The list price being considered (USD). */
  price: number;
  /** Cost of goods (acquired_price). */
  costBasis?: number | null;
  /** Grading cost already incurred. */
  gradingCost?: number | null;
  /** Seller-paid shipping label, if known. */
  shippingCost?: number | null;
  /** eBay final-value fee fraction (default 13.25%). */
  feeRate?: number;
  /** Fixed per-order fee (default $0.40). */
  fixedFee?: number;
}

export interface ProfitEstimate {
  /** Estimated marketplace fees (FVF + fixed). */
  fees: number;
  /** Your costs: cost basis + grading + shipping. */
  costs: number;
  /** price − fees − costs (can be negative). */
  net: number;
  /** net / price * 100; 0 when price is 0. */
  marginPct: number;
}

export function estimateListingProfit(input: ProfitInputs): ProfitEstimate {
  const price = Math.max(0, input.price || 0);
  const feeRate = input.feeRate ?? DEFAULT_EBAY_FEE_RATE;
  const fixedFee = input.fixedFee ?? DEFAULT_EBAY_FIXED_FEE;
  const costBasis = Math.max(0, input.costBasis ?? 0);
  const grading = Math.max(0, input.gradingCost ?? 0);
  const shipping = Math.max(0, input.shippingCost ?? 0);

  const fees = price > 0 ? price * feeRate + fixedFee : 0;
  const costs = costBasis + grading + shipping;
  const net = price - fees - costs;
  const marginPct = price > 0 ? (net / price) * 100 : 0;
  return { fees, costs, net, marginPct };
}
