// Realized (sold) comps for honest pricing (US-542).
//
// The pricing bug this fixes: AutoLister priced from `searchBrowseComps`, which
// returns ACTIVE eBay asking prices, yet flagged `price_is_estimated=false` as
// if the number were backed by realized sales. Asking prices skew high, so
// suggested prices were systematically inflated.
//
// This module returns comps that come from ACTUAL sales, in priority order:
//   1. eBay Marketplace Insights (LAST_SOLD prices) — gated, off by default.
//   2. The platform's own `sales` table as a private comp set (the seller's
//      realized sales for the same brand/category/condition).
// When neither yields enough data it returns null, and the caller falls back to
// active Browse comps WITH the limitation surfaced (price stays estimated).
//
// The range math is a pure function (realizedRangeFromPrices) so it is unit
// tested without eBay or the database.

import { searchSoldComps } from "./ebay-client.ts";
import { supabaseAdmin } from "./supabase.ts";

// Below this many realized comps the distribution is statistically meaningless —
// we treat it as "no sold data" so the caller never claims a sold-backed price
// off two data points (mirrors condition-value's MIN_VALUE_COMPS).
export const MIN_SOLD_COMPS = 3;

// Private sales older than this don't reflect current market value.
const PRIVATE_SALES_LOOKBACK_DAYS = 365;
const PRIVATE_SALES_FETCH_LIMIT = 300;

export type CompSource = "ebay_sold" | "private_sales";

export interface RealizedComps {
  source: CompSource;
  count: number;
  currency: string;
  lowCents: number | null; // p25
  medianCents: number | null;
  highCents: number | null; // p75
  confidence: number; // 0..1
}

export interface RealizedCompsArgs {
  /** Workspace owner — scopes the private sales comp set (US-268). */
  ownerId: string;
  categoryId: string;
  brand?: string;
  q?: string;
  size?: string;
  conditionId?: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

/**
 * Realized-comp confidence from sample size. More conservative than active-comp
 * confidence: sold data is the gold standard, but a small sold sample still
 * carries real variance. 3 comps → ~0.5, 10+ → ~0.9.
 */
export function soldConfidenceFromCount(count: number): number {
  if (count < MIN_SOLD_COMPS) return 0;
  return Math.max(0, Math.min(0.95, 0.35 + count * 0.055));
}

/**
 * Pure: build a price range + confidence (in cents) from a list of realized
 * sale prices (dollars). Returns null when the sample is too thin to price
 * honestly. The range is the interquartile band; the center is the median.
 */
export function realizedRangeFromPrices(
  prices: number[],
  currency = "USD",
  source: CompSource = "private_sales",
): RealizedComps | null {
  const clean = prices
    .filter((p): p is number => typeof p === "number" && isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (clean.length < MIN_SOLD_COMPS) return null;

  const toCents = (d: number | null): number | null =>
    d == null ? null : Math.round(d * 100);
  const median = percentile(clean, 0.5);
  if (median == null) return null;

  return {
    source,
    count: clean.length,
    currency,
    lowCents: toCents(percentile(clean, 0.25)),
    medianCents: toCents(median),
    highCents: toCents(percentile(clean, 0.75)),
    confidence: soldConfidenceFromCount(clean.length),
  };
}

interface PrivateSaleRow {
  sale_price: number | string | null;
  inventory_items: {
    user_id: string;
    brand: string | null;
    ebay_category_id: string | null;
  } | null;
}

/**
 * The seller's own realized sales for comparable items as a private comp set.
 * Tenant-scoped to the workspace owner (US-268). A sold row is a comp when the
 * brand matches (case-insensitive); when a category is supplied it must also
 * match, except rows with no recorded category (kept as weak matches). Returns
 * null when fewer than MIN_SOLD_COMPS comparable sales exist.
 */
export async function getPrivateSalesComps(
  args: RealizedCompsArgs,
): Promise<RealizedComps | null> {
  const brand = args.brand?.trim().toLowerCase();
  if (!brand) return null; // brand is the only reliable private-comp key

  const cutoff = new Date(
    Date.now() - PRIVATE_SALES_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();

  const { data, error } = await supabaseAdmin
    .from("sales")
    .select(
      "sale_price, inventory_items!inner(user_id, brand, ebay_category_id)",
    )
    .eq("inventory_items.user_id", args.ownerId)
    .gte("sale_date", cutoff)
    .order("sale_date", { ascending: false })
    .limit(PRIVATE_SALES_FETCH_LIMIT);
  if (error) {
    console.error("[sold-comps] private sales query failed:", error.message);
    return null;
  }

  const rows = (data ?? []) as unknown as PrivateSaleRow[];
  const prices: number[] = [];
  for (const row of rows) {
    const item = row.inventory_items;
    if (!item) continue;
    if ((item.brand ?? "").trim().toLowerCase() !== brand) continue;
    if (
      args.categoryId &&
      item.ebay_category_id != null &&
      item.ebay_category_id !== args.categoryId
    ) {
      continue;
    }
    const price = typeof row.sale_price === "string"
      ? Number(row.sale_price)
      : row.sale_price;
    if (typeof price === "number" && isFinite(price) && price > 0) {
      prices.push(price);
    }
  }

  return realizedRangeFromPrices(prices, "USD", "private_sales");
}

/**
 * Get realized/sold comps for an item, preferring eBay Marketplace Insights
 * (when enabled) and falling back to the platform's private sales table.
 * Returns null when no sold-backed comp set is available — the caller then
 * falls back to active Browse comps and keeps price_is_estimated=true.
 */
export async function getRealizedComps(
  args: RealizedCompsArgs,
): Promise<RealizedComps | null> {
  // 1. eBay sold data (LAST_SOLD) — the broadest realized comp set when granted.
  try {
    const ebay = await searchSoldComps({
      categoryId: args.categoryId,
      q: args.q,
      brand: args.brand,
      size: args.size,
      conditionId: args.conditionId,
    });
    if (ebay && ebay.stats.count >= MIN_SOLD_COMPS && ebay.stats.median != null) {
      const toCents = (d: number | null): number | null =>
        d == null ? null : Math.round(d * 100);
      return {
        source: "ebay_sold",
        count: ebay.stats.count,
        currency: ebay.stats.currency,
        lowCents: toCents(ebay.stats.p25),
        medianCents: toCents(ebay.stats.median),
        highCents: toCents(ebay.stats.p75),
        confidence: soldConfidenceFromCount(ebay.stats.count),
      };
    }
  } catch (err) {
    console.error(
      "[sold-comps] eBay sold lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 2. Private sales comp set (the seller's own realized sales).
  return await getPrivateSalesComps(args);
}
