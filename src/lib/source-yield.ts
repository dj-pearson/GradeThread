// US-2824: source condition yield.
//
// flipdesk_source_yield (migration 00656) aggregates over items_full under RLS,
// windowed on the PURCHASE date rather than the sale date, because attributing
// an outcome to a venue means asking what happened to the things bought there.
//
// The reading rule worth stating: costPerGradePoint is the comparison the whole
// report exists for, and it is null whenever the sample floor is not met. A
// venue with three items has a cost per grade point; it does not have a
// trustworthy one, and the null is the difference.

import { supabase } from "@/lib/supabase";

export interface SourceYieldRow {
  source: string;
  itemsSourced: number;
  itemsWithPrice: number;
  gradedCount: number;
  gradedShare: number | null;
  listed: number;
  sold: number;
  avgPurchasePrice: number | null;
  medianGrade: number | null;
  costPerGradePoint: number | null;
  medianNetProfit: number | null;
  medianDaysToSell: number | null;
  sellThrough: number | null;
  thin: boolean;
}

export interface SourceYieldReport {
  periodStart: string | null;
  minSample: number;
  rows: SourceYieldRow[];
  itemsWithoutPrice: number;
  itemsWithoutPurchaseDate: number;
}

export const EMPTY_SOURCE_YIELD: SourceYieldReport = {
  periodStart: null,
  minSample: 5,
  rows: [],
  itemsWithoutPrice: 0,
  itemsWithoutPurchaseDate: 0,
};

/** Venues with a quotable cost per grade point, cheapest first. */
export function rankedByCostPerGradePoint(
  report: SourceYieldReport,
): SourceYieldRow[] {
  return report.rows
    .filter((r) => r.costPerGradePoint != null)
    .sort(
      (a, b) =>
        a.costPerGradePoint! - b.costPerGradePoint! ||
        a.source.localeCompare(b.source),
    );
}

export interface SourceFinding {
  best: SourceYieldRow;
  worst: SourceYieldRow;
  /** How many times more a grade point costs at `worst` than at `best`. */
  ratio: number;
}

/**
 * The comparison worth leading with. Null unless at least two venues have a
 * quotable figure and the cheap one is actually cheaper, because "your only
 * source is also your best source" is not a finding.
 */
export function sourceFinding(report: SourceYieldReport): SourceFinding | null {
  const ranked = rankedByCostPerGradePoint(report);
  if (ranked.length < 2) return null;
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  if (best.costPerGradePoint! <= 0) return null;
  const ratio = worst.costPerGradePoint! / best.costPerGradePoint!;
  if (ratio <= 1) return null;
  return { best, worst, ratio };
}

type RpcClient = {
  rpc: (
    fn: "flipdesk_source_yield",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: SourceYieldReport | null;
    error: { message: string } | null;
  }>;
};

export async function fetchSourceYield(
  periodStart: string | null,
): Promise<SourceYieldReport> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_source_yield", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  return data ?? EMPTY_SOURCE_YIELD;
}
