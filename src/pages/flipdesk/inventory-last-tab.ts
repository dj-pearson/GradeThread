// The Inventory tab a seller was last on, remembered across page loads.
//
// The table used to open on the first stage tab whenever the URL carried no
// `?tab=`, and a bare URL is what most routes into it produce: the sidebar
// entry, the "Back to items" button on an item opened from a row (which passed
// no return location), the mobile tab bar. A seller working through the old
// Drafts tab opened one, came back, and was on To List again, every time.
//
// Explicit intent still wins. A `?tab=` or `?status=` in the URL is a request
// for that tab and is honoured before this value is consulted; this only
// decides what a URL that says nothing should mean, and "where I was" is the
// answer that matches what a seller expects from every other list they use.
//
// Storage is per browser, not per account. A tab is not a secret, and a shared
// machine opening on Sold rather than Unlisted is a shrug, not a leak.

import { TABS, resolveTabId, type TabId } from "./inventory-tabs";

export const INVENTORY_LAST_TAB_KEY = "flipdesk:inventory:last-tab";

function isTabId(value: unknown): value is TabId {
  return typeof value === "string" && TABS.some((t) => t.id === value);
}

/** The remembered tab, or null when nothing valid is stored. */
export function readLastInventoryTab(): TabId | null {
  try {
    const raw = window.localStorage.getItem(INVENTORY_LAST_TAB_KEY);
    return isTabId(raw) ? raw : null;
  } catch {
    // Private mode, a blocked storage API, or no window at all (prerender).
    return null;
  }
}

export function writeLastInventoryTab(tab: TabId): void {
  try {
    window.localStorage.setItem(INVENTORY_LAST_TAB_KEY, tab);
  } catch {
    // Same reasons as above; forgetting is the acceptable failure.
  }
}

/**
 * The tab the table should open on, in priority order: an explicit `?tab=`
 * (old ids like `to_list` and `drafts` included), a `?status=` deep link
 * already mapped to a tab, the remembered tab, Unlisted.
 */
export function initialInventoryTab(
  tabParam: string | null,
  tabFromStatus: TabId | null,
  remembered: TabId | null,
): TabId {
  const explicit = resolveTabId(tabParam);
  if (explicit) return explicit;
  if (tabFromStatus) return tabFromStatus;
  return remembered ?? "unlisted";
}
