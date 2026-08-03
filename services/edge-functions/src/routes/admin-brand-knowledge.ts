import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { resolveBrandKnowledgePack } from "../lib/brand-knowledge.ts";
import { validateTellsForWrite } from "../lib/brand-authenticity.ts";

// US-1715: admin authoring + verification surface for the Brand & Style
// Knowledge Base (00389 tables: brand_knowledge / brand_styles /
// brand_style_codes / brand_colorways / brand_size_charts). Mounted at
// /api/admin/brand-knowledge, it inherits authMiddleware + adminAuthMiddleware
// (admin/super_admin + AAL2 MFA) from the /api/admin/* group in main.ts, plus a
// whole-router content:publish scope guard.
//
// The five tables are GLOBAL REFERENCE (no user_id / tenant, deny-all RLS), so
// all reads + writes run service-role and the admin+MFA+scope gate IS the
// authorization boundary — there is intentionally no per-tenant scoping. This is
// where AI-drafted / migration-seeded facts get human-VERIFIED (verified=true)
// or corrected; every fact carries source_url + confidence so a reviewer can
// judge it. `updated_by` is stamped with the acting admin for attribution.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminBrandKnowledgeRoutes = new Hono<AdminEnv>();

// Whole-router scope guard (registered in lib/admin-scope-map.ts).
adminBrandKnowledgeRoutes.use("*", requireScope("content:publish"));

const db = supabaseAdmin as unknown as CheckedUpdateClient;

// The five KB tables and the columns an admin may edit on each. brand_key is
// deliberately NOT editable — it's the identity/link key. Anything not listed
// is rejected, so a typo can never write an arbitrary column.
const KB_TABLES: Record<string, readonly string[]> = {
  brand_knowledge: [
    "canonical_brand", "aliases", "category_focus", "registered_numbers",
    "tag_eras", "country_patterns", "authentication_tells", "notes",
    "source_url", "confidence", "verified",
  ],
  brand_styles: [
    "style_name", "aliases", "product_line", "department", "category",
    "visual_fingerprint", "fabric_tech", "era", "msrp_band", "keywords",
    "source_url", "confidence", "verified",
  ],
  brand_style_codes: [
    "decoder_kind", "description", "pattern", "extraction_rules", "examples",
    "source_url", "confidence", "verified",
  ],
  brand_colorways: [
    "color_name", "aliases", "hex", "years",
    "source_url", "confidence", "verified",
  ],
  brand_size_charts: [
    "brand_label", "brand_match", "department", "garment", "category_match",
    "rows", "note", "source_url", "confidence", "verified",
  ],
};
const CHILD_TABLES = [
  "brand_styles", "brand_style_codes", "brand_colorways", "brand_size_charts",
] as const;

// ── GET / — list brands with child-row counts ────────────────────────────────
adminBrandKnowledgeRoutes.get("/", async (c) => {
  const { data: brands, error } = await supabaseAdmin
    .from("brand_knowledge")
    .select(
      "id, brand_key, canonical_brand, aliases, category_focus, verified, confidence, source_url, updated_by, updated_at",
    )
    .order("canonical_brand", { ascending: true });
  if (error) {
    console.error("[admin-brand-kb] list failed:", error.message);
    return c.json({ error: "Could not load brands" }, 500);
  }

  // Cheap per-brand child counts (the KB is small — dozens of brands).
  const counts: Record<string, Record<string, number>> = {};
  for (const table of CHILD_TABLES) {
    const { data } = await supabaseAdmin.from(table).select("brand_key");
    for (const row of (data ?? []) as Array<{ brand_key: string }>) {
      (counts[row.brand_key] ??= {})[table] =
        ((counts[row.brand_key] ??= {})[table] ?? 0) + 1;
    }
  }

  const rows = (brands ?? []).map((b) => ({
    ...b,
    counts: counts[(b as { brand_key: string }).brand_key] ?? {},
  }));
  return c.json({ brands: rows });
});

// ── GET /:brandKey — all facts for a brand + the compact pack preview ─────────
adminBrandKnowledgeRoutes.get("/:brandKey", async (c) => {
  const brandKey = c.req.param("brandKey");

  const [knowledge, styles, codes, colorways, charts] = await Promise.all([
    supabaseAdmin.from("brand_knowledge").select("*").eq("brand_key", brandKey)
      .maybeSingle(),
    supabaseAdmin.from("brand_styles").select("*").eq("brand_key", brandKey)
      .order("style_name", { ascending: true }),
    supabaseAdmin.from("brand_style_codes").select("*").eq("brand_key", brandKey)
      .order("decoder_kind", { ascending: true }),
    supabaseAdmin.from("brand_colorways").select("*").eq("brand_key", brandKey)
      .order("color_name", { ascending: true }),
    supabaseAdmin.from("brand_size_charts").select("*").eq("brand_key", brandKey)
      .order("department", { ascending: true }),
  ]);

  const err = knowledge.error || styles.error || codes.error ||
    colorways.error || charts.error;
  if (err) {
    console.error("[admin-brand-kb] detail failed:", err.message);
    return c.json({ error: "Could not load brand knowledge" }, 500);
  }

  // Pack preview — EXACTLY what the extractor (US-1713) would receive for this
  // brand, so a reviewer sees the effect of their edits (noCache = live).
  let pack = null;
  const canonical = (knowledge.data as { canonical_brand?: string } | null)
    ?.canonical_brand;
  if (canonical) {
    try {
      pack = await resolveBrandKnowledgePack(canonical, { noCache: true });
    } catch (e) {
      console.warn(
        "[admin-brand-kb] pack preview failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return c.json({
    knowledge: knowledge.data ?? null,
    styles: styles.data ?? [],
    codes: codes.data ?? [],
    colorways: colorways.data ?? [],
    charts: charts.data ?? [],
    pack,
  });
});

// Validate + coerce a patch against a table's editable-column allow-list.
// Exported for unit testing — it is the write-safety boundary (a non-editable
// column, a bad confidence, or a non-boolean verified must never reach the DB).
export function buildPatch(
  table: string,
  body: Record<string, unknown>,
): { patch: Record<string, unknown> } | { error: string } {
  const allowed = KB_TABLES[table];
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) continue; // silently drop non-editable keys
    if (key === "confidence") {
      if (value === null) { patch.confidence = null; continue; }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { error: "confidence must be a number in [0,1]" };
      }
      patch.confidence = n;
      continue;
    }
    if (key === "verified") {
      if (typeof value !== "boolean") {
        return { error: "verified must be a boolean" };
      }
      patch.verified = value;
      continue;
    }
    // US-1768: enforce STRUCTURED authentication tells on write. The generic
    // JSONB column would otherwise accept any shape; here we require an array of
    // checkable {category, claim, check, confidence, ...} entries and store the
    // canonicalized result (unknown categories → 'other', confidence clamped).
    if (table === "brand_knowledge" && key === "authentication_tells") {
      const v = validateTellsForWrite(value);
      if (!v.ok) return { error: v.error };
      patch.authentication_tells = v.tells;
      continue;
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    return { error: "No editable fields in the request" };
  }
  return { patch };
}

// ── PATCH /:table/:id — edit or verify one fact ──────────────────────────────
adminBrandKnowledgeRoutes.patch("/:table/:id", async (c) => {
  const table = c.req.param("table");
  const id = c.req.param("id");
  const adminId = c.get("userId");
  // US-2356 AC5: `in` walks the PROTOTYPE CHAIN, so "toString",
  // "constructor", "valueOf" and friends all satisfied this allow-list.
  // Nothing catastrophic followed — the lookup then yields undefined and the
  // request dies on a TypeError or at PostgREST — but an allow-list that admits
  // names it does not list is not an allow-list, and "it fails later anyway" is
  // the argument that keeps a weak check in place right up until the thing after
  // it stops failing.
  if (!Object.hasOwn(KB_TABLES, table)) {
    return c.json({ error: "Unknown brand-knowledge table" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const built = buildPatch(table, body);
  if ("error" in built) return c.json({ error: built.error }, 400);

  // Read the prior row for the audit trail.
  const { data: before } = await supabaseAdmin.from(table).select("*").eq(
    "id",
    id,
  ).maybeSingle();
  if (!before) return c.json({ error: "Row not found" }, 404);

  const patch = { ...built.patch, updated_by: `admin:${adminId}` };
  try {
    await updateByIdChecked(db, table, id, patch);
  } catch (e) {
    if (e instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Row not found" }, 404);
    }
    console.error("[admin-brand-kb] update failed:", e);
    return c.json({ error: "Update failed" }, 500);
  }

  const { data: after } = await supabaseAdmin.from(table).select("*").eq(
    "id",
    id,
  ).maybeSingle();
  await writeAuditLog(c, {
    action: "brand_knowledge.update",
    targetType: table,
    targetId: id,
    before,
    after,
  });
  return c.json({ row: after });
});

// ── DELETE /:table/:id — remove a bad fact ───────────────────────────────────
adminBrandKnowledgeRoutes.delete("/:table/:id", async (c) => {
  const table = c.req.param("table");
  const id = c.req.param("id");
  if (!Object.hasOwn(KB_TABLES, table)) {
    return c.json({ error: "Unknown brand-knowledge table" }, 400);
  }

  const { data: before } = await supabaseAdmin.from(table).select("*").eq(
    "id",
    id,
  ).maybeSingle();
  if (!before) return c.json({ error: "Row not found" }, 404);

  const { error } = await supabaseAdmin.from(table).delete().eq("id", id);
  if (error) {
    console.error("[admin-brand-kb] delete failed:", error.message);
    return c.json({ error: "Delete failed" }, 500);
  }
  await writeAuditLog(c, {
    action: "brand_knowledge.delete",
    targetType: table,
    targetId: id,
    before,
  });
  return c.json({ ok: true });
});
