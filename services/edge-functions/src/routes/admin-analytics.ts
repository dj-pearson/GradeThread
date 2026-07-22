import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  resolveRevenueWindow,
  type ResolvedRevenueWindow,
} from "../lib/revenue-window.ts";

// US-907: Product funnel & retention analytics (read-only).
//
// Mounted at /api/admin/analytics, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. The aggregation is
// done server-side by two RPCs (migration 00229):
//   * funnel_metrics(start, end)  → signup activation funnel for the window.
//   * retention_cohorts()         → last 12 weekly cohorts x W0..W8 retention.
// Both are SECURITY DEFINER + admin/service-role-guarded. No writes, so no audit
// log / MFA step-up. Period resolution reuses resolveRevenueWindow (mtd/qtd/ytd/
// custom) so the period semantics match the revenue dashboard exactly.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminAnalyticsRoutes = new Hono<AdminEnv>();

// GET /api/admin/analytics/funnel?period=mtd|qtd|ytd|custom&start=&end=
adminAnalyticsRoutes.get("/funnel", async (c) => {
  let window: ResolvedRevenueWindow;
  try {
    window = resolveRevenueWindow({
      period: c.req.query("period"),
      start: c.req.query("start"),
      end: c.req.query("end"),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Invalid period" },
      400,
    );
  }

  const { data, error } = await supabaseAdmin.rpc("funnel_metrics", {
    p_start: window.start,
    p_end: window.end,
  });

  if (error) {
    console.error("[admin-analytics] funnel_metrics failed:", error);
    return c.json({ error: "Failed to load funnel metrics" }, 500);
  }

  return c.json({ window, funnel: data });
});

// GET /api/admin/analytics/channels — US-2101 AC5: first-touch UTM channel
// attribution (source/medium/campaign → converting-user counts), so the
// organic / email / social / content investment is finally measurable. The
// aggregation is the SECURITY DEFINER channel_attribution() RPC (00492); it
// returns only counts, never a user id.
adminAnalyticsRoutes.get("/channels", async (c) => {
  const { data, error } = await supabaseAdmin.rpc("channel_attribution");
  if (error) {
    console.error("[admin-analytics] channel_attribution failed:", error);
    return c.json({ error: "Failed to load channel attribution" }, 500);
  }
  return c.json({ channels: data ?? [] });
});

// GET /api/admin/analytics/retention — fixed last-12-weeks weekly cohort grid.
adminAnalyticsRoutes.get("/retention", async (c) => {
  const { data, error } = await supabaseAdmin.rpc("retention_cohorts");

  if (error) {
    console.error("[admin-analytics] retention_cohorts failed:", error);
    return c.json({ error: "Failed to load retention cohorts" }, 500);
  }

  return c.json({ retention: data });
});
