// US-3133: measure how crowded each resale market is, once a day.
//
// WHY THIS EXISTS. Sellers ask constantly whether sales are down on a platform
// or whether it is just them, and every answer is an anecdote. eBay's
// sold-price API is ungranted here, so we cannot count sales. We can count
// LISTINGS, and rising supply is more often the real cause anyway. Thirty of
// these ticks make a trend; one makes a number that answers nothing.
//
// THE JOB IS DELIBERATELY THE LOWEST-PRIORITY EBAY CALLER. The comps ladder,
// the seller Add flow and the style-code crawl all draw on the same app-level
// allowance, and a seller waiting on comps is blocked while a supply trend that
// skips a night is not. So the pass sizes itself from eBay's own reported
// headroom and yields first. See HEADROOM_FRACTION in lib/supply-sampling.ts.
//
// MOST TICKS ARE UNREMARKABLE AND STAY QUIET. A cell whose count matches
// yesterday is the normal case; it is counted, not logged.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { searchBrowseComps } from "../lib/ebay-client.ts";
import {
  medianAskCents,
  passSizeFromHeadroom,
} from "../lib/supply-sampling.ts";

/** Listings pulled per cell, for the asking-price median. `total` comes back
 *  whatever this is, so it buys the price distribution and nothing else. */
const PAGE_SIZE = 50;

/** How far back the run looks to decide which cells are most overdue. Long
 *  enough to order a list this size fairly, short enough that the read stays
 *  small as the panel grows past a year. */
const RECENCY_WINDOW_DAYS = 30;

/**
 * How a Browse row is recognised in ebay_rate_limit_snapshots.
 *
 * MATCHED LOOSELY ON PURPOSE. Those rows carry eBay's own `apiName` and
 * `resource.name` verbatim (parseRateLimits in lib/ebay-rate-limits.ts stores
 * them unchanged), and this codebase has never recorded which exact spelling
 * eBay sends for Browse. Guessing one exact string would fail closed in the
 * silent direction: no match reads as "no snapshot", which is indistinguishable
 * from eBay never having reported. Matching either column on a substring costs
 * nothing and cannot mistake a Browse row for something else, because no other
 * eBay API has "browse" in its name.
 */
const BROWSE_MATCH = "browse";

interface CellRow {
  cell_key: string;
  marketplace: string;
  brand_key: string | null;
  brand_display: string | null;
  category_id: string;
  query_terms: string | null;
}

/** eBay's own statement of Browse calls left, or null when it has not said. */
async function readBrowseHeadroom(): Promise<{ remaining: number | null } | null> {
  // `.or()` is fine here: the US-1552 ban is on UPDATE and DELETE, where prod's
  // PostgREST rejects logical operators on the update CTE. This is a SELECT.
  const { data, error } = await supabaseAdmin
    .from("ebay_rate_limit_snapshots")
    .select("remaining")
    .or(`api_name.ilike.%${BROWSE_MATCH}%,resource_name.ilike.%${BROWSE_MATCH}%`)
    .order("captured_at", { ascending: false })
    .limit(1);
  if (error) {
    // Not fatal. An unreadable snapshot is the same state as no snapshot: we do
    // not know the ceiling, so we run the conservative batch and say so.
    console.error("[supply-sample] headroom read failed:", error.message);
    return null;
  }
  const row = (data ?? [])[0] as { remaining: number | null } | undefined;
  return row ? { remaining: row.remaining } : null;
}

export async function handleSupplySampleCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("supply-sample", 1800);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const observedOn = new Date().toISOString().slice(0, 10);

    const { data: cellData, error: cellError } = await supabaseAdmin
      .from("marketplace_supply_cells")
      .select("cell_key, marketplace, brand_key, brand_display, category_id, query_terms")
      .eq("is_active", true)
      .eq("marketplace", "ebay");
    if (cellError) {
      console.error("[supply-sample] cell scan failed:", cellError.message);
      return c.json({ ok: false, error: "cell scan failed" }, 500);
    }
    const allCells = (cellData ?? []) as CellRow[];

    // The recent past, for two purposes: skipping what today already has, and
    // ordering what it does not.
    const since = new Date(Date.now() - RECENCY_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const { data: recentData } = await supabaseAdmin
      .from("marketplace_supply_samples")
      .select("cell_key, observed_on")
      .gte("observed_on", since);
    const recent = (recentData ?? []) as Array<{ cell_key: string; observed_on: string }>;

    const lastSeen = new Map<string, string>();
    for (const row of recent) {
      const prev = lastSeen.get(row.cell_key);
      if (prev === undefined || row.observed_on > prev) {
        lastSeen.set(row.cell_key, row.observed_on);
      }
    }

    // Already-measured cells are skipped rather than re-fetched: the unique
    // constraint would collapse them anyway, and a re-fetch spends an eBay call
    // to write the row we already have. This is what makes a retry cheap.
    const pending = allCells
      .filter((cell) => lastSeen.get(cell.cell_key) !== observedOn)
      // LEAST RECENTLY SAMPLED FIRST, and never-sampled before either.
      //
      // Not a nicety. On a night the budget covers only part of the list, a
      // stable order means the same head is measured every time and the tail
      // is never measured at all, so the trend would look complete while a
      // third of the cells had no history whatever. Rotating turns a budget
      // shortfall into thinner coverage everywhere, which is recoverable,
      // instead of no coverage somewhere, which is not.
      .sort((a, b) => {
        const av = lastSeen.get(a.cell_key) ?? "";
        const bv = lastSeen.get(b.cell_key) ?? "";
        if (av !== bv) return av < bv ? -1 : 1;
        return a.cell_key < b.cell_key ? -1 : 1;
      });

    const headroom = await readBrowseHeadroom();
    const pass = passSizeFromHeadroom(headroom, pending.length);
    const batch = pending.slice(0, pass.cells);

    let sampled = 0;
    let failed = 0;
    for (const cell of batch) {
      try {
        const res = await searchBrowseComps({
          categoryId: cell.category_id,
          brand: cell.brand_display ?? undefined,
          q: cell.query_terms ?? undefined,
          limit: PAGE_SIZE,
        });
        const pricesCents = res.items
          .map((i) => i.price)
          .filter((p): p is number => p != null && p > 0)
          .map((p) => Math.round(p * 100));
        const { median, sampleSize } = medianAskCents(pricesCents);

        const { error } = await supabaseAdmin
          .from("marketplace_supply_samples")
          .upsert({
            cell_key: cell.cell_key,
            marketplace: cell.marketplace,
            brand_key: cell.brand_key,
            category_id: cell.category_id,
            observed_on: observedOn,
            active_listings: res.total,
            median_ask_cents: median,
            ask_sample_size: sampleSize,
            currency: res.stats.currency,
          }, { onConflict: "cell_key,observed_on" });
        if (error) throw new Error(error.message);
        sampled++;
      } catch (err) {
        // One cell must never cost the other two hundred. eBay 500s on a single
        // query, a category goes away, a brand name stops matching an aspect:
        // count it, keep going, report the number.
        failed++;
        console.error(
          `[supply-sample] cell ${cell.cell_key} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return c.json({
      ok: true,
      observed_on: observedOn,
      cells: allCells.length,
      pending: pending.length,
      sampled,
      failed,
      skipped: pending.length - batch.length,
      basis: pass.basis,
    });
  } finally {
    await lock.release();
  }
}
