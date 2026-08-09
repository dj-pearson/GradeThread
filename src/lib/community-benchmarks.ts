// US-602: client wrapper over the community_benchmarks RPC (migration 00173,
// deepened in 00241 — US-1063).
//
// Unlike the other analytics wrappers (flipdesk-analytics-server.ts), this RPC
// aggregates across the WHOLE platform, not just the caller's tenant. Privacy is
// enforced DB-side: every returned cohort row passes a k-anonymity threshold
// (>= `meta.minSellers` distinct sellers, configured in system_settings and
// hard-clamped to a floor of 5) and the only seller-specific numbers are the
// caller's own. The client just receives the already-shaped, already-anonymized
// summary.

import { supabase } from "@/lib/supabase";

/**
 * Default minimum distinct sellers behind any returned aggregate (k-anonymity).
 * The live threshold is config-driven and arrives in `meta.minSellers`; this
 * constant is the fallback used before the RPC has responded.
 */
export const MIN_COHORT_SELLERS = 5;

export type BrandBenchmark = {
  brand: string;
  sellers: number;
  listed: number;
  sold: number;
  sellThrough: number | null;
  avgSalePrice: number | null;
  /** Median sale ÷ list price for this brand's sold cohort (k-anon-gated). */
  medianRealization?: number | null;
  /** Median days listed→sold for this brand's sold cohort (k-anon-gated). */
  medianDaysToSell?: number | null;
};

/** Brand and category deep-dives share the same shape. */
export type CategoryBenchmark = {
  category: string;
  sellers: number;
  listed: number;
  sold: number;
  sellThrough: number | null;
  avgSalePrice: number | null;
  medianRealization?: number | null;
  medianDaysToSell?: number | null;
};

export type CategoryTrend = {
  category: string;
  sellers: number;
  soldRecent: number;
  soldPrevious: number;
  growth: number | null;
};

export type PeerComparison = {
  peerCount: number;
  peerMedianSellThrough: number | null;
  yourSellThrough: number | null;
  /** Fraction of peers at or below the caller's sell-through (0–1). */
  percentile: number | null;
};

/** Community-wide price realization (sale price as a fraction of list price). */
export type PriceRealization = {
  sellers: number;
  sales: number;
  /** Median sale ÷ list ratio (1.0 = sold at list, <1 = discounted). */
  medianRatio: number | null;
  p25Ratio: number | null;
  p75Ratio: number | null;
  medianSalePrice: number | null;
  medianListPrice: number | null;
};

/** Community-wide time-to-sell distribution, in days listed→sold. */
export type TimeToSell = {
  sellers: number;
  sales: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
};

/** A single fixed trend window (count + GMV across the community). */
export type TrendWindow = {
  sellers: number;
  sold: number;
  gmv: number;
};

/** One month of the trailing-12-month series; values null when below k-anon. */
export type TrendMonth = {
  month: string;
  sellers: number | null;
  sold: number | null;
  gmv: number | null;
};

export type CommunityTrends = {
  windows: {
    d30: TrendWindow | null;
    d90: TrendWindow | null;
    d365: TrendWindow | null;
  };
  monthly: TrendMonth[];
};

export type CommunityBenchmarks = {
  meta: {
    minSellers: number;
    periodStart: string | null;
    generatedAt: string;
    // US-2235 AC1: echoed back by the RPC so the UI renders what the SERVER
    // applied, not what it believes it asked for. Absent on a pre-00569 payload.
    filters?: CommunityBenchmarkFilters;
    // US-2235 AC2. Both counts are null below the k-anonymity floor — see
    // `belowFloor` to tell "too few to show" apart from "nobody has sold yet".
    coverage?: {
      cohortSellers: number | null;
      totalSellers: number | null;
      belowFloor: boolean;
    };
  };
  topBrands: BrandBenchmark[];
  categories: CategoryBenchmark[];
  trendingCategories: CategoryTrend[];
  priceRealization: PriceRealization | null;
  timeToSell: TimeToSell | null;
  trends: CommunityTrends;
  you: {
    listed: number;
    sold: number;
    sellThrough: number | null;
    /** Caller's own median days listed→sold (always shown — own data). */
    medianDaysToSell: number | null;
    /** Caller's own median price realization (always shown — own data). */
    medianRealization: number | null;
    peerComparison: PeerComparison | null;
  };
};

// Not in the generated Database types; call through a narrowly-typed view of the
// client (same pattern as fetchSellThrough / finances_dashboard).
type RpcClient = {
  rpc: (
    fn: "community_benchmarks",
    // US-2235: the five filter params are REQUIRED here even though the SQL
    // defaults them, so a call site cannot silently omit one and get the
    // unfiltered cohort back while believing it filtered. Pass null to mean
    // "no filter" — that is what the RPC reads too.
    args: {
      p_period_start: string | null;
      p_brand: string | null;
      p_category: string | null;
      p_size: string | null;
      p_price_min: number | null;
      p_price_max: number | null;
    },
  ) => Promise<{
    data: CommunityBenchmarks | null;
    error: { message: string } | null;
  }>;
};

/** US-2235 AC1. Every field optional; all absent = the unfiltered snapshot. */
export interface CommunityBenchmarkFilters {
  brand?: string | null;
  category?: string | null;
  size?: string | null;
  priceMin?: number | null;
  priceMax?: number | null;
}

/**
 * Normalize a filter set for the RPC.
 *
 * Blank strings become null rather than being sent through. An empty text input
 * must mean "no filter", not "match the empty brand" — the RPC compares against
 * a coalesced 'No brand' / 'Uncategorized', so an empty string would select a
 * real and very wrong cohort.
 *
 * Pure + exported so the mapping is testable without a database.
 */
export function normalizeBenchmarkFilters(
  f: CommunityBenchmarkFilters | undefined,
): Required<CommunityBenchmarkFilters> {
  const text = (v: string | null | undefined) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : null;
  };
  const num = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    brand: text(f?.brand),
    category: text(f?.category),
    size: text(f?.size),
    priceMin: num(f?.priceMin),
    priceMax: num(f?.priceMax),
  };
}

/** True when any filter is actually narrowing the cohort. */
export function hasActiveFilters(f: CommunityBenchmarkFilters | undefined): boolean {
  const n = normalizeBenchmarkFilters(f);
  return Object.values(n).some((v) => v !== null);
}

/**
 * Anonymized, platform-wide reseller benchmarks filtered to items listed/sold on
 * or after `periodStart` (yyyy-mm-dd, or null for all time). Trending categories
 * always use a fixed last-30d-vs-prior-30d window regardless of `periodStart`.
 *
 * US-2235: `filters` narrows the cohort SERVER-side (00569). That is the whole
 * point — filtering client-side over the returned aggregates would hide rows
 * without recomputing the medians behind them, so "Carhartt sell-through" would
 * still be everyone's sell-through with the other brands' rows removed. The
 * k-anonymity floor re-applies to the narrowed cohort, so a filter that isolates
 * too few sellers returns nulls rather than their numbers.
 */
export async function fetchCommunityBenchmarks(
  periodStart: string | null,
  filters?: CommunityBenchmarkFilters,
): Promise<CommunityBenchmarks> {
  const client = supabase as unknown as RpcClient;
  const f = normalizeBenchmarkFilters(filters);
  const { data, error } = await client.rpc("community_benchmarks", {
    p_period_start: periodStart,
    p_brand: f.brand,
    p_category: f.category,
    p_size: f.size,
    p_price_min: f.priceMin,
    p_price_max: f.priceMax,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No benchmark data returned");
  return data;
}
