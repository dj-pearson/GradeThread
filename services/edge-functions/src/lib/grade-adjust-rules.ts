// US-478: the >1.5-point grade-adjustment rule. A human review that moves the
// overall grade by MORE than 1.5 points is a large correction and requires a
// super_admin — the client disabled the button, but the gate must be enforced
// SERVER-SIDE so it can't be bypassed by a direct API call. Kept pure so the
// rule is unit-testable without the route's hono/supabase graph.

/** Maximum overall-score swing a plain `admin` may apply in one adjustment. */
export const ADMIN_MAX_ADJUST_DELTA = 1.5;

/**
 * True when an adjustment from `originalScore` to `adjustedScore` exceeds the
 * plain-admin threshold and therefore requires super_admin. Uses a tiny epsilon
 * so an exactly-1.5 swing (allowed) isn't rejected by float noise.
 */
export function requiresSuperAdmin(
  originalScore: number,
  adjustedScore: number,
): boolean {
  return Math.abs(adjustedScore - originalScore) > ADMIN_MAX_ADJUST_DELTA + 1e-9;
}
