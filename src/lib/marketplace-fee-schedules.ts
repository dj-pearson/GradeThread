// Fee schedules for the four marketplaces that are not eBay (US-9005), plus
// the cross-platform comparison that runs over all five.
//
// EBAY IS NOT IN HERE. It lives in src/lib/ebay-fee-schedule.ts because it is
// genuinely a different shape: three category models, six store tiers, marginal
// and cliff thresholds, standing surcharges. Folding it into this file would
// mean either flattening eBay into something wrong or bending every other
// platform around eBay's complexity. The comparison below calls into it
// instead, so there is still one number per platform on one page.
//
// EVERY RATE WAS READ OFF THE MARKETPLACE'S OWN FEE PAGE AND CONFIRMED AGAINST
// A SECOND SOURCE. The working is recorded in
// docs/seo/marketplace-fees-CONFIRMED.csv. This is the rule US-9003 produced
// after its first draft carried a real eBay percentage belonging to the wrong
// category, and US-9004 followed it too.
//
// ONE SHAPE, so a rate change is a one-file edit (AC2): every platform is a
// percentage on some base, plus a fixed amount, plus at most one threshold
// rule. What differs between them is WHICH BASE, and that is the thing sellers
// get wrong, so `feeBase` is stated on the page rather than assumed.

import { calculateEbayFees } from "./ebay-fee-schedule";

export type MarketplaceKey = "ebay" | "poshmark" | "mercari" | "depop" | "etsy";

/** What a percentage fee is charged on. The differences here are the story. */
export type FeeBase =
  /** Item price only. Shipping and tax are outside the fee. */
  | "item"
  /** Item price plus the shipping the buyer paid. */
  | "item-plus-shipping"
  /** Item price plus shipping plus sales tax. */
  | "item-plus-shipping-plus-tax";

export interface MarketplaceFeeSchedule {
  key: MarketplaceKey;
  name: string;
  /** Slug under /tools/, absent for eBay which has its own calculator. */
  slug?: string;
  /**
   * The day the schedule took effect, when the marketplace publishes one, or
   * null when it does not. A null is honest; an invented date is not.
   */
  effectiveFrom: string | null;
  /** The day the fee page was read. Always known, always shown. */
  retrievedOn: string;
  /** URL of the marketplace's own fee page, for the reader to check. */
  source: string;
  /** Selling commission as a fraction, e.g. 0.2 for 20%. */
  commissionRate: number;
  commissionBase: FeeBase;
  /**
   * A flat fee that REPLACES the commission below a price threshold, as
   * Poshmark does. Null when the platform has no such rule.
   */
  smallOrderFlatFee: { under: number; fee: number } | null;
  /** Payment processing, charged on top of commission. */
  processingRate: number;
  processingFixed: number;
  processingBase: FeeBase;
  /** Per-listing fee charged whether or not the item sells. */
  listingFee: number;
  /** Optional promotion, as a fraction of the same base as the commission. */
  promotionRate: number | null;
  promotionLabel: string | null;
  /** What the BUYER pays on top, which is not your cost but is your conversion. */
  buyerFee: { rate: number; fixed: number; label: string } | null;
  /** The one thing about this platform's fees that surprises people. */
  gotcha: string;
}

export const MARKETPLACE_FEES: Readonly<Record<MarketplaceKey, MarketplaceFeeSchedule>> = {
  ebay: {
    key: "ebay",
    name: "eBay",
    effectiveFrom: null,
    retrievedOn: "2026-08-18",
    source: "https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees",
    // Apparel, no Store, good standing. The full model is in ebay-fee-schedule.ts.
    commissionRate: 0.136,
    commissionBase: "item-plus-shipping-plus-tax",
    smallOrderFlatFee: null,
    processingRate: 0,
    processingFixed: 0.4,
    processingBase: "item",
    listingFee: 0,
    promotionRate: null,
    promotionLabel: "Promoted Listings",
    buyerFee: null,
    gotcha:
      "The fee is charged on sales tax as well as shipping, so eBay takes a cut of money you never touch.",
  },
  poshmark: {
    key: "poshmark",
    name: "Poshmark",
    slug: "poshmark-fee-calculator",
    effectiveFrom: null,
    retrievedOn: "2026-08-18",
    source: "https://poshmark.com/posh_guide/get_started_on_poshmark",
    commissionRate: 0.2,
    commissionBase: "item",
    smallOrderFlatFee: { under: 15, fee: 2.95 },
    processingRate: 0,
    processingFixed: 0,
    processingBase: "item",
    listingFee: 0,
    promotionRate: null,
    promotionLabel: null,
    buyerFee: null,
    gotcha:
      "20% is the highest headline rate of the five, but it is charged on the item price alone and there is no processing fee under it. Below $15 the flat $2.95 is worse than 20% would have been: on a $10 sale it is 29.5%.",
  },
  mercari: {
    key: "mercari",
    name: "Mercari",
    slug: "mercari-fee-calculator",
    effectiveFrom: "2025-01-06",
    retrievedOn: "2026-08-18",
    source: "https://www.mercari.com/us/help_center/article/2518/",
    commissionRate: 0.1,
    commissionBase: "item-plus-shipping",
    smallOrderFlatFee: null,
    processingRate: 0,
    processingFixed: 0,
    processingBase: "item",
    listingFee: 0,
    promotionRate: null,
    promotionLabel: "Promote",
    buyerFee: { rate: 0.036, fixed: 0, label: "Buyer Protection fee" },
    gotcha:
      "Mercari ran a zero-seller-fee experiment and ended it on 2025-01-06. The 10% now applies to buyer-paid shipping too, and the old 2.9% + $0.50 processing fee is gone rather than hidden.",
  },
  depop: {
    key: "depop",
    name: "Depop",
    slug: "depop-fee-calculator",
    effectiveFrom: "2024-07-18",
    retrievedOn: "2026-08-18",
    source:
      "https://depophelp.zendesk.com/hc/en-gb/articles/360001791127-Seller-fees-and-charges",
    commissionRate: 0,
    commissionBase: "item",
    smallOrderFlatFee: null,
    processingRate: 0.033,
    processingFixed: 0.45,
    processingBase: "item-plus-shipping-plus-tax",
    listingFee: 0,
    promotionRate: 0.12,
    promotionLabel: "Boosted Listings",
    buyerFee: { rate: 0.05, fixed: 1, label: "marketplace fee, up to" },
    gotcha:
      "There is no selling fee for US sellers, which makes Depop look free and it nearly is. The cost moved to the buyer: up to 5% plus up to $1 at checkout. Boosting a listing costs 12%, which is more than most platforms charge to sell at all.",
  },
  etsy: {
    key: "etsy",
    name: "Etsy",
    slug: "etsy-fee-calculator",
    effectiveFrom: null,
    retrievedOn: "2026-08-18",
    source: "https://help.etsy.com/hc/en-us/articles/360035902374-Etsy-Fee-Basics",
    commissionRate: 0.065,
    commissionBase: "item-plus-shipping",
    smallOrderFlatFee: null,
    processingRate: 0.03,
    processingFixed: 0.25,
    processingBase: "item-plus-shipping",
    listingFee: 0.2,
    promotionRate: 0.15,
    promotionLabel: "Offsite Ads",
    buyerFee: null,
    gotcha:
      "The 6.5% is the smallest headline rate here and it is not the whole cost: add 3% + $0.25 processing and $0.20 a listing, charged again every four months whether it sells or not. Pass $10,000 in a rolling year and Offsite Ads become mandatory at 12%, with no opt-out for the life of the shop.",
  },
};

export const FEE_BASE_LABELS: Record<FeeBase, string> = {
  item: "the item price only",
  "item-plus-shipping": "the item price plus shipping",
  "item-plus-shipping-plus-tax": "the item price plus shipping plus sales tax",
};

export interface SaleInput {
  itemPrice: number;
  shippingCharged: number;
  salesTax: number;
  /** What the item cost you. Optional; profit is only shown when it is set. */
  itemCost?: number;
  /** What postage costs you, when you are the one paying it. */
  shippingCost?: number;
  /** Whether the seller bought the platform's promotion on this listing. */
  promoted?: boolean;
}

function baseAmount(base: FeeBase, sale: SaleInput): number {
  switch (base) {
    case "item":
      return sale.itemPrice;
    case "item-plus-shipping":
      return sale.itemPrice + sale.shippingCharged;
    case "item-plus-shipping-plus-tax":
      return sale.itemPrice + sale.shippingCharged + sale.salesTax;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface FeeLine {
  label: string;
  /** Plain-English statement of what the number was calculated on. */
  basis: string;
  amount: number;
}

export interface MarketplaceQuote {
  key: MarketplaceKey;
  name: string;
  lines: FeeLine[];
  totalFees: number;
  /** What lands in your account before your own costs. */
  payout: number;
  /** Payout minus what the item and the postage cost you. */
  profit: number;
  /** Total fees as a percentage of the item price, to one decimal. */
  effectiveRatePct: number;
  /** What the buyer pays over the item price, when the platform charges them. */
  buyerPays: number;
}

/**
 * The eBay row, computed by the real eBay schedule with the defaults a
 * clothing seller has on a first sale: apparel, no Store, good standing, not
 * promoted, inside the US, inside the free listing allowance. Anything more
 * specific belongs on /tools/ebay-fee-calculator, and the page says so.
 */
function quoteEbay(sale: SaleInput): MarketplaceQuote {
  const r = calculateEbayFees({
    itemPrice: sale.itemPrice,
    shippingCharged: sale.shippingCharged,
    salesTax: sale.salesTax,
    itemCost: sale.itemCost ?? 0,
    shippingCost: sale.shippingCost ?? 0,
    category: "apparel",
    storeTier: "none",
    listingFormat: "fixed",
    startingPrice: sale.itemPrice,
    pastFreeListings: false,
    adRatePct: sale.promoted ? 2 : 0,
    international: false,
    offersEbayInternationalShipping: false,
    currencyConverted: false,
    standing: "good",
    lostDispute: false,
  });
  return {
    key: "ebay",
    name: "eBay",
    lines: r.lines.filter((l) => l.amount > 0),
    totalFees: r.totalFees,
    payout: r.payout,
    profit: r.profit,
    effectiveRatePct:
      sale.itemPrice > 0 ? Math.round((r.totalFees / sale.itemPrice) * 1000) / 10 : 0,
    buyerPays: 0,
  };
}

/**
 * One platform's arithmetic. Sales tax is collected and remitted by every one
 * of these marketplaces, so it can be inside the fee base and is never inside
 * the payout. That asymmetry is the most common reason a payout comes in lower
 * than a seller's own spreadsheet said.
 */
export function quoteMarketplace(key: MarketplaceKey, sale: SaleInput): MarketplaceQuote {
  // eBay delegates to its own module so the comparison row and the eBay
  // calculator can never disagree. The rates in MARKETPLACE_FEES.ebay are
  // there for the comparison TABLE (headline rate, fee base, gotcha) and are
  // deliberately not used for arithmetic.
  if (key === "ebay") return quoteEbay(sale);

  const s = MARKETPLACE_FEES[key];
  const lines: FeeLine[] = [];

  const commissionBase = baseAmount(s.commissionBase, sale);
  if (s.smallOrderFlatFee && sale.itemPrice < s.smallOrderFlatFee.under) {
    lines.push({
      label: "Flat commission",
      basis: `Sales under $${s.smallOrderFlatFee.under} are charged a flat fee instead of a percentage`,
      amount: s.smallOrderFlatFee.fee,
    });
  } else if (s.commissionRate > 0) {
    lines.push({
      label: "Selling fee",
      basis: `${(s.commissionRate * 100).toFixed(1).replace(/\.0$/, "")}% of ${FEE_BASE_LABELS[s.commissionBase]}`,
      amount: round2(commissionBase * s.commissionRate),
    });
  }

  const processingBase = baseAmount(s.processingBase, sale);
  const processing = round2(processingBase * s.processingRate) + s.processingFixed;
  if (processing > 0) {
    const pct = s.processingRate > 0 ? `${(s.processingRate * 100).toFixed(1)}% of ` : "";
    const fixed = s.processingFixed > 0 ? ` plus $${s.processingFixed.toFixed(2)}` : "";
    lines.push({
      label: s.processingRate > 0 ? "Payment processing" : "Per-order fee",
      basis: `${pct}${s.processingRate > 0 ? FEE_BASE_LABELS[s.processingBase] : "every order"}${fixed}`,
      amount: round2(processing),
    });
  }

  if (s.listingFee > 0) {
    lines.push({
      label: "Listing fee",
      basis: "Charged when you list, and again every four months whether it sells or not",
      amount: s.listingFee,
    });
  }

  if (sale.promoted && s.promotionRate !== null) {
    lines.push({
      label: s.promotionLabel ?? "Promotion",
      basis: `${(s.promotionRate * 100).toFixed(0)}% of ${FEE_BASE_LABELS[s.commissionBase]}`,
      amount: round2(commissionBase * s.promotionRate),
    });
  }

  const totalFees = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  // Tax is remitted by the platform, so it never reaches the seller.
  const payout = round2(sale.itemPrice + sale.shippingCharged - totalFees);
  const profit = round2(payout - (sale.itemCost ?? 0) - (sale.shippingCost ?? 0));
  const effectiveRatePct =
    sale.itemPrice > 0 ? Math.round((totalFees / sale.itemPrice) * 1000) / 10 : 0;

  const buyerPays = s.buyerFee
    ? round2(baseAmount("item-plus-shipping", sale) * s.buyerFee.rate + s.buyerFee.fixed)
    : 0;

  return {
    key,
    name: s.name,
    lines,
    totalFees,
    payout,
    profit,
    effectiveRatePct,
    buyerPays,
  };
}

export const COMPARISON_ORDER: readonly MarketplaceKey[] = [
  "ebay",
  "poshmark",
  "mercari",
  "depop",
  "etsy",
];

/** Every platform's quote for the same sale, best payout first. */
export function compareMarketplaces(sale: SaleInput): MarketplaceQuote[] {
  return COMPARISON_ORDER.map((k) => quoteMarketplace(k, sale)).sort(
    (a, b) => b.payout - a.payout,
  );
}

/**
 * The /compare/ page for a pair, in whichever direction we actually published.
 * Returns null when no page exists, rather than linking to a 404.
 */
const COMPARE_PAGES = new Set([
  "mercari-vs-ebay",
  "poshmark-vs-mercari",
  "depop-vs-poshmark",
  "ebay-vs-poshmark",
  "ebay-vs-depop",
  "mercari-vs-depop",
]);

export function comparePagePath(a: MarketplaceKey, b: MarketplaceKey): string | null {
  for (const slug of [`${a}-vs-${b}`, `${b}-vs-${a}`]) {
    if (COMPARE_PAGES.has(slug)) return `/compare/${slug}`;
  }
  return null;
}
