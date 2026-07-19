// US-1870: nightly Inventory Equity snapshot cron.
//
// Once a day, for every seller with unsold inventory, compute the tenant equity
// aggregate (US-1869 model, CACHED comps → zero eBay/AI spend) and upsert one
// row into inventory_equity_snapshots keyed by (user_id, snapshot_date). That
// history powers the equity-over-time trend chart. Idempotent: a same-day re-run
// upserts the row rather than duplicating it.
//
// Mounted in main.ts as POST /api/jobs/equity-snapshot, OUTSIDE the /api/* JWT
// groups, gated by the internal job secret (same pattern as the other crons).
// Register the Coolify scheduled task to curl this daily (see COOLIFY.md).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { computeEquityForOwner } from "./flipdesk-equity.ts";

// Bound a single run. Distinct owners with unsold inventory; scanning their id
// column is cheap, and most workspaces are well under this.
const OWNER_SCAN_CAP = 20_000;
// US-2029: the realized-status list now lives in the equity_snapshot_owners
// RPC (migration 00485) so the DISTINCT happens in the database. Deliberately
// NOT kept as a duplicate constant here — two copies of a status list is how
// they drift, and the SQL is the one that runs.

function todayKeyUTC(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function handleEquitySnapshotCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!(await isFeatureEnabled("inventory_equity"))) {
    return c.json({ ok: true, skipped: true, reason: "feature_disabled" });
  }

  const lock = await acquireJobLock("equity-snapshot", 1800);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    // US-2029 AC1: distinct owners holding unsold inventory, via an RPC.
    //
    // This used to select user_id from inventory_items across ALL tenants and
    // de-duplicate in JS. Two problems, and the second is the serious one:
    //   • a NOT IN over four enum values will not use idx_inventory_items_status,
    //     so it was a nightly sequential scan on the largest table; and
    //   • the 20,000 cap applied to ROWS, not OWNERS — so past that point owners
    //     were silently dropped, and one seller with 20,000 unsold items could
    //     starve every other seller out of the snapshot. The job still reported
    //     success; those sellers' equity trend just went flat.
    // The RPC does the DISTINCT in the database and bounds OWNERS.
    const { data: ownerRows, error: ownerErr } = await supabaseAdmin.rpc(
      "equity_snapshot_owners",
      { p_limit: OWNER_SCAN_CAP },
    );
    if (ownerErr) {
      // Fail LOUD. Returning zero owners would look identical to "no sellers
      // hold inventory" and write no snapshots — the exact silent-flat-trend
      // failure this story is about.
      console.error("[equity-snapshot] owner discovery failed:", ownerErr.message);
      return c.json({ ok: false, error: "owner discovery failed" }, 500);
    }
    const owners = ((ownerRows ?? []) as Array<{ user_id: string | null }>)
      .map((r) => r.user_id)
      .filter((id): id is string => !!id);

    const snapshotDate = todayKeyUTC();
    let written = 0;
    let failed = 0;

    // US-2029: process owners with BOUNDED CONCURRENCY instead of one at a time.
    //
    // computeEquityForOwner issues 4 queries per owner (2 of them genuinely
    // sequential) plus this upsert, so a strictly serial loop is ~5 round trips
    // x every seller. At 5,000 sellers that is ~25,000 sequential round trips —
    // roughly 500s at ~20ms each, still inside the 1800s lock TODAY, but it
    // scales linearly and blows the lock somewhere around 10k sellers. The
    // failure then is SILENT: snapshots simply stop and the equity trend chart
    // goes flat with no error anywhere.
    //
    // Concurrency 8 is deliberately modest. These are reads plus one idempotent
    // upsert per owner (onConflict user_id,snapshot_date), so ordering does not
    // matter and a retry is harmless — but the shared Postgres is the same one
    // serving live traffic, and a nightly job has no business saturating it.
    const CONCURRENCY = 8;
    const processOwner = async (owner: string) => {
      try {
        const { aggregate } = await computeEquityForOwner(owner);
        const { error } = await supabaseAdmin
          .from("inventory_equity_snapshots")
          .upsert(
            {
              user_id: owner,
              snapshot_date: snapshotDate,
              total_equity_cents: aggregate.totalEquityCents,
              total_low_cents: aggregate.totalLowCents,
              total_high_cents: aggregate.totalHighCents,
              valued_count: aggregate.valuedCount,
              unvalued_count: aggregate.unvaluedCount,
            },
            { onConflict: "user_id,snapshot_date" },
          );
        if (error) {
          failed++;
          console.error(`[equity-snapshot] upsert failed for ${owner}:`, error.message);
        } else {
          written++;
        }
      } catch (err) {
        failed++;
        console.error(
          `[equity-snapshot] compute failed for ${owner}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    for (let i = 0; i < owners.length; i += CONCURRENCY) {
      // One owner's failure must not abort the batch — processOwner swallows and
      // counts its own errors, so allSettled is belt-and-braces for anything
      // thrown outside that try.
      await Promise.allSettled(
        owners.slice(i, i + CONCURRENCY).map((owner) => processOwner(owner)),
      );
    }

    return c.json({ ok: true, owners: owners.length, written, failed, snapshotDate });
  } finally {
    await lock.release();
  }
}
