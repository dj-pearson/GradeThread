// US-1898: client mirror of the publish-time Best Offer threshold clamp
// (services/edge-functions/src/lib/best-offer.ts, US-562). The single-item
// composer uses it to prefill auto-accept/auto-decline from the listing's comp
// band and clamp the seller's edits to eBay's constraints BEFORE persisting to
// the best_offer_* columns. The edge remains the authoritative clamp at publish;
// keep the two in lockstep (the constraints below are eBay's, not ours).
//
// eBay Inventory API constraints:
//   - autoAcceptPrice  must be strictly LESS THAN the listing price
//   - autoDeclinePrice must be strictly LESS THAN autoAcceptPrice (when both set)
//   - both must be greater than 0
// Comp-derived defaults: p75 (price_range_high) → accept, p25 (low) → decline.

export interface BestOfferThresholdInput {
  /** Listing (Buy It Now) price, in whole cents. */
  priceCents: number;
  /** Comp 25th percentile (floor) in cents, or null. */
  p25Cents: number | null;
  /** Comp 75th percentile in cents, or null. */
  p75Cents: number | null;
  /** Seller override for auto-accept, in cents, or null. */
  acceptOverrideCents: number | null;
  /** Seller override for auto-decline, in cents, or null. */
  declineOverrideCents: number | null;
}

export interface BestOfferThresholds {
  autoAcceptCents: number | null;
  autoDeclineCents: number | null;
}

function pickPositive(a: number | null, b: number | null): number | null {
  if (a != null && Number.isFinite(a) && a > 0) return Math.round(a);
  if (b != null && Number.isFinite(b) && b > 0) return Math.round(b);
  return null;
}

/**
 * Resolve auto-accept / auto-decline: override wins over the comp-derived
 * default, then the result is clamped to eBay's constraints (accept < price;
 * decline < accept). A value that can't be made valid is dropped (null) rather
 * than silently rewritten. Mirrors resolveBestOfferThresholds in the edge lib.
 */
export function resolveBestOfferThresholds(
  input: BestOfferThresholdInput,
): BestOfferThresholds {
  const price =
    Number.isFinite(input.priceCents) && input.priceCents > 0
      ? Math.round(input.priceCents)
      : 0;

  let accept = pickPositive(input.acceptOverrideCents, input.p75Cents);
  let decline = pickPositive(input.declineOverrideCents, input.p25Cents);

  // accept must be strictly below the listing price; nudge to one cent under,
  // or drop if there's no room.
  if (accept != null && price > 0 && accept >= price) {
    accept = price > 1 ? price - 1 : null;
  }
  // decline must be strictly below accept when both are present.
  if (accept != null && decline != null && decline >= accept) {
    decline = null;
  }
  // with no accept, decline still must sit below the listing price.
  if (accept == null && decline != null && price > 0 && decline >= price) {
    decline = null;
  }

  return {
    autoAcceptCents: accept != null && accept > 0 ? accept : null,
    autoDeclineCents: decline != null && decline > 0 ? decline : null,
  };
}

/** Whole cents → an editable dollar string ("24.99"), or "" for null/≤0. */
export function centsToDollarInput(cents: number | null | undefined): string {
  return cents != null && cents > 0 ? (Math.round(cents) / 100).toFixed(2) : "";
}

/** A dollar input string → whole cents, or null when blank/invalid/≤0. */
export function dollarInputToCents(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
