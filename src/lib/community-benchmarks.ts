// US-602: client wrapper over the community_benchmarks RPC (migration 00173).
//
// Unlike the other analytics wrappers (flipdesk-analytics-server.ts), this RPC
// aggregates across the WHOLE platform, not just the caller's tenant. Privacy is
// enforced DB-side: every returned cohort row passes a k-anonymity threshold
// (>= 5 distinct sellers) and the only seller-specific numbers are the caller's
// own. The client just receives the already-shaped, already-anonymized summary.

import { supabase } from "@/lib/supabase";

/** Minimum distinct sellers behind any returned aggregate (k-anonymity). */
export const MIN_COHORT_SELLERS = 5;

export type BrandBenchmark = {
  brand: string;
  sellers: number;
  listed: number;
  sold: number;
  sellThrough: number | null;
  avgSalePrice: number | null;
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

export type CommunityBenchmarks = {
  meta: {
    minSellers: number;
    periodStart: string | null;
    generatedAt: string;
  };
  topBrands: BrandBenchmark[];
  trendingCategories: CategoryTrend[];
  you: {
    listed: number;
    sold: number;
    sellThrough: number | null;
    peerComparison: PeerComparison | null;
  };
};

// Not in the generated Database types; call through a narrowly-typed view of the
// client (same pattern as fetchSellThrough / finances_dashboard).
type RpcClient = {
  rpc: (
    fn: "community_benchmarks",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: CommunityBenchmarks | null;
    error: { message: string } | null;
  }>;
};

/**
 * Anonymized, platform-wide reseller benchmarks filtered to items listed/sold on
 * or after `periodStart` (yyyy-mm-dd, or null for all time). Trending categories
 * always use a fixed last-30d-vs-prior-30d window regardless of `periodStart`.
 */
export async function fetchCommunityBenchmarks(
  periodStart: string | null,
): Promise<CommunityBenchmarks> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("community_benchmarks", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No benchmark data returned");
  return data;
}
