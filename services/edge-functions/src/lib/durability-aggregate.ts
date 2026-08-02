// US-1773: cross-garment durability aggregation engine.
//
// Rolls up per-garment condition curves (passport-curve.ts buildConditionCurve)
// across garments by sku_class into cohort durability metrics — how much
// condition a class RETAINS on regrade, which factors decay fastest, and (where
// sold-event prices exist) resale value by condition band. Sample-gated so a
// thin cohort never ships a false claim, mirroring the condition-index floor.
//
// The aggregation MATH is pure + unit-tested (aggregateDurabilityForClass); the
// job (computeDurabilityAggregates) does the DB plumbing and upserts the
// deny-all durability_aggregates table (00406). Aggregate-only + PII-safe: no
// per-listing price, no buyer, no node identity leaves this module.

import { supabaseAdmin } from "./supabase.ts";
import {
  buildConditionCurve,
  CONDITION_FACTORS,
  type ConditionCurvePoint,
  type ConditionFactorKey,
  type PublicGradePoint,
} from "./passport-curve.ts";

// Sample gates — a cohort needs enough garments AND enough regraded garments
// before any decay claim is trustworthy; resale metrics need enough sales.
export const DURABILITY_MIN_GARMENTS = 8;
export const DURABILITY_MIN_REGRADED = 3;
export const DURABILITY_MIN_SALES = 5;

export type ConditionBand = "excellent" | "good" | "fair";

/** Coarse condition band from an overall grade (used to bucket resale value). */
export function conditionBand(
  overall: number | null | undefined,
): ConditionBand | null {
  if (typeof overall !== "number" || !Number.isFinite(overall)) return null;
  if (overall >= 7.5) return "excellent";
  if (overall >= 5.5) return "good";
  return "fair";
}

export interface SaleInput {
  priceCents: number;
  /** The garment's condition band at the time of sale (nearest prior grade). */
  band: ConditionBand | null;
}

export interface DurabilityMetrics {
  garment_count: number;
  regraded_count: number;
  avg_overall_decay: number | null;
  avg_retention: number | null;
  avg_span_days: number | null;
  per_factor_decay: Record<string, number>;
  resale_sample: number;
  resale_median_cents: number | null;
  resale_by_band: Record<string, number>;
  sufficient: boolean;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function firstOverall(c: ConditionCurvePoint[]): number | null {
  return c[0]?.overall ?? null;
}
function lastOverall(c: ConditionCurvePoint[]): number | null {
  return c[c.length - 1]?.overall ?? null;
}
function spanDays(c: ConditionCurvePoint[]): number | null {
  const a = Date.parse(c[0].graded_at);
  const b = Date.parse(c[c.length - 1].graded_at);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 86_400_000;
}

/**
 * Aggregate durability for ONE sku_class from its garments' condition curves +
 * sold prices. Pure + exported for tests. Decay metrics use only REGRADED
 * garments (≥2 grades with a non-null first + last overall); resale metrics use
 * only sales with a positive price. `sufficient` gates the whole cohort on the
 * garment + regrade floors — the resale block has its own MIN_SALES floor.
 */
export function aggregateDurabilityForClass(
  curves: ConditionCurvePoint[][],
  sales: SaleInput[],
): DurabilityMetrics {
  const garment_count = curves.length;
  const regraded = curves.filter(
    (c) => c.length >= 2 && firstOverall(c) != null && lastOverall(c) != null,
  );
  const regraded_count = regraded.length;

  let avg_overall_decay: number | null = null;
  let avg_retention: number | null = null;
  let avg_span_days: number | null = null;
  const per_factor_decay: Record<string, number> = {};

  if (regraded_count > 0) {
    avg_overall_decay = round(
      mean(regraded.map((c) => firstOverall(c)! - lastOverall(c)!)),
      2,
    );

    const retentions = regraded
      .map((c) => lastOverall(c)! / firstOverall(c)!)
      .filter((r) => Number.isFinite(r) && r > 0);
    avg_retention = retentions.length ? round(mean(retentions), 4) : null;

    const spans = regraded.map(spanDays).filter((s): s is number => s != null);
    avg_span_days = spans.length ? round(mean(spans), 2) : null;

    for (const f of CONDITION_FACTORS) {
      const key = f.key as ConditionFactorKey;
      const lost = regraded
        .map((c) => {
          const first = c[0].factors[key];
          const last = c[c.length - 1].factors[key];
          return first != null && last != null ? first - last : null;
        })
        .filter((v): v is number => v != null);
      if (lost.length) per_factor_decay[key] = round(mean(lost), 2);
    }
  }

  // Resale value from sold prices (aggregate-only).
  const priced = sales.filter((s) =>
    Number.isFinite(s.priceCents) && s.priceCents > 0
  );
  const resale_sample = priced.length;
  let resale_median_cents: number | null = null;
  const resale_by_band: Record<string, number> = {};
  if (resale_sample >= DURABILITY_MIN_SALES) {
    resale_median_cents = Math.round(median(priced.map((s) => s.priceCents)));
    for (const band of ["excellent", "good", "fair"] as const) {
      const inBand = priced.filter((s) => s.band === band).map((s) =>
        s.priceCents
      );
      if (inBand.length >= 2) resale_by_band[band] = Math.round(median(inBand));
    }
  }

  const sufficient = garment_count >= DURABILITY_MIN_GARMENTS &&
    regraded_count >= DURABILITY_MIN_REGRADED;

  return {
    garment_count,
    regraded_count,
    avg_overall_decay,
    avg_retention,
    avg_span_days,
    per_factor_decay,
    resale_sample,
    resale_median_cents,
    resale_by_band,
    sufficient,
  };
}

// ── sku_class keying ─────────────────────────────────────────────────────
interface SkuClass {
  brand?: string | null;
  garment_type?: string | null;
  category?: string | null;
}

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Canonical cohort key, e.g. "gucci::outerwear". "" when there's no brand. */
export function skuClassKey(sku: SkuClass): string {
  const brand = s(sku.brand).toLowerCase();
  const type = s(sku.garment_type).toLowerCase();
  if (!brand) return "";
  return `${brand}::${type}`;
}

export function skuClassLabel(sku: SkuClass): string {
  const brand = s(sku.brand);
  const type = s(sku.garment_type);
  return [brand, type].filter(Boolean).join(" ") || "Unknown";
}

// Defensive price extraction — the sold-event payload key isn't standardized.
function salePriceCents(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (
    const key of [
      "price_cents",
      "priceCents",
      "sale_price_cents",
      "sold_price_cents",
      "amount_cents",
    ]
  ) {
    const v = p[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return Math.round(v);
    }
  }
  return null;
}

// The garment's condition band at a sale: the band of its latest grade at or
// before the sale date (null when no prior grade).
function bandAtSale(
  curve: ConditionCurvePoint[],
  soldAt: string,
): ConditionBand | null {
  const t = Date.parse(soldAt);
  if (!Number.isFinite(t)) return conditionBand(lastOverall(curve));
  let band: ConditionBand | null = null;
  for (const pt of curve) {
    const pt_t = Date.parse(pt.graded_at);
    if (Number.isFinite(pt_t) && pt_t <= t) band = conditionBand(pt.overall);
  }
  return band;
}

/**
 * Load every garment's condition curve + sold prices, group by sku_class, and
 * upsert the durability_aggregates rows. Returns a small summary. Best-effort
 * per class — one bad cohort never aborts the whole run.
 */
/**
 * US-2317: per-table read caps.
 *
 * These three reads had no .limit(), no time window and no cap constant, and
 * all three are materialized into JS Maps SIMULTANEOUSLY before the cohort pass
 * — so peak memory is the sum of all three, growing forever on append-only
 * tables. Every sibling job in this codebase already declares a cap
 * (relist-detect's MAX_CANDIDATES 500, newsletter-personalization's ROW_CAP
 * 20_000, agent-memory's MEMORY_ROW_CAP 40); this one was the outlier.
 *
 * The numbers are deliberately generous — this is a bound against unbounded
 * growth, not a tuning knob. What matters more than the value is that
 * truncation is REPORTED: a silently short read would compute durability
 * rankings over a subset and publish them as if they covered everything, which
 * is the failure mode vault/10-ops/postgrest-row-cap.md exists for.
 */
export const GARMENT_SCAN_CAP = 50_000;
export const GRADE_SCAN_CAP = 100_000;
export const SOLD_EVENT_SCAN_CAP = 100_000;

export interface DurabilityAggregateResult {
  classes: number;
  sufficient: number;
  upserted: number;
  /**
   * Which reads came back AT their cap, i.e. were probably clipped. Empty is
   * the healthy state. Named `truncated` rather than folded into a boolean so
   * an operator can see WHICH table outgrew its bound first.
   */
  truncated: string[];
}

export async function computeDurabilityAggregates(): Promise<
  DurabilityAggregateResult
> {
  const truncated: string[] = [];
  const { data: garments, error: gErr } = await supabaseAdmin
    .from("garments")
    .select("id, sku_class")
    .order("id", { ascending: true })
    .limit(GARMENT_SCAN_CAP);
  if (gErr) {
    throw new Error(`durability: load garments failed: ${gErr.message}`);
  }
  if (!garments || garments.length === 0) {
    return { classes: 0, sufficient: 0, upserted: 0, truncated };
  }
  if (garments.length >= GARMENT_SCAN_CAP) truncated.push("garments");

  // Grades per garment (public, PII-safe projection).
  const { data: grades } = await supabaseAdmin
    .from("public_grade_reports")
    .select(
      "garment_id, certificate_id, created_at, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score",
    )
    .not("garment_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(GRADE_SCAN_CAP);
  if ((grades ?? []).length >= GRADE_SCAN_CAP) {
    truncated.push("public_grade_reports");
  }
  const gradesByGarment = new Map<string, PublicGradePoint[]>();
  for (
    const r of (grades ?? []) as Array<
      PublicGradePoint & { garment_id: string }
    >
  ) {
    const list = gradesByGarment.get(r.garment_id) ?? [];
    list.push(r);
    gradesByGarment.set(r.garment_id, list);
  }

  // Sold events (prices) per garment.
  const { data: soldEvents } = await supabaseAdmin
    .from("garment_events")
    .select("garment_id, created_at, payload")
    .eq("event_type", "sold")
    .order("created_at", { ascending: false })
    .limit(SOLD_EVENT_SCAN_CAP);
  if ((soldEvents ?? []).length >= SOLD_EVENT_SCAN_CAP) {
    truncated.push("garment_events");
  }
  const salesByGarment = new Map<
    string,
    Array<{ priceCents: number; soldAt: string }>
  >();
  for (
    const ev of (soldEvents ?? []) as Array<
      { garment_id: string; created_at: string; payload: unknown }
    >
  ) {
    const price = salePriceCents(ev.payload);
    if (price == null) continue;
    const list = salesByGarment.get(ev.garment_id) ?? [];
    list.push({ priceCents: price, soldAt: ev.created_at });
    salesByGarment.set(ev.garment_id, list);
  }

  // Group garments by sku_class key.
  interface Cohort {
    sku: SkuClass;
    curves: ConditionCurvePoint[][];
    sales: SaleInput[];
  }
  const cohorts = new Map<string, Cohort>();
  for (const gm of garments as Array<{ id: string; sku_class: SkuClass }>) {
    const key = skuClassKey(gm.sku_class ?? {});
    if (!key) continue; // no brand → not a rankable cohort
    const cohort = cohorts.get(key) ??
      { sku: gm.sku_class, curves: [], sales: [] };
    const curve = buildConditionCurve(gradesByGarment.get(gm.id) ?? []);
    cohort.curves.push(curve);
    for (const sale of salesByGarment.get(gm.id) ?? []) {
      cohort.sales.push({
        priceCents: sale.priceCents,
        band: bandAtSale(curve, sale.soldAt),
      });
    }
    cohorts.set(key, cohort);
  }

  let sufficient = 0;
  let upserted = 0;
  for (const [key, cohort] of cohorts) {
    const m = aggregateDurabilityForClass(cohort.curves, cohort.sales);
    if (m.sufficient) sufficient += 1;
    const { error } = await supabaseAdmin
      .from("durability_aggregates")
      .upsert(
        {
          sku_class_key: key,
          brand: s(cohort.sku.brand) || null,
          garment_type: s(cohort.sku.garment_type) || null,
          label: skuClassLabel(cohort.sku),
          garment_count: m.garment_count,
          regraded_count: m.regraded_count,
          avg_overall_decay: m.avg_overall_decay,
          avg_retention: m.avg_retention,
          avg_span_days: m.avg_span_days,
          per_factor_decay: m.per_factor_decay,
          resale_sample: m.resale_sample,
          resale_median_cents: m.resale_median_cents,
          resale_by_band: m.resale_by_band,
          sufficient: m.sufficient,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "sku_class_key" },
      );
    if (error) {
      console.error(`[durability] upsert ${key} failed:`, error.message);
    } else {
      upserted += 1;
    }
  }

  if (truncated.length > 0) {
    // Loud on purpose. A truncated run still upserts, so the rankings it
    // publishes are computed over a SUBSET while looking complete — the exact
    // shape vault/10-ops/postgrest-row-cap.md was written about. Raise the cap
    // or window the read; do not just watch this go by.
    console.warn(
      `[durability] scan hit its cap on: ${truncated.join(", ")} — ` +
        "aggregates were computed over a partial dataset",
    );
  }
  return { classes: cohorts.size, sufficient, upserted, truncated };
}
