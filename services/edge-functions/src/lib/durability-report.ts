// US-1775: "State of Secondhand Durability" — a PUBLIC, aggregate-only data
// report built from the durability_aggregates table (US-1773). Surfaces
// GradeThread's proprietary findings — which brands hold condition best/worst
// and which factors decay fastest — as a citable, press-ready asset (the GEO
// lever: AI engines + journalists cite GradeThread by name).
//
// Honesty rule (matches the resale-condition report): a finding is built ONLY
// from sample-gated (sufficient) cohorts, and every headline states the sample
// behind it. When there isn't enough data, the arrays are empty and the page
// says so — never a fabricated ranking.

import { supabaseAdmin } from "./supabase.ts";
import { CONDITION_FACTORS } from "./passport-curve.ts";
import { brandSlug } from "./durability-index.ts";

export interface DurabilityBrandFinding {
  brand: string;
  brandSlug: string;
  /** Best condition retention across the brand's cohorts, as a percent (0–100). */
  retentionPct: number | null;
  /** Mean overall points lost on regrade across the brand's cohorts. */
  avgDecay: number | null;
  cohortCount: number;
}

export interface DurabilityFactorFinding {
  factor: string;
  label: string;
  /** Mean points lost for this factor across sufficient cohorts. */
  avgDecay: number;
}

export interface DurabilityReport {
  generated_at: string;
  sample: {
    brands: number;
    sufficient_cohorts: number;
    total_cohorts: number;
    garments: number;
    regrades: number;
  };
  most_durable: DurabilityBrandFinding[];
  least_durable: DurabilityBrandFinding[];
  weakest_factors: DurabilityFactorFinding[];
}

export interface DurabilityAggregateRow {
  brand: string | null;
  garment_count: number;
  regraded_count: number;
  avg_retention: number | null;
  avg_overall_decay: number | null;
  per_factor_decay: Record<string, number> | null;
  sufficient: boolean;
}
type Row = DurabilityAggregateRow;

const FACTOR_LABELS: Record<string, string> = Object.fromEntries(
  CONDITION_FACTORS.map((f) => [f.key, f.label]),
);

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Build the public "State of Secondhand Durability" report. Aggregate-only and
 * PII-safe (durability_aggregates carries no per-listing/buyer data). Empty
 * findings until the aggregation job has enough sufficient cohorts.
 */
export async function computeDurabilityReport(): Promise<DurabilityReport> {
  const { data, error } = await supabaseAdmin
    .from("durability_aggregates")
    .select("brand, garment_count, regraded_count, avg_retention, avg_overall_decay, per_factor_decay, sufficient");
  return buildDurabilityReport((error ? [] : (data ?? [])) as Row[], new Date().toISOString());
}

/**
 * Build the report from aggregate rows. Pure + exported for tests — this is the
 * ranking + factor-aggregation logic. Only SUFFICIENT cohorts feed the findings.
 */
export function buildDurabilityReport(rows: Row[], generated_at: string): DurabilityReport {
  const sufficientRows = rows.filter((r) => r.sufficient && r.brand);

  // Group sufficient cohorts by brand.
  const byBrand = new Map<string, Row[]>();
  for (const r of sufficientRows) {
    const slug = brandSlug(r.brand!);
    if (!slug) continue;
    (byBrand.get(slug) ?? byBrand.set(slug, []).get(slug)!).push(r);
  }

  const brandFindings: DurabilityBrandFinding[] = [];
  for (const [slug, cohorts] of byBrand) {
    const retentions = cohorts.map((c) => c.avg_retention).filter((v): v is number => v != null);
    const decays = cohorts.map((c) => c.avg_overall_decay).filter((v): v is number => v != null);
    brandFindings.push({
      brand: cohorts[0].brand!,
      brandSlug: slug,
      retentionPct: retentions.length ? round(Math.max(...retentions) * 100, 1) : null,
      avgDecay: decays.length ? round(mean(decays), 2) : null,
      cohortCount: cohorts.length,
    });
  }

  const ranked = brandFindings.filter((b) => b.retentionPct != null);
  ranked.sort((a, b) => (b.retentionPct ?? 0) - (a.retentionPct ?? 0));
  const most_durable = ranked.slice(0, 10);
  const least_durable = [...ranked].reverse().slice(0, 10);

  // Which factors decay fastest across all sufficient cohorts?
  const weakest_factors: DurabilityFactorFinding[] = [];
  for (const f of CONDITION_FACTORS) {
    const vals = sufficientRows
      .map((r) => r.per_factor_decay?.[f.key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vals.length) {
      weakest_factors.push({ factor: f.key, label: FACTOR_LABELS[f.key] ?? f.key, avgDecay: round(mean(vals), 2) });
    }
  }
  weakest_factors.sort((a, b) => b.avgDecay - a.avgDecay);

  return {
    generated_at,
    sample: {
      brands: byBrand.size,
      sufficient_cohorts: sufficientRows.length,
      total_cohorts: rows.length,
      garments: rows.reduce((a, r) => a + (r.garment_count || 0), 0),
      regrades: rows.reduce((a, r) => a + (r.regraded_count || 0), 0),
    },
    most_durable,
    least_durable,
    weakest_factors,
  };
}
