import { supabaseAdmin } from "./supabase.ts";
import { coerceDefectType, DEFECT_TYPES, type DefectType } from "./defect-weighting.ts";

// US-1691: the GRADING half of the "State of Secondhand Condition" data report.
//
// US-976 already publishes the OUTCOME half (return rate / sell-through / resale
// value by grade band, from FlipDesk sales+listings). What no one else can
// publish — and what a journalist or an answer engine actually asks for — is the
// CONDITION half: what shape secondhand clothing is actually in. Two findings
// come out of the grading data and nothing else:
//
//   • average condition grade by garment type (are jackets really in better
//     shape than tops?), and
//   • the most common flaws found across graded garments.
//
// Same safety contract as computeResaleConditionReport: this runs on the
// service-role client, so it crosses tenants BY DESIGN to produce a platform
// aggregate — but only counts, rates and means ever leave the function. No
// per-user, per-item or per-submission row does.
//
// Honesty rule (the whole reason the report is citable): a figure is published
// only once its cohort clears MIN_SAMPLE. Below the bar the field is null and
// the page says "not enough data yet" rather than printing a mean over nine
// garments. Small-n honesty is the AC, not a nicety.

// A cohort needs at least this many graded garments before its mean/rate is
// published. Deliberately the same bar as the resale half (RESALE_MIN_SAMPLE)
// so one report never publishes two different definitions of "enough data".
export const SECONDHAND_MIN_SAMPLE = 25;

// Bounds the scan cost as grading volume grows; the report states the actual
// sample so the cap stays truthful.
const SCAN_CAP = 50_000;

// Mirrors the `garment_type` enum (00001_initial_schema.sql). Ordered for the
// published table; a row whose type isn't one of these is skipped rather than
// bucketed into a junk "unknown" row nobody can cite.
const GARMENT_TYPE_ORDER: Array<{ key: string; label: string }> = [
  { key: "tops", label: "Tops" },
  { key: "bottoms", label: "Bottoms" },
  { key: "outerwear", label: "Outerwear" },
  { key: "dresses", label: "Dresses" },
  { key: "footwear", label: "Footwear" },
  { key: "accessories", label: "Accessories" },
];

// Plain-English names for the US-1027 defect taxonomy. Keyed off DEFECT_TYPES so
// a new member of the enum surfaces here as a missing label at type-check time
// rather than as a raw snake_case string on a public page.
const DEFECT_LABELS: Record<DefectType, string> = {
  stain: "Stains",
  hole_puncture: "Holes and punctures",
  rip_tear: "Rips and tears",
  seam_failure_unthreading: "Seam failure and unthreading",
  pilling: "Pilling",
  abrasion_thinning: "Abrasion and thinning",
  fading: "Fading",
  discoloration: "Discoloration",
  snag_pull: "Snags and pulls",
  broken_zipper: "Broken zippers",
  broken_button: "Broken or missing buttons",
  missing_hardware: "Missing hardware",
  stretched_misshapen: "Stretched or misshapen",
  odor_indicator: "Odor indicators",
  wrinkle_crease: "Set-in wrinkles and creases",
  other: "Other (unclassified)",
};

export interface FlawFinding {
  defect_type: DefectType;
  label: string;
  /** Graded garments carrying at least one defect of this type. */
  items: number;
  /** items / graded garments in scope. Null until the scope clears MIN_SAMPLE. */
  share: number | null;
}

export interface GarmentTypeCondition {
  key: string;
  label: string;
  graded_items: number;
  /** Mean overall grade on the 1.0–10.0 scale, 1dp. Null until MIN_SAMPLE. */
  average_grade: number | null;
  /** Share of the type's garments carrying ≥1 genuine defect. Null until MIN_SAMPLE. */
  flaw_rate: number | null;
  /** The type's most frequent NAMED flaw. Null until MIN_SAMPLE, or if none. */
  most_common_flaw: FlawFinding | null;
}

export interface SecondhandConditionStats {
  min_sample: number;
  sample: {
    graded_items: number;
    /** Garments carrying ≥1 genuine defect (the denominator honesty check). */
    items_with_flaws: number;
    /** Total (item, defect-type) pairs observed — always ≥ items_with_flaws. */
    flaw_observations: number;
  };
  /** Platform-wide mean grade, 1dp. Null until MIN_SAMPLE. */
  average_grade: number | null;
  by_garment_type: GarmentTypeCondition[];
  /** Named flaws, most common first. `other` is included but never ranked #1 per type. */
  common_flaws: FlawFinding[];
}

// The minimal row we aggregate. Deliberately carries no identifying column — no
// user_id, no submission id, no title.
export interface SecondhandConditionRow {
  garment_type: string | null;
  overall_score: number | null;
  defects_found: unknown;
}

/** Mean of a non-empty list, rounded to `dp` decimals. */
function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Distinct defect TYPES on one grade report. Deduped per item on purpose: the
 * published statistic is "what share of garments have this flaw", so three
 * stains on one shirt must count once, not three times.
 */
export function flawTypesForItem(defectsFound: unknown): DefectType[] {
  if (!Array.isArray(defectsFound)) return [];
  const types = new Set<DefectType>();
  for (const d of defectsFound) {
    if (d && typeof d === "object") {
      types.add(coerceDefectType((d as Record<string, unknown>).defect_type));
    }
  }
  return [...types];
}

interface TypeAcc {
  grades: number[];
  withFlaws: number;
  flawCounts: Map<DefectType, number>;
}

/**
 * Pure, deterministic aggregation — exported for unit testing. The same rows and
 * the same minSample always produce the same stats.
 */
export function buildSecondhandConditionStats(
  rows: SecondhandConditionRow[],
  minSample: number = SECONDHAND_MIN_SAMPLE,
): SecondhandConditionStats {
  const emptyAcc = (): TypeAcc => ({ grades: [], withFlaws: 0, flawCounts: new Map() });
  const byType = new Map<string, TypeAcc>();
  for (const t of GARMENT_TYPE_ORDER) byType.set(t.key, emptyAcc());
  const overall = emptyAcc();

  let flawObservations = 0;

  for (const r of rows) {
    // A row with no usable grade carries no condition signal.
    if (typeof r.overall_score !== "number" || !Number.isFinite(r.overall_score)) continue;
    const key = (r.garment_type ?? "").trim().toLowerCase();
    const acc = byType.get(key);

    const flaws = flawTypesForItem(r.defects_found);
    flawObservations += flaws.length;

    overall.grades.push(r.overall_score);
    if (flaws.length > 0) overall.withFlaws++;
    for (const f of flaws) overall.flawCounts.set(f, (overall.flawCounts.get(f) ?? 0) + 1);

    // An off-enum / null garment_type still counts toward the platform totals —
    // it is a real graded garment — it just can't be attributed to a type.
    if (!acc) continue;
    acc.grades.push(r.overall_score);
    if (flaws.length > 0) acc.withFlaws++;
    for (const f of flaws) acc.flawCounts.set(f, (acc.flawCounts.get(f) ?? 0) + 1);
  }

  const gatedMean = (acc: TypeAcc): number | null =>
    acc.grades.length >= minSample
      ? roundTo(acc.grades.reduce((a, b) => a + b, 0) / acc.grades.length, 1)
      : null;

  // Flaw findings for one scope, most common first. `share` is gated on the
  // SCOPE's sample, so a thin garment type publishes counts but no percentages.
  const findingsFor = (acc: TypeAcc): FlawFinding[] => {
    const n = acc.grades.length;
    return DEFECT_TYPES
      .map((t) => ({
        defect_type: t,
        label: DEFECT_LABELS[t],
        items: acc.flawCounts.get(t) ?? 0,
        share: n >= minSample ? roundTo((acc.flawCounts.get(t) ?? 0) / n, 4) : null,
      }))
      .filter((f) => f.items > 0)
      .sort((a, b) => b.items - a.items || a.defect_type.localeCompare(b.defect_type));
  };

  const by_garment_type: GarmentTypeCondition[] = GARMENT_TYPE_ORDER.map(({ key, label }) => {
    const acc = byType.get(key)!;
    const n = acc.grades.length;
    // `other` is the catch-all for a string the taxonomy didn't recognize, so
    // naming it as a garment type's "most common flaw" would be a headline that
    // means nothing. It stays in the full list; it is never the ranked answer.
    const named = findingsFor(acc).filter((f) => f.defect_type !== "other");
    return {
      key,
      label,
      graded_items: n,
      average_grade: gatedMean(acc),
      flaw_rate: n >= minSample ? roundTo(acc.withFlaws / n, 4) : null,
      most_common_flaw: n >= minSample && named.length > 0 ? named[0]! : null,
    };
  });

  return {
    min_sample: minSample,
    sample: {
      graded_items: overall.grades.length,
      items_with_flaws: overall.withFlaws,
      flaw_observations: flawObservations,
    },
    average_grade: gatedMean(overall),
    by_garment_type,
    common_flaws: findingsFor(overall),
  };
}

/**
 * Load and aggregate the grading half of the report. Aggregate-only and safe to
 * serve unauthenticated; callers should cache it (it scans grade_reports) — see
 * computeResaleConditionReport, which composes it.
 *
 * Only FINALIZED, non-superseded grades count (same rule as the peer-norm
 * cohort): a preliminary AI grade can still be corrected on human review, so
 * publishing it as platform truth would let un-vetted grades move the means.
 */
export async function computeSecondhandConditionStats(): Promise<SecondhandConditionStats> {
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select("overall_score, defects_found, submissions!inner(garment_type)")
    .is("superseded_at", null)
    .not("finalized_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(SCAN_CAP);

  if (error) {
    throw new Error(`Failed to load secondhand-condition rows: ${error.message}`);
  }

  const rows = ((data ?? []) as unknown as Array<{
    overall_score: number | null;
    defects_found: unknown;
    submissions: { garment_type: string | null } | null;
  }>).map((r): SecondhandConditionRow => ({
    garment_type: r.submissions?.garment_type ?? null,
    overall_score: r.overall_score,
    defects_found: r.defects_found,
  }));

  return buildSecondhandConditionStats(rows);
}
