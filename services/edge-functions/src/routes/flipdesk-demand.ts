// US-1831: seller-facing demand signal — aggregated PUBLIC buyer wants.
//
// Reads active PUBLIC wants (visibility='public') and returns a PII-SAFE
// aggregate (per-brand / per-category counts + strongest grade/budget signal) so
// a seller sees what to source, grade, and list. No buyer identity leaves here —
// the aggregation is the privacy boundary. Global signal (NOT tenant-scoped): a
// logged-in seller sees the same market demand. Mounted at /api/flipdesk/demand.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { aggregatePublicWants, type PublicWantRow } from "../lib/demand-board.ts";

export const flipdeskDemandRoutes = new Hono();

const MAX_PUBLIC_WANTS = 5000;

flipdeskDemandRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("buyer_wants")
    .select("brands, categories, min_grade, max_price_cents")
    .eq("visibility", "public")
    .eq("status", "active")
    .limit(MAX_PUBLIC_WANTS);
  if (error) {
    console.error("[flipdesk-demand] load failed:", error.message);
    return c.json({ error: "Could not load demand." }, 500);
  }
  return c.json(aggregatePublicWants((data ?? []) as PublicWantRow[]));
});
