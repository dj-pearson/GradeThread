// US-1774: public read model for the durability rankings pages.
//
// Projects the deny-all durability_aggregates table (00406, written by the
// US-1773 job) into the buyer-safe shapes the /durability Pages Function
// renders. ONLY sample-gated cohorts (sufficient=true) are ever surfaced — a
// thin cohort must never become a public "brand X lasts longer" claim. Reads
// run service-role (the table is deny-all); nothing here exposes a per-listing
// price, a buyer, or a node identity.

import { supabaseAdmin } from "./supabase.ts";

/** URL-safe slug for a brand (matches the Pages Function's /durability/<slug>). */
export function brandSlug(brand: string): string {
  return brand.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface AggregateRow {
  brand: string | null;
  garment_type: string | null;
  label: string;
  garment_count: number;
  regraded_count: number;
  avg_overall_decay: number | null;
  avg_retention: number | null;
  avg_span_days: number | null;
  per_factor_decay: Record<string, number> | null;
  resale_median_cents: number | null;
  computed_at: string;
}

export interface DurabilityHubItem {
  brandSlug: string;
  brand: string;
  cohortCount: number;
  /** Best (highest) condition retention across the brand's cohorts, 0–1. */
  bestRetention: number | null;
  refreshedAt: string;
}

export interface DurabilityCohort {
  garmentType: string | null;
  label: string;
  garmentCount: number;
  regradedCount: number;
  avgOverallDecay: number | null;
  avgRetention: number | null;
  avgSpanDays: number | null;
  perFactorDecay: Record<string, number>;
  resaleMedianCents: number | null;
}

export interface DurabilityBrandDto {
  brand: string;
  brandSlug: string;
  cohorts: DurabilityCohort[];
  refreshedAt: string;
}

async function loadSufficient(): Promise<AggregateRow[]> {
  const { data, error } = await supabaseAdmin
    .from("durability_aggregates")
    .select(
      "brand, garment_type, label, garment_count, regraded_count, avg_overall_decay, avg_retention, avg_span_days, per_factor_decay, resale_median_cents, computed_at",
    )
    .eq("sufficient", true);
  if (error) throw new Error(`durability-index load failed: ${error.message}`);
  return (data ?? []) as AggregateRow[];
}

/** Hub: one entry per brand (that has ≥1 sufficient cohort), ranked by best
 *  retention descending. Empty until the aggregation job has enough data. */
export async function getDurabilityHub(): Promise<DurabilityHubItem[]> {
  const rows = (await loadSufficient()).filter((r) => r.brand);
  const byBrand = new Map<string, AggregateRow[]>();
  for (const r of rows) {
    const key = brandSlug(r.brand!);
    if (!key) continue;
    (byBrand.get(key) ?? byBrand.set(key, []).get(key)!).push(r);
  }
  const items: DurabilityHubItem[] = [];
  for (const [slug, cohorts] of byBrand) {
    const retentions = cohorts.map((c) => c.avg_retention).filter((v): v is number => v != null);
    items.push({
      brandSlug: slug,
      brand: cohorts[0].brand!,
      cohortCount: cohorts.length,
      bestRetention: retentions.length ? Math.max(...retentions) : null,
      refreshedAt: cohorts.map((c) => c.computed_at).sort().at(-1) ?? cohorts[0].computed_at,
    });
  }
  return items.sort((a, b) => (b.bestRetention ?? 0) - (a.bestRetention ?? 0));
}

/** One brand's sufficient cohorts, ranked most-durable first (retention desc). */
export async function getDurabilityByBrand(slug: string): Promise<DurabilityBrandDto | null> {
  const rows = (await loadSufficient()).filter((r) => r.brand && brandSlug(r.brand) === slug);
  if (rows.length === 0) return null;
  const cohorts: DurabilityCohort[] = rows
    .map((r) => ({
      garmentType: r.garment_type,
      label: r.label,
      garmentCount: r.garment_count,
      regradedCount: r.regraded_count,
      avgOverallDecay: r.avg_overall_decay,
      avgRetention: r.avg_retention,
      avgSpanDays: r.avg_span_days,
      perFactorDecay: r.per_factor_decay ?? {},
      resaleMedianCents: r.resale_median_cents,
    }))
    .sort((a, b) => (b.avgRetention ?? 0) - (a.avgRetention ?? 0));
  return {
    brand: rows[0].brand!,
    brandSlug: slug,
    cohorts,
    refreshedAt: rows.map((r) => r.computed_at).sort().at(-1) ?? rows[0].computed_at,
  };
}
