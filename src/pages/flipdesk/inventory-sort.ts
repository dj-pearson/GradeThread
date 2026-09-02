// Sort options for the Inventory table, one set per tab.
//
// Until now only To List had a sort menu (the four `SortPreset` values the
// server scores in SQL); every other tab ran in a fixed order the seller could
// change only by clicking a column header, and nothing on screen said which
// headers sorted. The menu here works on every tab. Most options are plain
// column sorts and ride the same `p_column_sort` argument a header click sends,
// so the server needs no new code for them; the three scored presets stay
// To List only, because `flipdesk_listing_page` only computes them there.
//
// The chosen option lives in `?sort=` so it survives a view-mode switch and a
// round trip through the composer. An id that does not apply to the current
// tab (a `best_roi` link opened on Sold) resolves to that tab's default rather
// than throwing or, worse, silently sorting by something else.

import type { ItemFullRow } from "@/types/database";
import type { TabId } from "./inventory-tabs";
import type { SortPreset } from "./listings-filter";

export interface ColumnSort {
  field: keyof ItemFullRow;
  dir: "asc" | "desc";
}

export type SortOptionId =
  | "default"
  // Scored on the server, To List only (migration 00515).
  | "listability"
  | "best_roi"
  | "highest_comp"
  // Plain column sorts.
  | "newest"
  | "oldest"
  | "recently_updated"
  | "least_recently_updated"
  | "title_az"
  | "brand_az"
  | "sku"
  | "price_high"
  | "price_low"
  | "cost_high"
  | "cost_low"
  | "longest_listed"
  | "most_views"
  | "most_watchers"
  | "oldest_sale"
  | "profit_high"
  | "profit_low";

export interface SortOption {
  id: SortOptionId;
  label: string;
  /** Sent as `p_sort_preset`; only honoured on To List. */
  preset?: SortPreset;
  /** Sent as `p_column_sort`. */
  column?: ColumnSort;
}

/**
 * The price column each tab means when it says "price". A To List item has a
 * target, a draft or live listing has a list price, and a sale has a sale
 * price; sorting To List by `list_price` would put every row at NULL.
 */
export function priceFieldForTab(tab: TabId): keyof ItemFullRow {
  switch (tab) {
    case "to_list":
      return "target_price";
    case "sold":
    case "shipped":
    case "returned":
      return "sale_price";
    default:
      return "list_price";
  }
}

const col = (field: keyof ItemFullRow, dir: "asc" | "desc"): ColumnSort => ({
  field,
  dir,
});

function priceOptions(tab: TabId): SortOption[] {
  const field = priceFieldForTab(tab);
  return [
    { id: "price_high", label: "Price: high to low", column: col(field, "desc") },
    { id: "price_low", label: "Price: low to high", column: col(field, "asc") },
  ];
}

const COST_OPTIONS: SortOption[] = [
  { id: "cost_high", label: "Cost: high to low", column: col("purchase_price", "desc") },
  { id: "cost_low", label: "Cost: low to high", column: col("purchase_price", "asc") },
];

const NAME_OPTIONS: SortOption[] = [
  { id: "title_az", label: "Title A to Z", column: col("item_title", "asc") },
  { id: "brand_az", label: "Brand A to Z", column: col("brand", "asc") },
  { id: "sku", label: "SKU", column: col("item_number", "asc") },
];

const NEWEST: SortOption = { id: "newest", label: "Newest added", column: col("created_at", "desc") };
const OLDEST: SortOption = { id: "oldest", label: "Oldest added", column: col("created_at", "asc") };
const RECENTLY_UPDATED: SortOption = {
  id: "recently_updated",
  label: "Recently updated",
  column: col("updated_at", "desc"),
};
const LEAST_RECENTLY_UPDATED: SortOption = {
  id: "least_recently_updated",
  label: "Untouched longest",
  column: col("updated_at", "asc"),
};

/**
 * The menu for one tab. The first entry is always that tab's default and
 * carries no column, so the server falls back to the order the tab has always
 * used (`flipdesk_listing_page`'s per-tab ORDER BY). Its label says what that
 * order is, so "Default" never reads as a mystery.
 */
export function sortOptionsForTab(tab: TabId): SortOption[] {
  switch (tab) {
    case "to_list":
      return [
        { id: "default", label: "Listability score", preset: "listability" },
        // `oldest` was a To List preset before it was a column sort. Keeping the
        // id means an existing `?sort=oldest` bookmark still means the same thing.
        OLDEST,
        { id: "best_roi", label: "Best ROI", preset: "best_roi" },
        { id: "highest_comp", label: "Highest comp", preset: "highest_comp" },
        LEAST_RECENTLY_UPDATED,
        RECENTLY_UPDATED,
        ...priceOptions(tab),
        ...COST_OPTIONS,
        ...NAME_OPTIONS,
      ];
    case "drafts":
      return [
        { id: "default", label: "Untouched longest" },
        RECENTLY_UPDATED,
        NEWEST,
        OLDEST,
        ...priceOptions(tab),
        ...COST_OPTIONS,
        ...NAME_OPTIONS,
      ];
    case "active":
      return [
        { id: "default", label: "Newest listing first" },
        { id: "longest_listed", label: "Longest listed first", column: col("list_date", "asc") },
        { id: "most_views", label: "Most views", column: col("listing_views", "desc") },
        { id: "most_watchers", label: "Most watchers", column: col("listing_watchers", "desc") },
        ...priceOptions(tab),
        ...COST_OPTIONS,
        ...NAME_OPTIONS,
      ];
    case "sold":
    case "shipped":
      return [
        { id: "default", label: "Most recent sale" },
        { id: "oldest_sale", label: "Oldest sale first", column: col("sale_date", "asc") },
        { id: "profit_high", label: "Profit: high to low", column: col("net_profit", "desc") },
        { id: "profit_low", label: "Profit: low to high", column: col("net_profit", "asc") },
        ...priceOptions(tab),
        ...COST_OPTIONS,
        ...NAME_OPTIONS,
      ];
    case "returned":
    case "archived":
      return [
        { id: "default", label: "Recently updated" },
        LEAST_RECENTLY_UPDATED,
        NEWEST,
        OLDEST,
        ...priceOptions(tab),
        ...NAME_OPTIONS,
      ];
    case "all":
    default:
      return [
        { id: "default", label: "Newest added" },
        OLDEST,
        RECENTLY_UPDATED,
        LEAST_RECENTLY_UPDATED,
        ...priceOptions(tab),
        ...COST_OPTIONS,
        ...NAME_OPTIONS,
      ];
  }
}

/**
 * The option a raw `?sort=` value names on this tab, or the tab's default when
 * the value is absent, unknown, or belongs to a different tab's menu.
 */
export function resolveSortOption(
  raw: string | null | undefined,
  tab: TabId,
): SortOption {
  const options = sortOptionsForTab(tab);
  const found = raw ? options.find((o) => o.id === raw) : undefined;
  return found ?? options[0]!;
}

/**
 * What to send to `flipdesk_listing_page` for an option.
 *
 * A clicked header wins over the menu, exactly as it did before the menu
 * existed on every tab. `preset` is always a valid `SortPreset` because the
 * server ignores it off To List and the query key needs a stable value.
 */
export function sortRequestFor(
  option: SortOption,
  headerSort: ColumnSort | null,
): { preset: SortPreset; columnSort: ColumnSort | null } {
  return {
    preset: option.preset ?? "listability",
    columnSort: headerSort ?? option.column ?? null,
  };
}
