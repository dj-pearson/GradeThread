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
