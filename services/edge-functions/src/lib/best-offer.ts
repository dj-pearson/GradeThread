// US-562: Best-offer auto-accept / auto-decline thresholds.
//
// eBay's Sell Inventory API accepts a per-offer `bestOfferTerms` with optional
// `autoAcceptPrice` / `autoDeclinePrice`. An incoming offer at or above
// autoAcceptPrice is auto-accepted; an offer at or below autoDeclinePrice is
// auto-declined; anything in between waits for the seller. So best offers clear
// within the seller's limits without babysitting.
//
// eBay enforces these constraints (Inventory API offer.listingPolicies):
//   - autoAcceptPrice  must be LESS THAN the listing (Buy It Now) price
//   - autoDeclinePrice must be LESS THAN autoAcceptPrice (when both are set)
//   - both must be greater than 0
//
// We derive defaults from the comp stats already stored on the listing
// (price_range_low_cents = p25 floor → decline; price_range_high_cents = p75 →
// accept) and let the seller override either per item. Whatever we end up with
// is clamped/validated to satisfy the constraints above; a value that cannot be
// made valid is dropped (Best Offer stays enabled, just without that one
// threshold) rather than failing the publish with an eBay 400.

export interface BestOfferThresholdInput {
  /** The listing (Buy It Now) price, in whole cents. */
  priceCents: number;
  /** Comp 25th percentile (the floor), in cents, or null when unknown. */
  p25Cents: number | null;
  /** Comp 75th percentile, in cents, or null when unknown. */
  p75Cents: number | null;
  /** Per-item seller override for auto-accept, in cents, or null. */
  acceptOverrideCents: number | null;
  /** Per-item seller override for auto-decline, in cents, or null. */
  declineOverrideCents: number | null;
}

export interface BestOfferThresholds {
  /** Resolved auto-accept price in cents, or null when none applies. */
  autoAcceptCents: number | null;
  /** Resolved auto-decline price in cents, or null when none applies. */
  autoDeclineCents: number | null;
}

function pickPositive(a: number | null, b: number | null): number | null {
  if (a != null && Number.isFinite(a) && a > 0) return Math.round(a);
  if (b != null && Number.isFinite(b) && b > 0) return Math.round(b);
  return null;
}

/**
 * Resolves the auto-accept / auto-decline thresholds to send on a best-offer
 * enabled offer. Override wins over the comp-derived default; the result is
 * always clamped to eBay's constraints (see file header).
 */
export function resolveBestOfferThresholds(
  input: BestOfferThresholdInput,
): BestOfferThresholds {
  const price =
    Number.isFinite(input.priceCents) && input.priceCents > 0
      ? Math.round(input.priceCents)
      : 0;

  // Override wins; else derive from comp stats (p75 → accept, p25 → decline).
  let accept = pickPositive(input.acceptOverrideCents, input.p75Cents);
  let decline = pickPositive(input.declineOverrideCents, input.p25Cents);

  // Constraint 1: autoAcceptPrice must be strictly below the listing price.
  // When the candidate sits at/above list (e.g. p75 exceeds an aggressively
  // priced item), nudge it to one cent under list. If list is ≤ 1 cent there's
  // no room for a valid accept threshold, so drop it.
  if (accept != null && price > 0 && accept >= price) {
    accept = price > 1 ? price - 1 : null;
  }

  // Constraint 2: autoDeclinePrice must be strictly below autoAcceptPrice when
  // both are present. A seller override (or odd comp data) can invert them; we
  // drop the decline rather than silently rewriting the seller's number.
  if (accept != null && decline != null && decline >= accept) {
    decline = null;
  }

  // When there's no accept threshold, decline still must sit below the list
  // price to be meaningful.
  if (accept == null && decline != null && price > 0 && decline >= price) {
    decline = null;
  }

  return {
    autoAcceptCents: accept != null && accept > 0 ? accept : null,
    autoDeclineCents: decline != null && decline > 0 ? decline : null,
  };
}

/** Formats whole cents as an eBay money string ("24.99"). */
export function centsToMoneyString(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}
