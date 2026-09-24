import type { ItemFullRow } from "@/types/database";

/**
 * INV-7: the selected rows, from the page PLUS every row remembered from other
 * pages (US-3467's actionItems), in selection order.
 *
 * The bulk dialogs used to resolve ids with `items.find` over the current page
 * only, so with 150 selected across three pages, Reprice acted on the 50 in
 * view while the bar said 150.
 */
export function selectedRowsFrom(
  actionItems: readonly ItemFullRow[],
  selected: ReadonlySet<string>,
): ItemFullRow[] {
  const byId = new Map(actionItems.map((r) => [r.id, r]));
  const out: ItemFullRow[] = [];
  for (const id of selected) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

/** The listing ids behind a set of selected rows; rows with no listing drop out. */
export function listingIdsOf(rows: readonly ItemFullRow[]): string[] {
  return rows.map((r) => r.listing_id).filter((v): v is string => !!v);
}
