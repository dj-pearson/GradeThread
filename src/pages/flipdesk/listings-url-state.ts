import type { ItemFullRow } from "@/types/database";
import type { SoldFilter } from "@/pages/flipdesk/listings-filter";
import type { ColumnSort } from "@/pages/flipdesk/inventory-sort";

// INV-12: the Inventory table's remaining view state, parsed from the URL.
//
// The Sold window and a clicked column header were useState, so a trip into an
// item and back reset both, and the header sort leaked from one tab to the
// next. They live in `?window=` and `?col=field:dir` now, next to the tab,
// sort, search and page that already did.


/**
 * Every column the desktop table offers as a sortable header. A `?col=` naming
 * anything else is ignored, so a hand-edited URL cannot send an arbitrary field
 * to the server's ORDER BY. A test keeps this in step with listings-table.tsx.
 */
export const SORTABLE_HEADER_FIELDS: ReadonlySet<string> = new Set([
  "brand",
  "carrier",
  "delivered_at",
  "floor_price",
  "item_number",
  "item_title",
  "list_date",
  "list_price",
  "listing_views",
  "listing_watchers",
  "net_profit",
  "notes",
  "payout",
  "purchase_price",
  "quality_score",
  "sale_price",
  "sourced_by",
  "status",
  "target_price",
  "tracking",
  "updated_at",
]);

/** `?col=field:dir` to a header sort, or null when absent or not allowed. */
export function parseHeaderSort(raw: string | null | undefined): ColumnSort | null {
  const m = /^([a-z_]+):(asc|desc)$/.exec((raw ?? "").trim());
  if (!m || !SORTABLE_HEADER_FIELDS.has(m[1]!)) return null;
  return { field: m[1] as keyof ItemFullRow, dir: m[2] as "asc" | "desc" };
}

export function formatHeaderSort(sort: ColumnSort | null): string {
  return sort ? `${String(sort.field)}:${sort.dir}` : "";
}

/** The header's three-click cycle: asc, desc, then off. */
export function nextHeaderSort(
  prev: ColumnSort | null,
  field: keyof ItemFullRow,
): ColumnSort | null {
  if (prev && prev.field === field) return prev.dir === "asc" ? { field, dir: "desc" } : null;
  return { field, dir: "asc" };
}

const SOLD_WINDOWS: readonly SoldFilter[] = [
  "all",
  "awaiting_payout",
  "discrepancy",
  "d7",
  "d30",
  // The overview's 90-day range links here, so the Sold tab has to be able to
  // show the same window the tile counted.
  "d90",
  "ytd",
];

/** `?window=` to a Sold window; anything unknown is "all". */
export function resolveSoldWindow(raw: string | null | undefined): SoldFilter {
  return (SOLD_WINDOWS as readonly string[]).includes(raw ?? "") ? (raw as SoldFilter) : "all";
}
