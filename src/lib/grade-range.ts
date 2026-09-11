// US-3339: turn a grade into a measured range, for example "likely 7.3 to 7.9".
//
// The half-width comes from GET /api/content/public/grade-ranges.json, which is
// built from the self-consistency job's measured regrade spreads per garment
// category (services/edge-functions/src/lib/grade-range.ts). A category that is
// not in that list has no range, and the caller shows nothing.
//
// NEVER from confidence_score. That is the model's opinion of itself, and a
// range built from it would look like a measurement and be a guess. Nothing in
// this file takes a confidence value, and a test holds it to that.

export interface CategoryRange {
  half_width: number;
  samples: number;
}

export type GradeRanges = Record<string, CategoryRange>;

export interface GradeRangeView {
  low: number;
  high: number;
  text: string;
  samples: number;
}

/** The range for this score and category, or null when none was measured. */
export function gradeRangeFor(
  score: number | null | undefined,
  category: string | null | undefined,
  ranges: GradeRanges | null | undefined,
): GradeRangeView | null {
  if (typeof score !== "number" || !Number.isFinite(score) || !ranges) return null;
  const r = ranges[(category ?? "").trim().toLowerCase()];
  if (!r || !(r.half_width >= 0.1)) return null;
  const tenth = (n: number) => Math.round(n * 10) / 10;
  const low = Math.max(1, tenth(score - r.half_width));
  const high = Math.min(10, tenth(score + r.half_width));
  return {
    low,
    high,
    text: `likely ${low.toFixed(1)} to ${high.toFixed(1)}`,
    samples: r.samples,
  };
}
