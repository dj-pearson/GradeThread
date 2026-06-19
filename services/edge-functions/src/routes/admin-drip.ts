import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// US-946: Trial-conversion drip analytics (read-only).
//
// Mounted at /api/admin/drip, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. The aggregation
// lives in the `drip_analytics` RPC (migration 00253), which rolls the
// enrollment/send/attribution tables into one bounded jsonb document
// (funnel, cohorts, phase + incentive + A/B splits, attention flags). This
// route only resolves the requested period + campaign and forwards it. No
// writes, so no audit log / step-up.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminDripRoutes = new Hono<AdminEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;

// Named lookback windows → days. `custom` honors explicit start/end.
const PERIOD_DAYS: Record<string, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

// GET /api/admin/drip/analytics?campaign=trial_conversion&period=90d
//     [&start=ISO&end=ISO]  (period=custom)
adminDripRoutes.get("/analytics", async (c) => {
  const campaign = (c.req.query("campaign") ?? "trial_conversion").trim() ||
    "trial_conversion";
  const period = c.req.query("period") ?? "90d";

  let start: string;
  let end: string;

  if (period === "custom") {
    const rawStart = c.req.query("start");
    const rawEnd = c.req.query("end");
    const startMs = rawStart ? Date.parse(rawStart) : NaN;
    const endMs = rawEnd ? Date.parse(rawEnd) : NaN;
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
      return c.json({ error: "Invalid custom start/end range" }, 400);
    }
    start = new Date(startMs).toISOString();
    end = new Date(endMs).toISOString();
  } else {
    const days = PERIOD_DAYS[period];
    if (!days) {
      return c.json(
        { error: `Unknown period '${period}' (expected 30d|90d|180d|365d|custom)` },
        400,
      );
    }
    const now = Date.now();
    start = new Date(now - days * DAY_MS).toISOString();
    end = new Date(now).toISOString();
  }

  const { data, error } = await supabaseAdmin.rpc("drip_analytics", {
    p_campaign: campaign,
    p_start: start,
    p_end: end,
  });

  if (error) {
    console.error("[admin-drip] drip_analytics failed:", error);
    return c.json({ error: "Failed to load drip analytics" }, 500);
  }

  return c.json({
    period,
    campaign,
    window: { start, end },
    analytics: data,
    // Stripe stays authoritative for realized conversions/MRR; the RPC reports a
    // reconciliation rate + documented tolerance so the client can surface it.
    stripeSourceOfTruth: true,
  });
});
