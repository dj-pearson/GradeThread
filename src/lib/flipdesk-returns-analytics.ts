// US-595: thin client wrapper over the flipdesk_return_reduction RPC
// (migration 00168). The DB does the grade-banded aggregation over the seller's
// fulfilled sales; the client receives a compact summary (4 bands + 3 rollups)
// and turns it into the "items graded <=6 return Nx more" headline and the
// condition-guarantee surface.

import { supabase } from "@/lib/supabase";

// A band's return rate is only trustworthy once it has this many fulfilled
// sales behind it. Below it we still show the band, but flag it as low-n and
// keep it out of the headline multipliers (mirrors MIN_BUCKET_SIZE in the
// grading-ROI report, scaled up for a rarer event).
export const MIN_RETURN_SAMPLE = 10;

export interface ReturnStat {
  sold: number; // fulfilled sales (shipped: completed + refunded)
  returns: number; // refunded sales
  returnRate: number | null; // returns / sold, null when nothing sold
}

export interface ReturnBandRow extends ReturnStat {
  key: "low" | "mid" | "high" | "ungraded";
  label: string;
}

export interface ReturnReductionSummary {
  overall: ReturnStat;
  graded: ReturnStat;
  ungraded: ReturnStat;
  bands: ReturnBandRow[];
}

// The RPC is not in the generated Database types; call it through a narrowly
// typed view of the client (same pattern as flipdesk_sell_through etc.).
type RpcClient = {
  rpc: (
    fn: "flipdesk_return_reduction",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: ReturnReductionSummary | null;
    error: { message: string } | null;
  }>;
};

const EMPTY_STAT: ReturnStat = { sold: 0, returns: 0, returnRate: null };

/**
 * Grade-banded return rates over the seller's fulfilled sales, filtered to sales
 * on/after `periodStart` (yyyy-mm-dd, or null for all time).
 */
export async function fetchReturnReduction(
  periodStart: string | null,
): Promise<ReturnReductionSummary> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_return_reduction", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  return (
    data ?? {
      overall: EMPTY_STAT,
      graded: EMPTY_STAT,
      ungraded: EMPTY_STAT,
      bands: [],
    }
  );
}

/**
 * "Graded items return Nx less than ungraded" — the headline multiplier. Returns
 * null unless both sides clear MIN_RETURN_SAMPLE and graded actually returns
 * less (we never spin a worse number as an ROI win).
 */
export function gradedReturnAdvantage(
  s: ReturnReductionSummary,
): number | null {
  const { graded, ungraded } = s;
  if (graded.sold < MIN_RETURN_SAMPLE || ungraded.sold < MIN_RETURN_SAMPLE) {
    return null;
  }
  if (
    graded.returnRate == null ||
    ungraded.returnRate == null ||
    graded.returnRate <= 0 ||
    ungraded.returnRate <= graded.returnRate
  ) {
    return null;
  }
  return ungraded.returnRate / graded.returnRate;
}

/**
 * "Items graded <=6 return Nx more than your 8.5-10.0 items." Compares the
 * low band against the high band when both clear MIN_RETURN_SAMPLE and the low
 * band returns more.
 */
export function lowVsHighBandMultiplier(
  s: ReturnReductionSummary,
): { multiplier: number; low: ReturnBandRow; high: ReturnBandRow } | null {
  const low = s.bands.find((b) => b.key === "low");
  const high = s.bands.find((b) => b.key === "high");
  if (!low || !high) return null;
  if (low.sold < MIN_RETURN_SAMPLE || high.sold < MIN_RETURN_SAMPLE) return null;
  if (
    low.returnRate == null ||
    high.returnRate == null ||
    high.returnRate <= 0 ||
    low.returnRate <= high.returnRate
  ) {
    return null;
  }
  return { multiplier: low.returnRate / high.returnRate, low, high };
}
