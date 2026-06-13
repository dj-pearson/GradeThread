// Pure analytics helpers over the items_full view. No data fetching here —
// callers pass the cached ItemFullRow[] and a date range.

import type { ItemFullRow } from "@/types/database";

export type GroupKey = "category" | "brand" | "source";

export interface DateRange {
  from: string | null; // yyyy-mm-dd inclusive
  to: string | null; // yyyy-mm-dd inclusive
}

function inRange(date: string | null, range: DateRange): boolean {
  if (!date) return false;
  const d = date.slice(0, 10);
  if (range.from && d < range.from) return false;
  if (range.to && d > range.to) return false;
  return true;
}

// True when a date passes the range, or has no range bound to fail against.
function inRangeOrOpen(date: string | null, range: DateRange): boolean {
  if (!date) return false;
  return inRange(date, range);
}

function groupValue(item: ItemFullRow, key: GroupKey): string {
  if (key === "category") return item.category?.trim() || "Uncategorized";
  if (key === "brand") return item.brand?.trim() || "No brand";
  return item.source_name?.trim() || "No source";
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? null;
}

export interface SellThroughRow {
  group: string;
  listed: number;
  sold: number;
  sellThrough: number | null; // 0..1, null when nothing listed
  avgNetProfit: number | null;
  medianDaysToSell: number | null;
}

/**
 * Sell-through and profit, grouped by category / brand / source.
 * "Listed" = the item has a list date in range; "sold" = a sale date in range.
 */
export function sellThroughByGroup(
  items: ItemFullRow[],
  key: GroupKey,
  range: DateRange,
): SellThroughRow[] {
  const acc = new Map<
    string,
    { listed: number; sold: number; profit: number[]; days: number[] }
  >();

  for (const it of items) {
    const listedHit = inRangeOrOpen(it.list_date, range);
    const soldHit = inRangeOrOpen(it.sale_date, range);
    if (!listedHit && !soldHit) continue;

    const g = groupValue(it, key);
    const row =
      acc.get(g) ?? { listed: 0, sold: 0, profit: [], days: [] };
    if (listedHit) row.listed += 1;
    if (soldHit) {
      row.sold += 1;
      if (it.net_profit != null && Number.isFinite(it.net_profit)) {
        row.profit.push(it.net_profit);
      }
      if (it.days_to_sell != null && Number.isFinite(it.days_to_sell)) {
        row.days.push(it.days_to_sell);
      }
    }
    acc.set(g, row);
  }

  return Array.from(acc.entries())
    .map(([group, r]) => ({
      group,
      listed: r.listed,
      sold: r.sold,
      sellThrough: r.listed > 0 ? r.sold / r.listed : null,
      avgNetProfit: mean(r.profit),
      medianDaysToSell: median(r.days),
    }))
    .sort((a, b) => b.sold - a.sold || b.listed - a.listed);
}

// ─── Grading ROI ─────────────────────────────────────────────────

export const PRICE_BANDS = [
  { label: "Under $50", min: 0, max: 50 },
  { label: "$50–150", min: 50, max: 150 },
  { label: "$150+", min: 150, max: Infinity },
] as const;

export type PriceBandLabel = (typeof PRICE_BANDS)[number]["label"];

function bandFor(price: number): PriceBandLabel {
  for (const b of PRICE_BANDS) {
    if (price >= b.min && price < b.max) return b.label;
  }
  return "$150+";
}

export interface RoiSide {
  count: number;
  avgNetProfit: number | null;
  avgSalePrice: number | null;
  medianDaysToSell: number | null;
}

export interface RoiBucket {
  category: string;
  band: PriceBandLabel;
  graded: RoiSide;
  ungraded: RoiSide;
  /** Graded avg net profit minus ungraded avg net profit. */
  netProfitLift: number | null;
  /** Both sides have >= MIN_BUCKET_SIZE items. */
  meaningful: boolean;
}

export const MIN_BUCKET_SIZE = 5;

function sideStats(items: ItemFullRow[]): RoiSide {
  const profit = items
    .map((i) => i.net_profit)
    .filter((n): n is number => n != null && Number.isFinite(n));
  const price = items
    .map((i) => i.sale_price)
    .filter((n): n is number => n != null && Number.isFinite(n));
  const days = items
    .map((i) => i.days_to_sell)
    .filter((n): n is number => n != null && Number.isFinite(n));
  return {
    count: items.length,
    avgNetProfit: mean(profit),
    avgSalePrice: mean(price),
    medianDaysToSell: median(days),
  };
}

/**
 * Compares graded vs ungraded sold items, bucketed by garment category and
 * sale-price band. Buckets where either side is too small to be meaningful
 * are still returned, flagged `meaningful: false`.
 */
export function gradingRoiBuckets(items: ItemFullRow[]): RoiBucket[] {
  const sold = items.filter(
    (i) => i.sale_price != null && Number.isFinite(i.sale_price),
  );

  const acc = new Map<
    string,
    {
      category: string;
      band: PriceBandLabel;
      graded: ItemFullRow[];
      ungraded: ItemFullRow[];
    }
  >();

  for (const it of sold) {
    const category = it.category?.trim() || "Uncategorized";
    const band = bandFor(it.sale_price as number);
    const k = `${category}|||${band}`;
    const row =
      acc.get(k) ?? { category, band, graded: [], ungraded: [] };
    if (it.grade_value != null) row.graded.push(it);
    else row.ungraded.push(it);
    acc.set(k, row);
  }

  const bandOrder = PRICE_BANDS.map((b) => b.label);

  return Array.from(acc.values())
    .map((r) => {
      const graded = sideStats(r.graded);
      const ungraded = sideStats(r.ungraded);
      const lift =
        graded.avgNetProfit != null && ungraded.avgNetProfit != null
          ? graded.avgNetProfit - ungraded.avgNetProfit
          : null;
      return {
        category: r.category,
        band: r.band,
        graded,
        ungraded,
        netProfitLift: lift,
        meaningful:
          graded.count >= MIN_BUCKET_SIZE &&
          ungraded.count >= MIN_BUCKET_SIZE,
      };
    })
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        bandOrder.indexOf(a.band) - bandOrder.indexOf(b.band),
    );
}

// ─── Grade-ROI estimate (intake / item detail) ───────────────────

export interface GradeRoiEstimate {
  category: string;
  /** The price band the estimate is pinned to, or null when aggregated. */
  band: PriceBandLabel | null;
  graded: RoiSide;
  ungraded: RoiSide;
  /** graded.avgSalePrice − ungraded.avgSalePrice; positive = graded sells higher. */
  priceLift: number | null;
  /** ungraded.medianDaysToSell − graded.medianDaysToSell; positive = graded sells faster. */
  daysFaster: number | null;
  /** Both sides have >= MIN_BUCKET_SIZE sold items — safe to surface. */
  meaningful: boolean;
}

export interface GradeRoiQuery {
  category: string | null | undefined;
  /** Optional sale-price hint (target/list/comp) to pin a specific band. */
  priceHint?: number | null;
}

/**
 * Single-category grade-vs-ungraded lift estimate for the intake / item-detail
 * "grade this -> +$X" recommendation. Same sold-item comparison as
 * {@link gradingRoiBuckets} but collapsed to one category (optionally one price
 * band), reusing the shared `sideStats`/`bandFor`/MIN_BUCKET_SIZE helpers.
 * Returns null when the category has no sold history at all; callers should
 * additionally suppress display unless `meaningful` is true (low-n guard).
 */
export function gradeRoiEstimate(
  items: ItemFullRow[],
  query: GradeRoiQuery,
): GradeRoiEstimate | null {
  const category = query.category?.trim() || "Uncategorized";
  const band =
    query.priceHint != null && Number.isFinite(query.priceHint)
      ? bandFor(query.priceHint)
      : null;

  const sold = items.filter((i) => {
    if (i.sale_price == null || !Number.isFinite(i.sale_price)) return false;
    const cat = i.category?.trim() || "Uncategorized";
    if (cat.toLowerCase() !== category.toLowerCase()) return false;
    if (band && bandFor(i.sale_price as number) !== band) return false;
    return true;
  });

  if (sold.length === 0) return null;

  const graded = sideStats(sold.filter((i) => i.grade_value != null));
  const ungraded = sideStats(sold.filter((i) => i.grade_value == null));

  const priceLift =
    graded.avgSalePrice != null && ungraded.avgSalePrice != null
      ? graded.avgSalePrice - ungraded.avgSalePrice
      : null;
  const daysFaster =
    graded.medianDaysToSell != null && ungraded.medianDaysToSell != null
      ? ungraded.medianDaysToSell - graded.medianDaysToSell
      : null;

  return {
    category,
    band,
    graded,
    ungraded,
    priceLift,
    daysFaster,
    meaningful:
      graded.count >= MIN_BUCKET_SIZE && ungraded.count >= MIN_BUCKET_SIZE,
  };
}
