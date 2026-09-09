// US-3208: the tab identity for the sold-and-shipping page.
//
// WHY THIS EXISTS. The page was a stack of seven cards, every one of them
// rendering its whole list at once. Measured on production before this change:
// 47,811 pixels of content in a 911-pixel window, which is FIFTY-TWO SCREENS.
// "Needs you" drew 215 rows with no paging, the ship queue began 14,487px down
// (screen 16), and payment disputes began at 43,966px (screen 48). 432 list
// items on one page.
//
// No single decision caused that. Each card was added by its own story and each
// was locally right — the note on the ship queue even reasoned that "a card
// matches its own idiom", which it does. Nobody measured the page afterwards,
// six times in a row.
//
// The fix is the one the inventory table already uses, and this module is
// deliberately shaped like inventory-tabs.ts: an id union, a `?tab=` value that
// survives a bookmark, and one section on screen at a time.
//
// Kept in its own module (not inside the heavy post-sale.tsx) so a test can
// import the mapping without dragging the whole page's component graph into
// coverage — the same reason inventory-tabs.ts is separate.

import type { NeedsYouItem, NeedsYouKind } from "@/pages/flipdesk/needs-you";

export type PostSaleTabId =
  | "ship"
  | "returns"
  | "cases"
  | "disputes"
  | "cancellations"
  | "insights";

export interface PostSaleTab {
  id: PostSaleTabId;
  label: string;
  /**
   * The Needs-You queues whose open items belong to this tab.
   *
   * This is what puts a number on the tab, and it is why the 215-row list at the
   * top of the page could go: a seller opened that list to find out WHERE the
   * work was, and a count on the tab answers the same question without rendering
   * two hundred rows to do it.
   *
   * Empty means no badge. Insights is a chart of what already happened, so a
   * count of things waiting on you would be meaningless there rather than zero.
   */
  kinds: readonly NeedsYouKind[];
}

/**
 * Ship leads because it is the only clock on this page that a marketplace
 * SCORES the seller on — a late shipment is a defect on the account, while a
 * slow return is only a slow return. The rest run most urgent first.
 */
export const POST_SALE_TABS: readonly PostSaleTab[] = [
  { id: "ship", label: "Ship", kinds: ["shipment"] },
  { id: "disputes", label: "Disputes", kinds: ["dispute"] },
  // Two queues, one tab. eBay files "case" and "item not received" separately;
  // a seller does not think of them as different jobs, and splitting them made
  // two cards that were each usually empty.
  { id: "cases", label: "Cases", kinds: ["case", "inquiry"] },
  { id: "returns", label: "Returns", kinds: ["return"] },
  { id: "cancellations", label: "Cancellations", kinds: ["cancellation"] },
  { id: "insights", label: "Insights", kinds: [] },
] as const;

export const DEFAULT_POST_SALE_TAB: PostSaleTabId = "ship";

/**
 * Anchors that still arrive in bookmarks and in links written before the tabs.
 *
 * The old page gave its cards DOM ids and linked to them with a hash, so
 * `#payment-disputes` is a real URL somebody may have saved. Each one maps to
 * the tab that now holds that card, so an old link lands on the work rather
 * than on a page that scrolls nowhere.
 */
const LEGACY_TAB_IDS: Readonly<Record<string, PostSaleTabId>> = {
  "payment-disputes": "disputes",
  "ebay-cases": "cases",
  inquiries: "cases",
  "item-not-received": "cases",
  returns: "returns",
  cancellations: "cancellations",
  "return-analytics": "insights",
  shipments: "ship",
  "ship-queue": "ship",
};

/** A `?tab=` (or legacy anchor) value as a current tab id, or null. */
export function resolvePostSaleTabId(
  raw: string | null | undefined,
): PostSaleTabId | null {
  if (!raw) return null;
  const key = raw.replace(/^#/, "");
  if (POST_SALE_TABS.some((t) => t.id === key)) return key as PostSaleTabId;
  return LEGACY_TAB_IDS[key] ?? null;
}

/**
 * A Needs-You kind's tab, or null when nothing on this page owns it.
 *
 * `offer` is the null case and stays null on purpose: offers are their own page
 * (/dashboard/flipdesk/offers), and quietly routing them here would put a
 * number on a tab that cannot show them.
 */
export function tabForKind(kind: NeedsYouKind): PostSaleTabId | null {
  return POST_SALE_TABS.find((t) => t.kinds.includes(kind))?.id ?? null;
}

export type PostSaleTabCounts = Record<PostSaleTabId, number>;

/**
 * How many open items each tab holds, from the merged Needs-You list.
 *
 * Counted off the SAME list the old ranked card rendered, so a badge can never
 * disagree with what the tab opens. A kind this page does not own is skipped
 * rather than dropped into a default bucket.
 */
export function postSaleTabCounts(items: NeedsYouItem[]): PostSaleTabCounts {
  const counts = Object.fromEntries(
    POST_SALE_TABS.map((t) => [t.id, 0]),
  ) as PostSaleTabCounts;
  for (const item of items) {
    const tab = tabForKind(item.kind);
    if (tab) counts[tab] += 1;
  }
  return counts;
}
