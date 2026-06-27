// US-1286: AI repair triage — recovered-value recommendations.
//
// Given the structured defect taxonomy the grader already produces (defect_type
// × severity × size × repairability — see services/edge-functions/src/lib/
// defect-weighting.ts), this PURE module estimates, per defect, what ADDRESSING a
// reversible/repairable flaw would do to the grade and to resale value. It moves
// GradeThread from merely measuring damage to recommending how to capture value.
//
// Design notes:
//   - We mirror (a deliberately lighter version of) the edge weighting tables so
//     the seller-facing estimate is consistent with how the grade was computed,
//     WITHOUT importing Deno/edge code into the browser bundle. The mirror is
//     intentionally an estimate: it omits the per-factor capping/blending the
//     real engine does, which is the right altitude for "what could I recover".
//   - Permanent defects (and grades with no repairability data) make NO repair
//     promise — `computeRepairImpact` returns null so the UI shows nothing.
//   - The referral block points to GENERIC resource categories (tailor, cleaner,
//     at-home care) — no hard partner dependency.
//
// Everything here is pure + unit-tested (repair-triage.test.ts).

import type { DefectFound } from "@/types/database";

export type Repairability = "reversible" | "repairable" | "permanent";

// The 5 PRD condition factors and their weight in the overall grade (CLAUDE.md:
// Fabric 30%, Structural 25%, Cosmetic 20%, Functional 15%, Odor 10%).
type FactorKey =
  | "fabric_condition"
  | "structural_integrity"
  | "cosmetic_appearance"
  | "functional_elements"
  | "odor_cleanliness";

const FACTOR_WEIGHT: Record<FactorKey, number> = {
  fabric_condition: 0.3,
  structural_integrity: 0.25,
  cosmetic_appearance: 0.2,
  functional_elements: 0.15,
  odor_cleanliness: 0.1,
};

// Base penalty for a MODERATE/MEDIUM defect of each type (mirrors edge
// BASE_WEIGHT). Unknown types fall back to the `other` weight.
const BASE_WEIGHT: Record<string, number> = {
  broken_zipper: 5.0,
  seam_failure_unthreading: 4.5,
  missing_hardware: 4.5,
  rip_tear: 4.0,
  hole_puncture: 3.5,
  stretched_misshapen: 3.0,
  odor_indicator: 3.0,
  stain: 2.5,
  broken_button: 2.5,
  abrasion_thinning: 2.5,
  discoloration: 2.0,
  other: 2.0,
  fading: 1.5,
  pilling: 1.5,
  snag_pull: 1.5,
  wrinkle_crease: 0.4,
};

const SEVERITY_MULT: Record<string, number> = {
  minor: 0.5,
  moderate: 1.0,
  major: 1.8,
};

// `unknown` sits at the small end (never inflate on absent data).
const SIZE_MULT: Record<string, number> = {
  pinhole: 0.25,
  small: 0.5,
  medium: 1.0,
  large: 1.8,
  extensive: 2.6,
  unknown: 0.5,
};

// How each defect type's penalty distributes across factors (mirrors edge
// FACTOR_ROUTING; splits per type sum to 1.0).
const FACTOR_ROUTING: Record<string, Partial<Record<FactorKey, number>>> = {
  stain: { odor_cleanliness: 0.6, cosmetic_appearance: 0.4 },
  hole_puncture: { fabric_condition: 0.8, cosmetic_appearance: 0.2 },
  rip_tear: { structural_integrity: 0.6, fabric_condition: 0.4 },
  seam_failure_unthreading: { structural_integrity: 1.0 },
  pilling: { fabric_condition: 0.7, cosmetic_appearance: 0.3 },
  abrasion_thinning: { fabric_condition: 0.8, cosmetic_appearance: 0.2 },
  fading: { cosmetic_appearance: 0.7, fabric_condition: 0.3 },
  discoloration: { cosmetic_appearance: 0.6, odor_cleanliness: 0.4 },
  snag_pull: { fabric_condition: 0.6, cosmetic_appearance: 0.4 },
  broken_zipper: { functional_elements: 1.0 },
  broken_button: { functional_elements: 0.8, cosmetic_appearance: 0.2 },
  missing_hardware: { functional_elements: 1.0 },
  stretched_misshapen: { structural_integrity: 0.6, cosmetic_appearance: 0.4 },
  odor_indicator: { odor_cleanliness: 1.0 },
  wrinkle_crease: { cosmetic_appearance: 1.0 },
  other: { fabric_condition: 0.5, cosmetic_appearance: 0.5 },
};

// area_pct → a size multiplier, so a defect explicitly covering a large fraction
// of the garment outweighs its physical-size bucket (mirrors edge areaPctMult).
function areaPctMult(areaPct: number): number {
  if (!Number.isFinite(areaPct) || areaPct <= 0) return 0;
  if (areaPct >= 30) return 2.8;
  if (areaPct >= 15) return 2.0;
  if (areaPct >= 5) return 1.3;
  if (areaPct >= 1) return 0.8;
  return 0.4;
}

// How much of a defect's grade cost a repair realistically recovers. Reversible
// flaws (steam/wash/lint/de-pill) come out clean; a repairable structural fix
// (re-stitch, replace a button/zipper) restores most but not all value.
const RECOVERY_FRACTION: Record<"reversible" | "repairable", number> = {
  reversible: 1.0,
  repairable: 0.75,
};

// Conservative resale-value elasticity: each restored grade point lifts resale
// value by roughly this %. Kept modest so the estimate never over-promises.
const VALUE_LIFT_PCT_PER_GRADE_POINT = 6;

export interface RepairResource {
  /** Generic resource category (no partner dependency). */
  label: string;
  hint: string;
}

// Generic, non-affiliated resource categories the referral block points to.
export const REPAIR_RESOURCES: Record<"cleaning" | "tailor" | "diy", RepairResource> = {
  cleaning: {
    label: "Professional cleaning",
    hint: "A dry cleaner or stain/odor specialist can often lift marks and smells fabric care alone won't.",
  },
  tailor: {
    label: "Tailor or alterations shop",
    hint: "A local tailor can re-stitch seams, replace buttons/zippers, reweave small holes, and reshape garments.",
  },
  diy: {
    label: "At-home care",
    hint: "A garment steamer, fabric shaver, or spot-treatment handles wrinkles, pilling, and light surface marks.",
  },
};

type ResourceKey = keyof typeof REPAIR_RESOURCES;

// Map each defect type to a suggested remedy + the resource category it needs.
const REMEDY_BY_TYPE: Record<string, { action: string; resource: ResourceKey }> = {
  stain: { action: "Spot-treat or have it professionally cleaned", resource: "cleaning" },
  discoloration: { action: "Try color-safe brightening or professional cleaning", resource: "cleaning" },
  odor_indicator: { action: "Deodorize or have it professionally cleaned", resource: "cleaning" },
  wrinkle_crease: { action: "Steam or press to release the creasing", resource: "diy" },
  pilling: { action: "De-pill with a fabric shaver or sweater stone", resource: "diy" },
  fading: { action: "Restore with a color-safe dye or refresh treatment", resource: "diy" },
  snag_pull: { action: "Pull the snag through to the inside with a snag tool", resource: "diy" },
  seam_failure_unthreading: { action: "Have the seam re-stitched", resource: "tailor" },
  broken_button: { action: "Replace the button", resource: "tailor" },
  broken_zipper: { action: "Replace or repair the zipper", resource: "tailor" },
  missing_hardware: { action: "Replace the missing hardware", resource: "tailor" },
  rip_tear: { action: "Have the tear mended or reinforced", resource: "tailor" },
  hole_puncture: { action: "Have the hole rewoven or patched", resource: "tailor" },
  stretched_misshapen: { action: "Reshape or have it tailored back to fit", resource: "tailor" },
  abrasion_thinning: { action: "Reinforce the worn area", resource: "tailor" },
  other: { action: "Consult a repair specialist", resource: "tailor" },
};

export interface RepairImpact {
  /** Only ever "reversible" | "repairable" — permanent defects return null. */
  repairability: "reversible" | "repairable";
  /** Estimated overall grade points restored if the defect is addressed (>0). */
  gradeLift: number;
  /** Estimated resale-value lift, as a % of the item's value (rounded, ≥0). */
  valueLiftPct: number;
  /** Fraction of the defect's grade cost a repair recovers (0–1). */
  recoveryFraction: number;
  /** Suggested remedy, e.g. "Re-stitch the seam". */
  action: string;
  /** Generic referral resource for this remedy. */
  resource: RepairResource;
}

function normalizeRepairability(raw: string | null | undefined): Repairability {
  if (raw === "reversible" || raw === "repairable" || raw === "permanent") return raw;
  // Cautious default mirrors edge coerceRepairability: assume not reversible.
  return "permanent";
}

/** Estimated overall grade points this defect costs (pre-recovery). */
function defectGradeCost(d: DefectFound): number {
  const type = d.defect_type ?? "other";
  // Literal fallbacks (not map lookups) so noUncheckedIndexedAccess yields a
  // concrete `number` — the `other` row's own values for an unknown type.
  const base = BASE_WEIGHT[type] ?? 2.0;
  const sev = SEVERITY_MULT[d.severity] ?? 1.0;
  let size = SIZE_MULT[d.size_bucket ?? "unknown"] ?? 0.5;
  if (d.area_pct != null) size = Math.max(size, areaPctMult(d.area_pct));
  const penalty = base * sev * size;
  // Route the penalty across factors and weight each by its overall grade share.
  const routing = FACTOR_ROUTING[type] ?? FACTOR_ROUTING.other ?? {};
  let overall = 0;
  for (const [factor, split] of Object.entries(routing) as [FactorKey, number][]) {
    overall += penalty * split * FACTOR_WEIGHT[factor];
  }
  return overall;
}

const DEFAULT_REMEDY: { action: string; resource: ResourceKey } = {
  action: "Consult a repair specialist",
  resource: "tailor",
};

/**
 * Per-defect repair impact, or null when the defect can't be meaningfully
 * repaired (permanent / no repairability data) — those make no repair promise.
 */
export function computeRepairImpact(d: DefectFound): RepairImpact | null {
  const repairability = normalizeRepairability(d.repairability);
  if (repairability === "permanent") return null;

  const recoveryFraction = RECOVERY_FRACTION[repairability];
  const gradeLift = Number((defectGradeCost(d) * recoveryFraction).toFixed(2));
  // Defensive: a reversible/repairable defect always routes to a weighted
  // factor, so cost > 0 — but never surface a non-positive lift as a promise.
  if (gradeLift <= 0) return null;

  const valueLiftPct = Math.round(gradeLift * VALUE_LIFT_PCT_PER_GRADE_POINT);
  const type = d.defect_type ?? "other";
  const remedy = REMEDY_BY_TYPE[type] ?? DEFAULT_REMEDY;

  return {
    repairability,
    gradeLift,
    valueLiftPct,
    recoveryFraction,
    action: remedy.action,
    resource: REPAIR_RESOURCES[remedy.resource],
  };
}

export interface DefectRepairImpact {
  defect: DefectFound;
  impact: RepairImpact;
}

export interface RepairTriageSummary {
  /** Per-defect impacts, worst-first by grade lift. */
  items: DefectRepairImpact[];
  /** Sum of per-defect grade lifts (rounded). */
  totalGradeLift: number;
  /** Sum of per-defect resale-value lifts, % (rounded). */
  totalValueLiftPct: number;
  /** Distinct referral resources across all repairable defects. */
  resources: RepairResource[];
}

/**
 * Build the repair-triage summary for a grade report's defects. Only
 * reversible/repairable defects appear; permanent ones are silently excluded.
 * Returns null when there's nothing worth repairing.
 */
export function summarizeRepairTriage(
  defects: DefectFound[] | null | undefined,
): RepairTriageSummary | null {
  if (!defects || defects.length === 0) return null;

  const items: DefectRepairImpact[] = [];
  for (const defect of defects) {
    const impact = computeRepairImpact(defect);
    if (impact) items.push({ defect, impact });
  }
  if (items.length === 0) return null;

  items.sort((a, b) => b.impact.gradeLift - a.impact.gradeLift);

  const totalGradeLift = Number(
    items.reduce((sum, it) => sum + it.impact.gradeLift, 0).toFixed(2),
  );
  const totalValueLiftPct = items.reduce((sum, it) => sum + it.impact.valueLiftPct, 0);

  const resources: RepairResource[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!seen.has(it.impact.resource.label)) {
      seen.add(it.impact.resource.label);
      resources.push(it.impact.resource);
    }
  }

  return { items, totalGradeLift, totalValueLiftPct, resources };
}
