// US-1429: shared inventory-tab identity + the status→tab routing used by the
// triage table (listings.tsx) and asserted in unit tests. Kept in its own module
// (not inside the heavy listings.tsx component) so importing the mapping for a
// test doesn't drag the whole page module graph into coverage.

import type { ItemFullRow, ItemStatus } from "@/types/database";

// "Unlisted" replaced the To List and Drafts tabs (2026-09-02). They were one
// job, getting an item live, split at a step the seller rarely thinks about:
// whether a listing row had been written yet. The split moved the bulk
// buttons apart, sent a seller tabbing back and forth, and read as two queues
// when there was one. The statuses are unchanged; the chips below expose the
// same split as a filter inside the one tab, and the bulk bar follows the
// selection instead of the tab.
export type TabId =
  | "all"
  | "unlisted"
  | "active"
  | "sold"
  | "shipped"
  | "returned"
  | "archived";

/**
 * Old tab ids that still arrive in bookmarks, saved links and the mobile apps'
 * deep links. Both land on Unlisted with no chip: a To List bookmark carried
 * every drafted-or-earlier item, and so does Unlisted.
 */
const LEGACY_TAB_IDS: Readonly<Record<string, TabId>> = {
  to_list: "unlisted",
  drafts: "unlisted",
};

/** A `?tab=` value as a current tab id, or null when it names nothing. */
export function resolveTabId(raw: string | null | undefined): TabId | null {
  if (!raw) return null;
  if (TABS.some((t) => t.id === raw)) return raw as TabId;
  return LEGACY_TAB_IDS[raw] ?? null;
}

// The Overview pipeline grid, stat cards, and Kanban "+N more" links navigate to
// the inventory table with `?status=<stage>` (an item stage or a sale state), but
// the table keys its view off `?tab=`. Map a `status` param onto the tab that
// actually surfaces those items so those links land on the intended filtered
// view instead of the default tab. Returns null for an unrecognized value so the
// caller can fall back to the default.
export function statusParamToTab(status: string | null | undefined): TabId | null {
  if (!status) return null;
  switch (status) {
    case "all":
      return "all";
    case "listed":
      return "active";
    case "sold":
      return "sold";
    // US-2547: `completed` is an ITEM status (the last pipeline stage), and NO
    // tab predicate matches it — Sold is `status = 'sold'`. It used to route
    // here because the string also names a SALE state, so the Completed tile
    // counted items the destination could not show, and the count read as a
    // filter that had eaten every row. It lands on All (the only tab that
    // includes it) with a narrowing; the money card that meant the sale state
    // now names `?tab=sold` directly instead of borrowing this word.
    case "completed":
      return "all";
    case "shipped":
      return "shipped";
    case "returned":
      return "returned";
    // Every pre-listed stage, drafted included, is surfaced together under
    // Unlisted; the caller adds a status filter so the link means one stage.
    case "sourced":
    case "acquired":
    case "cataloged":
    case "measured":
    case "photographed":
    case "grading":
    case "graded":
    case "comped":
    case "drafted":
      return "unlisted";
    // US-1483: archived items have their own tab (and are excluded from All).
    case "archived":
      return "archived";
    default:
      return null;
  }
}


// ── US-2178: the tab predicates, moved out of the 3,581-line page ──────────
//
// These decide which rows each tab shows and how they sort. They used to be
// module-level consts inside listings.tsx, where nothing could reach them, so
// the rules that determine what a seller sees on every tab had no unit tests.
// The page imports them from here now; behaviour is unchanged.

/**
 * Every prep stage before a draft exists. These are the Unlisted rows that
 * still need a listing written ("Needs draft"); `drafted` is the rest.
 */
export const TO_LIST_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  // US-1429: `grading` (mid-grade) is a pre-listed prep stage too — include it
  // so an item being graded isn't stranded out of the queue (and so an Overview
  // "?status=grading" deep-link lands on a tab that actually shows it).
  "grading",
  "graded",
  "comped",
]);

/**
 * Item statuses that mean "being prepped / drafted, not on a marketplace".
 * Moving an item here should also demote a LOCAL listing row so the composer's
 * live-listing test and the tabs don't desync (item shows as a draft while its
 * listing still says active). This is also exactly what the Unlisted tab shows.
 */
export const DRAFT_LIKE_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  ...TO_LIST_STATUSES,
  "drafted",
]);

/**
 * Stages a tab folds in with others, so a `?status=` deep link to one needs a
 * narrowing filter on top of the tab (US-2547).
 *
 * The nine Unlisted stages share one tab, and `completed` only appears inside
 * All. Every other stage IS its own tab, where a filter rule would be a chip
 * that removes nothing.
 */
const FOLDED_STAGE_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  ...DRAFT_LIKE_STATUSES,
  "completed",
]);

/**
 * The stage a `?status=` deep link asked for, when its tab shows more than it.
 *
 * Overview's pipeline grid says "click a stage to see the items in it" and links
 * `?status=measured`. Without this the click landed on every unlisted item — a
 * tile reading "Measured 12" opening a list of 200. The caller turns this into a
 * `status eq <stage>` rule on top of the tab, which is a filter the seller can
 * see and clear.
 */
export function stageFilterStatusFromParam(
  status: string | null | undefined,
): ItemStatus | null {
  if (!status) return null;
  return FOLDED_STAGE_STATUSES.has(status as ItemStatus)
    ? (status as ItemStatus)
    : null;
}

// ── The Unlisted tab's chips ────────────────────────────────────────────────
//
// The same split the two old tabs made, as a filter the seller can see. It
// lives in `?show=` so it survives a trip through the composer and a view-mode
// switch, and the server applies it inside flipdesk_listing_page (00721) so the
// page and its count agree.

export const UNLISTED_FILTERS = [
  "all",
  "needs_draft",
  "ready",
  "needs_review",
] as const;
export type UnlistedFilter = (typeof UNLISTED_FILTERS)[number];

export const UNLISTED_FILTER_LABELS: Readonly<Record<UnlistedFilter, string>> = {
  all: "All",
  needs_draft: "Needs draft",
  ready: "Ready to publish",
  needs_review: "Needs review",
};

export function resolveUnlistedFilter(
  raw: string | null | undefined,
): UnlistedFilter {
  return UNLISTED_FILTERS.includes(raw as UnlistedFilter)
    ? (raw as UnlistedFilter)
    : "all";
}

/**
 * Whether an Unlisted row passes the chip. Only meaningful for rows the tab
 * already matches; "Ready" and "Needs review" split `drafted` on the AI's
 * review flag (US-1569), and a draft with no flag recorded counts as ready.
 */
export function matchesUnlistedFilter(
  it: ItemFullRow,
  filter: UnlistedFilter,
): boolean {
  switch (filter) {
    case "needs_draft":
      return TO_LIST_STATUSES.has(it.status);
    case "ready":
      return it.status === "drafted" && !it.listing_needs_review;
    case "needs_review":
      return it.status === "drafted" && it.listing_needs_review === true;
    default:
      return true;
  }
}

export interface TabDef {
  id: TabId;
  label: string;
  matches: (it: ItemFullRow) => boolean;
  sortKey: keyof ItemFullRow;
  sortDir: "asc" | "desc";
  emptyCta: { label: string; to: string };
}

export const TABS: TabDef[] = [
  {
    id: "all",
    label: "All",
    // US-1483: exclude archived items so archived inventory isn't permanently
    // mixed into the active list — they have their own Archived tab.
    matches: (it) => it.status !== "archived",
    sortKey: "created_at",
    sortDir: "desc",
    emptyCta: { label: "Add item", to: "/dashboard/flipdesk/intake" },
  },
  {
    id: "unlisted",
    label: "Unlisted",
    matches: (it) => DRAFT_LIKE_STATUSES.has(it.status),
    // The default order on this tab is the listability preset, applied by the
    // server and by selectListingRows; this pair is the fallback the other
    // tabs use and is what a client-side consumer without presets gets.
    sortKey: "updated_at",
    sortDir: "asc",
    emptyCta: { label: "Add item", to: "/dashboard/flipdesk/intake" },
  },
  {
    id: "active",
    label: "Active",
    matches: (it) => it.status === "listed",
    sortKey: "list_date",
    sortDir: "desc",
    emptyCta: { label: "View unlisted items", to: "?tab=unlisted" },
  },
  {
    id: "sold",
    label: "Sold",
    // US-1451: a refunded/cancelled sale is no longer revenue — exclude it from
    // the Sold view + its aggregates even if the item's status restore lagged
    // (the edge return/cancel flow moves the item to 'returned' too).
    matches: (it) =>
      it.status === "sold" &&
      it.sale_status !== "refunded" &&
      it.sale_status !== "cancelled",
    sortKey: "sale_date",
    sortDir: "desc",
    emptyCta: { label: "View active listings", to: "?tab=active" },
  },
  {
    id: "shipped",
    label: "Shipped",
    matches: (it) => it.status === "shipped",
    sortKey: "sale_date",
    sortDir: "desc",
    emptyCta: { label: "View sold items", to: "?tab=sold" },
  },
  {
    id: "returned",
    label: "Returned",
    matches: (it) => it.status === "returned",
    sortKey: "updated_at",
    sortDir: "desc",
    emptyCta: { label: "View completed", to: "?tab=all" },
  },
  {
    // US-1483: dedicated home for archived items (previously only visible mixed
    // into All). Personal keeping/wearing items still live in All.
    id: "archived",
    label: "Archived",
    matches: (it) => it.status === "archived",
    sortKey: "updated_at",
    sortDir: "desc",
    emptyCta: { label: "View all items", to: "?tab=all" },
  },
];
