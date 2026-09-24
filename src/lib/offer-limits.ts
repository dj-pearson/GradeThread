// OM-02 / OM-09 / OM-12: the web mirror of the edge's Offers & Messages limits.
//
// The edge (services/edge-functions/src/lib/offer-limits.ts) is AUTHORITATIVE:
// it refuses a body that breaks these rules. The page uses the same numbers so
// the seller sees the rule before pressing Send rather than as a 400 after.
// The two projects cannot import each other, so
// src/test/offer-limits-parity.test.ts reads the edge file and fails if any of
// these drift from it.

/** eBay's cap on a member-message reply body. */
export const MEMBER_MESSAGE_MAX = 2000;
/** The smallest discount a watcher offer may carry, in whole percent. */
export const SEND_OFFER_MIN_PCT = 1;
/** The largest. */
export const SEND_OFFER_MAX_PCT = 60;
/** How many listings one send-offer request may carry. */
export const SEND_OFFER_MAX_LISTINGS = 100;
/** eBay's cap on the note sent with a counter (SellerResponse). */
export const SELLER_RESPONSE_MAX = 250;
/** Longest eBay item / message / user id the edge accepts. */
export const EBAY_ID_MAX = 64;

/** The seller-facing range, for inline hints. */
export const SEND_OFFER_RANGE_COPY = `Offers go from ${SEND_OFFER_MIN_PCT}% to ${SEND_OFFER_MAX_PCT}%.`;

/**
 * What the seller typed in a discount box, as a whole percent, or null when it
 * is not one the edge will take. Never substitutes a default: "0.4" is not 0,
 * and "75" is not 60.
 */
export function parseDiscountInput(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= SEND_OFFER_MIN_PCT && n <= SEND_OFFER_MAX_PCT ? n : null;
}
