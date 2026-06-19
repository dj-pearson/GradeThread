// Garment Passport longitudinal resale-value & depreciation forecast (US-1104).
//
// Pure, unit-tested estimator that turns a cohort of historical SALE observations
// (price, condition at sale, days-to-sell, sale date) into a forward-looking
// valuation: a condition-adjusted list price, an expected days-to-sell, and a
// projected 12-month resale value with a confidence interval. This is the payoff
// of the longitudinal passport dataset — valuation intelligence derived from the
// ledger, not a single live comp snapshot.
//
// HONESTY (AC3): every output is an ESTIMATE, labeled as such, and degrades
// gracefully — below a corroboration floor it returns dataQuality:"insufficient"
// with null values rather than a confident-looking fabrication. No PII enters
// here: observations carry only money/condition/time scalars.
//
// METHODOLOGY (documented in docs/PASSPORT_FORECAST.md):
//   • List price        — median cohort sale price, adjusted toward the subject's
//                         current grade via a least-squares price~grade slope when
//                         the cohort has grade spread (else the plain median).
//   • Days-to-sell      — median of the cohort's listed→sold durations.
//   • 12-month value    — list price carried forward one year by an annual rate
//                         fitted from a log(price)~time regression across the
//                         cohort (captures the SKU-class's market trajectory);
//                         falls back to a conservative default rate when the
//                         cohort lacks date spread.
//   • Confidence + CI   — grow with sample size and shrink with dispersion; the
//                         12-month interval widens as confidence drops.
//
// Pure: no DB, no clock — the caller passes "now" implicitly via the observations'
// dates and the subject; nothing here reads the environment.

export interface SaleObservation {
  /** Gross sale price in cents (> 0). */
  salePriceCents: number;
  /** The garment's grade (0–10) at the time of this sale, if known. */
  gradeAtSale: number | null;
  /** ISO timestamp of the sale (drives the depreciation-over-time fit). */
  soldAt: string;
  /** Listed→sold duration in days, if both timestamps are known. */
  daysToSell: number | null;
}

export interface ForecastSubject {
  /** The subject garment's CURRENT grade (0–10), the price-adjustment anchor. */
  currentGrade: number | null;
  /** brand / garment_type / category descriptor (for the methodology label). */
  skuClass: Record<string, unknown>;
}

export interface ForecastInterval {
  lowCents: number;
  highCents: number;
}

export type ForecastDataQuality = "sufficient" | "sparse" | "insufficient";

export interface DepreciationForecast {
  dataQuality: ForecastDataQuality;
  /** Cohort size after filtering to valid observations. */
  sampleSize: number;
  /** Condition-adjusted suggested list price (cents), or null if insufficient. */
  listPriceCents: number | null;
  listPriceInterval: ForecastInterval | null;
  /** Median expected days-to-sell, or null when no timed observations exist. */
  expectedDaysToSell: number | null;
  /** Projected resale value 12 months out (cents), or null if insufficient. */
  resaleValue12moCents: number | null;
  resaleValue12moInterval: ForecastInterval | null;
  /** Annualised depreciation as a %, + = value declines, − = appreciates. */
  annualDepreciationPct: number | null;
  /** Overall confidence in the forecast [0,1]. */
  confidence: number;
  /** Short, human-readable methodology basis for the UI tooltip. */
  basis: string;
  /** Always true — these are estimates, never asserted facts (AC3). */
  isEstimate: true;
}

// ── Tunables ──────────────────────────────────────────────────────────────────
// At least this many sales → a full, fitted forecast.
export const MIN_SUFFICIENT_OBS = 6;
// Between sparse and sufficient → forecast emitted but flagged sparse + lower
// confidence; below sparse → insufficient (null values).
export const MIN_SPARSE_OBS = 3;
// A time-trend fit needs the cohort to span at least this many days, else we use
// the default prior rate (a 2-week cluster can't reveal a yearly trend).
const MIN_TREND_SPAN_DAYS = 60;
// Conservative default annual depreciation when we can't fit one (15%/yr).
const DEFAULT_ANNUAL_DEPRECIATION = 0.15;
// Cap a fitted annual rate so a noisy small cohort can't imply a wild swing.
const MAX_ANNUAL_RATE = 0.6;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

// Ordinary least-squares slope + intercept for y ~ x. Returns null if x has no
// variance (a vertical fit is meaningless).
function linregress(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round(n: number): number {
  return Math.round(n);
}

function skuLabel(skuClass: Record<string, unknown>): string {
  const parts = ["brand", "garment_type", "category"]
    .map((k) => skuClass[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.length > 0 ? parts.join(" ") : "this SKU class";
}

/**
 * Forecast list price, days-to-sell and 12-month resale value from a cohort of
 * historical sales. Pure + deterministic. Returns dataQuality:"insufficient"
 * (null values) below the corroboration floor.
 */
export function forecastDepreciation(
  subject: ForecastSubject,
  observations: SaleObservation[],
): DepreciationForecast {
  const label = skuLabel(subject.skuClass);

  // Keep only well-formed observations (a real price + a parseable sale date).
  const obs = observations
    .map((o) => ({ ...o, soldMs: Date.parse(o.soldAt) }))
    .filter((o) => Number.isFinite(o.salePriceCents) && o.salePriceCents > 0 && Number.isFinite(o.soldMs));
  const n = obs.length;

  const insufficient: DepreciationForecast = {
    dataQuality: "insufficient",
    sampleSize: n,
    listPriceCents: null,
    listPriceInterval: null,
    expectedDaysToSell: null,
    resaleValue12moCents: null,
    resaleValue12moInterval: null,
    annualDepreciationPct: null,
    confidence: 0,
    basis: `Not enough sales history for ${label} yet (need ${MIN_SPARSE_OBS}+).`,
    isEstimate: true,
  };
  if (n < MIN_SPARSE_OBS) return insufficient;

  const prices = obs.map((o) => o.salePriceCents);
  const baseMedian = median(prices);

  // ── Condition-adjusted list price ───────────────────────────────────────────
  // Fit price ~ grade when the cohort has grade spread and we know the subject's
  // current grade; otherwise the plain median is the honest estimate.
  let listPrice = baseMedian;
  const graded = obs.filter((o): o is typeof o & { gradeAtSale: number } =>
    typeof o.gradeAtSale === "number" && o.gradeAtSale >= 0 && o.gradeAtSale <= 10
  );
  if (graded.length >= MIN_SPARSE_OBS && subject.currentGrade != null) {
    const fit = linregress(graded.map((o) => o.gradeAtSale), graded.map((o) => o.salePriceCents));
    if (fit) {
      const predicted = fit.intercept + fit.slope * clamp(subject.currentGrade, 0, 10);
      // Never let the model extrapolate outside the observed price envelope.
      listPrice = clamp(predicted, Math.min(...prices), Math.max(...prices));
    }
  }
  listPrice = Math.max(1, round(listPrice));

  // ── Days-to-sell ────────────────────────────────────────────────────────────
  const sellTimes = obs
    .map((o) => o.daysToSell)
    .filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d >= 0);
  const expectedDaysToSell = sellTimes.length > 0 ? round(median(sellTimes)) : null;

  // ── Annual depreciation rate (log-price ~ time) ─────────────────────────────
  // multiplier = value retained per year; rate = 1 − multiplier.
  const minMs = Math.min(...obs.map((o) => o.soldMs));
  const maxMs = Math.max(...obs.map((o) => o.soldMs));
  const spanDays = (maxMs - minMs) / MS_PER_DAY;

  let annualMultiplier = 1 - DEFAULT_ANNUAL_DEPRECIATION;
  let fittedRate = false;
  if (n >= MIN_SUFFICIENT_OBS && spanDays >= MIN_TREND_SPAN_DAYS) {
    const years = obs.map((o) => (o.soldMs - minMs) / MS_PER_DAY / DAYS_PER_YEAR);
    const logPrices = obs.map((o) => Math.log(o.salePriceCents));
    const fit = linregress(years, logPrices);
    if (fit) {
      // slope = annual change in log-price; exp(slope) = annual multiplier.
      const m = Math.exp(fit.slope);
      annualMultiplier = clamp(m, 1 - MAX_ANNUAL_RATE, 1 + MAX_ANNUAL_RATE);
      fittedRate = true;
    }
  }
  const annualDepreciationPct = round((1 - annualMultiplier) * 1000) / 10; // 1 dp
  const resaleValue12mo = Math.max(1, round(listPrice * annualMultiplier));

  // ── Confidence + intervals ──────────────────────────────────────────────────
  // Grows with sample size; shrinks with price dispersion (IQR / median).
  const iqr = percentile(prices, 0.75) - percentile(prices, 0.25);
  const dispersion = baseMedian > 0 ? clamp(iqr / baseMedian, 0, 1) : 1;
  const sizeScore = clamp(0.25 + n * 0.06, 0, 0.85);
  const confidence = clamp(sizeScore * (1 - dispersion * 0.5) * (fittedRate ? 1 : 0.8), 0, 0.95);

  const listPriceInterval: ForecastInterval = {
    lowCents: Math.max(1, round(percentile(prices, 0.25))),
    highCents: Math.max(1, round(percentile(prices, 0.75))),
  };
  // The 12-month band carries the list-price band forward and widens it by the
  // forecast uncertainty (1 − confidence), so a thin cohort yields an honestly
  // wide range.
  const widen = 1 + (1 - confidence) * 0.5;
  const resaleValue12moInterval: ForecastInterval = {
    lowCents: Math.max(1, round(listPriceInterval.lowCents * annualMultiplier / widen)),
    highCents: Math.max(1, round(listPriceInterval.highCents * annualMultiplier * widen)),
  };

  const dataQuality: ForecastDataQuality = n >= MIN_SUFFICIENT_OBS ? "sufficient" : "sparse";
  const trendBasis = fittedRate
    ? `${annualDepreciationPct >= 0 ? "depreciating" : "appreciating"} ~${Math.abs(annualDepreciationPct)}%/yr`
    : `assumed ${Math.round(DEFAULT_ANNUAL_DEPRECIATION * 100)}%/yr (too little date spread to fit)`;
  const basis = `Estimate from ${n} ${label} sale${n === 1 ? "" : "s"}; ${trendBasis}.`;

  return {
    dataQuality,
    sampleSize: n,
    listPriceCents: listPrice,
    listPriceInterval,
    expectedDaysToSell,
    resaleValue12moCents: resaleValue12mo,
    resaleValue12moInterval,
    annualDepreciationPct,
    confidence: Math.round(confidence * 100) / 100,
    basis,
    isEstimate: true,
  };
}
