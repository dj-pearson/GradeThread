import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// US-909: per-admin saved views for the admin list pages.
//
// Mounted at /api/admin/views — inherits authMiddleware + adminAuthMiddleware
// (admin/super_admin + AAL2 MFA) from the /api/admin/* group in main.ts. Every
// read/write is scoped to the CALLING admin (c.get("userId")) so views are
// PRIVATE to the admin who saved them — there is no cross-admin visibility.
// Service-role client on a deny-all table (admin_saved_views, migration 00297);
// the SPA never reads the raw rows.
//
// GET    /?surface=users        list this admin's views for a surface
// POST   /  { surface, name, filter }   save the current filter as a named view
// DELETE /:id                    remove one of this admin's views

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminViewsRoutes = new Hono<AdminEnv>();

// Whitelist the list pages that support saved views, so a typo'd surface can't
// silently fragment a view into an unreachable namespace.
const VALID_SURFACES = new Set([
  "users",
  "signals",
  "tickets",
  "reconciliation",
]);

const MAX_NAME_CHARS = 80;
const MAX_VIEWS_PER_SURFACE = 50;

interface SavedViewRow {
  id: string;
  surface: string;
  name: string;
  filter: Record<string, unknown>;
  created_at: string;
}

// GET / — this admin's saved views, optionally filtered to one surface.
adminViewsRoutes.get("/", async (c) => {
  const adminId = c.get("userId");
  const surface = c.req.query("surface");
  if (surface && !VALID_SURFACES.has(surface)) {
    return c.json({ error: "Unknown surface" }, 400);
  }

  let query = supabaseAdmin
    .from("admin_saved_views")
    .select("id, surface, name, filter, created_at")
    .eq("admin_user_id", adminId)
    .order("created_at", { ascending: true });
  if (surface) query = query.eq("surface", surface);

  const { data, error } = await query;
  if (error) {
    console.error("[admin-views] list failed:", error.message);
    return c.json({ error: "Could not load saved views" }, 500);
  }
  return c.json({ views: (data ?? []) as SavedViewRow[] });
});

// POST / — save the current filter set as a named view for this admin.
adminViewsRoutes.post("/", async (c) => {
  const adminId = c.get("userId");

  let body: { surface?: unknown; name?: unknown; filter?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const surface = typeof body.surface === "string" ? body.surface : "";
  if (!VALID_SURFACES.has(surface)) {
    return c.json({ error: "Unknown surface" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_CHARS) : "";
  if (!name) return c.json({ error: "A view name is required" }, 400);
  // filter must be a plain JSON object (never an array / scalar).
  const filter = body.filter;
  if (
    filter === null ||
    typeof filter !== "object" ||
    Array.isArray(filter)
  ) {
    return c.json({ error: "filter must be an object" }, 400);
  }

  // Cap per-surface views so a stuck client can't fill the table.
  const { count } = await supabaseAdmin
    .from("admin_saved_views")
    .select("id", { count: "exact", head: true })
    .eq("admin_user_id", adminId)
    .eq("surface", surface);
  if ((count ?? 0) >= MAX_VIEWS_PER_SURFACE) {
    return c.json(
      { error: `You can save at most ${MAX_VIEWS_PER_SURFACE} views per page.` },
      409,
    );
  }

  const { data, error } = await supabaseAdmin
    .from("admin_saved_views")
    .insert({
      admin_user_id: adminId,
      surface,
      name,
      filter,
    } as never)
    .select("id, surface, name, filter, created_at")
    .maybeSingle();
  if (error || !data) {
    console.error("[admin-views] save failed:", error?.message);
    return c.json({ error: "Could not save view" }, 500);
  }
  return c.json({ view: data as SavedViewRow }, 201);
});

// DELETE /:id — remove one of THIS admin's views (the admin_user_id scope makes
// another admin's id a no-op 404 rather than a cross-admin delete).
adminViewsRoutes.delete("/:id", async (c) => {
  const adminId = c.get("userId");
  const id = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("admin_saved_views")
    .delete()
    .eq("id", id)
    .eq("admin_user_id", adminId)
    .select("id");
  if (error) {
    console.error("[admin-views] delete failed:", error.message);
    return c.json({ error: "Could not delete view" }, 500);
  }
  if (!data || data.length === 0) {
    return c.json({ error: "View not found" }, 404);
  }
  return c.json({ ok: true });
});
