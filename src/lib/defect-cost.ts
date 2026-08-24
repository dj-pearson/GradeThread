// US-2821: the Defect Cost Ledger.
//
// flipdesk_defect_cost (migration 00653) prices each (defect, severity) pair
// against the median of the item's own (grade, category) band. This module owns
// the reading rules and the arithmetic the SQL is specified against.
//
// WHY A RATIO AND NOT A DOLLAR FIGURE: a dollar average ranks defects by how
// expensive the garments carrying them happen to be. `medianRatio` below is the
// reference implementation of the normalization, and its scale invariance is
// pinned by a test rather than asserted in a comment.

import { supabase } from "@/lib/supabase";
import { normaliseAgainst } from "@/lib/rpc-shape";

export type DefectSeverity = "minor" | "moderate" | "major" | "unspecified";

export interface DefectCostRow {
  defect: string;
  severity: string;
  ownCount: number;
  ownPriceRatio: number | null;
  ownDaysDelta: number | null;
  cohortCount: number;
  cohortSellers: number;
  cohortSuppressed: boolean;
  cohortPriceRatio: number | null;
  cohortDaysDelta: number | null;
}

export interface DefectCostReport {
  periodStart: string | null;
  minSellers: number;
  minSample: number;
  minDefectSample: number;
  itemsSold: number;
  itemsScored: number;
  itemsWithDefects: number;
  /**
   * Sold items whose grade recorded no defects. NOT a control group: 00058
   * added defects_found as NOT NULL DEFAULT '[]', so a grade produced before it
   * is indistinguishable from one that genuinely found nothing.
   */
  noDefectsRecorded: number;
  rows: DefectCostRow[];
}

export const EMPTY_DEFECT_COST: DefectCostReport = {
  periodStart: null,
  minSellers: 5,
  minSample: 5,
  minDefectSample: 5,
  itemsSold: 0,
  itemsScored: 0,
  itemsWithDefects: 0,
  noDefectsRecorded: 0,
  rows: [],
};

// ─── The normalization, as a testable function ───────────────────

/** Median of a list. Null on empty. Ties take the mean of the middle pair. */
export function median(nums: number[]): number | null {
  const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

/**
 * The reference implementation of what 00653 computes per (defect, severity):
 * the median of each sale price divided by its band median.
 *
 * Scale invariance is the whole point. Multiply every price AND the band by the
 * same factor and this returns the identical number, which is why a defect
 * ledger built on it cannot rank flaws by how expensive their garments were.
 */
export function medianRatio(
  prices: number[],
  bandMedian: number,
): number | null {
  if (!Number.isFinite(bandMedian) || bandMedian <= 0) return null;
  return median(prices.map((p) => p / bandMedian));
}

// ─── Reading rules ───────────────────────────────────────────────

export type ImpactSource = "cohort" | "own";

export interface DefectImpact {
  /** Median realized price as a share of the grade band. 0.89 = 11% under. */
  ratio: number | null;
  /** Median extra days on market vs the band. Positive = slower. */
  daysDelta: number | null;
  source: ImpactSource | null;
  count: number;
}

/** Cohort first when it survived suppression, own data as the fallback. */
export function defectImpact(row: DefectCostRow): DefectImpact {
  if (!row.cohortSuppressed && row.cohortPriceRatio != null) {
    return {
      ratio: row.cohortPriceRatio,
      daysDelta: row.cohortDaysDelta,
      source: "cohort",
      count: row.cohortCount,
    };
  }
  if (row.ownPriceRatio != null) {
    return {
      ratio: row.ownPriceRatio,
      daysDelta: row.ownDaysDelta,
      source: "own",
      count: row.ownCount,
    };
  }
  return { ratio: null, daysDelta: null, source: null, count: 0 };
}

/**
 * What the flaw costs, as a percentage of the grade band.
 *
 * Positive = sells for less than the grade alone implies. NEGATIVE IS REAL AND
 * IS NOT CLAMPED: a flaw whose items beat their band usually means it is being
 * disclosed well, and hiding that would remove the ledger's most useful finding.
 */
export function costPercent(row: DefectCostRow): number | null {
  const { ratio } = defectImpact(row);
  if (ratio == null) return null;
  return (1 - ratio) * 100;
}

/** Rows carrying a quotable impact, most expensive first. */
export function quotableRows(report: DefectCostReport): DefectCostRow[] {
  return report.rows
    .filter((r) => defectImpact(r).ratio != null)
    .sort((a, b) => {
      const ca = costPercent(a) ?? -Infinity;
      const cb = costPercent(b) ?? -Infinity;
      return cb - ca || a.defect.localeCompare(b.defect);
    });
}

/**
 * The single most expensive flaw the seller ACTUALLY HAS. A ledger row the
 * seller has never had an item for is market trivia, not a finding, so the lead
 * line only ever names something in their own inventory.
 */
export function topCostForSeller(
  report: DefectCostReport,
): DefectCostRow | null {
  const mine = quotableRows(report).filter((r) => r.ownCount > 0);
  const worst = mine[0];
  if (!worst) return null;
  const pct = costPercent(worst);
  // A flaw that costs nothing is not a finding either.
  if (pct == null || pct <= 0) return null;
  return worst;
}

/** "Pilling" out of "pilling", "Seam separation" out of "seam_separation". */
export function defectLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  if (!words) return "Unspecified";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ─── Fetch ───────────────────────────────────────────────────────

type RpcClient = {
  rpc: (
    fn: "flipdesk_defect_cost",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: DefectCostReport | null;
    error: { message: string } | null;
  }>;
};

export async function fetchDefectCost(
  periodStart: string | null,
): Promise<DefectCostReport> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_defect_cost", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  // US-2838: the cast above makes `data: X | null` an assertion, not a check,
  // and `?? EMPTY_DEFECT_COST` only catches null. An empty ARRAY — what the e2e mock
  // sends for any unmatched RPC — passed straight through and took a whole
  // route down through the ErrorBoundary. normaliseAgainst forces the shape.
  return normaliseAgainst(EMPTY_DEFECT_COST, data);
}
