// Listing provenance helpers for the FlipDesk UI (US-1081).
//
// Mirrors the edge registry `deriveListingOrigin` in
// `services/edge-functions/src/lib/sync-precedence.ts` so the editor can show
// the correct authority badge. This is display-only: there is NO client-side
// precedence/write logic — the edge service is the single enforcement point
// (see vault/20-domain/sync-source-of-truth.md "Surface parity").

export interface ListingOriginSignals {
  /** Persisted marker once US-1077 lands it ('ebay' | 'gradethread'). */
  listing_origin?: string | null;
  platform?: string | null;
  /** eBay listing id — present on listings that exist on eBay. */
  platform_listing_id?: string | null;
  /** FlipDesk publish batch — set only when WE created the listing. */
  batch_id?: string | null;
  /** Set only when FlipDesk pushed the listing up to eBay. */
  synced_to_ebay_at?: string | null;
}

/**
 * Decide whether a listing is eBay-originated or GradeThread-originated.
 * GT-originated = published from FlipDesk (`batch_id` / `synced_to_ebay_at`);
 * eBay-originated = imported from eBay (`platform_listing_id` set, never
 * published by us). Ambiguous defaults to 'gradethread' (full bidirectional),
 * matching the edge helper exactly.
 */
export function deriveListingOrigin(
  s: ListingOriginSignals,
): "ebay" | "gradethread" {
  if (s.listing_origin === "ebay" || s.listing_origin === "gradethread") {
    return s.listing_origin;
  }
  if (s.batch_id || s.synced_to_ebay_at) return "gradethread";
  if ((s.platform ?? "").toLowerCase() === "ebay" && s.platform_listing_id) {
    return "ebay";
  }
  return "gradethread";
}

// Shape of the eBay-drift marker the inbound pull records on a GradeThread-
// originated listing (listings.platform_fields.sync_drift). Informational only.
export interface SyncDriftMarker {
  fields: string[];
  ebay?: Record<string, unknown>;
  detected_at?: string;
}

// US-2165: stamped by autoEndCrossListings when a sibling sale could NOT end a
// listing on its marketplace — an unsupported platform, a dropped connection, or
// a rejected delist call. Unlike sync_drift this is NOT informational: the
// listing is still live and purchasable, so the same garment can sell twice
// until the seller ends it there.
export interface DelistUnresolvedMarker {
  platform: string;
  reason: string;
  detected_at?: string;
}

// US-2656: eBay's OWN verdict on the listing, recorded by the inbound pull on
// every change. The local `listing_status` enum has three words for it (active /
// ended / sold), so a listing eBay took down, one that ran out of stock, and one
// the seller ended all read the same there. This keeps the distinction that the
// collapse loses, and it is the difference between "relist it" and "read your
// eBay messages first, because a relist gets removed again".
//
// `reason` mirrors the server's ListingStateReason; `ebay_status` is eBay's raw
// word, carried verbatim so a value eBay adds shows up as itself in the data
// rather than being folded into a neighbour.
export interface EbayStateMarker {
  status: "active" | "ended";
  reason:
    | "active"
    | "out_of_stock"
    | "ended"
    | "inactive"
    | "completed"
    | "not_in_feed"
    | "unknown_status";
  ebay_status?: string | null;
  message?: string | null;
  observed_at?: string;
}

// The reasons worth interrupting the seller for. `active` needs no explanation,
// and `ended`/`completed` are already what the status badge says — repeating
// them as a banner would train the seller to ignore the banner. These three are
// the ones with no representation anywhere else, and each needs a DIFFERENT
// action, which is the whole reason the reason is kept.
export const NOTABLE_EBAY_STATE_REASONS: ReadonlySet<string> = new Set([
  "out_of_stock",
  "inactive",
  "unknown_status",
]);

// US-1290: stamped on BOTH listings when the same physical garment appears to
// have sold on more than one channel. We never auto-pick a winner — the seller
// has to cancel one order.
export interface OversellConflictMarker {
  conflicting_listing_id: string;
  detected_at?: string;
}

/** Human label for a drifted eBay-owned field. */
export function driftFieldLabel(field: string): string {
  switch (field) {
    case "title":
      return "Title";
    case "price":
      return "Price";
    case "description":
      return "Description";
    case "quantity":
      return "Quantity";
    default:
      return field;
  }
}
