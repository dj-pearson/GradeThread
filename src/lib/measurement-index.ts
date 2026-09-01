// US-3039: what the composer does with the Fit & Measurement Index.
//
// ⚠ THIS IS NOT `measurement-drift.ts`, AND THE DIFFERENCE IS THE WHOLE POINT.
//
// US-2827 already compares a measurement against a cohort, and its own
// migration (00658) groups by `(garment_category, size, key)` — with NO BRAND.
// So it answers "is your medium the same medium everybody else is selling",
// pooling every brand together. That is a real question and it stays.
//
// This module answers a narrower one: "is this the same as other Levi's 550 in
// W34". The cohort is `(brand, style, department, group, size, field)`, which
// is the only version of the question a buyer actually asks, and the only one
// that can autofill a number rather than merely doubt one.
//
// Where both have an answer, the brand cohort wins — see `preferIndexBand` in
// measurement-form.tsx. They must never both render a warning on one field.
//
// PURE, and deliberately not in the route. The edge resolves the cohort once
// and hands back a small table; every keystroke after that is compared locally,
// so typing a measurement never waits on a network call. Web, iOS and Android
// can share this rule because there is nothing in it but arithmetic.

export interface IndexStatField {
  field: string;
  label: string;
  median: number;
  p25: number;
  p75: number;
  sampleCount: number;
  contributorCount: number;
}

export interface IndexStatsResponse {
  cohort:
    | {
      brandKey: string;
      styleKey: string;
      department: string;
      group: string;
      sizeLabel: string;
      styleMatched: boolean;
    }
    | null;
  fields: IndexStatField[];
}

export const NO_INDEX_STATS: IndexStatsResponse = { cohort: null, fields: [] };

/**
 * How far past the quartiles a value has to sit before it is worth mentioning.
 *
 * A quarter of genuine garments sit outside the interquartile range by
 * construction, so warning on that alone would fire on a quarter of correctly
 * measured items — and a seller who learns to click past the warning still has
 * it in front of them on the day their item really is mismeasured.
 *
 * 1.5 matches the outlier fence the nightly aggregate uses, which is the point:
 * the composer warns about roughly the values that job would have discarded, so
 * a seller hears about a number before it is thrown away rather than after.
 */
export const DRIFT_IQR_MULTIPLE = 1.5;

/**
 * The minimum absolute gap before a warning fires, in inches.
 *
 * This matters more than the multiple. Cohorts here are small and tight, so an
 * IQR can easily be a quarter inch, and a purely proportional rule would flag
 * differences no tape measure resolves. Three quarters of an inch is about
 * where two people measuring the same flat garment stop agreeing.
 */
export const DRIFT_MIN_INCHES = 0.75;

export interface IndexDriftVerdict {
  drifted: boolean;
  direction: "above" | "below" | null;
  median: number;
  sampleCount: number;
}

/**
 * Should we say something about this measurement?
 *
 * Returns `drifted: false` for anything we cannot judge — no cohort, no value,
 * a non-numeric entry. Silence is the default and the caller renders nothing.
 */
export function checkIndexDrift(
  stat: IndexStatField | undefined,
  entered: number | null | undefined,
): IndexDriftVerdict {
  const none: IndexDriftVerdict = {
    drifted: false,
    direction: null,
    median: stat?.median ?? 0,
    sampleCount: stat?.sampleCount ?? 0,
  };
  if (!stat) return none;
  if (entered == null || !Number.isFinite(entered) || entered <= 0) return none;

  const iqr = stat.p75 - stat.p25;
  const pad = Math.max(DRIFT_IQR_MULTIPLE * iqr, DRIFT_MIN_INCHES);

  if (entered > stat.p75 + pad) {
    return {
      drifted: true,
      direction: "above",
      median: stat.median,
      sampleCount: stat.sampleCount,
    };
  }
  if (entered < stat.p25 - pad) {
    return {
      drifted: true,
      direction: "below",
      median: stat.median,
      sampleCount: stat.sampleCount,
    };
  }
  return none;
}

/** The sentence shown under a drifted field. Null when there is nothing to say. */
export function indexDriftMessage(
  stat: IndexStatField | undefined,
  entered: number | null | undefined,
): string | null {
  const verdict = checkIndexDrift(stat, entered);
  if (!verdict.drifted || !stat) return null;
  const garments = verdict.sampleCount === 1 ? "garment" : "garments";
  // Names the median and the sample count, because "this looks wrong" with no
  // number behind it is an accusation rather than information. A seller whose
  // item really is unusual can then dismiss it knowing what they are dismissing.
  return `Most measure about ${stat.median}in here (${verdict.sampleCount} ${garments}). ` +
    `Worth a second check.`;
}

/**
 * Which fields can be suggested: published, and not already filled in.
 *
 * NEVER overwrites. A value the seller typed is the value they stand behind,
 * and a wrong measurement on a listing becomes a return, which is the problem
 * this whole product exists to prevent.
 */
export function suggestableFields(
  stats: IndexStatsResponse | null | undefined,
  current: Record<string, unknown> | null | undefined,
): IndexStatField[] {
  if (!stats?.cohort || stats.fields.length === 0) return [];
  const filled = current ?? {};
  return stats.fields.filter((f) => {
    const v = filled[f.field];
    if (v == null || v === "") return true;
    const n = typeof v === "number" ? v : Number(v);
    return !Number.isFinite(n) || n <= 0;
  });
}

/** "Median of 14 measured pairs" — the claim no competitor can make. */
export function provenanceLine(
  stats: IndexStatsResponse | null | undefined,
  group: string,
): string | null {
  if (!stats?.cohort || stats.fields.length === 0) return null;
  // The sample count differs per field (a cohort can clear the floor on waist
  // and not on rise), so the line reports the SMALLEST, which is the weakest
  // claim actually supported by every number on screen.
  const n = Math.min(...stats.fields.map((f) => f.sampleCount));
  const plural = group === "bottom" ? "pairs" : "garments";
  const noun = n === 1 ? plural.replace(/s$/, "") : plural;
  return `Median of ${n} measured ${noun}`;
}

/** The stat for one field, or undefined. */
export function statFor(
  stats: IndexStatsResponse | null | undefined,
  field: string,
): IndexStatField | undefined {
  return stats?.fields.find((f) => f.field === field);
}
