// Garment Passport longitudinal resale-value & depreciation forecast (US-1104).
//
// Turns the reseller's accumulated passport/sale ledger into forward-looking
// valuation intelligence: a condition-adjusted list price, an expected
// days-to-sell, and a projected 12-month resale value with a confidence interval.
// The forecasting MATH lives in the pure lib/passport-forecast.ts; this route is
// the tenant-scoped I/O shell that assembles the cohort and calls it.
//
// Tenancy (US-268): the cohort is built EXCLUSIVELY from the caller's OWN sales
// (sales/inventory_items/listings all scoped by user_id = workspaceOwnerId), and
// the garment lookup is scoped by created_by — a non-owned id resolves to no row
// → 404. No cross-tenant rows are read. No PII: only money/condition/time scalars
// flow into the estimator.
//
// Gating (AC4): the compPulls plan tier (pro+) — the same gate as Scout/comps —
// PLUS a `passport_forecast` feature-flag kill-switch (fail-open). Mounted at
// /api/flipdesk/forecast, inheriting authMiddleware + workspaceMiddleware.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { jsonError } from "../lib/http-errors.ts";
import {
  forecastDepreciation,
  type SaleObservation,
} from "../lib/passport-forecast.ts";

export const flipdeskForecastRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// Bound the owner's sale history pulled for a cohort (recent-first).
const COHORT_SALE_CAP = 1000;
const MS_PER_DAY = 86_400_000;

interface SkuTarget {
  brand?: string;
  garment_type?: string;
  category?: string;
}

function norm(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined;
}

// Build a SkuTarget from a sku_class object or loose top-level fields.
function targetFromSku(sku: Record<string, unknown>): SkuTarget {
  return {
    brand: norm(sku.brand),
    // garments store garment_type under a few possible keys; inventory uses
    // garment_type/garment_category.
    garment_type: norm(sku.garment_type) ?? norm(sku.type),
    category: norm(sku.category) ?? norm(sku.garment_category),
  };
}

// An inventory item matches the target when every SPECIFIED target facet matches
// (case-insensitive). At least one facet must be specified by the caller, else
// the cohort would be "all my sales" — too broad to be a SKU-class forecast.
function matchesTarget(
  item: { brand: string | null; garment_type: string | null; garment_category: string | null },
  t: SkuTarget,
): boolean {
  if (!t.brand && !t.garment_type && !t.category) return false;
  if (t.brand && norm(item.brand) !== t.brand) return false;
  if (t.garment_type && norm(item.garment_type) !== t.garment_type) return false;
  if (t.category && norm(item.garment_category) !== t.category) return false;
  return true;
}

interface SaleRow {
  inventory_item_id: string;
  sale_price: number | string | null;
  sale_date: string | null;
  sold_at: string | null;
}
interface ItemRow {
  id: string;
  brand: string | null;
  garment_type: string | null;
  garment_category: string | null;
  grade_value: number | string | null;
}
interface ListingRow {
  inventory_item_id: string;
  listed_at: string | null;
}

function toNum(v: number | string | null): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Assemble the owner's SKU-class sale cohort from sales ⋈ inventory_items ⋈
 * listings. Tenant-scoped (every query filters user_id = owner). Returns the
 * SaleObservation[] the pure estimator consumes.
 */
async function buildOwnerCohort(owner: string, target: SkuTarget): Promise<SaleObservation[]> {
  const { data: salesRaw } = await supabaseAdmin
    .from("sales")
    .select("inventory_item_id, sale_price, sale_date, sold_at")
    .eq("user_id", owner)
    .order("sale_date", { ascending: false })
    .limit(COHORT_SALE_CAP);
  const sales = (salesRaw ?? []) as SaleRow[];
  if (sales.length === 0) return [];

  const itemIds = [...new Set(sales.map((s) => s.inventory_item_id).filter(Boolean))];
  if (itemIds.length === 0) return [];

  const [{ data: itemsRaw }, { data: listingsRaw }] = await Promise.all([
    supabaseAdmin
      .from("inventory_items")
      .select("id, brand, garment_type, garment_category, grade_value")
      .eq("user_id", owner)
      .in("id", itemIds),
    supabaseAdmin
      .from("listings")
      .select("inventory_item_id, listed_at")
      .eq("user_id", owner)
      .in("inventory_item_id", itemIds),
  ]);

  const itemById = new Map<string, ItemRow>();
  for (const it of (itemsRaw ?? []) as ItemRow[]) itemById.set(it.id, it);

  // Earliest listed_at per item → the start of the listed→sold clock.
  const listedByItem = new Map<string, number>();
  for (const l of (listingsRaw ?? []) as ListingRow[]) {
    const t = l.listed_at ? Date.parse(l.listed_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const prev = listedByItem.get(l.inventory_item_id);
    if (prev == null || t < prev) listedByItem.set(l.inventory_item_id, t);
  }

  const observations: SaleObservation[] = [];
  for (const s of sales) {
    const item = itemById.get(s.inventory_item_id);
    if (!item || !matchesTarget(item, target)) continue;
    const price = toNum(s.sale_price);
    if (price == null || price <= 0) continue;
    const soldAt = s.sold_at ?? s.sale_date;
    if (!soldAt) continue;
    const soldMs = Date.parse(soldAt);
    const listedMs = listedByItem.get(s.inventory_item_id);
    const daysToSell = listedMs != null && Number.isFinite(soldMs) && soldMs >= listedMs
      ? Math.round((soldMs - listedMs) / MS_PER_DAY)
      : null;
    const grade = toNum(item.grade_value);
    observations.push({
      salePriceCents: Math.round(price * 100),
      gradeAtSale: grade != null && grade >= 0 && grade <= 10 ? grade : null,
      soldAt,
      daysToSell,
    });
  }
  return observations;
}

// Shared gate: compPulls plan tier + the passport_forecast kill-switch.
async function gateForecast(
  c: Context<{ Variables: { userId: string; workspaceOwnerId: string } }>,
  owner: string,
): Promise<Response | null> {
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId: owner });
  if (gate) return gate;
  if (!(await isFeatureEnabled("passport_forecast", { userId: owner, defaultEnabled: true }))) {
    return jsonError(c, 403, "Resale forecasting is not available right now.");
  }
  return null;
}

// POST / — ad-hoc SKU-class forecast (the Scout pre-buy surface). Body:
//   { sku_class?: {...} | brand?, garment_type?, category?, grade? }
flipdeskForecastRoutes.post("/", async (c) => {
  const owner = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await gateForecast(c, owner);
  if (gate) return gate;

  let body: {
    sku_class?: unknown;
    brand?: unknown;
    garment_type?: unknown;
    category?: unknown;
    grade?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const sku = (body.sku_class && typeof body.sku_class === "object")
    ? body.sku_class as Record<string, unknown>
    : { brand: body.brand, garment_type: body.garment_type, category: body.category };
  const target = targetFromSku(sku);
  if (!target.brand && !target.garment_type && !target.category) {
    return jsonError(c, 400, "Provide a brand and/or garment_type to forecast a SKU class.");
  }
  const grade = typeof body.grade === "number" && body.grade >= 0 && body.grade <= 10 ? body.grade : null;

  const cohort = await buildOwnerCohort(owner, target);
  const forecast = forecastDepreciation({ currentGrade: grade, skuClass: sku }, cohort);
  return c.json({ forecast });
});

// GET /garments/:id — forecast for one OWNED passport garment. The subject's
// sku_class + current grade come from the garment + its latest fingerprint.
flipdeskForecastRoutes.get("/garments/:id", async (c) => {
  const owner = c.get("workspaceOwnerId") ?? c.get("userId");
  const garmentId = c.req.param("id");
  if (!garmentId) return jsonError(c, 400, "garment id is required");

  const gate = await gateForecast(c, owner);
  if (gate) return gate;

  // US-268: the garment must belong to this workspace owner.
  const { data: garment, error: gErr } = await supabaseAdmin
    .from("garments")
    .select("id, sku_class")
    .eq("id", garmentId)
    .eq("created_by", owner)
    .maybeSingle();
  if (gErr) return jsonError(c, 500, "Lookup failed");
  if (!garment) return jsonError(c, 404, "Garment not found");
  const sku = ((garment as { sku_class: unknown }).sku_class ?? {}) as Record<string, unknown>;

  // Current grade = 10 − latest wear_score (the wear-monotonicity convention).
  const { data: fp } = await supabaseAdmin
    .from("garment_fingerprints")
    .select("wear_score")
    .eq("garment_id", garmentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const wear = toNum((fp as { wear_score: number | string | null } | null)?.wear_score ?? null);
  const currentGrade = wear != null ? Math.max(0, Math.min(10, 10 - wear)) : null;

  const target = targetFromSku(sku);
  const cohort = await buildOwnerCohort(owner, target);
  const forecast = forecastDepreciation({ currentGrade, skuClass: sku }, cohort);
  return c.json({ forecast });
});
