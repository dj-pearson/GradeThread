// US-1826: portfolio valuation — impure resolution + cache (service-role).
//
// Resolves each closet item's inputs (cost basis from the purchase link; Value
// Index fair-value band for its brand+grade — best-effort, a miss degrades to
// cost-basis-only, never errors), runs the pure engine, and upserts the cache.
// Recompute is cost-controlled: cached with a TTL and only refreshed when stale,
// bounded to one user's closet. Every query is scoped by user_id (US-268).

import { supabaseAdmin } from "./supabase.ts";
import { getPriceGuideEntry, type PriceGuideBand } from "./price-guide.ts";
import { getValueHub } from "./value-index.ts";
import { slugify } from "./value-index.ts";
import { bandForGrade } from "./resale-condition.ts";
import { estimateItemValue, type Valuation } from "./portfolio-valuation.ts";

const DAY_MS = 86_400_000;
export const VALUATION_TTL_MS = DAY_MS; // recompute at most daily per item

interface ClosetItemRow {
  id: string;
  brand: string | null;
  condition_grade: number | null;
  certificate_id: string | null;
}

export interface ClosetValuationRow {
  closet_item_id: string;
  user_id: string;
  estimate_cents: number | null;
  low_cents: number | null;
  high_cents: number | null;
  confidence: string;
  basis: string[];
  cost_basis_cents: number | null;
  trend: string;
  computed_at: string;
}

/** Best-effort Value Index fair-value band for a brand + grade (null on any miss). */
async function fairValueBand(
  brand: string | null,
  grade: number | null,
  hubByBrandSlug: Map<string, string>,
  guideCache: Map<string, PriceGuideBand[] | null>,
): Promise<PriceGuideBand | null> {
  if (!brand) return null;
  const slug = hubByBrandSlug.get(slugify(brand));
  if (!slug) return null;
  let bands = guideCache.get(slug);
  if (bands === undefined) {
    try {
      const entry = await getPriceGuideEntry(slug);
      bands = entry?.bands ?? null;
    } catch {
      bands = null;
    }
    guideCache.set(slug, bands);
  }
  if (!bands) return null;
  const key = bandForGrade(grade);
  return bands.find((b) => b.band === key) ?? null;
}

/**
 * Recompute + cache every closet item's valuation for one user. Bounded to that
 * user's closet; the Value Index hub + per-brand guides are resolved once and
 * reused across items. Returns the fresh valuation rows.
 */
export async function recomputeUserPortfolio(
  userId: string,
  nowMs: number = Date.now(),
): Promise<ClosetValuationRow[]> {
  const { data: itemsData, error } = await supabaseAdmin
    .from("closet_items")
    .select("id, brand, condition_grade, certificate_id")
    .eq("user_id", userId);
  if (error) throw new Error(`recomputeUserPortfolio load failed: ${error.message}`);
  const items = (itemsData ?? []) as ClosetItemRow[];
  if (items.length === 0) return [];

  // Cost basis + purchase date from the buyer's purchase links (by certificate).
  const certIds = items.map((i) => i.certificate_id).filter((c): c is string => !!c);
  const purchaseByCert = new Map<string, { price: number | null; purchasedAt: string | null }>();
  if (certIds.length > 0) {
    const { data: purchases } = await supabaseAdmin
      .from("buyer_purchases")
      .select("certificate_id, purchase_price_cents, purchased_at")
      .eq("user_id", userId)
      .in("certificate_id", certIds);
    for (const p of purchases ?? []) {
      const row = p as { certificate_id: string; purchase_price_cents: number | null; purchased_at: string | null };
      purchaseByCert.set(row.certificate_id, { price: row.purchase_price_cents, purchasedAt: row.purchased_at });
    }
  }

  // Value Index hub → brandSlug map, resolved once.
  const hubByBrandSlug = new Map<string, string>();
  try {
    for (const h of await getValueHub()) hubByBrandSlug.set(h.brandSlug, h.slug);
  } catch {
    /* Value Index unavailable → every item degrades to cost-basis-only. */
  }
  const guideCache = new Map<string, PriceGuideBand[] | null>();

  const rows: ClosetValuationRow[] = [];
  for (const item of items) {
    const purchase = item.certificate_id ? purchaseByCert.get(item.certificate_id) : undefined;
    const costBasisCents = purchase?.price ?? null;
    const ageDays = purchase?.purchasedAt
      ? Math.max(0, Math.floor((nowMs - Date.parse(purchase.purchasedAt)) / DAY_MS))
      : null;
    const band = await fairValueBand(item.brand, item.condition_grade, hubByBrandSlug, guideCache);

    const v: Valuation = estimateItemValue({
      realizedMedianCents: null, // the Value Index band already encodes realized prices
      fairValueMedianCents: band?.valueMedianCents ?? null,
      fairValueLowCents: band?.valueLowCents ?? null,
      fairValueHighCents: band?.valueHighCents ?? null,
      costBasisCents,
      ageDays,
    });

    rows.push({
      closet_item_id: item.id,
      user_id: userId,
      estimate_cents: v.estimateCents,
      low_cents: v.lowCents,
      high_cents: v.highCents,
      confidence: v.confidence,
      basis: v.basis,
      cost_basis_cents: costBasisCents,
      trend: v.trend,
      computed_at: new Date(nowMs).toISOString(),
    });
  }

  if (rows.length > 0) {
    const { error: upErr } = await supabaseAdmin
      .from("closet_item_valuations")
      .upsert(rows as never, { onConflict: "closet_item_id" });
    if (upErr) console.error("[portfolio-valuation] cache upsert failed:", upErr.message);
  }
  return rows;
}

/**
 * Return the user's cached valuations, recomputing first when the cache is stale
 * or incomplete (any closet item missing a row, or the oldest row past the TTL).
 */
export async function getPortfolioValuation(
  userId: string,
  nowMs: number = Date.now(),
): Promise<ClosetValuationRow[]> {
  const [{ count: itemCount }, { data: cached }] = await Promise.all([
    supabaseAdmin.from("closet_items").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabaseAdmin
      .from("closet_item_valuations")
      .select("closet_item_id, user_id, estimate_cents, low_cents, high_cents, confidence, basis, cost_basis_cents, trend, computed_at")
      .eq("user_id", userId),
  ]);

  const rows = (cached ?? []) as ClosetValuationRow[];
  const stale = rows.some((r) => nowMs - Date.parse(r.computed_at) > VALUATION_TTL_MS);
  const incomplete = rows.length < (itemCount ?? 0);
  if (stale || incomplete) {
    return await recomputeUserPortfolio(userId, nowMs);
  }
  return rows;
}
