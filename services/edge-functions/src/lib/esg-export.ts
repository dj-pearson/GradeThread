// US-1788: aggregate ESG export — graded-volume circularity impact by brand, for
// a brand-resale partner's ESG reporting. Aggregate-only + PII-safe: it exposes
// a brand + its graded volume + the estimated impact avoided, never a seller,
// listing, or per-item row. Sample-gated so a brand with only a handful of grades
// (which could de-anonymize a single seller) is withheld.
//
// The impact math reuses the US-1786 factor lib; every figure is an ESTIMATE.

import { supabaseAdmin } from "./supabase.ts";
import {
  computeGarmentImpact,
  type ImpactEstimate,
  IMPACT_METHODOLOGY,
} from "./impact-estimate.ts";

// A brand needs at least this many graded garments before it appears — both a
// statistical floor and an anonymity guard (never a single-seller brand).
export const ESG_MIN_GRADES_PER_BRAND = 5;

export interface BrandEsgRow {
  brand: string;
  graded_count: number;
  co2e_kg: number;
  water_liters: number;
  landfill_kg: number;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Aggregate graded-garment rows ({brand, garment_type}) into per-brand impact,
 * using a precomputed per-type impact map. Sample-gated by minGrades. Pure +
 * exported for tests.
 */
export function aggregateBrandImpact(
  rows: Array<{ brand: string | null; garment_type: string | null }>,
  impactByType: Record<string, ImpactEstimate>,
  minGrades = ESG_MIN_GRADES_PER_BRAND,
): BrandEsgRow[] {
  // brand → garment_type → count
  const byBrand = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const brand = (r.brand ?? "").trim();
    const type = (r.garment_type ?? "").trim().toLowerCase();
    if (!brand || !type) continue;
    const types = byBrand.get(brand) ?? new Map<string, number>();
    types.set(type, (types.get(type) ?? 0) + 1);
    byBrand.set(brand, types);
  }

  const out: BrandEsgRow[] = [];
  for (const [brand, types] of byBrand) {
    let graded = 0;
    let co2e = 0;
    let water = 0;
    let landfill = 0;
    for (const [type, count] of types) {
      graded += count;
      const est = impactByType[type];
      if (!est) continue;
      co2e += est.co2e_kg * count;
      water += est.water_liters * count;
      landfill += est.landfill_kg * count;
    }
    if (graded < minGrades) continue; // sample + anonymity gate
    out.push({
      brand,
      graded_count: graded,
      co2e_kg: round(co2e, 1),
      water_liters: Math.round(water / 10) * 10,
      landfill_kg: round(landfill, 2),
    });
  }
  return out.sort((a, b) => b.graded_count - a.graded_count);
}

const CSV_HEADER = "brand,graded_count,co2e_kg_avoided,water_liters_avoided,landfill_kg_diverted";

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render the ESG rows as a CSV string (a methodology comment leads). Pure. */
export function toEsgCsv(rows: BrandEsgRow[]): string {
  const lines = [
    `# GradeThread ESG export — estimated circularity impact avoided by resale, by brand. ${IMPACT_METHODOLOGY}`,
    CSV_HEADER,
    ...rows.map((r) =>
      [r.brand, r.graded_count, r.co2e_kg, r.water_liters, r.landfill_kg].map(csvCell).join(",")
    ),
  ];
  return lines.join("\n") + "\n";
}

const GARMENT_TYPES = ["tops", "bottoms", "outerwear", "dresses", "footwear", "accessories"];

/** Compute the full brand ESG dataset from platform-wide graded submissions. */
export async function computeEsgExport(): Promise<BrandEsgRow[]> {
  // Precompute per-type impact once (6 types).
  const impactByType: Record<string, ImpactEstimate> = {};
  for (const t of GARMENT_TYPES) {
    const est = await computeGarmentImpact(t);
    if (est) impactByType[t] = est;
  }

  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select("brand, garment_type")
    .eq("status", "completed")
    .not("brand", "is", null)
    .limit(100000);
  if (error) throw new Error(`esg-export load failed: ${error.message}`);

  return aggregateBrandImpact(
    (data ?? []) as Array<{ brand: string | null; garment_type: string | null }>,
    impactByType,
  );
}
