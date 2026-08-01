// US-2178: the listings table's row-level decisions, lifted out of the page so
// they can be tested.
//
// Each of these was a closure or a module-private helper inside a 3,500-line
// component, which is why none of them had a test. They are small, but they are
// the rules that decide what a seller sees and — in the case of the demote
// planner — whether a LIVE marketplace listing gets quietly pulled out from
// under them. Behaviour is unchanged; only the address is.

import type { ItemFullRow } from "@/types/database";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The columns the table's search box looks at. */
export const SEARCH_FIELDS = [
  "item_title",
  "brand",
  "style",
  "item_number",
  "container",
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
