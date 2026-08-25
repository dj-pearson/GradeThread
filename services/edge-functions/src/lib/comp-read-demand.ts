// US-2845 AC2: the queue is fed by demand, and demand only.
//
// WHERE THE SIGNAL COMES FROM. Every condition-adjusted value the product
// quotes passes through applyMeasuredCurve in condition-value.ts: the grade
// result, scout's scan, appraisal and prospect, FlipDesk pricing, and
// grade-band pricing. So the cells our sellers grade, scout and list are
// already all flowing through one function, and recording them there means the
// queue is fed without a single route knowing this file exists.
//
// THAT IS ALSO WHY THERE IS NO CRAWL. Not "we chose not to write one" but
// "there is no input that could produce one": nothing here enumerates a
// catalogue, and a cell can only enter the queue by a seller asking about it.
// Coverage follows demand because demand is the only source.
//
// NOT TENANT DATA. A row is (cell, count, when), aggregate across every seller.
// Who asked is not recorded and is not wanted: the worker reads the market, and
// a per-seller queue would leak which sellers are working which brands.
//
// FIRE AND FORGET. A demand write must never slow or fail a seller's request,
// so every failure here is swallowed and counted.

import { supabaseAdmin } from "./supabase.ts";
import { type ItemIdentity, normalizeItemKey } from "./condition-item-key.ts";
import { logEvent } from "./observability.ts";

export const COMP_READ_DEMAND_TABLE = "comp_read_demand";

/** The row shape. Exported so the writer and the tests agree on it. */
export interface DemandUpsert {
  cell_key: string;
  category_id: string | null;
  brand: string | null;
  query: string | null;
  last_seen_at: string;
}

export interface DemandCounters {
  recorded: number;
  skipped: number;
  failed: number;
}

const counters: DemandCounters = { recorded: 0, skipped: 0, failed: 0 };
export function demandCounters(): DemandCounters {
  return { ...counters };
}
export function resetDemandCounters(): void {
  counters.recorded = 0;
  counters.skipped = 0;
  counters.failed = 0;
}

/**
 * Build the row, or null when this cell is not worth queueing.
 *
 * A cell with no categoryId is refused HERE rather than at the worker: the
 * Browse search needs one, so a row without it is a queue entry that can never
 * be served and would sit at the top of the demand list forever.
 */
export function toDemandUpsert(
  item: ItemIdentity,
  nowIso: string,
): DemandUpsert | null {
  const categoryId = (item.categoryId ?? "").trim();
  if (categoryId === "") return null;
  const cellKey = normalizeItemKey(item);
  if (cellKey.trim() === "" || cellKey === "||") return null;
  return {
    cell_key: cellKey,
    category_id: categoryId,
    brand: (item.brand ?? "")?.trim() || null,
    query: (item.q ?? "")?.trim() || null,
    last_seen_at: nowIso,
  };
}

/** The slice of supabase-js this module uses, injected so it is testable. */
export interface DemandClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ error: { message: string } | null }>;
}

/**
 * Record that a seller asked about this cell.
 *
 * Goes through an RPC rather than an upsert because the count has to INCREMENT,
 * and supabase-js has no read-modify-write that two replicas can run at the
 * same moment without losing one. The function is `comp_read_demand_touch` in
 * migration 00667.
 */
export async function recordCompDemand(
  item: ItemIdentity,
  client: DemandClient = supabaseAdmin as unknown as DemandClient,
  now: () => number = Date.now,
): Promise<boolean> {
  const row = toDemandUpsert(item, new Date(now()).toISOString());
  if (!row) {
    counters.skipped++;
    return false;
  }
  try {
    const { error } = await client.rpc("comp_read_demand_touch", {
      p_cell_key: row.cell_key,
      p_category_id: row.category_id,
      p_brand: row.brand,
      p_query: row.query,
    });
    if (error) {
      counters.failed++;
      logEvent("warn", "comp-read-demand.write_failed", {
        cell_key: row.cell_key,
        error: error.message,
      });
      return false;
    }
    counters.recorded++;
    return true;
  } catch (err) {
    counters.failed++;
    logEvent("warn", "comp-read-demand.threw", {
      cell_key: row.cell_key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
