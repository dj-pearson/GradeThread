import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  resolveRevenueWindow,
  type ResolvedRevenueWindow,
} from "../lib/revenue-window.ts";

// US-891: Revenue & MRR analytics dashboard (read-only).
//
// Mounted at /api/admin/revenue, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. The heavy lifting
// is the `revenue_dashboard` RPC (migration 00215) which aggregates everything
// server-side into one jsonb document; this route only resolves the named period
// (MTD / QTD / YTD / custom) into a concrete window + granularity and forwards
// it. No writes, so no audit log / step-up.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminRevenueRoutes = new Hono<AdminEnv>();

// GET /api/admin/revenue/summary?period=mtd|qtd|ytd|custom&start=&end=&granularity=
adminRevenueRoutes.get("/summary", async (c) => {
  let window: ResolvedRevenueWindow;
  try {
    window = resolveRevenueWindow({
      period: c.req.query("period"),
      start: c.req.query("start"),
      end: c.req.query("end"),
      granularity: c.req.query("granularity"),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Invalid period" },
      400,
    );
  }

  const { data, error } = await supabaseAdmin.rpc("revenue_dashboard", {
    p_start: window.start,
    p_end: window.end,
    p_granularity: window.granularity,
  });

  if (error) {
    console.error("[admin-revenue] revenue_dashboard failed:", error);
    return c.json({ error: "Failed to load revenue summary" }, 500);
  }

  return c.json({
    window,
    summary: data,
    // Stripe stays authoritative for cash collected — surface it so the client
    // can show the reconciliation note without hardcoding it (AC4).
    stripeSourceOfTruth: true,
  });
});
