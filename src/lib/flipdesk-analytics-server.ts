// US-418: thin client wrappers over the DB-side analytics RPCs
// (flipdesk_sell_through / flipdesk_grading_roi, migration 00148). The heavy
// per-row aggregation that sellThroughByGroup()/gradingRoiBuckets() used to do
// in the browser now runs in Postgres; the client just receives the already
// shaped summary rows, so the payload is bounded by the number of distinct
// groups / buckets rather than by inventory size.

import { supabase } from "@/lib/supabase";
import type {
  SellThroughRow,
  RoiBucket,
  GradingRoiSummary,
  GroupKey,
} from "@/lib/flipdesk-analytics";

// These RPCs are not in the generated Database types; call them through a
// narrowly-typed view of the client (same pattern as finances_dashboard etc.).
type RpcClient = {
  rpc: ((
    fn: "flipdesk_sell_through",
    args: { p_group_key: GroupKey; p_period_start: string | null },
  ) => Promise<{
    data: SellThroughRow[] | null;
    error: { message: string } | null;
  }>) &
    ((
      fn: "flipdesk_grading_roi",
      args?: { p_period_start: string | null },
    ) => Promise<{
      data: RoiBucket[] | null;
      error: { message: string } | null;
    }>) &
    ((
      fn: "flipdesk_grading_roi_summary",
      args?: { p_period_start: string | null },
    ) => Promise<{
      data: GradingRoiSummary | null;
      error: { message: string } | null;
    }>);
};

/**
 * Sell-through + profit rows for one grouping (category/brand/source), filtered
 * to items with a list/sale date on or after `periodStart` (yyyy-mm-dd, or null
 * for all time). Rows arrive pre-sorted (sold desc, listed desc).
 */
export async function fetchSellThrough(
  groupKey: GroupKey,
  periodStart: string | null,
): Promise<SellThroughRow[]> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_sell_through", {
    p_group_key: groupKey,
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Grading-ROI buckets (category × price band, graded vs ungraded) over all sold
 * items. Rows arrive pre-sorted by category then band, with `meaningful` already
 * computed against MIN_BUCKET_SIZE.
 */
export async function fetchGradingRoi(
  periodStart: string | null = null,
): Promise<RoiBucket[]> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_grading_roi", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * The account-wide graded-vs-ungraded headline (sell-through %, median days-to-
 * sell, net-profit lift) that fronts the Grading-ROI view. A single bounded
 * jsonb object — independent of inventory size. Returns null when the function
 * has no data to summarize (empty account).
 */
export async function fetchGradingRoiSummary(
  periodStart: string | null = null,
): Promise<GradingRoiSummary | null> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_grading_roi_summary", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  return data ?? null;
}
