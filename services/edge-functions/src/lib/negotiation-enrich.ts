// US-1062: enrich eBay "send offers to interested buyers" eligible items.
//
// eBay's find_eligible_items returns only { listingId, title? } — a bare numeric
// listing id is useless for deciding which buyers to offer. We enrich each item
// with the seller's real title, price, currency, thumbnail and condition by
// joining eBay's eligible listingIds to local listings (by platform_listing_id)
// + item_photos, falling back to an eBay Browse lookup when no local row exists.
//
// The join/lookup (network + DB) lives in the route; this module holds the pure
// mapping so it can be unit-tested without a database or eBay credentials.

export interface EligibleItemInput {
  listingId: string;
  title: string | null;
}

/** Display fields resolved for a single listing from local rows or Browse. */
export interface EligibleEnrichment {
  title: string | null;
  price: number | null;
  currency: string;
  imageUrl: string | null;
  condition: string | null;
}

export type EligibleSource = "local" | "browse" | "ebay";

export interface EnrichedEligibleItem {
  listingId: string;
  title: string | null;
  price: number | null;
  currency: string;
  imageUrl: string | null;
  condition: string | null;
  /** Where the display fields came from — "ebay" means only the bare id resolved. */
  source: EligibleSource;
}

/**
 * Merge eBay's eligible items with locally-joined and Browse-resolved
 * enrichments. Precedence: local listing → Browse lookup → eBay's own
 * title (id-only fallback). The eBay-supplied title is used as a backstop for
 * the title field at every level so we never lose it.
 */
export function enrichEligibleItems(
  items: EligibleItemInput[],
  localByListingId: Map<string, EligibleEnrichment>,
  browseByListingId: Map<string, EligibleEnrichment>,
): EnrichedEligibleItem[] {
  return items.map((it) => {
    const local = localByListingId.get(it.listingId);
    if (local) {
      return {
        listingId: it.listingId,
        title: local.title ?? it.title ?? null,
        price: local.price,
        currency: local.currency,
        imageUrl: local.imageUrl,
        condition: local.condition,
        source: "local",
      };
    }
    const browse = browseByListingId.get(it.listingId);
    if (browse) {
      return {
        listingId: it.listingId,
        title: browse.title ?? it.title ?? null,
        price: browse.price,
        currency: browse.currency,
        imageUrl: browse.imageUrl,
        condition: browse.condition,
        source: "browse",
      };
    }
    return {
      listingId: it.listingId,
      title: it.title ?? null,
      price: null,
      currency: "USD",
      imageUrl: null,
      condition: null,
      source: "ebay",
    };
  });
}
