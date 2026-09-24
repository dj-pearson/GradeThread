// Plain names for the slugs an automation rule stores. A rule summary that
// reads "move the item to photographed" or "cross-list it to ebay" is the
// database talking, not the product.

import { ITEM_STATUS_LABELS, MARKETPLACE_LABELS } from "@/lib/constants";

/** "Photographed", not the "photographed" slug. Unknown values pass through. */
export function statusLabel(slug: unknown): string {
  const s = String(slug ?? "");
  return (ITEM_STATUS_LABELS as Record<string, string>)[s] ?? s;
}

/** "eBay", not "ebay". Unknown values pass through. */
export function platformLabel(slug: unknown): string {
  const s = String(slug ?? "");
  return (MARKETPLACE_LABELS as Record<string, string>)[s] ?? s;
}
