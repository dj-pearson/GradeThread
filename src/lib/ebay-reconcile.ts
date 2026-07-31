// Reconciliation between imported eBay listings and FlipDesk inventory.
// The match key is eBay's "Custom label (SKU)" ⇄ the FlipDesk SKU. In the
// items_full view the SKU is surfaced as `item_number` (it is literally
// inventory_items.sku), so that is what we match against.

import type { EbayListingRow, ItemFullRow } from "@/types/database";
import { normalizeSku } from "@/lib/ebay-csv";

// US-2188: reconciliation reads five scalars off an inventory row, so it is
// typed on that minimum instead of the whole 61-column ItemFullRow. The
// generic keeps the buckets carrying whatever row shape the caller passed in
// (full row or the projected list row), so callers lose no fields.
export type ItemMatchFields = Pick<
  ItemFullRow,
  "id" | "item_number" | "item_title" | "status" | "listed"
>;

export interface MatchedPair<T extends ItemMatchFields = ItemFullRow> {
  listing: EbayListingRow;
  item: T;
}

export interface UnmatchedListing<T extends ItemMatchFields = ItemFullRow> {
  listing: EbayListingRow;
  /**
   * A likely FlipDesk item even though SKUs don't line up — matched on an
   * identical listing title. Lets the user resolve a mismatch in one click.
   */
  suggestion: T | null;
  reason: "no_custom_label" | "sku_not_found";
}

export interface ReconcileBuckets<T extends ItemMatchFields = ItemFullRow> {
  matched: MatchedPair<T>[];
  unmatched: UnmatchedListing<T>[];
  ignored: EbayListingRow[];
  /** FlipDesk items marked listed that no imported eBay listing accounts for. */
  listedNotOnEbay: T[];
}

function normalizeTitle(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function reconcile<T extends ItemMatchFields>(
  listings: EbayListingRow[],
  items: T[],
): ReconcileBuckets<T> {
  const itemById = new Map<string, T>();
  const itemBySku = new Map<string, T>();
  const itemByTitle = new Map<string, T>();
  for (const it of items) {
    itemById.set(it.id, it);
    const sku = normalizeSku(it.item_number);
    if (sku) itemBySku.set(sku, it);
    const title = normalizeTitle(it.item_title);
    if (title && !itemByTitle.has(title)) itemByTitle.set(title, it);
  }

  const matched: MatchedPair<T>[] = [];
  const unmatched: UnmatchedListing<T>[] = [];
  const ignored: EbayListingRow[] = [];
  const accountedItemIds = new Set<string>();

  for (const listing of listings) {
    if (listing.match_status === "ignored") {
      ignored.push(listing);
      continue;
    }

    const explicit = listing.matched_item_id
      ? itemById.get(listing.matched_item_id)
      : undefined;
    const label = normalizeSku(listing.custom_label);
    const bySku = label ? itemBySku.get(label) : undefined;
    const item = explicit ?? bySku;

    if (item) {
      matched.push({ listing, item });
      accountedItemIds.add(item.id);
      continue;
    }

    const suggestion = itemByTitle.get(normalizeTitle(listing.title)) ?? null;
    unmatched.push({
      listing,
      suggestion,
      reason: label ? "sku_not_found" : "no_custom_label",
    });
  }

  const listedNotOnEbay = items.filter(
    (it) => (it.status === "listed" || it.listed) && !accountedItemIds.has(it.id),
  );

  return { matched, unmatched, ignored, listedNotOnEbay };
}

/**
 * Computes the match for a freshly-imported listing against current
 * inventory, before any manual linking. Used at import time so rows land in
 * the right bucket immediately.
 */
export function autoMatch(
  customLabel: string | null,
  itemsBySku: Map<string, string>,
): { matched_item_id: string | null; match_status: "matched" | "unmatched" } {
  const sku = normalizeSku(customLabel);
  const itemId = sku ? itemsBySku.get(sku) : undefined;
  return itemId
    ? { matched_item_id: itemId, match_status: "matched" }
    : { matched_item_id: null, match_status: "unmatched" };
}
