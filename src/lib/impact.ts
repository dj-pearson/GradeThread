// US-1787: client-side circularity impact helpers. Per-garment impact comes from
// the public, aggregate-only endpoint (deterministic, no PII); the user's closet
// total is summed CLIENT-SIDE from their RLS-scoped submission counts, so no
// authed edge route or per-user server aggregation is needed. Every figure is an
// ESTIMATE with a methodology link (US-1786).

import { edgeApiUrl } from "@/lib/edge-api";

export interface ImpactEstimate {
  estimate: true;
  co2e_kg: number;
  water_liters: number;
  landfill_kg: number;
  source: string;
  version: string;
  methodology: string;
}

export interface ImpactSummary {
  estimate: true;
  garment_count: number;
  co2e_kg: number;
  water_liters: number;
  landfill_kg: number;
  methodology: string;
}

/** Fetch the per-garment impact for a type. Returns null for an unknown type. */
export async function fetchGarmentImpact(garmentType: string): Promise<ImpactEstimate | null> {
  try {
    const res = await fetch(
      `${edgeApiUrl()}/api/grading/public/impact/${encodeURIComponent(garmentType)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as ImpactEstimate;
  } catch {
    return null;
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Sum per-type estimates × counts into a closet total. Pure + testable. */
export function sumImpacts(parts: Array<{ estimate: ImpactEstimate; count: number }>): ImpactSummary {
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
  const methodology = parts[0]?.estimate.methodology ??
    "Estimated impact avoided by buying secondhand instead of new.";
  return {
    estimate: true,
    garment_count: count,
    co2e_kg: round(co2e, 1),
    water_liters: Math.round(water / 10) * 10,
    landfill_kg: round(landfill, 2),
    methodology,
  };
}

/** Given garment-type counts, fetch each type's impact and sum the closet total. */
export async function summarizeClosetImpact(
  typeCounts: Record<string, number>,
): Promise<ImpactSummary> {
  const types = Object.keys(typeCounts).filter((t) => typeCounts[t] > 0);
  const estimates = await Promise.all(types.map((t) => fetchGarmentImpact(t)));
  const parts = types
    .map((t, i) => ({ estimate: estimates[i], count: typeCounts[t] }))
    .filter((p): p is { estimate: ImpactEstimate; count: number } => p.estimate != null);
  return sumImpacts(parts);
}

// ── Display formatting ──────────────────────────────────────────────────────
export function formatCo2e(kg: number): string {
  if (kg >= 1000) return `${round(kg / 1000, 1)} t CO₂e`;
  return `${Math.round(kg)} kg CO₂e`;
}
export function formatWater(liters: number): string {
  if (liters >= 1000) return `${round(liters / 1000, 1)}k L water`;
  return `${Math.round(liters)} L water`;
}
export function formatLandfill(kg: number): string {
  return `${round(kg, 1)} kg from landfill`;
}
