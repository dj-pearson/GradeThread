// US-1113: buyer-guarantee claim → grading-accuracy calibration math.
//
// An APPROVED buyer trust-guarantee claim is a confirmed "the grade was wrong"
// signal — the certified item was materially WORSE than graded. This module is
// the PURE half of the feedback loop (no supabase/env, fully unit-tested): it
// maps a claim's structured `claimed_issues` ({ defect, severity, location }) to
// the five grading factors and turns them into per-factor "over-grade" deltas,
// and it aggregates the persisted signals into the per-factor report the admin
// grading-calibration panel renders.
//
// The IMPURE half (persist on approve / neutralize on reject + the DB read for
// the aggregate) lives in accuracy-tracking.ts, the accuracy-tracking pipeline.

// The five grading factors (mirrors accuracy-tracking.ts FACTOR_NAMES + the
// CLAUDE.md rubric).
export const CLAIM_FACTORS = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;
export type ClaimFactor = (typeof CLAIM_FACTORS)[number];

// Rubric weights (CLAUDE.md grading system): Fabric 30%, Structural 25%,
// Cosmetic 20%, Functional 15%, Odor/Cleanliness 10%. Used to roll the per-factor
// over-grade deltas up into an implied OVERALL over-grade.
const FACTOR_WEIGHTS: Record<ClaimFactor, number> = {
  fabric_condition: 0.3,
  structural_integrity: 0.25,
  cosmetic_appearance: 0.2,
  functional_elements: 0.15,
  odor_cleanliness: 0.1,
};

// Buyer-claim severity → the over-grade magnitude (points the grade was too high)
// a CONFIRMED issue implies for its factor. Mirrors the intake severities
// (guarantee-public.ts normalizes to minor|moderate|major, default moderate).
const SEVERITY_WEIGHT: Record<string, number> = {
  minor: 0.5,
  moderate: 1.0,
  major: 2.0,
};
const DEFAULT_SEVERITY_WEIGHT = SEVERITY_WEIGHT.moderate;

// defect keyword → factor. Checked most-specific first (odor / functional /
// structural before the broad fabric & cosmetic buckets) so e.g. "broken zipper"
// lands on functional, not the cosmetic fallback. A defect that matches nothing
// falls back to cosmetic_appearance (a generic condition complaint).
// NOTE: matching is plain substring (defect.includes(keyword)), so keywords are
// kept specific enough not to fire on unrelated words (e.g. bare "thin" would hit
// "someTHINg"; bare "rip" would hit "stRIPe"). Prefer the longer, unambiguous form.
const FACTOR_KEYWORDS: Array<[ClaimFactor, string[]]> = [
  ["odor_cleanliness", [
    "odor", "odour", "smell", "stink", "musty", "mildew", "moldy", "mold",
    "smoke", "perfume", "fragrance", "dirty", "soiled", "unwashed", "stale",
  ]],
  ["functional_elements", [
    "zipper", "zip", "button", "snap", "clasp", "buckle", "drawstring",
    "elastic", "pocket", "hardware", "closure", "fasten", "velcro", "hook",
    "strap", "broken", "missing", "doesn't work", "does not work", "stuck",
  ]],
  ["structural_integrity", [
    "seam", "stitch", "hole", "tear", "torn", "ripped", "rips", "hem",
    "unravel", "fray", "frayed", "split", "loose thread", "construction",
    "lining", "shoulder", "fall apart", "falling apart",
  ]],
  ["fabric_condition", [
    "stain", "discolor", "discolour", "fade", "faded", "pill", "pilling",
    "thinning", "sheer", "snag", "fabric", "material", "bleach", "yellow",
    "shrink", "shrunk", "worn", "spot", "stretch",
  ]],
  ["cosmetic_appearance", [
    "scuff", "scratch", "print", "logo", "graphic", "crack", "cracked",
    "peel", "fuzz", "wrinkle", "crease", "appearance", "cosmetic", "color",
    "colour", "blemish",
  ]],
];

const DEFAULT_FACTOR: ClaimFactor = "cosmetic_appearance";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Map one claimed defect description to the grading factor it most affects. */
export function factorForDefect(defect: string): ClaimFactor {
  const d = defect.toLowerCase();
  for (const [factor, keywords] of FACTOR_KEYWORDS) {
    if (keywords.some((k) => d.includes(k))) return factor;
  }
  return DEFAULT_FACTOR;
}

/** Over-grade magnitude (points) implied by a claimed issue's severity. */
export function severityWeight(severity: string): number {
  return SEVERITY_WEIGHT[severity.toLowerCase()] ?? DEFAULT_SEVERITY_WEIGHT;
}

export interface ClaimIssue {
  defect: string;
  severity: string;
  location?: string;
}

export interface ClaimFactorDeltas {
  // Per-factor summed over-grade points (how much too HIGH the factor graded).
  deltas: Record<ClaimFactor, number>;
  // Rubric-weighted implied overall over-grade.
  overall_delta: number;
  // Count of issues that mapped to a factor.
  issue_count: number;
}

export function emptyFactorDeltas(): Record<ClaimFactor, number> {
  return {
    fabric_condition: 0,
    structural_integrity: 0,
    cosmetic_appearance: 0,
    functional_elements: 0,
    odor_cleanliness: 0,
  };
}

/**
 * Coerce a claim's stored `claimed_issues` jsonb into a clean ClaimIssue[].
 * Tolerant of malformed rows (drops entries with no `defect`).
 */
export function normalizeClaimIssues(raw: unknown): ClaimIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaimIssue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const defect = typeof rec.defect === "string" ? rec.defect.trim() : "";
    if (!defect) continue;
    out.push({
      defect,
      severity: typeof rec.severity === "string" ? rec.severity : "moderate",
      location: typeof rec.location === "string" ? rec.location : undefined,
    });
  }
  return out;
}

/**
 * Map a confirmed claim's structured issues to per-factor over-grade deltas.
 * Each issue adds its severity weight to the factor its defect maps to; the
 * overall delta is the rubric-weighted sum. A claim with no structured issues
 * yields zero deltas (it still records as an approved claim, just no per-factor
 * signal — we never fabricate one from free text).
 */
export function mapClaimIssuesToFactorDeltas(issues: ClaimIssue[]): ClaimFactorDeltas {
  const deltas = emptyFactorDeltas();
  let count = 0;
  for (const issue of issues) {
    if (!issue || typeof issue.defect !== "string" || !issue.defect.trim()) continue;
    const factor = factorForDefect(issue.defect);
    deltas[factor] = round2(deltas[factor] + severityWeight(issue.severity ?? ""));
    count++;
  }
  let overall = 0;
  for (const f of CLAIM_FACTORS) overall += deltas[f] * FACTOR_WEIGHTS[f];
  return { deltas, overall_delta: round2(overall), issue_count: count };
}

// ─── Aggregate (panel report) ───────────────────────────────────────

export interface ClaimFactorSignal {
  factor: ClaimFactor;
  // Active approved claims that flagged this factor (delta > 0).
  claims: number;
  // Summed over-grade points across those claims.
  total_delta: number;
  // Mean over-grade per flagging claim.
  mean_delta: number;
}

export interface ClaimAccuracySignalReport {
  factors: ClaimFactorSignal[];
  // Active approved claims feeding the loop.
  total_claims: number;
  // Structured issues across all active claims.
  total_issues: number;
  // Mean implied overall over-grade across active claims.
  mean_overall_delta: number;
  generated_at: string;
}

// One persisted signal row (the subset the aggregate reads).
export interface ClaimSignalRow {
  factor_deltas: Record<string, number> | null;
  overall_delta: number | null;
  issue_count: number | null;
}

/**
 * Aggregate the persisted (active) claim signals into the per-factor report the
 * admin grading-calibration panel renders. Pure — fed the rows by the impure
 * computeClaimAccuracySignal() in accuracy-tracking.ts.
 */
export function aggregateClaimSignals(
  rows: ClaimSignalRow[],
  generatedAt: string,
): ClaimAccuracySignalReport {
  const totals = emptyFactorDeltas();
  const flagCounts = emptyFactorDeltas();
  let totalIssues = 0;
  let overallSum = 0;

  for (const row of rows) {
    const fd = (row.factor_deltas ?? {}) as Record<string, number>;
    for (const f of CLAIM_FACTORS) {
      const v = Number(fd[f] ?? 0);
      if (Number.isFinite(v) && v > 0) {
        totals[f] += v;
        flagCounts[f] += 1;
      }
    }
    totalIssues += Number(row.issue_count ?? 0);
    overallSum += Number(row.overall_delta ?? 0);
  }

  const factors: ClaimFactorSignal[] = CLAIM_FACTORS.map((f) => ({
    factor: f,
    claims: flagCounts[f],
    total_delta: round2(totals[f]),
    mean_delta: flagCounts[f] > 0 ? round2(totals[f] / flagCounts[f]) : 0,
  })).sort((a, b) => b.total_delta - a.total_delta);

  return {
    factors,
    total_claims: rows.length,
    total_issues: totalIssues,
    mean_overall_delta: rows.length > 0 ? round2(overallSum / rows.length) : 0,
    generated_at: generatedAt,
  };
}
