// US-2828 AC2/AC3: is this week's number unusual FOR THIS SELLER?
//
// Pure math, no IO, so the thresholds are reviewable in one place and the job
// that will call this can be tested separately. Same split as ads-anomaly.ts.
//
// ── WHY STANDARD DEVIATIONS AND NOT A PERCENTAGE ─────────────────────────────
//
// ads-anomaly.ts compares the latest day to a trailing average by PERCENT, and
// that is right for ad spend, where a 2x day is a 2x day whoever you are. It is
// wrong per seller. A seller who sells two or three items most weeks has a
// hundred-percent swing constantly and nothing has happened; a seller who sells
// forty every week and drops to thirty has had a real event that a percentage
// rule would rank BELOW the first one. AC2 asks for deviations from that
// seller's own baseline, which is the same question asked in units that survive
// the difference in scale.
//
// ── THE FLOORS ARE THE FEATURE ───────────────────────────────────────────────
//
// AC3 says no anomaly fires below a minimum activity floor, and the reason is
// the seller with three sales and a 100% swing. Two floors do that work here and
// they are NOT the same floor:
//
//   MIN_BASELINE_WEEKS  how many prior weeks are needed before a baseline means
//                       anything. Fewer, and the standard deviation is a
//                       description of noise.
//   MIN_ACTIVITY        how much has to be happening in the window at all.
//                       Applied to the BASELINE MEAN, not to the latest week —
//                       otherwise a seller whose activity collapsed to zero
//                       would be silenced by the collapse, which is exactly the
//                       event worth telling them about.
//
// That second choice is the one to read twice. Flooring on the latest value
// hides the drop that matters; flooring on the baseline says "you used to do
// enough for this to mean something".

export interface WeekPoint {
  /** ISO date of the week start. Sorted internally; callers need not. */
  week: string;
  value: number;
}

export interface AnomalyThresholds {
  /** Deviations from the seller's own mean before a week is called unusual. */
  sigma: number;
  /** Prior weeks required before a baseline is trusted. */
  minBaselineWeeks: number;
  /** Baseline mean required before any anomaly fires. */
  minActivity: number;
}

export const DEFAULT_SELLER_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  // 2.5 rather than 2: at 2 sigma roughly one week in twenty is "unusual" for a
  // seller whose numbers are pure noise, which across a whole user base is a
  // weekly alert for thousands of people about nothing. The point of an alert is
  // that receiving one is information.
  sigma: 2.5,
  // 6 weeks of history before a baseline is trusted, and 90 days of window (AC2)
  // holds ~13, so a seller who joined mid-quarter still qualifies.
  minBaselineWeeks: 6,
  minActivity: 5,
};

export interface Baseline {
  mean: number;
  /** POPULATION standard deviation over the prior weeks. */
  stdDev: number;
  weeks: number;
}

/**
 * Mean and spread of the prior weeks — the latest week is NOT included.
 *
 * Including it would let a big week inflate the spread it is being measured
 * against, which is how a detector quietly stops firing exactly when the number
 * gets interesting.
 */
export function baselineOf(prior: readonly WeekPoint[]): Baseline {
  const n = prior.length;
  if (n === 0) return { mean: 0, stdDev: 0, weeks: 0 };
  const mean = prior.reduce((s, p) => s + p.value, 0) / n;
  const variance = prior.reduce((s, p) => s + (p.value - mean) ** 2, 0) / n;
  return { mean, stdDev: Math.sqrt(variance), weeks: n };
}

export type AnomalyDirection = "up" | "down";

export interface SellerAnomaly {
  metric: string;
  direction: AnomalyDirection;
  week: string;
  value: number;
  baseline: Baseline;
  /** Signed deviations from the mean. Negative for a drop. */
  sigma: number;
}

/**
 * Is the latest week unusual for this seller?
 *
 * Returns null — never a zero-sigma result — when there is nothing honest to
 * say. The caller cannot then mistake "not enough history" for "normal week",
 * which are different messages and only one of them is worth sending.
 */
export function detectSellerAnomaly(
  metric: string,
  series: readonly WeekPoint[],
  thresholds: AnomalyThresholds = DEFAULT_SELLER_ANOMALY_THRESHOLDS,
): SellerAnomaly | null {
  // ONE history check, not two. A `series.length < minBaselineWeeks + 1`
  // early-out used to sit here as well, and it was exactly equivalent: the
  // baseline is series.length - 1 weeks, so both refuse the same inputs.
  // Sabotage found it — breaking the early-out changed nothing, because the
  // check below caught every case. Two guards for one property means neither is
  // testable on its own, and the redundant one reads as a second rule.
  //
  // ⚠ THE LINE BELOW IS DEFENSIVE AND CANNOT BE REDDENED, which is worth saying
  // rather than leaving it looking proven. It protects the non-null assertion on
  // `latest`; with an empty series that assertion is a lie, but `baselineOf([])`
  // reports zero weeks and the check further down returns null before `latest` is
  // ever read. So removing this changes no behaviour today — it just makes the
  // function correct by ORDERING rather than by construction.
  if (series.length === 0) return null;

  const sorted = [...series].sort((a, b) => a.week.localeCompare(b.week));
  const latest = sorted[sorted.length - 1]!;
  const baseline = baselineOf(sorted.slice(0, -1));

  if (baseline.weeks < thresholds.minBaselineWeeks) return null;
  // AC3, and see the header: the floor is on the BASELINE, so a collapse to zero
  // still reports.
  if (baseline.mean < thresholds.minActivity) return null;

  // A flat baseline has no spread to measure against. Dividing by it would make
  // every non-identical week infinitely unusual, so a seller who sold exactly
  // four items for six weeks and then five would be paged.
  if (baseline.stdDev <= 0) return null;

  const sigma = (latest.value - baseline.mean) / baseline.stdDev;
  if (Math.abs(sigma) < thresholds.sigma) return null;

  return {
    metric,
    direction: sigma > 0 ? "up" : "down",
    week: latest.week,
    value: latest.value,
    baseline,
    sigma,
  };
}

/**
 * One plain sentence for an anomaly.
 *
 * No jargon: a seller reading a weekly email should not have to know what a
 * standard deviation is. The numbers carry the meaning, and the phrasing says
 * which direction is which without implying either is good or bad — a spike in
 * returns and a spike in sales are the same shape and opposite news.
 */
export function describeAnomaly(a: SellerAnomaly): string {
  const dir = a.direction === "up" ? "above" : "below";
  const value = Number.isInteger(a.value) ? String(a.value) : a.value.toFixed(2);
  const mean = a.baseline.mean.toFixed(1);
  return (
    `${a.metric}: ${value} in the week of ${a.week}, ${dir} your usual ${mean} ` +
    `over the previous ${a.baseline.weeks} weeks.`
  );
}
