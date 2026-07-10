// US-1822: admin ops dashboard for the buyer guarantee claims pool.
//
// Mounted at /api/admin/guarantee-pool — inherits authMiddleware +
// adminAuthMiddleware from main.ts (/api/admin/*). Read-only exposure / loss
// ratio / claim volume + outcomes. Cap/term edits happen through the existing
// system_settings editor (/admin/ops/settings, key buyer.guarantee_pool +
// buyer.guarantee_remedy), so this surface stays a dashboard, not a form.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  computePoolPeriodStats,
  getGuaranteePoolConfig,
  periodKey,
  type PoolLedgerEntry,
} from "../lib/guarantee-pool.ts";

type AdminEnv = { Variables: { userId: string } };

export const adminGuaranteePoolRoutes = new Hono<AdminEnv>();

const RECENT_PERIODS = 6;

adminGuaranteePoolRoutes.get("/", async (c) => {
  const config = await getGuaranteePoolConfig();

  const { data: ledger, error } = await supabaseAdmin
    .from("guarantee_pool_ledger")
    .select("entry_type, amount_cents, period")
    .order("period", { ascending: false })
    .limit(5000);
  if (error) {
    console.error("[admin-guarantee-pool] ledger load failed:", error.message);
    return c.json({ error: "Failed to load the pool ledger." }, 500);
  }
  const entries = (ledger ?? []) as PoolLedgerEntry[];

  // Distinct periods present, newest first, capped — plus always the current one
  // so an empty current period still shows.
  const periods = [...new Set([periodKey(Date.now()), ...entries.map((e) => e.period)])]
    .sort()
    .reverse()
    .slice(0, RECENT_PERIODS);
  const stats = periods.map((p) => computePoolPeriodStats(entries, p));

  // Claim outcome mix (all-time counts by status).
  const { data: claims } = await supabaseAdmin
    .from("buyer_guarantee_claims")
    .select("status");
  const outcomes: Record<string, number> = {};
  for (const r of claims ?? []) {
    const s = (r as { status: string }).status;
    outcomes[s] = (outcomes[s] ?? 0) + 1;
  }

  const current = stats[0] ?? null;
  const throttled = current?.lossRatio != null && current.lossRatio > config.loss_ratio_throttle;

  return c.json({
    config,
    periods: stats,
    outcomes,
    throttled,
  });
});
