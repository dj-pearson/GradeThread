// US-2846: fit price against measured condition, and refuse to publish a curve
// that is worse than the answer it would replace.
//
// THE CLAIM THIS MODULE IS THE TEST OF. The whole condition-priced comps bet
// (US-2841) says a price fitted against measured condition beats the plain comp
// median. That is falsifiable, and this is where it gets falsified: every cell
// is scored leave-one-out against the median before anything reaches a seller.
// A cell that cannot beat the median keeps serving the median. So the worst
// case for a seller is today's answer, never a confident wrong one.
//
// PURE. No I/O, no eBay, no supabase, no env, same posture as
// condition-value-math.ts. The caller loads rows and hands them over.
//
// WHAT THE SLOPE MEANS, SAID PLAINLY. Cents of asking price per one point of
// grade, for one cell. While eBay Marketplace Insights is ungranted the samples
// are ACTIVE listings, so this is an asking-price slope, not a realized-price
// slope. It is the right number for a sourcing ceiling and the wrong number for
// how fast something sells. US-2850 owns saying so on screen.

/** One comp read, as the fitter wants it. */
export interface CompReadSample {
  /** 1.0-10.0. Null means we never scored it, so it cannot be fitted. */
  readScore: number | null;
  /** 0..1. Doubles as the fit weight: a two-photo read counts for less. */
  readConfidence: number | null;
  askingPriceCents: number | null;
  /** Catalog imagery caught by US-2843. Kept as a row, never fitted. */
  stockRejected: boolean;
}

/** A read at or above this confidence counts toward the minimum sample. */
export const HIGH_CONFIDENCE_BAR = 0.6;

/**
 * How many high-confidence reads a cell needs before it may publish.
 *
 * Twelve. Below that a single mis-read garment can swing the slope by more than
 * the slope is worth, and the leave-one-out score stops being a check and
 * becomes noise measuring itself.
 */
export const MIN_HIGH_CONFIDENCE_READS = 12;

/** Tukey fence for the price trim. Generous on purpose, see trimPriceOutliers. */
export const TRIM_IQR_MULTIPLIER = 1.5;

/**
 * How much better than the median the curve must be to earn the switch.
 *
 * Five percent relative. A curve that ties the median is not worth the extra
 * machinery, the extra explanation, or the risk of being confidently wrong in a
 * new way, so a tie loses.
 */
export const CURVE_MUST_BEAT_MEDIAN_BY = 0.05;

/** The minimum reads any fit needs, regardless of confidence. */
export const MIN_FIT_READS = 3;

export interface CurveFit {
  /** Cents of asking price per one point of grade. May be zero or negative. */
  slopeCentsPerPoint: number;
  interceptCents: number;
  /** Reads that survived the trim and were actually fitted. */
  sampleSize: number;
  /** 0..1, from weighted goodness of fit and how much sample stands behind it. */
  fitConfidence: number;
  /** How many reads the price trim removed. */
  trimmed: number;
}

export interface HoldOutScore {
  /** Mean absolute error of the fitted curve, in cents. */
  curveErrorCents: number;
  /** Mean absolute error of the plain comp median, in cents. The incumbent. */
  medianErrorCents: number;
  curveErrorPct: number;
  medianErrorPct: number;
  /** How many leave-one-out rounds actually ran. */
  rounds: number;
}

export interface PublishVerdict {
  ok: boolean;
  /** Always populated, including on ok:true, so a log line explains itself. */
  reason: string;
}

// eligibility

interface FittableRead {
  grade: number;
  priceCents: number;
  weight: number;
}

/**
 * Keep only what may legally be fitted (US-2843 AC4).
 *
 * A stock-rejected read stays in the table because knowing how much of a cell
 * is catalog imagery is worth knowing. It must never reach a curve, and this is
 * the only door into one.
 */
export function eligibleReads(reads: CompReadSample[]): FittableRead[] {
  const out: FittableRead[] = [];
  for (const r of reads) {
    if (r.stockRejected) continue;
    if (r.readScore == null || r.askingPriceCents == null) continue;
    if (r.readScore < 1 || r.readScore > 10) continue;
    if (r.askingPriceCents <= 0) continue;
    const w = r.readConfidence == null ? 0 : Math.max(0, Math.min(1, r.readConfidence));
    if (w <= 0) continue;
    out.push({ grade: r.readScore, priceCents: r.askingPriceCents, weight: w });
  }
  return out;
}

/**
 * How much confident sample actually stands behind a curve.
 *
 * Counted AFTER the price trim, not before. A bundle listing is often
 * photographed clearly, so it reads at high confidence and would otherwise
 * count toward the sample bar while contributing nothing to the fit it was
 * trimmed out of. The bar has to measure the reads the curve was built from.
 */
export function highConfidenceCount(reads: CompReadSample[]): number {
  const { kept } = trimPriceOutliers(eligibleReads(reads));
  return kept.filter((r) => r.weight >= HIGH_CONFIDENCE_BAR).length;
}

// the trim

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Median of a list of cent values. Pure, exported because the gate compares against it. */
export function medianCents(values: number[]): number {
  if (values.length === 0) return 0;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/**
 * Drop prices outside a Tukey fence.
 *
 * WHAT THIS IS FOR: a bundle. "Lot of 5 Patagonia fleeces" matches the keywords,
 * carries one asking price for five garments, and drags the top of the range up
 * hard enough to invent a slope out of nothing.
 *
 * THE COST, STATED. A genuinely new-with-tags item at the top of its market has
 * the same shape as a bundle from here, and this will sometimes drop one. The
 * fence is 1.5 IQR rather than something tighter precisely to keep that rare.
 * Trimming on price is what the story asked for; trimming on residual would
 * spare the NWT item and is the obvious next move once real data exists.
 */
export function trimPriceOutliers(
  reads: FittableRead[],
): { kept: FittableRead[]; dropped: FittableRead[] } {
  if (reads.length < 4) return { kept: reads, dropped: [] };
  const sorted = reads.map((r) => r.priceCents).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) return { kept: reads, dropped: [] };
  const lo = q1 - TRIM_IQR_MULTIPLIER * iqr;
  const hi = q3 + TRIM_IQR_MULTIPLIER * iqr;
  const kept: FittableRead[] = [];
  const dropped: FittableRead[] = [];
  for (const r of reads) {
    (r.priceCents < lo || r.priceCents > hi ? dropped : kept).push(r);
  }
  return { kept, dropped };
}

// the fit

function weightedFit(
  reads: FittableRead[],
): { slope: number; intercept: number; r2: number } | null {
  const sw = reads.reduce((a, r) => a + r.weight, 0);
  if (sw <= 0) return null;
  const xbar = reads.reduce((a, r) => a + r.weight * r.grade, 0) / sw;
  const ybar = reads.reduce((a, r) => a + r.weight * r.priceCents, 0) / sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (const r of reads) {
    const dx = r.grade - xbar;
    const dy = r.priceCents - ybar;
    sxx += r.weight * dx * dx;
    sxy += r.weight * dx * dy;
    syy += r.weight * dy * dy;
  }
  // Every read at the same grade. There is no slope to find, and inventing one
  // by dividing by ~0 is how a cell gets a confident number from no evidence.
  if (sxx <= 1e-9) return null;
  const slope = sxy / sxx;
  const intercept = ybar - slope * xbar;
  const r2 = syy <= 1e-9 ? 0 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));
  return { slope, intercept, r2 };
}

/**
 * Fit one cell. Returns null when there is nothing honest to fit.
 *
 * A FLAT OR NEGATIVE SLOPE COMES BACK AS IT IS. For some brands condition
 * barely moves price, and for a few it moves it the wrong way. That is a real
 * finding and it tells a seller not to pay to grade this item, so suppressing
 * it for being unflattering would delete the most useful thing we learned.
 */
export function fitCurve(reads: CompReadSample[]): CurveFit | null {
  const eligible = eligibleReads(reads);
  if (eligible.length < MIN_FIT_READS) return null;
  const { kept, dropped } = trimPriceOutliers(eligible);
  if (kept.length < MIN_FIT_READS) return null;
  const fit = weightedFit(kept);
  if (fit == null) return null;

  // Sample weight rises to 1 around 25 reads; r2 says how much of the spread the
  // grade actually explains. A tight fit on four listings is still four listings.
  const sampleFactor = Math.min(1, kept.length / 25);
  return {
    slopeCentsPerPoint: fit.slope,
    interceptCents: fit.intercept,
    sampleSize: kept.length,
    fitConfidence: Math.max(0, Math.min(0.95, fit.r2 * sampleFactor)),
    trimmed: dropped.length,
  };
}

/** Price this curve predicts at a grade. Never negative: a quote of minus four dollars is not a quote. */
export function priceAtGrade(fit: CurveFit, grade: number): number {
  return Math.max(0, Math.round(fit.interceptCents + fit.slopeCentsPerPoint * grade));
}

// the gate

function meanAbs(errors: number[]): number {
  if (errors.length === 0) return 0;
  return errors.reduce((a, e) => a + Math.abs(e), 0) / errors.length;
}

/**
 * Score the curve against the incumbent, leave-one-out.
 *
 * Both contenders are rebuilt WITHOUT the held-out read on every round, the
 * curve and the median alike. Scoring the curve out-of-sample against a median
 * that got to see the answer would flatter the median, and a gate that is
 * unfair in the incumbent's favour is still an unfair gate.
 */
export function holdOutScore(reads: CompReadSample[]): HoldOutScore | null {
  const eligible = eligibleReads(reads);
  if (eligible.length < MIN_FIT_READS + 1) return null;
  const { kept } = trimPriceOutliers(eligible);
  if (kept.length < MIN_FIT_READS + 1) return null;

  const curveErrors: number[] = [];
  const medianErrors: number[] = [];
  const curvePct: number[] = [];
  const medianPct: number[] = [];

  for (let i = 0; i < kept.length; i++) {
    const rest = kept.filter((_, j) => j !== i);
    const held = kept[i];
    const fit = weightedFit(rest);
    if (fit == null) continue;
    const predicted = Math.max(0, fit.intercept + fit.slope * held.grade);
    const median = medianCents(rest.map((r) => r.priceCents));
    const ce = predicted - held.priceCents;
    const me = median - held.priceCents;
    curveErrors.push(ce);
    medianErrors.push(me);
    curvePct.push(Math.abs(ce) / held.priceCents);
    medianPct.push(Math.abs(me) / held.priceCents);
  }
  if (curveErrors.length === 0) return null;

  return {
    curveErrorCents: meanAbs(curveErrors),
    medianErrorCents: meanAbs(medianErrors),
    curveErrorPct: meanAbs(curvePct),
    medianErrorPct: meanAbs(medianPct),
    rounds: curveErrors.length,
  };
}

/**
 * May this cell go live?
 *
 * Two bars, and both are hard. Enough high-confidence sample to be worth
 * fitting, and a leave-one-out error that beats the plain median by a margin.
 * Failing either is not an error state: the surface keeps serving the median,
 * which is exactly what it serves today.
 */
export function publishable(
  reads: CompReadSample[],
  fit: CurveFit | null,
  score: HoldOutScore | null,
): PublishVerdict {
  if (fit == null) {
    return { ok: false, reason: "no_fit" };
  }
  const confident = highConfidenceCount(reads);
  if (confident < MIN_HIGH_CONFIDENCE_READS) {
    return {
      ok: false,
      reason: "too_few_confident_reads:" + confident + "/" + MIN_HIGH_CONFIDENCE_READS,
    };
  }
  if (score == null) {
    return { ok: false, reason: "no_holdout_score" };
  }
  if (score.medianErrorCents <= 0) {
    // The median is already perfect on this sample, so there is nothing to beat
    // and nothing to gain. Almost always means every price is identical.
    return { ok: false, reason: "median_already_exact" };
  }
  const improvement = (score.medianErrorCents - score.curveErrorCents) /
    score.medianErrorCents;
  if (improvement < CURVE_MUST_BEAT_MEDIAN_BY) {
    return {
      ok: false,
      reason: "no_better_than_median:" + (improvement * 100).toFixed(1) + "%",
    };
  }
  return { ok: true, reason: "beats_median_by:" + (improvement * 100).toFixed(1) + "%" };
}
