import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// Account data portability (US-275 / GDPR + CCPA). Authed user exports a copy
// of their own data. Mounted behind authMiddleware in main.ts, so c.var.userId
// is the caller. Every query is scoped to that user — directly by user_id, or
// through the parent row's ownership (grade_reports via submission, listings/
// sales via inventory_item).

type AccountEnv = { Variables: { userId: string } };

export const accountRoutes = new Hono<AccountEnv>();

accountRoutes.get("/export", async (c) => {
  const userId = c.get("userId");

  const [profile, submissions, inventory, sources] = await Promise.all([
    supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle(),
    supabaseAdmin.from("submissions").select("*").eq("user_id", userId),
    supabaseAdmin.from("inventory_items").select("*").eq("user_id", userId),
    supabaseAdmin.from("sources").select("*").eq("user_id", userId),
  ]);

  const submissionIds = (submissions.data ?? []).map((r) => (r as { id: string }).id);
  const itemIds = (inventory.data ?? []).map((r) => (r as { id: string }).id);

  // Children scoped through the owned parents (these tables have no user_id).
  const [gradeReports, listings, sales] = await Promise.all([
    submissionIds.length
      ? supabaseAdmin.from("grade_reports").select("*").in("submission_id", submissionIds)
      : Promise.resolve({ data: [] }),
    itemIds.length
      ? supabaseAdmin.from("listings").select("*").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] }),
    itemIds.length
      ? supabaseAdmin.from("sales").select("*").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] }),
  ]);

  const payload = {
    exported_at: new Date().toISOString(),
    user_id: userId,
    profile: profile.data ?? null,
    submissions: submissions.data ?? [],
    grade_reports: gradeReports.data ?? [],
    inventory_items: inventory.data ?? [],
    listings: listings.data ?? [],
    sales: sales.data ?? [],
    sources: sources.data ?? [],
  };

  return c.json(payload, 200, {
    "Content-Disposition": `attachment; filename="gradethread-export-${userId}.json"`,
  });
});
