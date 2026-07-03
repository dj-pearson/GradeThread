// US-1557: per-category confidence calibration — pure binning + threshold
// derivation math, fallback semantics, and the category resolver.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  binReliability,
  deriveThreshold,
  EMPTY_CALIBRATION,
  MIN_CALIBRATION_SAMPLES,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  thresholdForCategory,
} = await import("../lib/confidence-calibration.ts");

/** n pairs at the given confidence, errFraction of them wrong by 1.0. */
function cohort(confidence: number, n: number, errFraction: number) {
  return Array.from({ length: n }, (_, i) => ({
    confidence,
    absError: i < Math.round(n * errFraction) ? 1.0 : 0.1,
  }));
}

Deno.test("US-1557: binReliability computes per-bin error rates", () => {
  const bins = binReliability([
    ...cohort(0.62, 10, 0.5), // 50% wrong in the 0.60-0.65 bin
    ...cohort(0.92, 10, 0.0), // clean 0.90-0.95 bin
  ]);
  const low = bins.find((b) => b.lo === 0.6);
  const high = bins.find((b) => b.lo === 0.9);
  assert(low && high);
  assertEquals(low!.n, 10);
  assertEquals(low!.errorRate, 0.5);
  assertEquals(high!.errorRate, 0);
  // Empty input → no bins.
  assertEquals(binReliability([]), []);
});

Deno.test("US-1557: deriveThreshold finds the lowest qualifying threshold", () => {
  // Below 0.7: noisy (40% error). At/above 0.7: clean (0%). A 10%-target
  // calibration should land the threshold at ~0.70 — LOWER thresholds still
  // include the noisy cohort and fail the target.
  const pairs = [...cohort(0.6, 40, 0.4), ...cohort(0.75, 60, 0.0)];
  const d = deriveThreshold(pairs, { targetErrorRate: 0.1, fallback: 0.75 });
  assertEquals(d.usedFallback, false);
  assert(d.threshold > 0.6 && d.threshold <= 0.75, `got ${d.threshold}`);
  assertEquals(d.shippedErrorRate, 0);
});

Deno.test("US-1557: a well-calibrated category earns a LOWER threshold than 0.75", () => {
  // Model is reliable from 0.6 up → calibration should ship 0.6+ unreviewed.
  const pairs = [...cohort(0.6, 50, 0.02), ...cohort(0.8, 50, 0.0)];
  const d = deriveThreshold(pairs, { targetErrorRate: 0.1, fallback: 0.75 });
  assertEquals(d.usedFallback, false);
  assert(d.threshold <= 0.6, `expected <=0.6, got ${d.threshold}`);
});

Deno.test("US-1557: under-sampled categories fall back to the flat threshold", () => {
  const d = deriveThreshold(cohort(0.9, MIN_CALIBRATION_SAMPLES - 1, 0), {
    fallback: 0.75,
  });
  assertEquals(d.usedFallback, true);
  assertEquals(d.threshold, 0.75);
});

Deno.test("US-1557: hopeless data (always wrong) falls back — review is never disabled", () => {
  const d = deriveThreshold(cohort(0.85, 100, 0.9), {
    targetErrorRate: 0.1,
    fallback: 0.75,
  });
  assertEquals(d.usedFallback, true);
});

Deno.test("US-1557: thresholdForCategory resolves, clamps, and falls back", () => {
  const calib = {
    ...EMPTY_CALIBRATION,
    categories: {
      jeans: { threshold: 0.62, sample_size: 120, shipped_error_rate: 0.05, curve: [] },
      hoodie: { threshold: 0.99, sample_size: 80, shipped_error_rate: 0.02, curve: [] },
    },
  };
  assertEquals(thresholdForCategory(calib, "jeans", 0.75), {
    threshold: 0.62,
    calibrated: true,
  });
  // Clamped to the sanity band.
  assertEquals(thresholdForCategory(calib, "HOODIE", 0.75).threshold, THRESHOLD_MAX);
  // Unknown category / null calibration → flat.
  assertEquals(thresholdForCategory(calib, "dress", 0.75), {
    threshold: 0.75,
    calibrated: false,
  });
  assertEquals(thresholdForCategory(null, "jeans", 0.75).calibrated, false);
  assert(THRESHOLD_MIN < THRESHOLD_MAX);
});
