// US-3326: a finished grade waits for the turnaround the customer paid for.
//
// Express is promised in 1 hour, Premium in 12, Standard in 48 (pricing
// config, admin-editable; TIER_SLA_HOURS is the compiled fallback). Before
// this, an auto-approved grade went live in minutes whatever tier was bought,
// so the faster tiers bought nothing visible.
//
// The whole feature is one timestamp, release_at, written at grade time and
// ONLY when the hold applies. NULL means "not held", and every reader treats it
// that way, so with the setting off every path is byte-identical to before:
//
//   - the owner/workspace RLS policies hide the row until release_at (00786);
//   - finalizeGradeReview parks a decided grade as review_status 'held'
//     instead of going live (grading-pipeline.ts);
//   - /api/jobs/grade-release finalizes held grades whose time has come, and
//     tells a seller when a still-in-review grade becomes visible.
//
// Pure helpers live here; the DB work stays in grading-pipeline.ts and the job
// route, so this file has no supabase import and tests need no env.

import type { GradeTier } from "./grade-pricing.ts";

export const GRADE_RELEASE_HOLD_SETTING = "grade_release_hold";

export interface GradeReleaseHoldSetting {
  enabled?: boolean;
}

export const GRADE_RELEASE_HOLD_DEFAULT: GradeReleaseHoldSetting = {
  enabled: false,
};

/** The setting's value, failing closed: anything but literal true is off. */
export function holdEnabled(
  setting: GradeReleaseHoldSetting | null | undefined,
): boolean {
  return setting?.enabled === true;
}

/**
 * When a grade may be released, or null when it is not held at all.
 *
 * Express is never held: it is the tier whose whole promise is "as soon as it
 * is ready". The clock starts when the customer paid, falling back to when the
 * submission was created, then to now. A non-positive or non-finite SLA is a
 * config error and holds nothing rather than holding forever.
 */
export function computeReleaseAt(opts: {
  enabled: boolean;
  tier: string | null | undefined;
  slaHours: number | null | undefined;
  paidAt?: string | null;
  createdAt?: string | null;
  now?: number;
}): string | null {
  if (!opts.enabled) return null;
  const tier = (opts.tier ?? "standard") as GradeTier | string;
  if (tier === "express") return null;
  const hours = Number(opts.slaHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const startMs = [opts.paidAt, opts.createdAt]
    .map((t) => (t ? Date.parse(t) : NaN))
    .find((t) => Number.isFinite(t)) ?? (opts.now ?? Date.now());
  return new Date(startMs + hours * 3_600_000).toISOString();
}

/** True while a grade with this release_at must stay out of its owner's sight. */
export function isBeforeRelease(
  releaseAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!releaseAt) return false;
  const t = Date.parse(releaseAt);
  return Number.isFinite(t) && t > now;
}
