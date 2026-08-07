// US-1029/US-1030: deterministic, calibrated defect → factor-score weighting.
//
// The vision model classifies each genuine defect (type × severity × size ×
// location); THIS module turns that structured evidence into per-factor score
// CEILINGS, so the final grade can never be higher than the defects justify —
// consistently, explainably, and tunable WITHOUT re-prompting the model.
//
// Design (why a ceiling, not a subtraction):
//   The model's per-factor scores already reflect what it saw, so subtracting a
//   second deterministic penalty would double-count. Instead we derive a
//   defect-only ceiling per factor (10 minus the routed penalties) and blend by
//   taking min(modelScore, ceiling). The model may still grade LOWER than the
//   ceiling (it can see things the taxonomy misses); it just can't grade higher
//   than the structured defects allow. The gap between the two (`divergence`)
//   is a calibration/own-review signal.
//
// Everything here is pure + unit-tested (defect-weighting_test.ts). All weights
// live in the versioned tables below so a calibration change (US-1036) is one
// auditable edit, recorded on the grade via DEFECT_WEIGHTS_VERSION.

// ⚠️ US-2107 — THREE OF THE TABLES BELOW ARE NOW PUBLISHED. READ THIS FIRST.
//
// SIZE_BUCKETS (the millimetre tolerances), SEVERITY_MULT and FACTOR_ROUTING are
// mirrored onto the public /condition-grading page via src/lib/grading-standard.ts.
// They stopped being purely internal calibration on 2026-07-19.
//
// What that changes: tuning one of them is no longer a private tweak that
// accuracy tracking absorbs. It edits a PUBLISHED SPEC — the page exists
// precisely to be cited and lifted verbatim into LLM answers, so a stale mirror
// is a precise, checkable, WRONG public claim, which is worse than the vague
// adjectives it replaced.
//
// src/test/grading-standard-parity.test.ts fails if this file moves and the
// mirror does not — but note it lives in the WEB project, so `deno test` alone
// will NOT catch you. Run `npm run verify` (or let CI's web lane run) for a
// change to any of these three tables.
//
// BASE_WEIGHT is deliberately NOT published: publishing which factor a flaw hits
// makes the standard auditable, publishing the exact score-points penalty makes
// it gameable — a seller who knows the arithmetic photographs to minimise it. A
// test asserts it stays out. Reversing that is a product call, not a tidy-up.
//
// Contract + rationale: vault/20-domain/grading-scale-and-weights.md
// (Published criteria). Procedure: the `grading-engine` skill.

// Bump whenever any weight/multiplier/routing below changes in a way that could
// move grades, so accuracy tracking can attribute a shift to the weight table.
export const DEFECT_WEIGHTS_VERSION = "defect_weights_v1";

// The 5 PRD condition factors (no "_score" suffix — matches ai-grading.ts
// FactorScores; structurally interchangeable with it).
export interface FactorScores {
  fabric_condition: number;
  structural_integrity: number;
  cosmetic_appearance: number;
  functional_elements: number;
  odor_cleanliness: number;
}

export type FactorKey = keyof FactorScores;

export const FACTOR_KEYS: FactorKey[] = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
];

// US-1027: the normalized defect taxonomy. `other` is the safe catch-all for an
// unrecognized model string so a defect is never dropped for lack of a type.
export type DefectType =
  | "stain"
  | "hole_puncture"
  | "rip_tear"
  | "seam_failure_unthreading"
  | "pilling"
  | "abrasion_thinning"
  | "fading"
  | "discoloration"
  | "snag_pull"
  | "broken_zipper"
  | "broken_button"
  | "missing_hardware"
  | "stretched_misshapen"
  | "odor_indicator"
  | "wrinkle_crease"
  | "other";

export const DEFECT_TYPES: readonly DefectType[] = [
  "stain", "hole_puncture", "rip_tear", "seam_failure_unthreading", "pilling",
  "abrasion_thinning", "fading", "discoloration", "snag_pull", "broken_zipper",
  "broken_button", "missing_hardware", "stretched_misshapen", "odor_indicator",
  "wrinkle_crease", "other",
] as const;

export type DefectSeverity = "minor" | "moderate" | "major";

// US-1028: physical-size buckets. `unknown` is treated as the LOW-impact end so
// absent size data can never inflate a penalty.
export type SizeBucket =
  | "pinhole" // < 3mm
  | "small" // 3–13mm
  | "medium" // 13–50mm
  | "large" // > 50mm
  | "extensive" // dominates a panel
  | "unknown";

export const SIZE_BUCKETS: readonly SizeBucket[] = [
  "pinhole", "small", "medium", "large", "extensive", "unknown",
] as const;

export type Repairability = "reversible" | "repairable" | "permanent";

export interface WeightedDefect {
  defect_type: DefectType;
  severity: DefectSeverity;
  size_bucket: SizeBucket;
  // Optional estimated % of the affected panel/garment area (0–100). When
  // present and large it can raise the size effect beyond the bucket alone.
  area_pct?: number | null;
  location?: string;
  // Intentional design features are excluded from weighting (defensive — callers
  // pass genuine defects only, but we double-check).
  is_intentional?: boolean;
}

// ── Weight tables (versioned via DEFECT_WEIGHTS_VERSION) ───────────────

// Base penalty (score points off a 10) for a MODERATE severity, MEDIUM size,
// normal-visibility defect of each type. Structural/functional failures and
// fabric loss weigh heaviest; surface marks lightest; wrinkles near-zero.
const BASE_WEIGHT: Record<DefectType, number> = {
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

const SEVERITY_MULT: Record<DefectSeverity, number> = {
  minor: 0.5,
  moderate: 1.0,
  major: 1.8,
};

// `unknown` sits at the small end (conservative — never inflate on absent data).
const SIZE_MULT: Record<SizeBucket, number> = {
  pinhole: 0.25,
  small: 0.5,
  medium: 1.0,
  large: 1.8,
  extensive: 2.6,
  unknown: 0.5,
};

// Routing: how each defect type's penalty is distributed across factors.
// Splits per type sum to 1.0.
//
// US-1997: exported so rubric.ts's CLOTHING rubric can REFERENCE this table
// instead of carrying a three-entry hand-copy of it (which is what it had, and
// which would have silently diverged from the live engine the moment either
// side was tuned). Exporting changes no value, so the published mirror
// (src/lib/grading-standard.ts, US-2107) and its parity test are unaffected.
export const FACTOR_ROUTING: Record<DefectType, Partial<Record<FactorKey, number>>> = {
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

// Location-visibility multiplier. High-visibility areas (front/chest) weigh
// more; hidden areas (inside/lining/underarm) less.
const HIGH_VIS = /\b(front|chest|breast|collar|neck|lapel|placket|face|sleeve)\b/i;
const LOW_VIS = /\b(inside|interior|lining|inner|underarm|armpit|hidden|back of|behind|hem|waistband interior)\b/i;

function locationMult(location?: string): number {
  if (!location) return 1.0;
  if (LOW_VIS.test(location)) return 0.8;
  if (HIGH_VIS.test(location)) return 1.2;
  return 1.0;
}

// area_pct → a size multiplier, so a defect explicitly covering a large fraction
// of the garment outweighs its physical-size bucket.
function areaPctMult(areaPct: number): number {
  if (!Number.isFinite(areaPct) || areaPct <= 0) return 0;
  if (areaPct >= 30) return 2.8;
  if (areaPct >= 15) return 2.0;
  if (areaPct >= 5) return 1.3;
  if (areaPct >= 1) return 0.8;
  return 0.4;
}

// US-1030: wrinkles are minor + recoverable and must never sink a grade. The
// cumulative wrinkle penalty on any one factor is capped so wrinkle-only damage
// keeps that factor at/above WRINKLE_FLOOR_FACTOR (Excellent band) — combined
// with cosmetic's 20% weight this keeps a wrinkles-only garment comfortably in
// "Very Good"+.
export const WRINKLE_FLOOR_FACTOR = 8.5;
const WRINKLE_MAX_FACTOR_PENALTY = 10 - WRINKLE_FLOOR_FACTOR; // 1.5

// Minimum any factor ceiling can reach (mirrors the 1.0 score floor).
const MIN_FACTOR = 1.0;

export interface AppliedDefectImpact {
  defect_type: DefectType;
  severity: DefectSeverity;
  size_bucket: SizeBucket;
  /** Total penalty points this defect contributed (pre per-factor capping). */
  penalty: number;
  /** Routed penalty per factor. */
  factors: Partial<Record<FactorKey, number>>;
}

export interface DefectWeightingResult {
  /** Defect-only ceiling per factor (1–10). */
  ceilingByFactor: FactorScores;
  /** Total penalty applied per factor (capped). */
  penaltyByFactor: FactorScores;
  /** min(modelScore, ceiling) per factor — the blended grade input. */
  blendedFactors: FactorScores;
  /** max |modelScore − ceiling| across factors (calibration/own-review signal). */
  divergence: number;
  /** Per-defect explanation, for disclosure/admin. */
  appliedDefects: AppliedDefectImpact[];
  /** Weight-table version that produced this result. */
  weightsVersion: string;
}

/** Per-defect penalty before routing: base × severity × size × location. */
export function defectPenalty(d: WeightedDefect): number {
  const base = BASE_WEIGHT[d.defect_type] ?? BASE_WEIGHT.other;
  const sev = SEVERITY_MULT[d.severity] ?? SEVERITY_MULT.moderate;
  let size = SIZE_MULT[d.size_bucket] ?? SIZE_MULT.unknown;
  if (d.area_pct != null) size = Math.max(size, areaPctMult(d.area_pct));
  const loc = locationMult(d.location);
  let penalty = base * sev * size * loc;
  // Wrinkles are individually tiny no matter how they're sized/located.
  if (d.defect_type === "wrinkle_crease") {
    penalty = Math.min(penalty, WRINKLE_MAX_FACTOR_PENALTY);
  }
  return penalty;
}

function emptyFactors(): FactorScores {
  return {
    fabric_condition: 0,
    structural_integrity: 0,
    cosmetic_appearance: 0,
    functional_elements: 0,
    odor_cleanliness: 0,
  };
}

/**
 * Convert structured defects into per-factor ceilings and blend with the model's
 * factor scores (ceiling = deterministic cap; blended = min(model, ceiling)).
 *
 * @param modelFactors the model's per-factor scores (1–10)
 * @param defects genuine defects (intentional features are ignored)
 */
export function applyDefectWeighting(
  modelFactors: FactorScores,
  defects: WeightedDefect[],
): DefectWeightingResult {
  const penaltyByFactor = emptyFactors();
  // Track per-factor penalty that came ONLY from wrinkles, so we can cap it.
  const wrinklePenaltyByFactor = emptyFactors();
  const appliedDefects: AppliedDefectImpact[] = [];

  for (const d of defects) {
    if (d.is_intentional) continue;
    const penalty = defectPenalty(d);
    const routing = FACTOR_ROUTING[d.defect_type] ?? FACTOR_ROUTING.other;
    const factors: Partial<Record<FactorKey, number>> = {};
    for (const [factor, split] of Object.entries(routing) as [FactorKey, number][]) {
      const routed = penalty * split;
      penaltyByFactor[factor] += routed;
      if (d.defect_type === "wrinkle_crease") {
        wrinklePenaltyByFactor[factor] += routed;
      }
      factors[factor] = routed;
    }
    appliedDefects.push({
      defect_type: d.defect_type,
      severity: d.severity,
      size_bucket: d.size_bucket,
      penalty,
      factors,
    });
  }

  // US-1030: cap the wrinkle-only contribution per factor. If a factor's entire
  // penalty came from wrinkles, hold it to WRINKLE_MAX_FACTOR_PENALTY so
  // wrinkles alone can't push the ceiling below the Excellent band.
  for (const f of FACTOR_KEYS) {
    const wrinkleOnly = Math.abs(penaltyByFactor[f] - wrinklePenaltyByFactor[f]) < 1e-9;
    if (wrinkleOnly && penaltyByFactor[f] > WRINKLE_MAX_FACTOR_PENALTY) {
      penaltyByFactor[f] = WRINKLE_MAX_FACTOR_PENALTY;
    }
  }

  const ceilingByFactor = emptyFactors();
  const blendedFactors = emptyFactors();
  let divergence = 0;
  for (const f of FACTOR_KEYS) {
    const ceiling = clampFactor(10 - penaltyByFactor[f]);
    ceilingByFactor[f] = ceiling;
    const model = clampFactor(modelFactors[f]);
    blendedFactors[f] = Math.min(model, ceiling);
    divergence = Math.max(divergence, Math.abs(model - ceiling));
  }

  return {
    ceilingByFactor,
    penaltyByFactor,
    blendedFactors,
    divergence: Number(divergence.toFixed(2)),
    appliedDefects,
    weightsVersion: DEFECT_WEIGHTS_VERSION,
  };
}

function clampFactor(n: number): number {
  if (!Number.isFinite(n)) return MIN_FACTOR;
  return Math.max(MIN_FACTOR, Math.min(10, n));
}

// ── Coercion helpers (model output → typed enums) ─────────────────────

export function coerceDefectType(raw: unknown): DefectType {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (DEFECT_TYPES as readonly string[]).includes(s) ? (s as DefectType) : "other";
}

export function coerceSizeBucket(raw: unknown): SizeBucket {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (SIZE_BUCKETS as readonly string[]).includes(s) ? (s as SizeBucket) : "unknown";
}

export function coerceRepairability(raw: unknown): Repairability {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "reversible" || s === "repairable" || s === "permanent") return s;
  // Default to the cautious end: assume not trivially reversible.
  return "permanent";
}

// US-1930: coerce a model-supplied severity to the enum. A non-structured-output
// model can return an off-spec / empty severity ("severe", "critical", "") for a
// GENUINE defect. Dropping such a defect (the old behavior) let a real major
// defect escape the defect-weighting ceiling, so the grade could exceed what the
// defect justifies. Never discard: coerce the unknown to the conservative middle
// ("moderate") so the defect still lowers the grade. `coerced` lets callers log
// model/prompt drift. Known values pass through case-insensitively.
export function coerceSeverity(
  raw: unknown,
): { severity: DefectSeverity; coerced: boolean } {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "minor" || s === "moderate" || s === "major") {
    return { severity: s, coerced: false };
  }
  return { severity: "moderate", coerced: true };
}

export function coerceAreaPct(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, raw));
}

// US-1028: bbox-area cross-check. A defect claimed "large/extensive" whose
// bounding box is tiny (or vice-versa) is internally inconsistent — callers use
// this to lower size confidence. Returns the bucket the bbox area implies, or
// null when there's no usable bbox.
export function bboxImpliedBucket(
  bbox: [number, number, number, number] | null | undefined,
): SizeBucket | null {
  if (!bbox || bbox.length !== 4) return null;
  const [, , w, h] = bbox;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const area = w * h; // fraction of the image (0–1)
  if (area >= 0.15) return "extensive";
  if (area >= 0.04) return "large";
  if (area >= 0.008) return "medium";
  if (area >= 0.0015) return "small";
  return "pinhole";
}

const BUCKET_RANK: Record<SizeBucket, number> = {
  pinhole: 0, small: 1, medium: 2, large: 3, extensive: 4, unknown: -1,
};

/**
 * True when the model's claimed size bucket and the bbox-implied bucket differ
 * by more than one rank — an inconsistency that should lower size confidence.
 */
export function sizeBucketConflict(
  claimed: SizeBucket,
  bbox: [number, number, number, number] | null | undefined,
): boolean {
  const implied = bboxImpliedBucket(bbox);
  if (!implied || claimed === "unknown") return false;
  return Math.abs(BUCKET_RANK[claimed] - BUCKET_RANK[implied]) > 1;
}
