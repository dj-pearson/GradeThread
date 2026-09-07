// US-3132/US-3133: the arithmetic behind the resale supply index.
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT. eBay's sold-price API is ungranted
// on this account (see isMarketplaceInsightsEnabled in ebay-client.ts), so we
// cannot count what sold or for how much. We CAN count what is listed, because
// Browse returns `total` on every search and searchBrowseComps already reads
// it. So this file is about SUPPLY. Nothing built on it may say "sales are
// down"; it may only say "listings rose", which is a different claim and the
// only one the data supports.
//
// Everything here is pure. The cron route owns eBay and the database; the
// decisions that are easy to get quietly wrong -- how big a pass may be, when a
// median is too thin to state -- live here where a unit test can pin them with
// no network and no stack.

import { normalizeItemKey } from "./condition-item-key.ts";

/**
 * Below this many asking prices the median is a number with no distribution
 * behind it. Mirrors MIN_SOLD_COMPS in sold-comps.ts and MIN_VALUE_COMPS in
 * condition-value.ts, for the same reason: a median of two is not a median.
 */
export const MIN_PRICE_SAMPLE = 5;

/**
 * The fraction of eBay's REMAINING Browse allowance one pass may spend.
 *
 * Not a round number chosen for looks. The style-code discovery crawl already
 * spends about 252 Browse calls a night out of the same app-level allowance
 * that the comps ladder and the seller Add flow draw on
 * (DEFAULT_BRANDS_PER_RUN in style-code-discovery.ts states the arithmetic).
 * This index is the least urgent of the four: a seller waiting on comps in the
 * Add flow is blocked, and a supply trend that skips a night is not. So it
 * takes a minority share and yields first.
 */
export const HEADROOM_FRACTION = 0.25;

/**
 * What one pass may spend when eBay has told us nothing.
 *
 * A missing snapshot is not permission to run at full size. It means the limits
 * cron has not reported yet, and the honest response to not knowing the ceiling
 * is a small pass that says so, not a full one that assumes the best.
 */
export const NO_SNAPSHOT_BATCH = 25;

/** A cell is one market we measure: a brand, a category and a search term. */
export interface SupplyCell {
  cellKey: string;
  marketplace: string;
  brandKey: string | null;
  /** The brand as eBay spells it, for the Browse `Brand` aspect. Null on a
   *  category-only cell. */
  brandDisplay: string | null;
  categoryId: string;
  queryTerms: string | null;
}

export interface CellSeed {
  brandKey?: string | null;
  brandDisplay?: string | null;
  categoryId: string;
  queryTerms?: string | null;
  marketplace?: string;
}

/**
 * Build cells from seeds, deduped on the cell key.
 *
 * THE KEY IS normalizeItemKey's, NOT A NEW ONE. condition-index.ts,
 * comp_condition_reads and condition_value_shadow_samples all key their market
 * cells with it. A supply row that used its own spelling would sit next to
 * those tables unable to join to any of them, which would cost us the one
 * sentence this index exists to say: supply rose while asking prices fell.
 *
 * Marketplace is NOT in the key, for the same reason it is not in
 * normalizeItemKey: it is a column, and folding it into the key would break
 * that join on the day a second marketplace is added.
 */
export function expandCells(seeds: readonly CellSeed[]): SupplyCell[] {
  const byKey = new Map<string, SupplyCell>();
  for (const seed of seeds) {
    const brandDisplay = seed.brandDisplay?.trim() || null;
    const cellKey = normalizeItemKey({
      categoryId: seed.categoryId,
      brand: brandDisplay,
      q: seed.queryTerms ?? null,
    });
    // A seed with no category is not a cell: eBay refuses an aspect_filter with
    // no category scope, so a brand cell without one silently becomes a
    // keyword search that happens to mention the brand.
    if (seed.categoryId.trim() === "") continue;
    if (byKey.has(cellKey)) continue;
    byKey.set(cellKey, {
      cellKey,
      marketplace: seed.marketplace ?? "ebay",
      brandKey: seed.brandKey?.trim() || null,
      brandDisplay,
      categoryId: seed.categoryId.trim(),
      queryTerms: seed.queryTerms?.trim() || null,
    });
  }
  return [...byKey.values()];
}

/**
 * Median asking price in cents, or null when the sample is too thin to state.
 *
 * Returns the count alongside it so the caller can record how thin "too thin"
 * was. A row saying `median null, sample 3` is a measurement; a row saying
 * `median null` with no count is an unexplained blank.
 */
export function medianAskCents(
  pricesCents: readonly number[],
): { median: number | null; sampleSize: number } {
  const usable = pricesCents
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (usable.length < MIN_PRICE_SAMPLE) {
    return { median: null, sampleSize: usable.length };
  }
  const mid = Math.floor(usable.length / 2);
  const median = usable.length % 2 === 1
    ? usable[mid]!
    : Math.round((usable[mid - 1]! + usable[mid]!) / 2);
  return { median, sampleSize: usable.length };
}

export interface HeadroomSnapshot {
  /** eBay's own statement of calls left in the window. */
  remaining: number | null;
}

export interface PassSize {
  cells: number;
  /** Why it is this size. Goes straight into the cron's response body. */
  basis: "headroom" | "no_snapshot" | "all_cells";
}

/**
 * How many cells this pass may touch.
 *
 * Three outcomes, and the caller reports which: the full list when the
 * allowance covers it, a fraction of eBay's remaining allowance when it does
 * not, and a small fixed batch when eBay has not told us. Never more than there
 * are cells, and never negative on a snapshot that reports a remaining of zero.
 */
export function passSizeFromHeadroom(
  snapshot: HeadroomSnapshot | null,
  cellCount: number,
  fraction: number = HEADROOM_FRACTION,
): PassSize {
  if (cellCount <= 0) return { cells: 0, basis: "all_cells" };
  const remaining = snapshot?.remaining;
  if (remaining == null || !Number.isFinite(remaining)) {
    return { cells: Math.min(NO_SNAPSHOT_BATCH, cellCount), basis: "no_snapshot" };
  }
  const budget = Math.max(0, Math.floor(remaining * fraction));
  if (budget >= cellCount) return { cells: cellCount, basis: "all_cells" };
  return { cells: budget, basis: "headroom" };
}
