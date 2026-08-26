import { tierBandForScore } from "@/lib/constants";
// What a condition grade does to resale price (US-9006).
//
// WHERE THESE NUMBERS COME FROM, because a made-up multiplier here would be
// worse than no condition axis at all: they are derived from GradeThread's own
// published Condition Index. On 2026-08-18 the public endpoint
// /api/grading/public/condition-index served 53 curves resting on 3,811 eBay
// listings. ACTIVE listings: EBAY_MARKETPLACE_INSIGHTS has never been granted,
// so nothing behind these ratios has been sold, and the header said "sold
// comps" here until US-2850. Every ratio below is a share of ASKING price.
// For each curve, every grade's median was divided by that same
// curve's grade-10 median, and the table below is the MEDIAN of those 53
// ratios at each grade. The script that did it is
// scripts/seo/derive-condition-value-curve.mjs, and it re-runs against live
// data.
//
// WHAT THE NUMBERS ARE NOT. Each Condition Index curve is anchored on three
// measured condition bands of up to 25 comps each; the grades between those
// anchors are the Index's own interpolation, not separate measurements. So
// this is a summary of 159 measured bands and the shape the Index draws
// between them, not 3,811 independent observations of ten grades. Stating that
// is the difference between a defensible default and a number that looks more
// precise than it is.
//
// THE SPREAD IS THE POINT. At grade 9.0 the ratio runs from 0.527 to 1.000
// across the 53 items. A generic curve cannot tell a Carhartt double knee
// (which holds full value down to 8.0) from a Lululemon Scuba (which does not).
// That is why the calculator prefers a live per-item curve when the seller
// picks one, and says which of the two it used.
//
// US-2280 will replace this with a regression against realized FlipDesk
// outcomes. Until it ships, this is the best evidence we have, and the page
// says so rather than implying a precision nobody measured.

export const CONDITION_CURVE_DERIVED_ON = "2026-08-18";

// US-2850: these two are no longer RENDERED. They were printed on
// /reseller-profit-calculator next to the word "sold", which was false, and the
// founder's call was to drop the counts along with the word rather than pair a
// corrected label with numbers measured on one day in August and never
// re-checked. They stay exported because they are the provenance of the ratio
// table below and the test pins them: deleting them would leave the table with
// no record of what it was derived from.
export const CONDITION_CURVE_SOURCE_CURVES = 53;
export const CONDITION_CURVE_SOURCE_COMPS = 3811;

export interface ConditionRatioPoint {
  grade: number;
  /** Median share of the grade-10 price across all 53 curves. */
  ratio: number;
  /** The range across those curves. Wide ranges mean "check your own comps". */
  low: number;
  high: number;
}

/**
 * Descending by grade. 9.5 and 10 share a ratio, and so do 8.5 and 9, because
 * the Condition Index bands them together. That is the source's shape, not a
 * rounding artefact, and flattening it would misrepresent the data.
 */
export const CONDITION_VALUE_CURVE: readonly ConditionRatioPoint[] = [
  { grade: 10, ratio: 1.0, low: 1.0, high: 1.0 },
  { grade: 9.5, ratio: 1.0, low: 1.0, high: 1.0 },
  { grade: 9, ratio: 0.837, low: 0.527, high: 1.0 },
  { grade: 8.5, ratio: 0.837, low: 0.527, high: 1.0 },
  { grade: 8, ratio: 0.737, low: 0.416, high: 1.0 },
  { grade: 7, ratio: 0.649, low: 0.385, high: 0.912 },
  { grade: 6, ratio: 0.562, low: 0.346, high: 0.825 },
  { grade: 5, ratio: 0.443, low: 0.262, high: 0.737 },
  { grade: 4, ratio: 0.313, low: 0.179, high: 0.558 },
  { grade: 3, ratio: 0.204, low: 0.06, high: 0.416 },
];

export const MIN_GRADE = 3;
export const MAX_GRADE = 10;

/**
 * The ratio at any grade on the scale, linearly interpolated between the
 * points above. Clamped at both ends: below 3.0 the Index has no comps at all,
 * and inventing a curve down to 1.0 would be exactly the fabrication this file
 * exists to avoid.
 */
export function conditionRatio(grade: number): number {
  const g = Math.min(MAX_GRADE, Math.max(MIN_GRADE, grade));
  const asc = [...CONDITION_VALUE_CURVE].sort((a, b) => a.grade - b.grade);
  for (let i = 0; i < asc.length; i++) {
    const point = asc[i]!;
    if (g === point.grade) return point.ratio;
    if (g < point.grade) {
      const prev = asc[i - 1];
      if (!prev) return point.ratio;
      const span = point.grade - prev.grade;
      const t = span === 0 ? 0 : (g - prev.grade) / span;
      return prev.ratio + (point.ratio - prev.ratio) * t;
    }
  }
  return 1;
}

export interface ConditionAdjustment {
  /** The price the seller entered, and the grade they said it was for. */
  compPrice: number;
  compGrade: number;
  /** The grade of the item actually being sold. */
  itemGrade: number;
  /** compRatio and itemRatio, so the page can show the working. */
  compRatio: number;
  itemRatio: number;
  /** The multiplier applied to the comp price. */
  multiplier: number;
  /** The adjusted estimate. */
  adjustedPrice: number;
  /** Signed difference from the comp price. */
  delta: number;
  /** Where the ratios came from, so the page never implies data it lacks. */
  source: "condition-index-item" | "condition-index-default";
}

/**
 * Move a comp price from the condition it was in to the condition your item is
 * in. Both ends matter: a comp taken from a mint listing overstates a worn
 * item, and a comp taken from a beaten one understates a clean item. Most
 * calculators assume the comp is grade 10 and only ever adjust downward, which
 * is why sellers using them consistently under-price good stock.
 *
 * `ratioFor` is injected so a live per-item Condition Index curve can replace
 * the default table without this function knowing the difference.
 */
export function adjustForCondition(
  compPrice: number,
  compGrade: number,
  itemGrade: number,
  ratioFor: (grade: number) => number = conditionRatio,
  source: ConditionAdjustment["source"] = "condition-index-default",
): ConditionAdjustment {
  const compRatio = ratioFor(compGrade);
  const itemRatio = ratioFor(itemGrade);
  // A zero comp ratio would divide by zero; it cannot happen on this curve,
  // but a live curve is data we do not control.
  const multiplier = compRatio > 0 ? itemRatio / compRatio : 1;
  const adjustedPrice = Math.round(compPrice * multiplier * 100) / 100;
  return {
    compPrice,
    compGrade,
    itemGrade,
    compRatio,
    itemRatio,
    multiplier,
    adjustedPrice,
    delta: Math.round((adjustedPrice - compPrice) * 100) / 100,
    source,
  };
}

/**
 * Build a ratio lookup from a live Condition Index curve, normalised to its own
 * top grade the same way the default table was. Returns null when the curve is
 * too thin to use, which the Index already suppresses for but a caller should
 * not assume.
 */
export function ratioFromCurve(
  points: ReadonlyArray<{ grade: number; medianCents: number | null }>,
): ((grade: number) => number) | null {
  const usable = points
    .filter((p) => p.medianCents !== null && p.medianCents > 0)
    .map((p) => ({ grade: p.grade, cents: p.medianCents as number }))
    .sort((a, b) => a.grade - b.grade);
  if (usable.length < 3) return null;
  const top = usable[usable.length - 1]!;
  const table = usable.map((p) => ({ grade: p.grade, ratio: p.cents / top.cents }));

  return (grade: number) => {
    const g = Math.min(table[table.length - 1]!.grade, Math.max(table[0]!.grade, grade));
    for (let i = 0; i < table.length; i++) {
      const point = table[i]!;
      if (g === point.grade) return point.ratio;
      if (g < point.grade) {
        const prev = table[i - 1];
        if (!prev) return point.ratio;
        const span = point.grade - prev.grade;
        const t = span === 0 ? 0 : (g - prev.grade) / span;
        return prev.ratio + (point.ratio - prev.ratio) * t;
      }
    }
    return 1;
  };
}

/**
 * The tier a grade falls in. These bands were already shipped inline in
 * whats-it-worth.tsx (US-849); this is the same function moved here so the two
 * surfaces cannot drift. The repo has been bitten by that before: US-2436
 * deleted a GRADE_LABELS map for naming tiers that are not on the published
 * scale at all.
 */
export function tierLabelForGrade(grade: number): string {
  // US-2871: the bands moved to GRADE_TIER_BANDS in constants.ts so the report
  // can show the RANGE beside the tier name without a second copy of the
  // numbers. Same bands, same results -- pinned by a fixture in
  // src/test/score-explanation.test.ts.
  return tierBandForScore(grade).label;
}
