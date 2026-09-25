// Worth My Time, R1 05/12 (US-3170): what finishing an item might actually
// leave the seller.
//
// A high asking price is not money. This exists so a plan sorts on what is
// left after costs rather than on the biggest number on the screen, and every
// rule below is about refusing to turn a hope into a figure.
//
// ── TWO NUMBERS, BECAUSE SUNK COST IS NOT A REASON TO SKIP WORK (AC1) ───────
// `wholeItemProfit` is the whole truth: proceeds minus what was paid, what has
// been spent, and what is still to spend. It is the number for "was this a
// good buy".
//
// `remainingContribution` subtracts ONLY the costs still ahead. It is the
// number for "is finishing this worth my next hour", and it is the one the
// planner ranks on. A jacket bought for $60 that will sell for $55 is a bad
// buy and still worth the twenty minutes it takes to recover $50 of it.
// Ranking on whole-item profit alone would bury exactly the items a seller
// most needs to clear.
//
// ── NO FABRICATED PROBABILITY, NO PROMISED DATE (AC3) ───────────────────────
// There is no field here for "likely to sell in 12 days" or "78% chance",
// because nothing in R1 measures either. A planning horizon of 30 days is
// stated as an assumption and is not a prediction about this garment.
//
// ── NO REPAIR UPLIFT (AC5) ──────────────────────────────────────────────────
// src/lib/repair-triage.ts is not read here. A mended garment may be worth
// more; nobody has measured how much, and adding an uplift would make a
// repair task outrank real work on a promise. R2 may use it as uncertain
// advisory input, never as a certified grade or a guaranteed increase.

import { EBAY_FEE_RATE, EBAY_FIXED_FEE } from "@/lib/ebay-fees";
import { estimateListingProfit } from "@/lib/listing-profit";

/**
 * Marketplaces whose fee schedule this repo actually knows (AC2).
 *
 * ONE ENTRY, AND THAT IS THE POINT. lib/ebay-fees.ts is the single source of
 * truth for eBay's rate and fixed fee. Poshmark's 20%, Mercari's tiering and
 * Depop's split are not in this codebase, so applying eBay's numbers to them
 * would produce a confident figure that is wrong by several dollars on every
 * item -- and wrong in the optimistic direction, which is the one that wastes
 * a seller's evening.
 */
export const SUPPORTED_FEE_MARKETPLACES = ["ebay"] as const;
export type SupportedFeeMarketplace = (typeof SUPPORTED_FEE_MARKETPLACES)[number];

/** R1 is USD only, the same contract US-3166 set for preferences. */
export const SUPPORTED_CURRENCY = "USD";

/** How long a plan looks ahead. An assumption, stated, not a prediction. */
export const PLANNING_HORIZON_DAYS = 30;

/**
 * Where a price came from. These stay DISTINCT (AC3) because they are worth
 * different amounts:
 *
 *   sold_comp       something actually sold for this. The only real evidence.
 *   seller_estimate the seller typed a target. A considered opinion.
 *   active_asking   somebody is ASKING this. Not a sale, and the weakest of
 *                   the three -- an unsold listing at $200 is evidence that
 *                   $200 did not sell.
 */
export const EVIDENCE_SOURCES = [
  "sold_comp",
  "seller_estimate",
  "active_asking",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * How much of an asking price to believe, when it is all there is.
 *
 * An active asking price is NEVER claimed sale proceeds (AC3). It enters at a
 * discount and is labelled, so a plan built on one reads as the guess it is.
 * The figure is an assumption like every other number in this feature.
 */
export const ASKING_PRICE_DISCOUNT = 0.8;

export interface PriceEvidence {
  amountCents: number;
  source: EvidenceSource;
  /** When the evidence was observed, ISO. Null when nobody recorded it. */
  observedAt: string | null;
  /**
   * The top of a range the SELLER set (WMT-14). When present, amountCents is
   * the bottom, both ends go through the same fees and costs, and no band is
   * added: the seller already said how wide it is, and widening it again
   * undid their correction.
   */
  highAmountCents?: number | null;
}

/** Everything the estimate could not get. Named, so a surface can ask for it. */
export type MissingInput =
  | "purchase_price"
  | "price_evidence"
  | "shipping_cost"
  | "supplies_cost"
  | "fee_schedule"
  /** No marketplace yet, so eBay's fees were assumed (WMT-14). */
  | "fee_schedule_assumed"
  | "currency";

export interface ValueEstimate {
  complete: true;
  /** Proceeds minus every cost, past and future. "Was this a good buy". */
  wholeItemProfitCents: number;
  /** Proceeds minus only the costs still ahead. What the planner ranks on. */
  remainingContributionCents: number;
  /** Conservative and optimistic bounds on the contribution. */
  lowCents: number;
  highCents: number;
  evidence: EvidenceSource;
  observedAt: string | null;
  /** Inputs that were guessed or absent. Empty when everything was recorded. */
  missing: MissingInput[];
  horizonDays: number;
}

export interface IncompleteEstimate {
  complete: false;
  reason:
    | "unsupported_fee_schedule"
    | "unsupported_currency"
    | "no_price_evidence";
  missing: MissingInput[];
  /**
   * TRUE when the seller could fix this by doing pricing research (AC4). An
   * item with no price evidence does not disappear from the planner; it
   * becomes the research task. An item on a marketplace whose fees nobody has
   * modelled cannot be fixed by the seller, so it is false there.
   */
  researchable: boolean;
  horizonDays: number;
}

export type ValueResult = ValueEstimate | IncompleteEstimate;

export function isComplete(r: ValueResult): r is ValueEstimate {
  return r.complete === true;
}

export interface ValueInput {
  marketplace: string | null;
  currency?: string | null;
  evidence: PriceEvidence | null;
  /**
   * What the seller paid. NULL IS UNKNOWN, NOT FREE (AC4). Treating an
   * unrecorded purchase as zero would report the full sale price as profit and
   * float every un-costed item to the top of the plan.
   */
  purchaseCents?: number | null;
  /** Costs already spent beyond the purchase, e.g. a grading fee. */
  spentCents?: number | null;
  /** Postage still to buy. Recorded where known; a fallback is labelled. */
  shippingCents?: number | null;
  /** Mailer, tape and label. Same treatment as shipping. */
  suppliesCents?: number | null;
  /**
   * Anything else still to spend before this sells, as the seller corrected
   * it (WMT-14). A FUTURE cost, so it comes off the contribution the planner
   * ranks on; spentCents above only moves the whole-item figure, which is why
   * the "remaining cost" correction used to change nothing about the rank.
   */
  futureCostCents?: number | null;
  /**
   * TRUE when the caller picked the fee schedule because the item has no
   * marketplace yet (WMT-14). The estimate is made, and `missing` says so.
   */
  feeScheduleAssumed?: boolean;
}

/**
 * A conservative fallback for postage when nothing is recorded (AC4).
 *
 * LABELLED, ALWAYS. It lands in `missing` so the caller can say "estimated"
 * rather than presenting it as this parcel's cost. It is deliberately on the
 * high side: under-estimating postage flatters the item, and a plan that
 * flatters items wastes evenings.
 */
export const FALLBACK_SHIPPING_CENTS = 900;
export const FALLBACK_SUPPLIES_CENTS = 100;

function positiveCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0) return null;
  return Math.round(v);
}

function isSupportedMarketplace(m: string | null): m is SupportedFeeMarketplace {
  return m !== null && (SUPPORTED_FEE_MARKETPLACES as readonly string[]).includes(m);
}

/**
 * What this item is worth finishing.
 *
 * Pure and deterministic. No network, no model call, no clock: `observedAt` is
 * carried through from the evidence rather than compared against now, because
 * a plan that changed its numbers between two readings is a plan a seller
 * stops trusting. Deciding whether evidence is STALE is the caller's job and
 * the observation date is what they need for it.
 */
export function estimateWorkValue(input: ValueInput): ValueResult {
  const missing: MissingInput[] = [];
  if (input.feeScheduleAssumed) missing.push("fee_schedule_assumed");

  const currency = input.currency ?? SUPPORTED_CURRENCY;
  if (currency !== SUPPORTED_CURRENCY) {
    // AC2: a non-USD item produces an explicit incomplete estimate. Converting
    // at a rate nobody supplied would be the same failure as guessing a fee.
    return {
      complete: false,
      reason: "unsupported_currency",
      missing: ["currency"],
      researchable: false,
      horizonDays: PLANNING_HORIZON_DAYS,
    };
  }

  if (!isSupportedMarketplace(input.marketplace)) {
    // AC2: never silently apply eBay's fees elsewhere. Not researchable: the
    // seller cannot fix a fee schedule this codebase does not know.
    return {
      complete: false,
      reason: "unsupported_fee_schedule",
      missing: ["fee_schedule"],
      researchable: false,
      horizonDays: PLANNING_HORIZON_DAYS,
    };
  }

  const evidenceAmount = input.evidence
    ? positiveCents(input.evidence.amountCents)
    : null;
  if (input.evidence === null || evidenceAmount === null) {
    // AC4: this item does NOT disappear from the planner. It becomes the
    // pricing-research task, which is exactly the work that would fix it.
    return {
      complete: false,
      reason: "no_price_evidence",
      missing: ["price_evidence"],
      researchable: true,
      horizonDays: PLANNING_HORIZON_DAYS,
    };
  }

  // An asking price enters at a discount and never as claimed proceeds (AC3).
  const expectedCents = input.evidence.source === "active_asking"
    ? Math.round(evidenceAmount * ASKING_PRICE_DISCOUNT)
    : evidenceAmount;

  const purchase = positiveCents(input.purchaseCents);
  if (purchase === null) missing.push("purchase_price");

  const spent = positiveCents(input.spentCents) ?? 0;

  let shipping = positiveCents(input.shippingCents);
  if (shipping === null) {
    shipping = FALLBACK_SHIPPING_CENTS;
    missing.push("shipping_cost");
  }
  let supplies = positiveCents(input.suppliesCents);
  if (supplies === null) {
    supplies = FALLBACK_SUPPLIES_CENTS;
    missing.push("supplies_cost");
  }

  // Fees come from the shared source, through the shared calculator (AC2), so
  // the plan and the pricing screen cannot disagree about eBay's cut.
  const priceDollars = expectedCents / 100;
  const feeOnly = estimateListingProfit({
    price: priceDollars,
    feeRate: EBAY_FEE_RATE,
    fixedFee: EBAY_FIXED_FEE,
  });
  const feesCents = Math.round(feeOnly.fees * 100);

  // A cost the SELLER stated is known to the cent, so it comes off both ends
  // of the band rather than shrinking it: the uncertainty is in the price.
  const statedFutureCost = positiveCents(input.futureCostCents) ?? 0;
  const futureCosts = shipping + supplies + statedFutureCost;
  // The costs still ahead. The purchase is NOT here: it is spent either way,
  // and charging it against the next hour is the sunk-cost error AC1 names.
  const remainingContributionCents = expectedCents - feesCents - futureCosts;
  // The whole truth. An unknown purchase is left OUT rather than treated as
  // zero, and `missing` says so -- a caller that prints this figure without
  // reading `missing` would report the full price as profit.
  const wholeItemProfitCents = remainingContributionCents - (purchase ?? 0) - spent;

  // The band. An asking price is already discounted once; widening the low
  // side again for it is deliberate, because it is the weakest evidence there
  // is and a plan built on one should read as uncertain.
  const spread = input.evidence.source === "sold_comp"
    ? 0.1
    : input.evidence.source === "seller_estimate"
    ? 0.2
    : 0.3;
  const band = Math.round(Math.abs(remainingContributionCents + statedFutureCost) * spread);

  // WMT-14: a seller's own range keeps its width. The top goes through the
  // same fees and the same costs as the bottom, and nothing is added.
  const rangeHigh = positiveCents(input.evidence.highAmountCents);
  let lowCents = remainingContributionCents - band;
  let highCents = remainingContributionCents + band;
  if (rangeHigh !== null && rangeHigh >= evidenceAmount) {
    const highFees = Math.round(
      estimateListingProfit({
        price: rangeHigh / 100,
        feeRate: EBAY_FEE_RATE,
        fixedFee: EBAY_FIXED_FEE,
      }).fees * 100,
    );
    lowCents = remainingContributionCents;
    highCents = rangeHigh - highFees - futureCosts;
  }

  return {
    complete: true,
    wholeItemProfitCents,
    remainingContributionCents,
    lowCents,
    highCents,
    evidence: input.evidence.source,
    observedAt: input.evidence.observedAt ?? null,
    missing,
    horizonDays: PLANNING_HORIZON_DAYS,
  };
}
