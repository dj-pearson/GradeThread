// US-1822: guarantee claims-pool accrual + reconciliation cron.
//
// Two idempotent period tasks (not a batch queue — a single-scan cron like
// billing-reconciliation, US-893):
//   1. ACCRUE the period's pool from active buyer subscriptions
//      (accrual_per_active_sub_cents × active subs), once per period.
//   2. RECONCILE: every auto_approved claim in the period must have a matching
//      pool drawdown row; a missing one is a discrepancy (logged + counted) so
//      the pool ledger can't silently under-count exposure.
//
// Job-secret gated + job-locked; the /api/jobs/* middleware records it to
// cron_runs. Mounted POST /api/jobs/guarantee-pool. Register in COOLIFY.md.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { getGuaranteePoolConfig, periodKey, recordPoolAccrual } from "../lib/guarantee-pool.ts";

const BUYER_ACTIVE_STATUSES = ["active", "trialing"];

export async function handleGuaranteePoolCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("guarantee-pool", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const period = periodKey(Date.now());
    const config = await getGuaranteePoolConfig();

    // 1) Accrual — count active buyer subscriptions, accrue once per period.
    let accruedCents = 0;
    let activeSubs = 0;
    if (config.accrual_per_active_sub_cents > 0) {
      const { count, error } = await supabaseAdmin
        .from("users")
        .select("id", { count: "exact", head: true })
        .not("buyer_plan", "is", null)
        .in("buyer_subscription_status", BUYER_ACTIVE_STATUSES);
      if (error) {
        console.error("[guarantee-pool] active-sub count failed:", error.message);
      } else {
        activeSubs = count ?? 0;
        accruedCents = activeSubs * config.accrual_per_active_sub_cents;
        if (accruedCents > 0) {
          await recordPoolAccrual(period, accruedCents, `active_subs:${activeSubs}`);
        }
      }
    }

    // 2) Reconcile — auto_approved claims this period vs pool drawdowns.
    const since = `${period}-01T00:00:00Z`;
    const { data: claims } = await supabaseAdmin
      .from("buyer_guarantee_claims")
      .select("id, remedy_cents")
      .eq("status", "auto_approved")
      .gte("created_at", since);
    const claimIds = (claims ?? []).map((r) => (r as { id: string }).id);

    let discrepancies = 0;
    if (claimIds.length > 0) {
      const { data: draws } = await supabaseAdmin
        .from("guarantee_pool_ledger")
        .select("reference_id")
        .eq("entry_type", "drawdown")
        .in("reference_id", claimIds);
      const drawn = new Set((draws ?? []).map((r) => (r as { reference_id: string }).reference_id));
      for (const id of claimIds) {
        if (!drawn.has(id)) {
          discrepancies++;
          console.error(`[guarantee-pool] reconciliation: auto_approved claim ${id} has no pool drawdown`);
        }
      }
    }

    return c.json({
      ok: true,
      period,
      activeSubs,
      accruedCents,
      reconciledClaims: claimIds.length,
      discrepancies,
    });
  } catch (err) {
    console.error("[guarantee-pool] cron failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Guarantee-pool job failed." }, 500);
  } finally {
    // US-2311: acquired but never released — the 300s lease was doing all the
    // work, so a manual Run Now inside it silently no-opped.
    await lock.release();
  }
}
