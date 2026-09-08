import type { ItemFullRow } from "@/types/database";

// US-3195: what counts as aged, and what it has cost so far.
//
// FlipDesk has had the aging RULES for a long time — automations trigger on
// days_listed_gt, the repricing engine nudges on a stale age, scheduled
// markdowns discount old stock. It has never had the SCREEN. A seller could
// automate a markdown on dead stock and could not browse it, so the only thing
// that ever saw the death pile was a robot, and the seller met it at tax time
// in the COGS worksheet.
//
// PURE, so the definition of "aged" is testable and is the same one the tab
// predicate, the empty state and the bulk markdown all use.

/**
 * Days listed before an item is aged, when the seller has set nothing.
 *
 * Sixty days is two full sell-through cycles for most clothing categories and
 * is the number the repricing engine's own stale-age nudge already uses, so a
 * seller who has never opened the setting sees a list consistent with the
 * automation that was already acting on the same items.
 */
export const DEFAULT_AGED_THRESHOLD_DAYS = 60;

/** The setting's bounds, matching the CHECK in migration 00771. */
export const MIN_AGED_THRESHOLD_DAYS = 1;
export const MAX_AGED_THRESHOLD_DAYS = 3650;

const DAY_MS = 86_400_000;

/**
 * A stored threshold as a usable number of days.
 *
 * Out-of-range values fall back rather than being honoured: a row outside the
 * column's own CHECK was written by something that bypassed the constraint, and
 * a zero would mark every listing aged the moment it went live.
 */
export function agedThresholdDays(stored: number | null | undefined): number {
  if (stored == null || !Number.isFinite(stored)) return DEFAULT_AGED_THRESHOLD_DAYS;
  if (stored < MIN_AGED_THRESHOLD_DAYS || stored > MAX_AGED_THRESHOLD_DAYS) {
    return DEFAULT_AGED_THRESHOLD_DAYS;
  }
  return Math.floor(stored);
}

/**
 * How many days this item has been listed, or null when it never was.
 *
 * Null is not zero. A drafted item has not been listed for no days; it has not
 * been listed. It is never aged, and it never appears on this list.
 */
export function daysListed(
  item: Pick<ItemFullRow, "list_date">,
  now: number = Date.now(),
): number | null {
  if (!item.list_date) return null;
  const t = new Date(item.list_date).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / DAY_MS);
}

/**
 * Whether this item belongs on the aged list.
 *
 * Live and unsold only. A sold item that took 200 days to sell is a fact for
 * the analytics, not a thing to mark down; putting it here would fill the
 * screen with rows nothing can be done to.
 */
export function isAged(
  item: Pick<ItemFullRow, "list_date" | "status" | "sale_date">,
  thresholdDays: number = DEFAULT_AGED_THRESHOLD_DAYS,
  now: number = Date.now(),
): boolean {
  if (item.status !== "listed") return false;
  if (item.sale_date) return false;
  const days = daysListed(item, now);
  return days != null && days >= thresholdDays;
}

/**
 * What this item has cost so far, in dollars, or null when the cost is unknown.
 *
 * Acquisition only. Adding a share of the seller's time or storage would be a
 * number we cannot source, and the point of the column is to answer "how much
 * of my money is asleep in this", which the purchase price answers exactly.
 */
export function capitalTiedUp(
  item: Pick<ItemFullRow, "purchase_price">,
): number | null {
  const p = item.purchase_price;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

/** Total capital sitting in a set of aged rows. Unknown costs are skipped, not zeroed. */
export function totalCapitalTiedUp(
  items: readonly Pick<ItemFullRow, "purchase_price">[],
): { total: number; unknownCount: number } {
  let total = 0;
  let unknownCount = 0;
  for (const it of items) {
    const c = capitalTiedUp(it);
    if (c == null) unknownCount += 1;
    else total += c;
  }
  return { total, unknownCount };
}
