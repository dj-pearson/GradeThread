// US-1557: per-category confidence calibration.
//
// The human-review trigger has been a flat threshold (grading_review_
// confidence_threshold, default 0.75) — a guess. This module derives
// MEASURED per-category thresholds from history: every human review yields a
// (confidence, |AI overall − human-final overall|) pair; the reliability curve
// of those pairs tells us, per garment_category, the lowest confidence at
// which grades shipped WITHOUT review stay under a target error rate. Fewer
// wasted reviews on categories the model grades well; earlier review routing
// on categories it doesn't.
//
// Rollout discipline (grading-engine skill): SHADOW FIRST. The calibration is
// computed + persisted by a scheduled job, but enforcement is gated on the
// setting's own `enabled` flag (default false) — until then the grading path
// logs would-have-routed deltas so the change is provable from data. The
// defect-divergence trigger and every confidence cap remain ORed in unchanged;
// calibration only replaces the flat-threshold term.

// A shipped grade off by more than this many points (0.1-rounded overall) is
// an "error event" for calibration purposes — half a grade point is the
// smallest materially-wrong delta.
export const ERROR_POINT_THRESHOLD = 0.5;
// Minimum pairs a category needs before its own threshold is trusted; below
// this the global flat threshold applies. Documented minimum N (AC1).
export const MIN_CALIBRATION_SAMPLES = 50;
// Minimum pairs that must sit ABOVE a candidate threshold for its shipped
// error rate to mean anything.
export const MIN_SHIPPED_SAMPLES = 10;
// Sanity band: a derived threshold outside this range is clamped — review can
// never be disabled (too low) or made universal (too high) by noisy data.
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.9;
// Default share of shipped (unreviewed) grades allowed to be error events.
export const DEFAULT_TARGET_ERROR_RATE = 0.1;

/** One historical outcome: the AI's confidence and how wrong it turned out. */
export interface CalibrationPair {
  confidence: number;
  absError: number;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanAbsError: number;
  /** Fraction of pairs in the bin with absError > ERROR_POINT_THRESHOLD. */
  errorRate: number;
}

/** Reliability curve: confidence bins vs realized error. Pure. */
export function binReliability(
  pairs: readonly CalibrationPair[],
  binWidth = 0.05,
): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let lo = 0; lo < 1 - 1e-9; lo += binWidth) {
    const hi = Math.min(1, lo + binWidth);
    const inBin = pairs.filter((p) =>
      p.confidence >= lo && (p.confidence < hi || (hi === 1 && p.confidence === 1))
    );
    if (inBin.length === 0) continue;
    const errors = inBin.filter((p) => p.absError > ERROR_POINT_THRESHOLD).length;
    bins.push({
      lo: Number(lo.toFixed(2)),
      hi: Number(hi.toFixed(2)),
      n: inBin.length,
      meanAbsError: Number(
        (inBin.reduce((s, p) => s + p.absError, 0) / inBin.length).toFixed(3),
      ),
      errorRate: Number((errors / inBin.length).toFixed(3)),
    });
  }
  return bins;
}

export interface DerivedThreshold {
  threshold: number;
  sampleSize: number;
  /** Error rate among grades at/above the derived threshold. */
  shippedErrorRate: number;
  /** True when the category fell back to the flat global threshold. */
  usedFallback: boolean;
}

/**
 * The lowest threshold in [THRESHOLD_MIN, THRESHOLD_MAX] whose shipped set
 * (pairs with confidence ≥ threshold, at least MIN_SHIPPED_SAMPLES of them)
 * keeps the error rate at/under target. Falls back to `fallback` when the
 * category is under-sampled or no candidate qualifies. Pure + deterministic.
 */
export function deriveThreshold(
  pairs: readonly CalibrationPair[],
  opts: { targetErrorRate?: number; fallback: number },
): DerivedThreshold {
  const target = opts.targetErrorRate ?? DEFAULT_TARGET_ERROR_RATE;
  const fallbackResult: DerivedThreshold = {
    threshold: opts.fallback,
    sampleSize: pairs.length,
    shippedErrorRate: NaN,
    usedFallback: true,
  };
  if (pairs.length < MIN_CALIBRATION_SAMPLES) return fallbackResult;

  const sorted = [...pairs].sort((a, b) => a.confidence - b.confidence);
  for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX + 1e-9; t += 0.01) {
    const shipped = sorted.filter((p) => p.confidence >= t - 1e-9);
    if (shipped.length < MIN_SHIPPED_SAMPLES) break; // higher t only shrinks it
    const errors = shipped.filter((p) => p.absError > ERROR_POINT_THRESHOLD).length;
    const rate = errors / shipped.length;
    if (rate <= target) {
      return {
        threshold: Number(t.toFixed(2)),
        sampleSize: pairs.length,
        shippedErrorRate: Number(rate.toFixed(3)),
        usedFallback: false,
      };
    }
  }
  return fallbackResult;
}

// ── Persisted shape (system_settings key `grading_confidence_calibration`) ──

export interface CategoryCalibration {
  threshold: number;
  sample_size: number;
  shipped_error_rate: number | null;
  curve: ReliabilityBin[];
}

export interface CalibrationSetting {
  /** Enforcement gate — false = shadow-only (log deltas, keep the flat rule). */
  enabled: boolean;
  target_error_rate: number;
  computed_at: string | null;
  categories: Record<string, CategoryCalibration>;
}

export const CALIBRATION_SETTING_KEY = "grading_confidence_calibration";

export const EMPTY_CALIBRATION: CalibrationSetting = {
  enabled: false,
  target_error_rate: DEFAULT_TARGET_ERROR_RATE,
  computed_at: null,
  categories: {},
};

/**
 * Resolve the review threshold for one category. Returns the calibrated value
 * only when calibration is present AND that category has a real (non-fallback)
 * derived threshold; every other case returns the flat global threshold.
 * Clamped to the sanity band. Pure.
 */
export function thresholdForCategory(
  calibration: CalibrationSetting | null | undefined,
  category: string | null | undefined,
  flatThreshold: number,
): { threshold: number; calibrated: boolean } {
  const cat = category?.trim().toLowerCase();
  const entry = cat ? calibration?.categories?.[cat] : undefined;
  if (!entry || !Number.isFinite(entry.threshold)) {
    return { threshold: flatThreshold, calibrated: false };
  }
  const clamped = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, entry.threshold));
  return { threshold: clamped, calibrated: true };
}
