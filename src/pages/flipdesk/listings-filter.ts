// US-2178: the listings table's row-level decisions, lifted out of the page so
// they can be tested.
//
// Each of these was a closure or a module-private helper inside a 3,500-line
// component, which is why none of them had a test. They are small, but they are
// the rules that decide what a seller sees and — in the case of the demote
// planner — whether a LIVE marketplace listing gets quietly pulled out from
// under them. Behaviour is unchanged; only the address is.

import type { ItemFullRow } from "@/types/database";
import { evalQuery, type FilterQuery } from "@/lib/item-filter";
import { scoreListability, maxCompPrice } from "@/lib/listability";
import {
  matchesUnlistedFilter,
  type TabDef,
  type UnlistedFilter,
} from "@/pages/flipdesk/inventory-tabs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The columns the table's search box looks at.
 *
 * Mirrored in SQL by flipdesk_listing_page (00721); change both together and
 * re-run src/test/listing-page-sql-parity.test.ts. Size, color, category, bin
 * and the draft's own title were added 2026-09-02: "medium blue jeans" and
 * "bin 12" are how a seller actually looks for a garment, and none of them
 * matched before.
 */
const SEARCH_FIELDS = [
  "item_title",
  "listing_title",
  "brand",
  "style",
  "item_number",
  "container",
  "size",
  "color",
  "category",
  "location_bin",
] as const;

/**
 * Free-text search across the columns a seller can actually see on a row.
 *
 * Deliberately substring, not prefix: a reseller searching "nike" expects to
 * find "Vintage Nike Windbreaker". An empty query matches everything rather
 * than nothing — an empty box is not a filter.
 */
export function matchesSearch(it: ItemFullRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = SEARCH_FIELDS.map((f) => it[f] as unknown)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export type PayoutState = "pending" | "cleared" | "discrepancy";

/**
 * Where a sale's money stands.
 *
 * `discrepancy` is the one that matters: a payout landed, but the fees are more
 * than 20% of the sale price, which usually means a fee we did not expect (or a
 * partial refund) ate the margin. Flagging it is how a seller finds the sale
 * worth disputing instead of averaging it into their numbers.
 */
export function payoutState(it: ItemFullRow): PayoutState {
  if (it.payout != null && it.payout > 0) {
    if (
      it.sale_price != null &&
      it.sale_price > 0 &&
      it.fees != null &&
      it.fees > it.sale_price * 0.2
    ) {
      return "discrepancy";
    }
    return "cleared";
  }
  return "pending";
}

export type SoldFilter =
  | "all"
  | "awaiting_payout"
  | "discrepancy"
  | "d7"
  | "d30"
  | "ytd";

/**
 * The Sold tab's secondary filter.
 *
 * `now` is injected rather than read from the clock so the date windows are
 * testable — the reason the d7/d30/ytd boundaries had no coverage before.
 *
 * A row with NO sale date fails every date window. That is deliberate: showing
 * an undated sale under "Last 7 days" would put a row in a window nothing
 * placed it in.
 */
export function matchesSoldFilter(
  it: ItemFullRow,
  filter: SoldFilter,
  now: number,
): boolean {
  if (filter === "all") return true;
  if (filter === "awaiting_payout") return payoutState(it) === "pending";
  if (filter === "discrepancy") return payoutState(it) === "discrepancy";

  const soldAt = it.sale_date ? new Date(it.sale_date).getTime() : null;
  if (soldAt == null || Number.isNaN(soldAt)) return false;
  if (filter === "d7") return soldAt >= now - 7 * DAY_MS;
  if (filter === "d30") return soldAt >= now - 30 * DAY_MS;
  // Year to date, in the viewer's local year — the boundary a seller's tax year
  // actually uses.
  return soldAt >= new Date(new Date(now).getFullYear(), 0, 1).getTime();
}

export type DemotePlan =
  | { action: "none" }
  /** A genuinely live marketplace offer. The caller must tell the seller to End it. */
  | { action: "live" }
  | { action: "patch"; patch: { listing_status?: string; is_active: boolean } };

/**
 * Decide what happens to an item's LISTING row when the item moves back to a
 * draft-like status.
 *
 * The rule that carries all the weight: a live marketplace offer is never
 * silently demoted. Rewriting the local row would make FlipDesk show the item
 * as a draft while it is still listed and purchasable — the seller stops
 * watching a listing that can still sell, which is the same failure class as
 * US-2162's "ended locally" bug.
 *
 * Terminal listing states (sold, ended) are never rewound either: a sold
 * listing is a record, not a state to move.
 */
export function planListingDemote(it: ItemFullRow): DemotePlan {
  if (!it.listing_id || !it.listing_status) return { action: "none" };
  if (it.listing_status === "sold" || it.listing_status === "ended") {
    return { action: "none" };
  }
  // Active AND a real marketplace URL — the URL is what distinguishes a
  // published offer from a local row someone set to "active".
  if (it.listing_status === "active" && !!it.link) return { action: "live" };
  return {
    action: "patch",
    patch: it.listing_status === "draft"
      ? { is_active: false }
      : { listing_status: "draft", is_active: false },
  };
}

// ─── The whole row-selection pipeline (US-2168 AC5) ────────────────────────

/** The four preset sorts the Unlisted tab offers. */
export type SortPreset = "listability" | "oldest" | "best_roi" | "highest_comp";

/** Everything the table's row selection depends on, as data. */
export interface RowSelectionCriteria {
  tab: TabDef;
  search: string;
  /** The Sold tab's date window. Only consulted when `tab.id === "sold"`. */
  soldFilter: SoldFilter;
  /** The Unlisted tab's chip. Only consulted when `tab.id === "unlisted"`. */
  unlistedFilter: UnlistedFilter;
  /** Advanced FilterBuilder query. `rules: []` means "no advanced filter". */
  filterQuery: FilterQuery;
  /** A clicked column header. Wins over every preset when present. */
  columnSort: { field: keyof ItemFullRow; dir: "asc" | "desc" } | null;
  /** Only consulted on the Unlisted tab. */
  sortPreset: SortPreset;
  /** Injected so the Sold date windows are assertable. */
  now: number;
}

/**
 * US-2168 AC5 — the executable specification of what a listings tab shows.
 *
 * WHY THIS IS A FUNCTION AND NOT A useMemo. AC3 moves search, tab filtering and
 * sort to the server, and AC5 requires row-count parity against "the current
 * client-side behaviour so the migration can't silently change what a tab
 * shows". You cannot assert parity against a `useMemo` closed over a dozen
 * pieces of component state — there is nothing to call. So the harness has to
 * exist BEFORE the port, not after it, and this is that harness: the current
 * behaviour, callable, with a fixture corpus pinning it.
 *
 * That ordering is the whole point. Written afterwards, a parity test asserts
 * that the new implementation matches itself.
 *
 * Behaviour is unchanged from the inline version — this is a move, and the
 * tests that came with it are the first coverage this pipeline has ever had.
 *
 * NOTE FOR WHOEVER WRITES THE SQL. Four things here are easy to get subtly
 * wrong in a port, and each changes which rows a seller sees:
 *   • NULLS LAST in both directions. `null` sorts after everything regardless
 *     of direction, which is NOT what `ORDER BY x DESC` does in Postgres
 *     (it puts NULLs first). You want `NULLS LAST` explicitly on both.
 *   • Strings compare with `numeric: true`, so "10" follows "9". Plain
 *     `ORDER BY text` gives "10" before "9".
 *   • `sensitivity: "base"` means case- AND accent-insensitive. That is closer
 *     to a collation with a non-default strength than to `lower()`.
 *   • The predicates compose as AND in a fixed order, and the advanced filter
 *     applies LAST, on top of the tab and the search.
 */
export function selectListingRows(
  items: readonly ItemFullRow[],
  c: RowSelectionCriteria,
): ItemFullRow[] {
  const rows = items.filter((it) => {
    if (!c.tab.matches(it)) return false;
    if (!matchesSearch(it, c.search)) return false;
    if (c.tab.id === "sold" && !matchesSoldFilter(it, c.soldFilter, c.now)) {
      return false;
    }
    if (c.tab.id === "unlisted" && !matchesUnlistedFilter(it, c.unlistedFilter)) {
      return false;
    }
    // Composes on top of the stage tab + search + sold-window filter.
    if (c.filterQuery.rules.length > 0 && !evalQuery(it, c.filterQuery)) {
      return false;
    }
    return true;
  });

  // A clicked column beats every default sort — including the Unlisted preset —
  // so the seller always gets the column they asked for.
  if (c.columnSort) {
    return sortByField(rows, c.columnSort.field, c.columnSort.dir);
  }

  if (c.tab.id === "unlisted") {
    const scoreById = new Map<string, number>();
    for (const it of rows) scoreById.set(it.id, scoreListability(it).score);
    rows.sort((a, b) => {
      switch (c.sortPreset) {
        case "listability":
          return (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0);
        case "oldest": {
          const at = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
          return at - bt;
        }
        case "best_roi":
          return roiOf(b) - roiOf(a);
        case "highest_comp":
          return maxCompPrice(b) - maxCompPrice(a);
      }
    });
    return rows;
  }

  return sortByField(rows, c.tab.sortKey, c.tab.sortDir);
}

/** Return on cost, or -1 when there is no usable price to reason about. */
function roiOf(it: ItemFullRow): number {
  const price = it.target_price ?? it.list_price;
  const cost = it.purchase_price ?? 0;
  if (price == null || price <= 0) return -1;
  return (price - cost) / price;
}

/**
 * The shared comparator. Nulls sort LAST in both directions — a row missing the
 * value being sorted on is not "smallest", it is "unknown", and burying it is
 * what a seller expects either way.
 */
function sortByField(
  rows: ItemFullRow[],
  field: keyof ItemFullRow,
  dir: "asc" | "desc",
): ItemFullRow[] {
  const sign = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * sign;
    }
    // Natural sort, so "10" follows "9" rather than "1".
    return (
      String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * sign
    );
  });
  return rows;
}
