import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  summarizeExtractionAccuracy,
  type ExtractionLogRow,
} from "../lib/extraction-accuracy.ts";

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

// GET /api/admin/ai/extraction-accuracy?days=30&model=...&brand=...&category=...
// US-1531: per-field suggestion→correction rates from ai_enrichment_log
// (accepted_fields + corrected_fields), aggregated by the pure
// summarizeExtractionAccuracy core. Read-only; no PII beyond field values the
// user already typed. brand/category filter via the inventory_items FK embed.
const ACCURACY_MAX_ROWS = 2000;

adminAiSpendRoutes.get("/extraction-accuracy", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30") || 30, 1), 365);
  const model = c.req.query("model")?.trim() || null;
  const brand = c.req.query("brand")?.trim() || null;
  const category = c.req.query("category")?.trim() || null;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let query = supabaseAdmin
    .from("ai_enrichment_log")
    .select(
      brand || category
        ? "accepted_fields, corrected_fields, model, created_at, inventory_items!inner(brand, item_category)"
        : "accepted_fields, corrected_fields, model, created_at",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(ACCURACY_MAX_ROWS);
  if (model) query = query.eq("model", model);
  if (brand) query = query.ilike("inventory_items.brand", brand);
  if (category) query = query.eq("inventory_items.item_category", category);

  const { data, error } = await query;
  if (error) {
    console.error("[admin-ai-spend] extraction-accuracy failed:", error);
    return c.json({ error: "Failed to load extraction accuracy" }, 500);
  }

  const rows = (data ?? []) as unknown as ExtractionLogRow[];
  return c.json({
    fields: summarizeExtractionAccuracy(rows),
    sample_size: rows.length,
    truncated: rows.length === ACCURACY_MAX_ROWS,
    days,
  });
});
