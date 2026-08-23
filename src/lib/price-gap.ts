// US-2820: Money Left On The Table.
//
// flipdesk_price_gap (migration 00652) does the scoring. This module owns the
// reading rules and the copy, both of which are opinionated enough to be worth
// testing without a database.
//
// THE FIGURE IS NOT RECOVERABLE REVENUE. It is the sum of shortfalls against
// the seller's own realized curve, and a shortfall is floored at zero so one
// good sale cannot mask ten bad ones. Every label this module produces says
// "estimate" and names the basis, because a number derived from four sales of
// the same brand deserves a different amount of trust than one derived from
// four hundred.

import { supabase } from "@/lib/supabase";

/** Which bucket the prediction for a row came from, best evidence first. */
export type GapBasis =
  | "cohort_brand"
  | "cohort_category"
  | "own_brand"
  | "own_category";

export interface GapRow {
  id: string;
  title: string;
  brand: string;
  grade: number;
  curveMedian: number;
  gapDollars: number;
  basis: GapBasis;
}

export interface SoldGapRow extends GapRow {
  salePrice: number;
  saleDate: string | null;
}

export interface LiveGapRow extends GapRow {
  listPrice: number;
}

export interface PriceGapReport {
  periodStart: string | null;
  minSellers: number;
  minSample: number;
  itemsScored: number;
  itemsUnscored: number;
  totalGapDollars: number;
  liveScored: number;
  liveGapDollars: number;
  worst: SoldGapRow[];
  live: LiveGapRow[];
}

export const EMPTY_PRICE_GAP: PriceGapReport = {
  periodStart: null,
  minSellers: 5,
  minSample: 5,
  itemsScored: 0,
  itemsUnscored: 0,
  totalGapDollars: 0,
  liveScored: 0,
  liveGapDollars: 0,
  worst: [],
  live: [],
};

const BASIS_LABEL: Record<GapBasis, string> = {
  cohort_brand: "other sellers, same brand and grade",
  cohort_category: "other sellers, same category and grade",
  own_brand: "your own sales, same brand and grade",
  own_category: "your own sales, same category and grade",
};

export function basisLabel(basis: GapBasis): string {
  return BASIS_LABEL[basis];
}

/** True when the prediction came from the cross-seller cohort. */
export function isCohortBasis(basis: GapBasis): boolean {
  return basis === "cohort_brand" || basis === "cohort_category";
}

/**
 * Share of the caller's in-window sales the report could price at all.
 * Null when nothing sold, which is different from "scored none of them".
 */
export function coverage(report: PriceGapReport): number | null {
  const total = report.itemsScored + report.itemsUnscored;
  if (total === 0) return null;
  return report.itemsScored / total;
}

/**
 * The headline sentence. Deliberately refuses to produce one when coverage is
 * thin: a dollar total over 3 of a seller's 90 sales reads as an account-wide
 * figure and is not one.
 */
export const MIN_COVERAGE_FOR_HEADLINE = 0.25;

export interface GapHeadline {
  totalGapDollars: number;
  itemsScored: number;
  /** 0..1 share of in-window sales that could be priced. */
  coverage: number;
  /** True when at least one scored row used the cross-seller cohort. */
  anyCohort: boolean;
}

export function gapHeadline(report: PriceGapReport): GapHeadline | null {
  const cov = coverage(report);
  if (cov == null || cov < MIN_COVERAGE_FOR_HEADLINE) return null;
  if (report.itemsScored === 0) return null;
  return {
    totalGapDollars: report.totalGapDollars,
    itemsScored: report.itemsScored,
    coverage: cov,
    anyCohort: report.worst.some((r) => isCohortBasis(r.basis)),
  };
}

/** Rows with a real shortfall, worst first. The RPC already sorts; this is the
 *  guard against a payload that does not. */
export function worstFirst<T extends GapRow>(rows: T[]): T[] {
  return [...rows]
    .filter((r) => r.gapDollars > 0)
    .sort((a, b) => b.gapDollars - a.gapDollars || a.id.localeCompare(b.id));
}

// ─── Fetch ───────────────────────────────────────────────────────

type RpcClient = {
  rpc: (
    fn: "flipdesk_price_gap",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: PriceGapReport | null;
    error: { message: string } | null;
  }>;
};

export async function fetchPriceGap(
  periodStart: string | null,
): Promise<PriceGapReport> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_price_gap", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  return data ?? EMPTY_PRICE_GAP;
}
