// US-562: Best-offer auto-accept / auto-decline thresholds.
//
// eBay's Sell Inventory API accepts a per-offer `bestOfferTerms` with optional
// `autoAcceptPrice` / `autoDeclinePrice`. An incoming offer at or above
// autoAcceptPrice is auto-accepted; an offer at or below autoDeclinePrice is
// auto-declined; anything in between waits for the seller.
//
// eBay enforces these constraints (Inventory API offer.listingPolicies):
//   - autoAcceptPrice  must be LESS THAN the listing (Buy It Now) price
//   - autoDeclinePrice must be LESS THAN autoAcceptPrice (when both are set)
//   - both must be greater than 0
//
// US-2405 — THE THRESHOLDS ARE THE SELLER'S OWN NUMBERS. NOTHING IS DERIVED.
// This used to fall back to the comp band (price_range_low_cents = p25 →
// decline, price_range_high_cents = p75 → accept) whenever the seller left a
// box blank. That default was persisted into the best_offer_* columns by the
// composer save, so it became a FIXED number that no longer tracked anything —
// and it survived a later price edit. A shirt repriced from $24 to $298 kept a
// $27.50 auto-accept, meaning a $28 offer on a $298 item would have been
// accepted automatically. Blank now means blank: no threshold is sent, the
// offer waits for the seller, which is the safe direction. The only work left
// here is validating what the seller typed against eBay's rules; a value that
// cannot be made valid is dropped rather than silently rewritten.

export interface BestOfferThresholdInput {
  /** The listing (Buy It Now) price, in whole cents. */
  priceCents: number;
  /** The seller's auto-accept threshold in cents, or null when they left it blank. */
  acceptCents: number | null;
  /** The seller's auto-decline threshold in cents, or null when they left it blank. */
  declineCents: number | null;
}

export interface BestOfferThresholds {
  /** Resolved auto-accept price in cents, or null when none applies. */
  autoAcceptCents: number | null;
  /** Resolved auto-decline price in cents, or null when none applies. */
  autoDeclineCents: number | null;
}

function positive(v: number | null): number | null {
  if (v != null && Number.isFinite(v) && v > 0) return Math.round(v);
  return null;
}

/**
 * Validates the auto-accept / auto-decline thresholds to send on a best-offer
 * enabled offer. Input is the seller's own numbers only; the result is always
 * clamped to eBay's constraints (see file header).
 */
export function resolveBestOfferThresholds(
  input: BestOfferThresholdInput,
): BestOfferThresholds {
  const price =
    Number.isFinite(input.priceCents) && input.priceCents > 0
      ? Math.round(input.priceCents)
      : 0;

  let accept = positive(input.acceptCents);
  let decline = positive(input.declineCents);

  // Constraint 1: autoAcceptPrice must be strictly below the listing price.
  // When the seller's number sits at/above list, nudge it to one cent under.
  // If list is ≤ 1 cent there's no room for a valid accept threshold, so drop it.
  if (accept != null && price > 0 && accept >= price) {
    accept = price > 1 ? price - 1 : null;
  }

  // Constraint 2: autoDeclinePrice must be strictly below autoAcceptPrice when
  // both are present. We drop the decline rather than silently rewriting the
  // seller's number.
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
