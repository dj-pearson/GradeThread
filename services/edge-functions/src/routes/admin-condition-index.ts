// US-846: admin curation surface for the Condition Index catalog.
//
// Mounted at /api/admin/condition-index — the /api/admin/* middleware (auth +
// adminAuthMiddleware, incl. the AAL2/MFA gate) already protects every route
// here. Lets an operator list / create / edit / disable condition_index_seeds
// and trigger an on-demand comp refresh for one entry or the whole catalog
// WITHOUT a deploy (the catalog became data-driven in US-845).
//
// PLATFORM-level config, not tenant data: condition_index_seeds is RLS deny-all
// (00190) and read/written exclusively by the service-role edge client. The
// admin gate is the authz boundary. Every mutation is audited.
//
// Sample depth + last-refreshed come from the matching condition_price_curves
// row (joined on slug, which refreshIndexSeed stamps). Entries below
// MIN_INDEX_TOTAL_SAMPLE never publish (US-622), so we flag them for pruning.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  type IndexSeed,
  MIN_INDEX_TOTAL_SAMPLE,
  refreshConditionIndex,
  refreshIndexSeed,
} from "../lib/condition-index.ts";
import { requireScope } from "../lib/scope-guard.ts";
import {
  SHADOW_SAMPLES_TABLE,
  type ShadowDeltaSampleRow,
  summarizeShadowDeltas,
} from "../lib/condition-value-shadow.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminConditionIndexRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminConditionIndexRoutes.use("*", requireScope("content:publish"));

const SEED_COLS =
  "id, slug, label, brand, category_id, q, enabled, priority, source, generated_at, created_at, updated_at";

interface SeedRow {
  id: string;
  slug: string;
  label: string;
  brand: string;
  category_id: string;
  q: string | null;
  enabled: boolean;
  priority: number;
  // US-1746: 'curated' (hand-added) or 'generated' (proposed by the seed-gen cron).
  source: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

function seedFromRow(row: SeedRow): IndexSeed {
  return {
    slug: row.slug,
    label: row.label,
    brand: row.brand,
    categoryId: row.category_id,
    q: row.q ?? undefined,
  };
}

// ── Validation ────────────────────────────────────────────────────
// Slugs are public URL segments (/condition-index/<slug>) — lowercase
// alphanumerics + single hyphens, the same shape we seeded in 00190.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ValidatedSeed {
  slug?: string;
  label?: string;
  brand?: string;
  category_id?: string;
  q?: string | null;
  enabled?: boolean;
  priority?: number;
}

function validateSeedBody(
  body: Record<string, unknown>,
  { requireCore }: { requireCore: boolean },
): { ok: true; value: ValidatedSeed } | { ok: false; error: string } {
  const out: ValidatedSeed = {};

  const strField = (
    key: "slug" | "label" | "brand" | "category_id",
    max: number,
  ): string | null => {
    const v = body[key];
    if (typeof v !== "string" || !v.trim()) return null;
    return v.trim().slice(0, max);
  };

  // slug — required on create, validated against the public-URL shape.
  if (body.slug !== undefined || requireCore) {
    const slug = strField("slug", 120);
    if (!slug || !SLUG_RE.test(slug)) {
      return { ok: false, error: "slug must be lowercase alphanumerics + hyphens" };
    }
    out.slug = slug;
  }

  for (const key of ["label", "brand", "category_id"] as const) {
    if (body[key] === undefined && !requireCore) continue;
    const v = strField(key, key === "category_id" ? 32 : 120);
    if (!v) return { ok: false, error: `${key} must be a non-empty string` };
    out[key] = v;
  }
  // category_id is an eBay numeric category — keep it digits-only.
  if (out.category_id !== undefined && !/^\d+$/.test(out.category_id)) {
    return { ok: false, error: "category_id must be a numeric eBay category id" };
  }

  if (body.q !== undefined) {
    if (body.q === null || body.q === "") {
      out.q = null;
    } else if (typeof body.q === "string") {
      out.q = body.q.trim().slice(0, 120) || null;
    } else {
      return { ok: false, error: "q must be a string or null" };
    }
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    out.enabled = body.enabled;
  }

  if (body.priority !== undefined) {
    const n = typeof body.priority === "number" ? body.priority : Number(body.priority);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) {
      return { ok: false, error: "priority must be an integer in [0, 100000]" };
    }
    out.priority = n;
  }

  if (!requireCore && Object.keys(out).length === 0) {
    return { ok: false, error: "No editable fields provided" };
  }
  return { ok: true, value: out };
}

// ── GET / — list seeds enriched with current sample depth + refreshed_at ──
adminConditionIndexRoutes.get("/", async (c) => {
  const { data: seedData, error } = await supabaseAdmin
    .from("condition_index_seeds")
    .select(SEED_COLS)
    .order("priority", { ascending: true })
    .order("label", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load Condition Index seeds");

  const seeds = (seedData ?? []) as SeedRow[];

  // Join each seed to its published curve by slug (refreshIndexSeed stamps slug
  // onto the curve row). One query, then map by slug.
  const slugs = seeds.map((s) => s.slug);
  const curveBySlug = new Map<string, { total_sample_size: number; refreshed_at: string }>();
  if (slugs.length > 0) {
    const { data: curveData } = await supabaseAdmin
      .from("condition_price_curves")
      .select("slug, total_sample_size, refreshed_at")
      .in("slug", slugs);
    for (const row of (curveData ?? []) as Array<{
      slug: string | null;
      total_sample_size: number;
      refreshed_at: string;
    }>) {
      if (row.slug) {
        curveBySlug.set(row.slug, {
          total_sample_size: row.total_sample_size,
          refreshed_at: row.refreshed_at,
        });
      }
    }
  }

  const items = seeds.map((s) => {
    const curve = curveBySlug.get(s.slug);
    const sampleDepth = curve?.total_sample_size ?? null;
    return {
      ...s,
      sample_depth: sampleDepth,
      refreshed_at: curve?.refreshed_at ?? null,
      // Below the publish floor (or never refreshed) → flag for pruning.
      below_threshold: sampleDepth == null || sampleDepth < MIN_INDEX_TOTAL_SAMPLE,
    };
  });

  return c.json({ seeds: items, publishThreshold: MIN_INDEX_TOTAL_SAMPLE });
});

// ── POST / — create a seed ────────────────────────────────────────
adminConditionIndexRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const valid = validateSeedBody(body, { requireCore: true });
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const { data, error } = await supabaseAdmin
    .from("condition_index_seeds")
    .insert({
      slug: valid.value.slug,
      label: valid.value.label,
      brand: valid.value.brand,
      category_id: valid.value.category_id,
      q: valid.value.q ?? null,
      enabled: valid.value.enabled ?? true,
      priority: valid.value.priority ?? 100,
    })
    .select(SEED_COLS)
    .maybeSingle();

  if (error) {
    // Unique-violation on slug → 409 so the UI can message it cleanly.
    if (error.code === "23505") {
      return jsonError(c, 409, "A seed with that slug already exists");
    }
    return jsonError(c, 500, "Failed to create seed");
  }

  await writeAuditLog(c, {
    action: "condition_index_seed.create",
    targetType: "condition_index_seed",
    targetId: (data as SeedRow | null)?.id ?? null,
    after: data,
  });

  return c.json({ ok: true, seed: data });
});

// ── PUT /:id — edit a seed (any subset; enabled toggle lives here too) ──
adminConditionIndexRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const valid = validateSeedBody(body, { requireCore: false });
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const { data: before } = await supabaseAdmin
    .from("condition_index_seeds")
    .select(SEED_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Seed not found");

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valid.value)) update[k] = v;

  const { data: after, error } = await supabaseAdmin
    .from("condition_index_seeds")
    .update(update)
    .eq("id", id)
    .select(SEED_COLS)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      return jsonError(c, 409, "A seed with that slug already exists");
    }
    return jsonError(c, 500, "Failed to update seed");
  }

  await writeAuditLog(c, {
    action: "condition_index_seed.update",
    targetType: "condition_index_seed",
    targetId: id,
    before,
    after,
  });

  return c.json({ ok: true, seed: after });
});

// ── DELETE /:id — hard-prune a seed ───────────────────────────────
// The matching condition_price_curves row is intentionally left in place: it's
// keyed by item_key (aggregate, non-tenant) and the hub/curve readers only
// surface curves whose slug is non-null — orphaning is harmless and the curve
// simply stops being refreshed.
adminConditionIndexRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { data: before } = await supabaseAdmin
    .from("condition_index_seeds")
    .select(SEED_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Seed not found");

  const { error } = await supabaseAdmin
    .from("condition_index_seeds")
    .delete()
    .eq("id", id);
  if (error) return jsonError(c, 500, "Failed to delete seed");

  await writeAuditLog(c, {
    action: "condition_index_seed.delete",
    targetType: "condition_index_seed",
    targetId: id,
    before,
  });

  return c.json({ ok: true });
});

// ── POST /:id/refresh — on-demand comp refresh for one entry ───────
adminConditionIndexRoutes.post("/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const { data: row } = await supabaseAdmin
    .from("condition_index_seeds")
    .select(SEED_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!row) return jsonError(c, 404, "Seed not found");

  const ok = await refreshIndexSeed(seedFromRow(row as SeedRow));
  if (!ok) return jsonError(c, 502, "Comp refresh failed for this entry");

  // Read back the freshly-stamped depth for the UI.
  const { data: curve } = await supabaseAdmin
    .from("condition_price_curves")
    .select("total_sample_size, refreshed_at")
    .eq("slug", (row as SeedRow).slug)
    .maybeSingle();

  await writeAuditLog(c, {
    action: "condition_index_seed.refresh",
    targetType: "condition_index_seed",
    targetId: id,
    details: { slug: (row as SeedRow).slug },
  });

  return c.json({
    ok: true,
    sample_depth: (curve as { total_sample_size?: number } | null)?.total_sample_size ?? null,
    refreshed_at: (curve as { refreshed_at?: string } | null)?.refreshed_at ?? null,
  });
});

// ── POST /refresh — refresh the whole catalog ─────────────────────
// Reuses the cron job-lock so a manual click can't pile on top of the scheduled
// run (or another admin clicking) — eBay comp pulls are network-heavy.
adminConditionIndexRoutes.post("/refresh", async (c) => {
  const lock = await acquireJobLock("condition-index-refresh", 600);
  if (!lock.acquired) {
    return c.json({ ok: false, skipped: true, reason: lock.reason ?? "A refresh is already running" }, 409);
  }
  try {
    const result = await refreshConditionIndex();
    await writeAuditLog(c, {
      action: "condition_index.refresh_all",
      targetType: "condition_index",
      details: { ...result },
    });
    return c.json({ ok: true, ...result });
  } finally {
    await lock.release();
  }
});

// -- GET /shadow-deltas -- how far measured sits from live, per cell ---------
//
// US-2848 AC4. The shadow writes one row per cell per graded request once that
// cell has a measured curve; this is the read that turns those rows into the
// one number a flip decision needs, which is median absolute delta by cell.
//
// THE CAP IS REPORTED, NOT HIDDEN. A window wider than MAX_SHADOW_ROWS rows
// comes back with `truncated: true` and the medians computed on the newest
// slice. A silently trimmed sample would read exactly like a complete one,
// which is the failure this endpoint exists to avoid making elsewhere.
const MAX_SHADOW_ROWS = 5000;

adminConditionIndexRoutes.get("/shadow-deltas", async (c) => {
  const rawDays = Number.parseInt(c.req.query("days") ?? "30", 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const cell = (c.req.query("cell") ?? "").trim();

  let q = supabaseAdmin
    .from(SHADOW_SAMPLES_TABLE)
    .select("cell_key, grade, live_median_cents, measured_median_cents, delta_cents, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_SHADOW_ROWS);
  if (cell) q = q.eq("cell_key", cell);

  const { data, error } = await q;
  if (error) {
    console.warn("[admin-condition-index] shadow-deltas read failed:", error.message);
    return jsonError(c, 500, "Failed to load shadow samples");
  }
  const rows = (data ?? []) as ShadowDeltaSampleRow[];
  const cells = summarizeShadowDeltas(rows);

  return c.json({
    since,
    days,
    cell: cell || null,
    rows_read: rows.length,
    truncated: rows.length >= MAX_SHADOW_ROWS,
    row_cap: MAX_SHADOW_ROWS,
    // Stated so nobody reads these as sold-price gaps. While
    // EBAY_MARKETPLACE_INSIGHTS is unset both sides are fitted on ACTIVE
    // listing prices (US-2850 owns saying so on customer-facing surfaces).
    basis: "active_listing_asking_prices",
    cells,
  });
});
