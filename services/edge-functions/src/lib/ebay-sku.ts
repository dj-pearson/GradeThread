// US-1999 — the eBay Inventory SKU is IDENTITY, not a display field.
//
// eBay's Inventory API addresses an item BY SKU: createOrReplaceInventoryItem,
// createOffer, listOffersForSku, deleteInventoryItem and the item-group calls
// all key off it. GradeThread used to DERIVE that key at three separate call
// sites from `inventory_items.sku` — a column the seller can freely edit in the
// item canvas. Renaming the SKU of an item with a live listing therefore made
// every later Inventory call address a key eBay had never heard of: the revise
// silently created a NEW orphan inventory item while the offer-id-keyed calls
// still hit the real offer, i.e. a split-brain listing.
//
// The fix is to treat the SKU we actually published under as listing state:
// `listings.inventory_sku` is written at publish and is AUTHORITATIVE for every
// later call. `deriveInventorySku` is only for minting a SKU for something that
// has never been published.
//
// The derivation rule is duplicated in SQL by the 00477 backfill
// (`coalesce(nullif(trim(i.sku), ''), 'FD-' || left(i.id::text, 8))`). Keep the
// two in lockstep — `ebay-sku_test.ts` pins the shape so a change here is at
// least visible.

/** An item as far as SKU derivation is concerned. */
export interface SkuItemLike {
  id: string;
  sku?: string | null;
}

/** A listing row as far as SKU resolution is concerned. */
export interface SkuListingLike {
  inventory_sku?: string | null;
}

/**
 * Mint the SKU for an item that has never been published.
 *
 * Prefers the seller's own item number; falls back to a stable id-derived key so
 * an item with no SKU can still be published. NOT for addressing an existing
 * listing — use {@link resolveInventorySku} for that.
 */
export function deriveInventorySku(item: SkuItemLike): string {
  const own = item.sku?.trim();
  return own ? own : `FD-${item.id.slice(0, 8)}`;
}

/**
 * The SKU eBay actually holds this listing under.
 *
 * The stored value wins unconditionally — including when it disagrees with
 * today's `item.sku`, which is exactly the case this function exists for. Only
 * a listing that predates the stored column (or was never published) falls back
 * to the derivation, which reproduces what that listing was published under
 * UNLESS the item's SKU was edited in between; such rows are already mismatched
 * and no local data can recover the true value (see 00477's backfill note).
 */
export function resolveInventorySku(
  listing: SkuListingLike | null | undefined,
  item: SkuItemLike,
): string {
  const stored = listing?.inventory_sku?.trim();
  return stored ? stored : deriveInventorySku(item);
}
