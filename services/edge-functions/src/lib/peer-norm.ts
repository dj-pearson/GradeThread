// US-1536 chunk 1: peer-norm sanity check — pure statistics core.
//
// Compares a fresh composite grade against the distribution of past FINAL grades
// (human-adjusted where reviewed) for SIMILAR items. A grade that lands well
// outside the peer inter-quartile range is confidence-capped and routed to human
// review with the peer context shown to the reviewer. Independent audit — peer
// grades are NEVER fed into the grading prompt (that would anchor the model);
// this checks the model's independent output after the fact.
//
// This module is the deterministic math + decision only. The peer-profile SQL
// query (+ any index migration), the grading-pipeline wiring, the reviewer-UI
// distribution line, and the system_settings config keys are wired in follow-up
// chunks. Kept pure so it is fully unit-testable with no DB / AI call.

// Cap sits just under the 0.75 human-review threshold so a peer-norm outlier is
// always routed to a reviewer — matching PARTIAL_IMAGE_CONFIDENCE_CAP and the
// other confidence caps in grading-pipeline.ts (composed via min-of-caps).
export const PEER_NORM_CONFIDENCE_CAP = 0.7;

export interface PeerNormConfig {
  enabled: boolean;
  /** No-op below this sample size (mirrors the transparency page's n<10 gate). */
  minSampleSize: number;
  /** Grade points beyond the peer IQR before a grade is flagged an outlier. */
  iqrMarginPoints: number;
}

export const DEFAULT_PEER_NORM_CONFIG: PeerNormConfig = {
  enabled: true,
  minSampleSize: 10,
  iqrMarginPoints: 1.0,
};

export interface PeerDistribution {
  sampleSize: number;
  median: number;
  p25: number;
  p75: number;
}

/**
 * Linear-interpolation quartiles over a set of final grades. Returns null for an
 * empty set. Ignores non-finite values.
 */
export function computePeerQuartiles(values: number[]): PeerDistribution | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const q = (p: number): number => {
    if (xs.length === 1) return xs[0]!;
    const idx = p * (xs.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return xs[lo]!;
    return xs[lo]! + (xs[hi]! - xs[lo]!) * (idx - lo);
  };
  return { sampleSize: xs.length, median: q(0.5), p25: q(0.25), p75: q(0.75) };
}

export interface PeerNormResult {
  flagged: boolean;
  /** Human-readable peer context for the reviewer, or null when not flagged. */
  reason: string | null;
  /** Confidence ceiling to compose (min) with existing caps, or null. */
  confidenceCap: number | null;
}

const NOT_FLAGGED: PeerNormResult = {
  flagged: false,
  reason: null,
  confidenceCap: null,
};

/**
 * Decide whether `overallGrade` is a peer-norm outlier relative to `dist`.
 * No-op (not flagged) when disabled or the sample is too thin — errs toward
 * NOT capping so a sparse category never over-triggers human review.
 */
export function evaluatePeerNorm(
  overallGrade: number,
  dist: PeerDistribution | null,
  config: PeerNormConfig = DEFAULT_PEER_NORM_CONFIG,
): PeerNormResult {
  if (!config.enabled) return NOT_FLAGGED;
  if (!dist || dist.sampleSize < config.minSampleSize) return NOT_FLAGGED;

  const lower = dist.p25 - config.iqrMarginPoints;
  const upper = dist.p75 + config.iqrMarginPoints;
  if (overallGrade >= lower && overallGrade <= upper) return NOT_FLAGGED;

  const direction = overallGrade > upper ? "above" : "below";
  const reason =
    `peer_norm: grade ${overallGrade.toFixed(1)} is ${direction} the similar-item ` +
    `range ${dist.p25.toFixed(1)}–${dist.p75.toFixed(1)} ` +
    `(median ${dist.median.toFixed(1)}, n=${dist.sampleSize})`;
  return { flagged: true, reason, confidenceCap: PEER_NORM_CONFIDENCE_CAP };
}

/**
 * Compose a peer-norm cap with the current confidence: the lower (more
 * conservative) value wins, so peer-norm never RAISES confidence and stacks
 * correctly with the pipeline's other caps.
 */
export function composeConfidenceCap(
  currentConfidence: number,
  cap: number | null,
): number {
  return cap == null ? currentConfidence : Math.min(currentConfidence, cap);
}

// ── Peer-profile cell (defect profile bucketing) ─────────────────────────────
//
// The peer distribution is computed per SIMILAR-item cell: same garment_category
// (+ brand when there are enough brand samples) with a similar defect profile —
// (defect count bucket × max severity). These pure helpers derive that cell key
// so the peer-profile SQL query (next chunk) groups on a stable, low-cardinality
// bucketing rather than exact defect counts.

export type DefectSeverity = "minor" | "moderate" | "major";

const SEVERITY_RANK: Record<DefectSeverity, number> = {
  minor: 1,
  moderate: 2,
  major: 3,
};

/** Low-cardinality bucket for a defect count: "0" | "1" | "2-3" | "4+". */
export function defectCountBucket(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2-3";
  return "4+";
}

/** Highest severity present, or "none" for a clean item. Unknown values ignored. */
export function maxSeverityBucket(
  severities: readonly string[],
): "none" | DefectSeverity {
  let best: DefectSeverity | null = null;
  for (const s of severities) {
    if (s === "minor" || s === "moderate" || s === "major") {
      if (!best || SEVERITY_RANK[s] > SEVERITY_RANK[best]) best = s;
    }
  }
  return best ?? "none";
}

export interface PeerProfileCell {
  garmentCategory: string;
  /** Brand-refined cell when brand samples are sufficient; null = category-only. */
  brand: string | null;
  defectCountBucket: string;
  maxSeverity: "none" | DefectSeverity;
}

/** Derive the peer-profile cell for an item from its category/brand + the
 *  severities of its consolidated defects. Pure. */
export function peerProfileCell(input: {
  garmentCategory: string;
  brand?: string | null;
  defectSeverities: readonly string[];
}): PeerProfileCell {
  const brand = input.brand?.trim() ? input.brand.trim() : null;
  return {
    garmentCategory: input.garmentCategory,
    brand,
    defectCountBucket: defectCountBucket(input.defectSeverities.length),
    maxSeverity: maxSeverityBucket(input.defectSeverities),
  };
}

// ── Peer selection + fetch (US-1536 final chunk) ─────────────────────────────

/** One past grade eligible as a peer: its FINAL grade (human-adjusted where
 *  reviewed), brand, and consolidated defect severities. */
export interface PeerCandidate {
  finalGrade: number;
  brand: string | null;
  severities: string[];
}

/**
 * Pure peer selection: keep candidates whose defect profile matches the cell,
 * refined to the brand subset when it alone clears minSampleSize (AC1) —
 * otherwise the category-level cohort is the comparison set.
 */
export function selectPeerGrades(
  candidates: readonly PeerCandidate[],
  cell: PeerProfileCell,
  minSampleSize: number,
): number[] {
  const inCell = candidates.filter(
    (c) =>
      defectCountBucket(c.severities.length) === cell.defectCountBucket &&
      maxSeverityBucket(c.severities) === cell.maxSeverity,
  );
  if (cell.brand) {
    const wanted = cell.brand.toLowerCase();
    const brandMatched = inCell.filter(
      (c) => (c.brand ?? "").trim().toLowerCase() === wanted,
    );
    if (brandMatched.length >= minSampleSize) {
      return brandMatched.map((c) => c.finalGrade);
    }
  }
  return inCell.map((c) => c.finalGrade);
}

// How many recent same-category grades to scan per check. Bounded so the
// post-composite check stays a cheap indexed read even on huge categories.
const PEER_SCAN_LIMIT = 400;

/**
 * Fetch the peer distribution for a fresh grade: recent FINAL grades in the
 * same garment_category (human-adjusted where reviewed), filtered to the same
 * defect-profile cell in TS via the pure bucketing above. Deliberately NOT a
 * SQL percentile query — the bounded scan + tested TS math is auditable and
 * needs no bespoke RPC on the grading path. Returns null on any failure or an
 * empty cohort (the caller's evaluatePeerNorm then no-ops).
 */
export async function fetchPeerDistribution(args: {
  garmentCategory: string;
  brand: string | null;
  defectSeverities: readonly string[];
  minSampleSize: number;
}): Promise<PeerDistribution | null> {
  const category = args.garmentCategory?.trim();
  if (!category) return null;
  try {
    const { supabaseAdmin } = await import("./supabase.ts");
    const { data: reportRows, error } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "id, overall_score, defects_found, submissions!inner(brand, garment_category)",
      )
      .eq("submissions.garment_category", category)
      .is("superseded_at", null)
      // US-1643: only FINALIZED grades form the peer cohort. A preliminary AI
      // grade (review_status='pending', finalized_at IS NULL) isn't official yet
      // and could still be corrected on review, so including it would let
      // un-vetted grades skew the peer-norm outlier check.
      .not("finalized_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(PEER_SCAN_LIMIT);
    if (error) return null;

    const rows = (reportRows ?? []) as unknown as Array<{
      id: string;
      overall_score: number;
      defects_found: unknown;
      submissions: { brand: string | null };
    }>;
    if (rows.length === 0) return null;

    // Latest human adjustment per report — the FINAL grade wins over the AI's.
    const adjustedByReport = new Map<string, number>();
    const { data: reviewRows } = await supabaseAdmin
      .from("human_reviews")
      .select("grade_report_id, adjusted_score, reviewed_at")
      .in("grade_report_id", rows.map((r) => r.id))
      .order("reviewed_at", { ascending: false });
    for (
      const r of (reviewRows ?? []) as Array<{
        grade_report_id: string;
        adjusted_score: number | null;
      }>
    ) {
      if (r.adjusted_score !== null && !adjustedByReport.has(r.grade_report_id)) {
        adjustedByReport.set(r.grade_report_id, r.adjusted_score);
      }
    }

    const candidates: PeerCandidate[] = rows.map((r) => ({
      finalGrade: adjustedByReport.get(r.id) ?? r.overall_score,
      brand: r.submissions?.brand ?? null,
      severities: Array.isArray(r.defects_found)
        ? (r.defects_found as Array<{ severity?: unknown }>)
          .map((d) => (typeof d?.severity === "string" ? d.severity : ""))
          .filter((s) => s !== "")
        : [],
    }));

    const cell = peerProfileCell({
      garmentCategory: category,
      brand: args.brand,
      defectSeverities: args.defectSeverities,
    });
    const grades = selectPeerGrades(candidates, cell, args.minSampleSize);
    return computePeerQuartiles(grades);
  } catch (err) {
    console.error(
      "[peer-norm] fetch failed (check skipped):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
