import { DRAFT_LIKE_STATUSES, type TabId } from "@/pages/flipdesk/inventory-tabs";
import type { ItemStatus } from "@/types/database";

/**
 * Stage-tab badge counts from the server-side grouped status count (US-404).
 *
 * INV-11: `null` means "no number to show". That is every tab while the count
 * is loading or after it failed, and always the Aged tab, which is not a status
 * and so cannot be counted by status (US-3195). It used to be 0 on every tab
 * for that window, which reads as "this tab is empty" rather than "not known".
 */
export function tabCountsFrom(
  statusCounts: Record<string, number> | undefined,
): Record<TabId, number | null> {
  const unknown: Record<TabId, number | null> = {
    all: null,
    unlisted: null,
    aged: null,
    active: null,
    sold: null,
    shipped: null,
    returned: null,
    archived: null,
  };
  if (!statusCounts) return unknown;
  let all = 0;
  let unlisted = 0;
  for (const [st, n] of Object.entries(statusCounts)) {
    // US-1483: archived items are excluded from the All tab.
    if ((st as ItemStatus) !== "archived") all += n;
    if (DRAFT_LIKE_STATUSES.has(st as ItemStatus)) unlisted += n;
  }
  return {
    ...unknown,
    all,
    unlisted,
    active: statusCounts.listed ?? 0,
    sold: statusCounts.sold ?? 0,
    shipped: statusCounts.shipped ?? 0,
    returned: statusCounts.returned ?? 0,
    archived: statusCounts.archived ?? 0,
  };
}

/**
 * INV-11: whether the previous page's rows may stay on screen while the next
 * key loads. Position 3 of the listings page key is the tab (see
 * listingsPageKey in listings.tsx); rows from another tab must never stand in,
 * because each tab offers different actions on its rows.
 */
export function keepRowsAcrossKeys(
  prevKey: readonly unknown[] | undefined,
  nextKey: readonly unknown[],
): boolean {
  return !!prevKey && prevKey[3] === nextKey[3];
}
