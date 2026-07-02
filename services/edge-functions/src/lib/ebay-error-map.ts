// US-567: map eBay's STRUCTURED publish error IDs to short, user-fixable
// messages (and the composer field the seller should fix), so the publish dialog
// can show "Pick a different condition" instead of a raw, localized eBay error
// blob. The raw provider detail stays server-side (logs only) — only the mapped
// message is returned to the client.
//
// IDs are stable across eBay message rewordings/locales (the message text is
// not), so we key off the numeric errorId that fetchAuthed() already parses onto
// the thrown error (err.ebayErrorIds).

export interface EbayFix {
  /** Short, actionable, seller-facing message. */
  message: string;
  /** Composer field the publish dialog can deep-link the seller to. */
  field?: "category" | "condition" | "specifics" | "price" | "photos" | "policies";
}

// Common Sell Inventory/Offer publish error IDs. Extend as new ones surface in
// the logs (the raw detail is always logged server-side for triage).
const EBAY_ERROR_FIX: Record<number, EbayFix> = {
  // Offer already exists for this SKU — handled by adopt-on-retry (US-464/528),
  // but if it ever reaches the user, this is the explanation.
  25002: { message: "This item already has a live eBay offer." },
  // Invalid/expired listing policy or a category↔policy mismatch.
  25007: {
    message:
      "An eBay business policy or category is invalid for this item. Re-check the category and your shipping/return/payment policies.",
    field: "policies",
  },
  // Condition not valid for the selected leaf category.
  25019: {
    message:
      "The selected condition isn't allowed in this eBay category. Pick a different condition in the composer.",
    field: "condition",
  },
  // Missing/invalid required item specific (aspect).
  25709: {
    message:
      "A required eBay item specific is missing or invalid. Fill the required specifics in the composer.",
    field: "specifics",
  },
  // Category invalid / not a leaf.
  25710: {
    message: "The eBay category is invalid. Pick a valid (leaf) category in the composer.",
    field: "category",
  },
  25713: {
    message:
      "The eBay category isn't specific enough. Pick a more specific (leaf) category in the composer.",
    field: "category",
  },
  // Price problems (e.g. below minimum, invalid).
  25023: {
    message: "The price is invalid for this listing. Set a valid target price.",
    field: "price",
  },
  // Generic invalid-request from the Sell API.
  2004: {
    message: "eBay rejected the listing data. Re-check the category, condition, price, and specifics.",
  },
};

/** Generic fallback when no specific errorId matched. */
export const EBAY_PUBLISH_GENERIC_FIX =
  "eBay rejected the listing. Re-check the category, condition, price, and required specifics, then try again.";

/**
 * First matching fix for a list of eBay error IDs, or null. Returns the most
 * specific (first-listed) match so callers can surface a single actionable line.
 */
export function mapEbayError(errorIds: number[] | undefined | null): EbayFix | null {
  if (!errorIds || errorIds.length === 0) return null;
  for (const id of errorIds) {
    const fix = EBAY_ERROR_FIX[id];
    if (fix) return fix;
  }
  return null;
}

/**
 * US-1511: client-safe `detail` for an eBay failure on the NON-publish paths
 * (revise/price/end/negotiation). Mirrors the publish path's US-567 contract:
 * the mapped structured-errorId message when one matches, else the caller's
 * operation-specific generic — NEVER the raw provider blob ("eBay POST
 * /sell/... failed (400): {json}"), which stays in the server logs only.
 */
export function ebayFailureDetail(err: unknown, generic: string): string {
  const ids = (err as { ebayErrorIds?: number[] } | null)?.ebayErrorIds;
  return mapEbayError(ids)?.message ?? generic;
}
