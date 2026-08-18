// The eBay selling-fee model (US-2325).
//
// This is the SINGLE SOURCE OF TRUTH for what eBay takes out of a sale. It is
// read by the forward profit estimate the seller sees in the composer
// (lib/listing-profit.ts) and by ScoutAI's arbitrage scoring and buy/skip
// decision (edge lib/scout-scoring.ts, lib/scout-decision.ts).
//
// WHY IT EXISTS. Those three lived with their own constants and two different
// numbers: the composer used 13.25% + $0.40, while both ScoutAI paths used a
// flat 13% and modelled NO fixed fee at all. So the tool that told a seller
// "buy this" and the tool that then told them what it would earn disagreed on
// every single item, and the disagreement always ran the same way — ScoutAI was
// the optimistic one, on the screen where the money actually leaves your hand.
//
// ⚠️ MIRROR: this file is duplicated VERBATIM at
//   services/edge-functions/src/lib/ebay-fees.ts
// because the Deno edge runtime cannot import from the Vite `src/` tree. The
// two copies MUST stay byte-identical — the guard test
// src/lib/__tests__/ebay-fees.test.ts fails the build if they drift. Keep this
// module dependency-free (pure constants + pure functions) so it type-checks
// under BOTH tsconfig and Deno.
//
// ⚠️ NUMBERS SHIFT. eBay changes fees without notice and the rate varies by
// category. VERIFY against the live fee schedule before treating these as
// authoritative; `EBAY_FEE_SOURCE` carries where they came from and when they
// were last checked.

/**
 * Final-value fee as a fraction of the total order amount.
 *
 * Under eBay Managed Payments this ALREADY INCLUDES payment processing — there
 * is no separate processor cut to subtract, which is the mistake to avoid when
 * someone later "adds Stripe-style fees" on top.
 *
 * ⚠️ CORRECTED 2026-08-18 (US-9003), from 0.1325 to 0.136. The old number is a
 * real eBay rate, but it belongs to Coins & Paper Money and the trading-card
 * categories, not apparel — apparel falls under "Most categories" at 13.6%.
 * Verified against eBay id=4822 rather than a secondary source. Under-stating
 * the fee by 0.35 points ran the same direction everywhere it was read: ScoutAI
 * called marginal buys profitable and the composer promised sellers more than
 * they got.
 */
export const EBAY_FEE_RATE = 0.136;

/** Fixed per-ORDER fee, in dollars. Charged once per order, not per item. */
export const EBAY_FIXED_FEE = 0.4;

/** Provenance for the two numbers above, in the marketplace-specs.ts style. */
export const EBAY_FEE_SOURCE = {
  sourceNote:
    "eBay Managed Payments standard final-value fee for most categories " +
    "(clothing/shoes/accessories), inclusive of payment processing, plus the " +
    "fixed per-order fee. Category-specific rates and store-subscription " +
    "discounts are NOT modelled — pass an override where a caller knows better. " +
    "The full schedule (store tiers, the handbag cliff, the athletic-shoe " +
    "threshold, standing surcharges) lives in src/lib/ebay-fee-schedule.ts, " +
    "which is not mirrored to the edge.",
  lastVerified: "2026-08",
} as const;

/**
 * Fee charged on a sale at `price` dollars.
 *
 * Both parts are applied because leaving the fixed fee out is not a rounding
 * difference at the low end: on a $12 item $0.40 is another 3.3% of the sale,
 * which is most of the gap between a thin flip and a loss.
 */
export function ebayFeesFor(
  price: number,
  opts: { feeRate?: number; fixedFee?: number } = {},
): number {
  const rate = opts.feeRate ?? EBAY_FEE_RATE;
  const fixed = opts.fixedFee ?? EBAY_FIXED_FEE;
  if (!Number.isFinite(price) || price <= 0) return 0;
  return price * rate + fixed;
}

/** What actually lands, in dollars. Never negative — a fee cannot pay you. */
export function ebayNetProceeds(
  price: number,
  opts: { feeRate?: number; fixedFee?: number } = {},
): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return Math.max(0, price - ebayFeesFor(price, opts));
}

/**
 * The same calculation in CENTS, for the edge paths that work in integers.
 *
 * Rounds the fee UP. Between two adjacent cents the conservative direction for
 * a buy/skip call is the one that assumes eBay keeps more — a decision engine
 * that rounds in its own favour is how "marginal" becomes "buy".
 */
export function ebayNetProceedsCents(
  priceCents: number,
  opts: { feeRate?: number; fixedFeeCents?: number } = {},
): number {
  const rate = opts.feeRate ?? EBAY_FEE_RATE;
  const fixedCents = opts.fixedFeeCents ?? Math.round(EBAY_FIXED_FEE * 100);
  if (!Number.isFinite(priceCents) || priceCents <= 0) return 0;
  const fee = Math.ceil(priceCents * rate) + fixedCents;
  return Math.max(0, priceCents - fee);
}
