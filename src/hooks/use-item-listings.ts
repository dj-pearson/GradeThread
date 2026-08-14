import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// US-2519. Four panels on the item page each ran their own `listings` query for
// the same inventory_item_id — the eBay-native notice, the alert markers, the
// GradeThread listing card and the promotion card. Same row, four round trips,
// four independent cache entries that could disagree with each other on screen.
//
// One read now, ordered newest-first, with the union of the columns those panels
// need. An item has a handful of listings at most, so the filtering the four
// queries did in SQL is cheaper done here — and it means a mutation invalidates
// ONE key and every panel updates together.

export const ITEM_LISTINGS_KEY = "item_listings";

export function itemListingsKey(itemId: string): [string, string] {
  return [ITEM_LISTINGS_KEY, itemId];
}

export interface ItemListingRow {
  id: string;
  platform: string;
  listing_status: string | null;
  listing_url: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  quantity: number | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  batch_id: string | null;
  synced_to_ebay_at: string | null;
  platform_fields: Record<string, unknown> | null;
  publish_error: string | null;
  publish_failed_at: string | null;
  updated_at: string | null;
}

const COLUMNS = [
  "id",
  "platform",
  "listing_status",
  "listing_url",
  "listing_title",
  "listing_description",
  "listing_price",
  "quantity",
  "platform_offer_id",
  "platform_listing_id",
  "batch_id",
  "synced_to_ebay_at",
  "platform_fields",
  "publish_error",
  "publish_failed_at",
  "updated_at",
].join(", ");

/** Every listing on one item, newest first. RLS scopes it to the caller. */
export function useItemListings(itemId: string | undefined) {
  return useQuery({
    queryKey: itemListingsKey(itemId ?? ""),
    enabled: Boolean(itemId),
    queryFn: async (): Promise<ItemListingRow[]> => {
      const { data, error } = await supabase
        .from("listings")
        .select(COLUMNS)
        .eq("inventory_item_id", itemId!)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as unknown) as ItemListingRow[];
    },
  });
}

// ── The selectors the four panels used to express as SQL filters ────────────

/** Newest active listing, whatever the platform. */
export function activeListing(rows: ItemListingRow[]): ItemListingRow | null {
  return rows.find((r) => r.listing_status === "active") ?? null;
}

/** Newest eBay listing at ANY status — a draft counts, which is the point. */
export function ebayListing(rows: ItemListingRow[]): ItemListingRow | null {
  return rows.find((r) => r.platform === "ebay") ?? null;
}

/**
 * Listings carrying an unresolved delist or an oversell conflict. Both mean the
 * same garment can still be bought right now, so they are read across every
 * platform, not just eBay.
 */
export function flaggedListings(rows: ItemListingRow[]): ItemListingRow[] {
  return rows.filter((r) => {
    const pf = r.platform_fields ?? {};
    return Boolean(pf.delist_unresolved) || Boolean(pf.oversell_conflict);
  });
}
