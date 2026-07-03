// US-722: admin management of the per-platform category map.
//
// Mounted at /api/admin/category-map — the /api/admin/* middleware (auth +
// adminAuthMiddleware) already protects it. Lets an operator extend or override
// the seeded/AI category mappings WITHOUT a redeploy: confirm an AI suggestion,
// add a mapping for a garment type the seed doesn't cover, or correct a leaf.
// The shared marketplace_category_map table is read by every seller's listing
// generation, so an admin fix benefits everyone (and repeat items cost ~0 AI).
//
// eBay/Shopify are NOT managed here (Taxonomy API / free-form).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { MAPPED_PLATFORMS } from "../lib/marketplace-category.ts";
import type { MarketplacePlatform } from "../lib/marketplace-specs.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminCategoryMapRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminCategoryMapRoutes.use("*", requireScope("marketplace:write"));

const SELECT_COLS =
  "id, platform, gradethread_garment, platform_category, department, source, " +
  "confidence, needs_confirmation, created_by, updated_at";

// ── GET / ─────────────────────────────────────────────────────────
// All mappings, newest first; optional ?platform= filter.
adminCategoryMapRoutes.get("/", async (c) => {
  const platform = c.req.query("platform");
  let q = supabaseAdmin
    .from("marketplace_category_map")
    .select(SELECT_COLS)
    .order("platform")
    .order("gradethread_garment");
  if (platform) q = q.eq("platform", platform);
  const { data, error } = await q;
  if (error) return jsonError(c, 500, "Failed to load category map");
  return c.json({ mappings: data ?? [] });
});

interface ValidMapping {
  platform: MarketplacePlatform;
  gradethread_garment: string;
  platform_category: string;
  department: string | null;
}

export function validateMapping(
  body: Record<string, unknown>,
): { ok: true; value: ValidMapping } | { ok: false; error: string } {
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  if (!MAPPED_PLATFORMS.has(platform as MarketplacePlatform)) {
    return {
      ok: false,
      error: `platform must be one of: ${[...MAPPED_PLATFORMS].join(", ")}`,
    };
  }
  const garment = typeof body.gradethread_garment === "string"
    ? body.gradethread_garment.trim().toLowerCase()
    : "";
  if (!garment) return { ok: false, error: "gradethread_garment is required" };

  const category = typeof body.platform_category === "string"
    ? body.platform_category.trim()
    : "";
  if (!category) return { ok: false, error: "platform_category is required" };

  const department = typeof body.department === "string" && body.department.trim()
    ? body.department.trim().slice(0, 60)
    : null;

  return {
    ok: true,
    value: {
      platform: platform as MarketplacePlatform,
      gradethread_garment: garment.slice(0, 80),
      platform_category: category.slice(0, 200),
      department,
    },
  };
}

// ── PUT / ─────────────────────────────────────────────────────────
// Upsert an admin mapping (also confirms an AI guess: source→admin, no pick).
adminCategoryMapRoutes.put("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const valid = validateMapping(body);
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const userId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("marketplace_category_map")
    .upsert(
      {
        ...valid.value,
        source: "admin",
        confidence: null,
        needs_confirmation: false,
        created_by: userId,
      },
      { onConflict: "platform,gradethread_garment" },
    )
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to save mapping");

  await writeAuditLog(c, {
    action: "category_map.upsert",
    targetType: "marketplace_category_map",
    targetId: `${valid.value.platform}:${valid.value.gradethread_garment}`,
    after: data,
  });

  return c.json({ ok: true, mapping: data });
});

// ── DELETE /:id ───────────────────────────────────────────────────
// Remove an override (the seed/AI layer re-resolves on the next item).
adminCategoryMapRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { data: before } = await supabaseAdmin
    .from("marketplace_category_map")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Mapping not found");

  const { error } = await supabaseAdmin
    .from("marketplace_category_map")
    .delete()
    .eq("id", id);
  if (error) return jsonError(c, 500, "Failed to delete mapping");

  await writeAuditLog(c, {
    action: "category_map.delete",
    targetType: "marketplace_category_map",
    targetId: id,
    before,
  });

  return c.json({ ok: true });
});
