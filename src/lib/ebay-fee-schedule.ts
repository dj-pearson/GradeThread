// The full eBay US selling fee schedule, and the arithmetic over it (US-9003).
//
// DISTINCT FROM src/lib/ebay-fees.ts, which is deliberately a two-constant
// model (one blended rate, one fixed fee) shared byte-for-byte with the Deno
// edge runtime for ScoutAI buy/skip and the composer profit estimate. This file
// is the PUBLIC CALCULATOR schedule: every category shape, every store tier,
// every surcharge. It is not mirrored to the edge and nothing on the edge reads
// it. The two agree on the headline apparel rate, and ebay-fees.test.ts holds
// them to that.
//
// EVERY NUMBER HERE WAS READ OFF EBAY'S OWN PAGES on 2026-08-18 — id=4822
// (Selling fees), id=4809 (Store selling fees), id=4164 (Promoted Listings) —
// and the working is recorded in docs/seo/ebay-fee-schedule-CONFIRMED.csv. The
// first draft of that sheet had 13.25% for apparel, which is a real eBay number
// belonging to Coins & Paper Money and the trading-card categories. A fee
// calculator that is confidently wrong is worse than no fee calculator, so
// nothing in this file may be edited from memory or from a secondary source.
//
// NO effectiveFrom FIELD, and that is deliberate. US-9003 AC2 asked for one.
// eBay does not print an effective date on either fee page, so an effectiveFrom
// would be a date we invented, and a made-up freshness stamp is worse than none
// — it tells a reader the schedule was current on a day nobody checked. What
// can be stated truthfully is the day it was READ, which is what the page says.
//
// THREE FEE SHAPES, which is the part every naive fee calculator gets wrong:
//   * apparel is MARGINAL — one rate up to a threshold, 2.35% on the portion
//     above it;
//   * handbags are a CLIFF — crossing $2,000 re-rates the WHOLE amount, so a
//     $2,001 sale costs less in fees than a $1,999 one;
//   * athletic shoes are CONDITIONAL — at $150 the rate drops AND the per-order
//     fee stops being charged at all.

/** The day the schedule was read off eBay's pages. Stated on the page. */
export const EBAY_FEES_RETRIEVED_ON = "2026-08-18";

export type StoreTier = "none" | "starter" | "basic" | "premium" | "anchor" | "enterprise";
export type FeeCategory = "apparel" | "handbags" | "athletic-shoes";
export type ListingFormat = "fixed" | "auction";

/**
 * Seller standing, which adds percentage points to the final value fee.
 * `inad-*` is the "item not as described" return-rate surcharge, judged per
 * category. A seller who is both Below Standard and Very High is charged the
 * Below Standard one only, never both — modelled in surchargePoints().
 */
export type SellerStanding =
  | "good"
  | "below-standard"
  | "below-standard-4mo"
  | "inad-very-high"
  | "inad-very-high-4mo";

export const STORE_TIER_LABELS: Record<StoreTier, string> = {
  none: "No Store",
  starter: "Starter Store",
  basic: "Basic Store",
  premium: "Premium Store",
  anchor: "Anchor Store",
  enterprise: "Enterprise Store",
};

export const FEE_CATEGORY_LABELS: Record<FeeCategory, string> = {
  apparel: "Clothing, Shoes & Accessories",
  handbags: "Women's Bags & Handbags",
  "athletic-shoes": "Athletic Shoes (men's or women's)",
};

export const SELLER_STANDING_LABELS: Record<SellerStanding, string> = {
  good: "Above Standard or Top Rated",
  "below-standard": "Below Standard",
  "below-standard-4mo": "Below Standard, 4+ months running",
  "inad-very-high": "'Not as described' return rate Very High",
  "inad-very-high-4mo": "'Not as described' rate Very High, 4+ months",
};

/**
 * Starter Store gets NO final-value discount — it pays the no-Store rate. This
 * is the single most surprising line in the schedule and the reason the tier
 * split is a function rather than a lookup keyed on the tier itself.
 */
function isDiscountTier(tier: StoreTier): boolean {
  return tier === "basic" || tier === "premium" || tier === "anchor" || tier === "enterprise";
}

/** Apparel and the sub-$150 athletic-shoe fallback: rate, then 2.35% above the cap. */
const APPAREL_RATE = { standard: 13.6, discounted: 12.7 } as const;
const APPAREL_CAP = { standard: 7500, discounted: 2500 } as const;
const ABOVE_CAP_RATE = 2.35;

/** Handbags re-rate the WHOLE amount at $2,000, rather than tapering. */
const HANDBAG_CLIFF = 2000;
const HANDBAG_RATE = {
  standard: { atOrBelow: 15.0, above: 9.0 },
  discounted: { atOrBelow: 13.0, above: 7.0 },
} as const;

/** Athletic shoes at or above this SALE TOTAL take the reduced rate and skip the per-order fee. */
export const ATHLETIC_SHOE_THRESHOLD = 150;
const ATHLETIC_SHOE_RATE = { standard: 8.0, discounted: 7.0 } as const;

const PER_ORDER_FEE = { atOrBelow10: 0.3, above10: 0.4 } as const;

/**
 * Insertion fee per listing past the free allotment. Premium and up charge more
 * for auction-style than for fixed price; the lower tiers charge the same.
 */
export const INSERTION_FEE: Record<StoreTier, { fixed: number; auction: number }> = {
  none: { fixed: 0.35, auction: 0.35 },
  starter: { fixed: 0.3, auction: 0.3 },
  basic: { fixed: 0.25, auction: 0.25 },
  premium: { fixed: 0.1, auction: 0.15 },
  anchor: { fixed: 0.05, auction: 0.1 },
  enterprise: { fixed: 0.05, auction: 0.1 },
};

/** Free fixed-price listings per month, all categories. */
export const FREE_LISTINGS_PER_MONTH: Record<StoreTier, number> = {
  none: 250,
  starter: 250,
  basic: 1000,
  premium: 10000,
  anchor: 25000,
  enterprise: 100000,
};

/**
 * Store subscription cost per month. `yearly` is the price on a yearly
 * renewal, `monthly` on a monthly one — the two differ by up to $50 a month
 * and the sheet's original single column silently mixed them. Enterprise is
 * yearly-renewal only, which is why `monthly` is nullable.
 */
export const STORE_MONTHLY_COST: Record<
  StoreTier,
  { yearly: number; monthly: number | null }
> = {
  none: { yearly: 0, monthly: 0 },
  starter: { yearly: 4.95, monthly: 7.95 },
  basic: { yearly: 21.95, monthly: 27.95 },
  premium: { yearly: 59.95, monthly: 74.95 },
  anchor: { yearly: 299.95, monthly: 349.95 },
  enterprise: { yearly: 2999.95, monthly: null },
};

/** Ad rate bounds for Promoted Listings Standard. */
export const AD_RATE_MIN = 2;
export const AD_RATE_MAX = 100;

/** Charged when the buyer's address, or the delivery address, is outside the US. */
const INTERNATIONAL_FEE_PCT = 1.65;
/** Charged only when eBay actually converts the payout to another currency. */
const CURRENCY_CONVERSION_PCT = 3.0;
/** Per chargeback or dispute the seller is found responsible for. */
export const DISPUTE_FEE = 20.0;

export interface FeeInput {
  /** What the buyer pays for the item itself. */
  itemPrice: number;
  /** Shipping and handling charged to the buyer. Counts toward the fee base. */
  shippingCharged: number;
  /** Sales tax collected. Also counts toward the fee base. */
  salesTax: number;
  /** What the item cost you. Only used for the profit line. */
  itemCost: number;
  /** What shipping actually costs you. Only used for the profit line. */
  shippingCost: number;
  category: FeeCategory;
  storeTier: StoreTier;
  listingFormat: ListingFormat;
  /**
   * The auction start price, or the Buy It Now price, BEFORE shipping and tax.
   * A separate $150 test from the one on the sale total: this one drives the
   * free athletic-shoe insertion fee, that one drives the rate.
   */
  startingPrice: number;
  /** True once this month's free listings are used up. */
  pastFreeListings: boolean;
  /** Promoted Listings ad rate, 0 for an unpromoted listing. */
  adRatePct: number;
  /** Buyer registered outside the US, or delivering outside it. */
  international: boolean;
  /** eBay International Shipping waives the international fee entirely. */
  offersEbayInternationalShipping: boolean;
  /** The payout is converted out of USD. Off for a US seller paid in USD. */
  currencyConverted: boolean;
  standing: SellerStanding;
  /** The sale ended in a dispute the seller lost. */
  lostDispute: boolean;
}

export interface FeeLine {
  label: string;
  amount: number;
  /** One line saying how it was worked out, shown next to the number. */
  basis: string;
}

export interface FeeResult {
  /** Item + shipping + tax. eBay's "total amount of the sale". */
  saleTotal: number;
  lines: FeeLine[];
  totalFees: number;
  /** What lands in your account: sale total, less fees, less the tax you remit. */
  payout: number;
  /** Payout less what the item and its shipping cost you. */
  profit: number;
  /** Fees as a percentage of the sale total. */
  effectiveFeePct: number;
}

/** Round to the cent, half away from zero, so a .005 never silently drops. */
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Percentage points added to the final value fee by seller standing. */
export function surchargePoints(standing: SellerStanding): number {
  switch (standing) {
    case "below-standard":
      return 6;
    case "below-standard-4mo":
      return 7;
    case "inad-very-high":
      return 5;
    case "inad-very-high-4mo":
      return 6;
    default:
      return 0;
  }
}

/**
 * The final value fee on a sale total, and the sentence explaining it. Split
 * out because the three category shapes are the part worth testing directly.
 */
export function finalValueFee(
  saleTotal: number,
  category: FeeCategory,
  storeTier: StoreTier,
): { amount: number; basis: string } {
  const discounted = isDiscountTier(storeTier);
  const band = discounted ? "discounted" : "standard";

  if (category === "handbags") {
    const rates = HANDBAG_RATE[band];
    const above = saleTotal > HANDBAG_CLIFF;
    const rate = above ? rates.above : rates.atOrBelow;
    return {
      amount: money((saleTotal * rate) / 100),
      basis: above
        ? `${rate}% of the whole sale, because it is over $${HANDBAG_CLIFF.toLocaleString()}`
        : `${rate}% of the whole sale, at or under $${HANDBAG_CLIFF.toLocaleString()}`,
    };
  }

  if (category === "athletic-shoes" && saleTotal >= ATHLETIC_SHOE_THRESHOLD) {
    const rate = ATHLETIC_SHOE_RATE[band];
    return {
      amount: money((saleTotal * rate) / 100),
      basis: `${rate}%, the athletic-shoe rate for a sale of $${ATHLETIC_SHOE_THRESHOLD} or more`,
    };
  }

  // Apparel, and athletic shoes that miss the threshold.
  const rate = APPAREL_RATE[band];
  const cap = APPAREL_CAP[band];
  if (saleTotal <= cap) {
    return { amount: money((saleTotal * rate) / 100), basis: `${rate}% of the sale total` };
  }
  const upTo = (cap * rate) / 100;
  const over = ((saleTotal - cap) * ABOVE_CAP_RATE) / 100;
  return {
    amount: money(upTo + over),
    basis: `${rate}% of the first $${cap.toLocaleString()}, then ${ABOVE_CAP_RATE}% of the rest`,
  };
}

/** True when this sale skips the per-order fee (athletic shoes at $150+). */
export function skipsPerOrderFee(saleTotal: number, category: FeeCategory): boolean {
  return category === "athletic-shoes" && saleTotal >= ATHLETIC_SHOE_THRESHOLD;
}

/** Every fee on one sale, itemised, plus the payout and profit that fall out of it. */
export function calculateEbayFees(input: FeeInput): FeeResult {
  const saleTotal = money(input.itemPrice + input.shippingCharged + input.salesTax);
  const lines: FeeLine[] = [];

  const fvf = finalValueFee(saleTotal, input.category, input.storeTier);
  lines.push({ label: "Final value fee", amount: fvf.amount, basis: fvf.basis });

  if (skipsPerOrderFee(saleTotal, input.category)) {
    lines.push({
      label: "Per-order fee",
      amount: 0,
      basis: `Not charged: athletic shoes at $${ATHLETIC_SHOE_THRESHOLD} or more`,
    });
  } else {
    const fee = saleTotal <= 10 ? PER_ORDER_FEE.atOrBelow10 : PER_ORDER_FEE.above10;
    lines.push({
      label: "Per-order fee",
      amount: fee,
      basis: saleTotal <= 10 ? "Order of $10.00 or less" : "Order over $10.00",
    });
  }

  const points = surchargePoints(input.standing);
  if (points > 0) {
    lines.push({
      label: "Seller-standing surcharge",
      amount: money((saleTotal * points) / 100),
      basis: `${points} percentage points on top, for ${SELLER_STANDING_LABELS[input.standing]}`,
    });
  }

  // Athletic shoes starting at $150 or more list free at every tier, so the
  // insertion fee can be waived on a listing whose SALE total never reaches it.
  const freeInsertion =
    input.category === "athletic-shoes" && input.startingPrice >= ATHLETIC_SHOE_THRESHOLD;
  if (input.pastFreeListings && !freeInsertion) {
    lines.push({
      label: "Insertion fee",
      amount: INSERTION_FEE[input.storeTier][input.listingFormat],
      basis: `Past this month's ${FREE_LISTINGS_PER_MONTH[input.storeTier].toLocaleString()} free listings on ${STORE_TIER_LABELS[input.storeTier]}`,
    });
  }

  if (input.adRatePct > 0) {
    lines.push({
      label: "Promoted Listings",
      amount: money((saleTotal * input.adRatePct) / 100),
      basis: `${input.adRatePct}% ad rate, charged on the full sale total`,
    });
  }

  if (input.international && !input.offersEbayInternationalShipping) {
    lines.push({
      label: "International fee",
      amount: money((saleTotal * INTERNATIONAL_FEE_PCT) / 100),
      basis: `${INTERNATIONAL_FEE_PCT}%, waived if you offer eBay International Shipping`,
    });
  }

  if (input.currencyConverted) {
    lines.push({
      label: "Currency conversion",
      amount: money((saleTotal * CURRENCY_CONVERSION_PCT) / 100),
      basis: `${CURRENCY_CONVERSION_PCT}%, only when eBay converts the payout`,
    });
  }

  if (input.lostDispute) {
    lines.push({
      label: "Dispute fee",
      amount: DISPUTE_FEE,
      basis: "Flat, per dispute you are found responsible for",
    });
  }

  const totalFees = money(lines.reduce((sum, l) => sum + l.amount, 0));
  // The tax is collected on eBay's behalf and remitted, so it never reaches you.
  const payout = money(saleTotal - totalFees - input.salesTax);
  const profit = money(payout - input.itemCost - input.shippingCost);
  return {
    saleTotal,
    lines,
    totalFees,
    payout,
    profit,
    effectiveFeePct: saleTotal > 0 ? money((totalFees / saleTotal) * 100) : 0,
  };
}
