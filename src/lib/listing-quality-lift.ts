// US-2826: what listing work is associated with traffic.
//
// flipdesk_listing_quality_lift (migration 00657) reads the listing_metrics
// history (00159) over each listing's first 14 days and buckets it by photo
// count, Listing Quality Score, and graded-or-not, WITHIN category.
//
// ⚠ THE WORD "CAUSE" APPEARS NOWHERE, and that is a rule this module enforces
// rather than a caveat it mentions. Sellers who take nine photos are not a
// random sample; they are the ones who care, and they do six other things
// differently too. comparisonLabel() below is the only sanctioned phrasing.

import { supabase } from "@/lib/supabase";
import { normaliseAgainst } from "@/lib/rpc-shape";

export type LiftDimension = "photos" | "quality" | "graded";

export const DIMENSION_LABEL: Record<LiftDimension, string> = {
  photos: "Photo count",
  quality: "Listing Quality Score",
  graded: "Grade shown",
};

export interface LiftBucket {
  dimension: LiftDimension;
  bucket: string;
  listings: number;
  medianImpressions: number | null;
  medianViews: number | null;
  medianWatchers: number | null;
  medianCtr: number | null;
}

export interface CategoryLiftBucket extends LiftBucket {
  category: string;
}

export interface ListingQualityLift {
  periodStart: string | null;
  windowDays: number;
  minDays: number;
  minListings: number;
  listingsIncluded: number;
  listingsExcluded: number;
  byCategory: CategoryLiftBucket[];
  /** Pooled across categories. Never the headline: see uncontrolledWarning. */
  uncontrolled: LiftBucket[];
}

export const EMPTY_LIFT: ListingQualityLift = {
  periodStart: null,
  windowDays: 14,
  minDays: 7,
  minListings: 5,
  listingsIncluded: 0,
  listingsExcluded: 0,
  byCategory: [],
  uncontrolled: [],
};

/** The only sanctioned way to phrase a difference between two buckets. */
export function comparisonLabel(
  dimension: LiftDimension,
  high: string,
  low: string,
): string {
  return `Listings with ${DIMENSION_LABEL[dimension].toLowerCase()} ${high} sit alongside ${low}`;
}

export const UNCONTROLLED_WARNING =
  "Pooled across categories, so it partly measures what you happen to sell.";

export type LiftMetric = "medianCtr" | "medianViews" | "medianWatchers";

export interface LiftFinding {
  dimension: LiftDimension;
  category: string;
  bestBucket: string;
  worstBucket: string;
  bestValue: number;
  worstValue: number;
  /** best / worst. Always > 1. */
  ratio: number;
  metric: LiftMetric;
  listings: number;
}

/**
 * The strongest association inside a single category, on one metric.
 *
 * WITHIN A CATEGORY ONLY. The pooled buckets are returned by the RPC and are
 * deliberately not eligible here: a finding drawn from them would mostly say
 * that outerwear gets more watchers than tees.
 */
export function strongestAssociation(
  report: ListingQualityLift,
  metric: LiftMetric = "medianCtr",
): LiftFinding | null {
  const groups = new Map<string, CategoryLiftBucket[]>();
  for (const b of report.byCategory) {
    const v = b[metric];
    if (v == null || !Number.isFinite(v)) continue;
    const k = `${b.category}|${b.dimension}`;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }

  let best: LiftFinding | null = null;
  for (const [k, buckets] of groups) {
    if (buckets.length < 2) continue;
    const hi = buckets.reduce((a, b) => (b[metric]! > a[metric]! ? b : a));
    const lo = buckets.reduce((a, b) => (b[metric]! < a[metric]! ? b : a));
    if (lo[metric]! <= 0) continue;
    const ratio = hi[metric]! / lo[metric]!;
    if (ratio <= 1) continue;
    if (!best || ratio > best.ratio) {
      const [category, dimension] = k.split("|") as [string, LiftDimension];
      best = {
        dimension,
        category,
        bestBucket: hi.bucket,
        worstBucket: lo.bucket,
        bestValue: hi[metric]!,
        worstValue: lo[metric]!,
        ratio,
        metric,
        listings: buckets.reduce((s, b) => s + b.listings, 0),
      };
    }
  }
  return best;
}

/** Categories present in the controlled buckets, in a stable order. */
export function categories(report: ListingQualityLift): string[] {
  return [...new Set(report.byCategory.map((b) => b.category))].sort();
}

type RpcClient = {
  rpc: (
    fn: "flipdesk_listing_quality_lift",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: ListingQualityLift | null;
    error: { message: string } | null;
  }>;
};

export async function fetchListingQualityLift(
  periodStart: string | null,
): Promise<ListingQualityLift> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_listing_quality_lift", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  // US-2838: the cast above makes `data: X | null` an assertion, not a check,
  // and `?? EMPTY_LIFT` only catches null. An empty ARRAY — what the e2e mock
  // sends for any unmatched RPC — passed straight through and took a whole
  // route down through the ErrorBoundary. normaliseAgainst forces the shape.
  return normaliseAgainst(EMPTY_LIFT, data);
}
