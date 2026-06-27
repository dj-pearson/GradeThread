// Verified 360 — photogrammetric / LiDAR capture badge (US-1281).
//
// The premium follow-on to the 2D zone-coverage engine (US-1276). On a capable
// device (LiDAR or multi-angle photogrammetry) the seller may OPT IN to a guided
// "Verified 360" capture that proves TRUE GEOMETRIC coverage of the garment. The
// on-device session reports a small metrics blob (angles captured, device-computed
// surface coverage, whether depth was used); this server-side evaluator is the
// AUTHORITATIVE gate that re-checks the thresholds — mirroring how Live Capture's
// device-attestation is re-verified server-side (US-1283), so a forged client
// metric can't mint the badge by itself.
//
// DESIGN — never required, never a penalty (mirrors Verified / Live Capture):
//   * Not opting in (or an unsupported device) grades exactly as before — the 2D
//     zone coverage (US-1276) stands as the fallback.
//   * A passing 360 capture earns the distinct "360-Verified" badge, a small
//     bounded grade-confidence boost, and lets the pipeline upgrade the stored
//     coverage to geometric-complete (every applicable zone documented → the
//     widest coverage-gated guarantee scope, US-1279).
//   * Any shortfall (incomplete pass / too few angles / low coverage) earns NO
//     badge and leaves the grade untouched. The reason is recorded server-side
//     for admin review; the public certificate exposes only the earned badge.
//
// Pure (clock injected) + dependency-free (no supabase) so it unit-tests without
// the env dance; it only reads optional tuning env vars that default.

// The device-reported capture metrics (persisted on submissions.capture_360 and
// fed in here). Every field is optional — a missing/garbage value simply fails
// the corresponding threshold rather than throwing.
export interface Capture360Report {
  // Distinct viewpoints captured around the garment.
  angles?: number;
  // Device-computed fraction of the garment surface geometrically covered, 0..1.
  geometric_coverage?: number;
  // Whether LiDAR/TrueDepth depth was used (strengthens, but is NOT required —
  // multi-angle photogrammetry qualifies on its own).
  depth_available?: boolean;
  // Whether the guided on-device capture session reported the pass complete.
  capture_complete?: boolean;
  device_model?: string | null;
}

export interface Verified360Result {
  verified: boolean;
  // The earned certificate badge tier ('verified_360' or null). A future
  // depth-vs-photogrammetry split would add tiers here.
  badge: "verified_360" | null;
  // Echoed for admin review / the cert detail.
  geometric_coverage_pct: number;
  depth_used: boolean;
  angles: number;
  // Human-readable detail for admin review (kept server-side; the public
  // certificate exposes only the pass/fail badge).
  reasons: string[];
  min_angles: number;
  min_coverage_pct: number;
  checked_at: string;
}

function clampInt(raw: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(raw) && raw >= lo && raw <= hi ? Math.round(raw) : fallback;
}

/** Minimum distinct viewpoints a 360 capture must report. */
export function verified360MinAngles(): number {
  return clampInt(Number(Deno.env.get("VERIFIED_360_MIN_ANGLES")), 2, 72, 8);
}

/** Minimum device-computed surface coverage fraction (0..1). */
export function verified360MinCoverage(): number {
  const raw = Number(Deno.env.get("VERIFIED_360_MIN_COVERAGE"));
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.85;
}

/** Confidence boost added when 360-Verified (capped at 1.0 by the caller). Small
 * and bounded — provenance/coverage corroborates, it never overrides the grade. */
export function verified360Boost(): number {
  const raw = Number(Deno.env.get("VERIFIED_360_CONFIDENCE_BOOST"));
  return Number.isFinite(raw) && raw >= 0 && raw <= 0.3 ? raw : 0.1;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Evaluate whether an opted-in submission earns the 360-Verified badge. Pure
 * (clock injected) so it's deterministic + unit-testable. NEVER penalizes: the
 * only outcomes are "verified" (badge + boost + geometric-complete coverage) or
 * "not verified" (grade + 2D coverage unchanged).
 */
export function evaluateVerified360(opts: {
  optedIn: boolean;
  report: Capture360Report | null;
  nowMs: number;
}): Verified360Result {
  const minAngles = verified360MinAngles();
  const minCoverage = verified360MinCoverage();
  const minCoveragePct = Math.round(minCoverage * 100);
  const report = opts.report ?? {};
  const angles = Math.max(0, Math.round(num(report.angles)));
  const coverage = num(report.geometric_coverage);
  const coveragePct = Math.round(Math.max(0, Math.min(1, coverage)) * 100);
  const depthUsed = report.depth_available === true;

  const base: Verified360Result = {
    verified: false,
    badge: null,
    geometric_coverage_pct: coveragePct,
    depth_used: depthUsed,
    angles,
    reasons: [],
    min_angles: minAngles,
    min_coverage_pct: minCoveragePct,
    checked_at: new Date(opts.nowMs).toISOString(),
  };

  if (!opts.optedIn) {
    return { ...base, reasons: ["not opted into Verified 360"] };
  }
  if (!opts.report || typeof opts.report !== "object") {
    return { ...base, reasons: ["no 360 capture metrics were reported"] };
  }

  // Collect every shortfall (never a silent pass — recorded for admin review).
  const failures: string[] = [];
  if (report.capture_complete === false) {
    failures.push("the guided 360 capture was not completed");
  }
  if (angles < minAngles) {
    failures.push(
      `only ${angles} of the required ${minAngles} capture angles`,
    );
  }
  if (coveragePct < minCoveragePct) {
    failures.push(
      `geometric coverage ${coveragePct}% is below the required ${minCoveragePct}%`,
    );
  }

  if (failures.length > 0) {
    return { ...base, reasons: [`360-Verified not earned — ${failures.join("; ")}`] };
  }

  return {
    ...base,
    verified: true,
    badge: "verified_360",
    reasons: [
      `360-Verified earned — ${angles} angles, ${coveragePct}% geometric coverage` +
      (depthUsed ? ", depth-backed (LiDAR/TrueDepth)" : ", photogrammetry"),
    ],
  };
}
