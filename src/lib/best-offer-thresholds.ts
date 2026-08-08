// US-1898: client mirror of the publish-time Best Offer threshold clamp
// (services/edge-functions/src/lib/best-offer.ts, US-562). The single-item
// composer uses it to validate the seller's auto-accept/auto-decline edits
// against eBay's constraints BEFORE persisting to the best_offer_* columns. The
// edge remains the authoritative clamp at publish; keep the two in lockstep
// (the constraints below are eBay's, not ours).
//
// eBay Inventory API constraints:
//   - autoAcceptPrice  must be strictly LESS THAN the listing price
//   - autoDeclinePrice must be strictly LESS THAN autoAcceptPrice (when both set)
//   - both must be greater than 0
//
// US-2405: THERE IS NO COMP-DERIVED DEFAULT ANY MORE. A blank box means no
// threshold — the offer waits for the seller. See the edge file header for the
// $24 → $298 reprice that a persisted comp default turned into a $28 auto-accept.

export interface BestOfferThresholdInput {
  /** Listing (Buy It Now) price, in whole cents. */
  priceCents: number;
  /** The seller's auto-accept threshold in cents, or null when blank. */
  acceptCents: number | null;
  /** The seller's auto-decline threshold in cents, or null when blank. */
  declineCents: number | null;
}

export interface BestOfferThresholds {
  autoAcceptCents: number | null;
  autoDeclineCents: number | null;
}

function positive(v: number | null): number | null {
  if (v != null && Number.isFinite(v) && v > 0) return Math.round(v);
  return null;
}

/**
 * Validate the seller's auto-accept / auto-decline numbers against eBay's
 * constraints (accept < price; decline < accept). A value that can't be made
 * valid is dropped (null) rather than silently rewritten. Mirrors
 * resolveBestOfferThresholds in the edge lib.
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

// US-2405: an auto-accept far below the asking price is almost always a number
// left over from an older, lower price — the exact shape of the bug that made
// these manual. eBay accepts it happily (it only checks accept < price), so the
// only place it can be caught is in front of the seller, before they save.
const LOW_ACCEPT_RATIO = 0.7;

/**
 * A non-blocking warning when the auto-accept sits below LOW_ACCEPT_RATIO of the
 * listing price, or null when there's nothing to say. Deliberately a warning and
 * not a validation error: a seller may genuinely want to clear stock at half
 * price, and we don't refuse their number — we make sure they see it.
 */
export function lowAcceptWarning(
  priceCents: number,
  acceptCents: number | null,
): string | null {
  if (acceptCents == null || acceptCents <= 0) return null;
  if (!Number.isFinite(priceCents) || priceCents <= 0) return null;
  if (acceptCents >= priceCents * LOW_ACCEPT_RATIO) return null;
  const pct = Math.round((acceptCents / priceCents) * 100);
  return (
    `Auto-accept is ${pct}% of your price — any offer at or above ` +
    `${centsToDollarInput(acceptCents)} sells this item instantly. ` +
    `Check it still matches your price.`
  );
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
