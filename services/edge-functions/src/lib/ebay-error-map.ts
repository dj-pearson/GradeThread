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
// eBay's 25002 and 2004 are OVERLOADED "A user error has occurred" codes: the
// SAME id covers "offer already exists", "the item specific <X> is missing",
// aspect-value-too-long, and many more. A fixed message for these is a guess and
// actively misleads (25002 showed "already has a live eBay offer" for a
// missing-Inseam rejection), so resolveEbayFix() prefers eBay's OWN message text
// for these ids and only falls back to the entry below when eBay sent none.
const OVERLOADED_EBAY_ERROR_IDS = new Set<number>([25002, 2004]);

const EBAY_ERROR_FIX: Record<number, EbayFix> = {
  // Overloaded generic (see above) — last-resort text only.
  25002: {
    message:
      "eBay rejected the listing — a required field or value is missing or invalid. Check the highlighted item specifics, category, and condition.",
  },
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

// Best-effort composer field to deep-link from eBay's free-text message when we
// only have the raw message (no specific mapped id).
function fieldHintFromMessage(msg: string): EbayFix["field"] | undefined {
  const m = msg.toLowerCase();
  if (m.includes("item specific") || m.includes("aspect")) return "specifics";
  if (m.includes("category")) return "category";
  if (m.includes("condition")) return "condition";
  if (m.includes("policy") || m.includes("policies")) return "policies";
  if (m.includes("price")) return "price";
  if (m.includes("image") || m.includes("photo") || m.includes("picture")) {
    return "photos";
  }
  return undefined;
}

/**
 * Resolve the best client-facing fix (message + optional field) for an eBay
 * failure. Priority:
 *   1. a SPECIFIC mapped errorId (25007/25019/25709/…) — clean + actionable;
 *   2. eBay's OWN structured message — for overloaded (25002/2004) or unmapped
 *      ids, this is the real reason ("The item specific Inseam is missing…");
 *   3. the hardcoded fallback for a known id, else the caller's generic.
 * Never returns the raw provider blob (err.message) — that stays in the logs.
 */
export function resolveEbayFix(
  err: unknown,
  generic: string = EBAY_PUBLISH_GENERIC_FIX,
): EbayFix {
  const e = err as { ebayErrorIds?: number[]; ebayErrorMessages?: string[] } | null;
  const ids = e?.ebayErrorIds ?? [];
  // 1. A specific, non-overloaded mapping wins.
  for (const id of ids) {
    if (OVERLOADED_EBAY_ERROR_IDS.has(id)) continue;
    const fix = EBAY_ERROR_FIX[id];
    if (fix) return fix;
  }
  // 2. eBay's own message (overloaded/unmapped ids).
  const real = (e?.ebayErrorMessages ?? [])
    .map((m) => m.trim())
    .find((m) => m.length > 0);
  if (real) return { message: real.slice(0, 400), field: fieldHintFromMessage(real) };
  // 3. Fallback to any hardcoded fix, else the generic.
  return mapEbayError(ids) ?? { message: generic };
}

/**
 * US-1511: client-safe `detail` for an eBay failure on the NON-publish paths
 * (revise/price/end/negotiation). Mirrors the publish path's US-567 contract:
 * the resolved structured-errorId / eBay message, else the caller's operation-
 * specific generic — NEVER the raw provider blob ("eBay POST /sell/... failed
 * (400): {json}"), which stays in the server logs only.
 */
export function ebayFailureDetail(err: unknown, generic: string): string {
  return resolveEbayFix(err, generic).message;
}
