// US-1786: circularity impact estimate.
//
// Estimates the production-phase impact AVOIDED by buying a garment secondhand
// instead of new — CO2e, water, and landfill diverted — from the deny-all
// impact_factors table (00408), keyed by garment_type (+ optional material). The
// numbers are conservative midpoints from openly published apparel LCAs; every
// result is explicitly an ESTIMATE with a methodology + source, and the code
// carries a FALLBACK so a missing row never breaks the surface.
//
// Aggregate/reference only — no tenant data. The pure estimate math is
// unit-tested; the DB lookup is a thin read.

import { supabaseAdmin } from "./supabase.ts";

export interface ImpactFactor {
  garment_type: string;
  material: string;
  co2e_kg: number;
  water_liters: number;
  weight_kg: number;
  source: string;
  version: string;
}

export interface ImpactEstimate {
  estimate: true;
  co2e_kg: number;
  water_liters: number;
  landfill_kg: number;
  source: string;
  version: string;
  methodology: string;
}

export const IMPACT_METHODOLOGY =
  "Estimated impact avoided by buying this item secondhand instead of a new " +
  "equivalent: the production-phase CO2e and water of a comparable new garment, " +
  "plus its weight kept out of landfill. Figures are conservative midpoints from " +
  "openly published apparel life-cycle assessments — they vary widely by exact " +
  "material and manufacturing, so treat them as an order-of-magnitude estimate, " +
  "not a precise measurement.";

// Code-side fallback (mirrors the 00408 seed) so an estimate is available even
// before the table is populated / for an unrecognized type. Keep in sync with
// the migration seed.
export const FALLBACK_FACTORS: Record<string, Omit<ImpactFactor, "garment_type" | "material" | "version">> = {
  tops: { co2e_kg: 2.5, water_liters: 2500, weight_kg: 0.2, source: "WRAP / Ellen MacArthur Foundation (conservative)" },
  bottoms: { co2e_kg: 12, water_liters: 3500, weight_kg: 0.6, source: "Levi Strauss & Co. jeans LCA (conservative)" },
  outerwear: { co2e_kg: 20, water_liters: 2000, weight_kg: 0.8, source: "Published apparel LCA datasets (conservative)" },
  dresses: { co2e_kg: 10, water_liters: 2500, weight_kg: 0.35, source: "Published apparel LCA datasets (conservative)" },
  footwear: { co2e_kg: 14, water_liters: 800, weight_kg: 0.7, source: "MIT footwear lifecycle study (conservative)" },
  accessories: { co2e_kg: 3, water_liters: 500, weight_kg: 0.2, source: "Published apparel LCA datasets (conservative)" },
};

const FALLBACK_VERSION = "2026-07-fallback";

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Turn a factor into an estimate (optionally for `quantity` garments). Pure +
 * exported for tests. Rounds to sensible precision — no false decimals.
 */
export function estimateFromFactor(factor: ImpactFactor, quantity = 1): ImpactEstimate {
  const q = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  return {
    estimate: true,
    co2e_kg: round(factor.co2e_kg * q, 1),
    water_liters: Math.round((factor.water_liters * q) / 10) * 10,
    landfill_kg: round(factor.weight_kg * q, 2),
    source: factor.source,
    version: factor.version,
    methodology: IMPACT_METHODOLOGY,
  };
}

/**
 * Resolve the impact factor for a garment: the material-specific row, else the
 * type 'default' row, else the code-side fallback. Best-effort — a DB hiccup
 * falls back rather than throwing.
 */
export async function getImpactFactor(
  garmentType: string,
  material?: string | null,
): Promise<ImpactFactor | null> {
  const type = (garmentType ?? "").trim().toLowerCase();
  if (!type) return null;
  const mat = (material ?? "").trim().toLowerCase();

  try {
    const wanted = mat ? [mat, "default"] : ["default"];
    const { data } = await supabaseAdmin
      .from("impact_factors")
      .select("garment_type, material, co2e_kg, water_liters, weight_kg, source, version")
      .eq("garment_type", type)
      .in("material", wanted);
    const rows = (data ?? []) as ImpactFactor[];
    // Prefer the material-specific row over the default.
    const row = rows.find((r) => r.material === mat) ?? rows.find((r) => r.material === "default");
    if (row) return row;
  } catch {
    /* fall through to code fallback */
  }

  const fb = FALLBACK_FACTORS[type];
  if (!fb) return null;
  return { garment_type: type, material: "default", version: FALLBACK_VERSION, ...fb };
}

/**
 * Estimate the circularity impact of one garment by type (+ optional material).
 * Returns null for an unrecognized type (no fabricated number).
 */
export async function computeGarmentImpact(
  garmentType: string,
  material?: string | null,
): Promise<ImpactEstimate | null> {
  const factor = await getImpactFactor(garmentType, material);
  return factor ? estimateFromFactor(factor) : null;
}

export interface ImpactSummary {
  estimate: true;
  garment_count: number;
  co2e_kg: number;
  water_liters: number;
  landfill_kg: number;
  methodology: string;
}

/**
 * Sum per-type estimates (each with a garment count) into a user/closet total.
 * Pure + exported for tests. Rounds the totals — never carries false precision.
 */
export function sumImpactEstimates(
  parts: Array<{ estimate: ImpactEstimate; count: number }>,
): ImpactSummary {
  let co2e = 0;
  let water = 0;
  let landfill = 0;
  let count = 0;
  for (const { estimate, count: n } of parts) {
    const q = Number.isFinite(n) && n > 0 ? n : 0;
    co2e += estimate.co2e_kg * q;
    water += estimate.water_liters * q;
    landfill += estimate.landfill_kg * q;
    count += q;
  }
  return {
    estimate: true,
    garment_count: count,
    co2e_kg: round(co2e, 1),
    water_liters: Math.round(water / 10) * 10,
    landfill_kg: round(landfill, 2),
    methodology: IMPACT_METHODOLOGY,
  };
}

/**
 * Compute a user's total circularity impact from their graded garment-type
 * counts, e.g. { tops: 12, bottoms: 5 }. Best-effort per type (an unknown type
 * contributes nothing rather than throwing).
 */
export async function summarizeUserImpact(
  typeCounts: Record<string, number>,
): Promise<ImpactSummary> {
  const parts: Array<{ estimate: ImpactEstimate; count: number }> = [];
  for (const [type, count] of Object.entries(typeCounts)) {
    if (!count || count <= 0) continue;
    const est = await computeGarmentImpact(type);
    if (est) parts.push({ estimate: est, count });
  }
  return sumImpactEstimates(parts);
}
