import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// US-894: AI spend & token-usage dashboard (read-only).
//
// Mounted at /api/admin/ai, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. All aggregation is
// done server-side by the `ai_spend` RPC (migration 00218) which re-prices the
// ai_usage_events ledger from the config-driven price table and rolls it up by
// model/feature/day with a top-features-today + today-vs-yesterday delta. This
// route only validates the query params and forwards them. No writes → no audit
// / step-up.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminAiSpendRoutes = new Hono<AdminEnv>();

const PERIODS = new Set(["today", "7d", "30d", "90d"]);
const GROUP_BYS = new Set(["model", "feature", "day"]);

// GET /api/admin/ai/spend?period=today|7d|30d|90d&groupBy=model|feature|day
adminAiSpendRoutes.get("/spend", async (c) => {
  const period = c.req.query("period") ?? "30d";
  const groupBy = c.req.query("groupBy") ?? "feature";

  if (!PERIODS.has(period)) {
    return c.json({ error: `Invalid period "${period}"` }, 400);
  }
  if (!GROUP_BYS.has(groupBy)) {
    return c.json({ error: `Invalid groupBy "${groupBy}"` }, 400);
  }

  const { data, error } = await supabaseAdmin.rpc("ai_spend", {
    p_period: period,
    p_group_by: groupBy,
  });

  if (error) {
    console.error("[admin-ai-spend] ai_spend failed:", error);
    return c.json({ error: "Failed to load AI spend" }, 500);
  }

  return c.json({ summary: data });
});

// GET /api/admin/ai/profitability?period=today|7d|30d|90d
// US-1065: per-feature profitability + modeled scenario projection. Aggregation
// is done by the `ai_profitability` RPC (migration 00240): it re-prices the same
// ledger as ai_spend into cost-per-action / gross margin per feature and projects
// monthly spend vs revenue under the config-driven usage scenarios. Read-only.
adminAiSpendRoutes.get("/profitability", async (c) => {
  const period = c.req.query("period") ?? "30d";

  if (!PERIODS.has(period)) {
    return c.json({ error: `Invalid period "${period}"` }, 400);
  }

  const { data, error } = await supabaseAdmin.rpc("ai_profitability", {
    p_period: period,
  });

  if (error) {
    console.error("[admin-ai-spend] ai_profitability failed:", error);
    return c.json({ error: "Failed to load AI profitability" }, 500);
  }

  return c.json({ report: data });
});
