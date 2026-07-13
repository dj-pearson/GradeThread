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
const REALIZED_STATUSES = "(sold,shipped,completed,archived)";

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
    // Distinct owners holding unsold inventory.
    const { data: ownerRows } = await supabaseAdmin
      .from("inventory_items")
      .select("user_id")
      .not("status", "in", REALIZED_STATUSES)
      .limit(OWNER_SCAN_CAP);
    const owners = [
      ...new Set(
        ((ownerRows ?? []) as Array<{ user_id: string | null }>)
          .map((r) => r.user_id)
          .filter((id): id is string => !!id),
      ),
    ];

    const snapshotDate = todayKeyUTC();
    let written = 0;
    let failed = 0;
    for (const owner of owners) {
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
    }

    return c.json({ ok: true, owners: owners.length, written, failed, snapshotDate });
  } finally {
    await lock.release();
  }
}
