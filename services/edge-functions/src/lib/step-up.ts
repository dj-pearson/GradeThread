// Step-up re-authentication for destructive super-admin actions (US-270).
//
// The most damaging actions (role grant/revoke, manual refund, account
// deletion, prompt-version activation) require a FRESH MFA challenge — a recent
// AAL2 re-auth — verified server-side here, in addition to the standing AAL2
// requirement in adminAuthMiddleware. The client performs an MFA challenge
// (supabase.auth.mfa.challenge/verify), which mints a token whose `amr` carries
// a new TOTP timestamp, then retries the action with that token.
import type { Context } from "hono";
import { type AuthAssuranceClaims, hasFreshStepUp } from "./jwt-claims.ts";
import { isAdminMfaEnforced, STEP_UP_FRESH_SEC, STEP_UP_MAX_AGE_SEC } from "./env.ts";

// Returns a 403 Response when the caller has NOT completed a fresh step-up,
// otherwise null. Usage:
//   const blocked = requireStepUp(c); if (blocked) return blocked;
export function requireStepUp(
  c: Context,
  maxAgeSec: number = STEP_UP_MAX_AGE_SEC,
): Response | null {
  // When enforcement is off (enrollment window) step-up is also relaxed so the
  // team isn't blocked before anyone has a second factor.
  if (!isAdminMfaEnforced()) return null;

  // US-357: read the assurance claims authMiddleware decoded from the VERIFIED
  // token (never re-decode the raw header). Missing claims → fail closed.
  const claims = c.get("authClaims") as AuthAssuranceClaims | undefined;
  if (claims && hasFreshStepUp(claims, maxAgeSec)) return null;

  return c.json({
    error:
      "This action requires re-verifying your second factor. Confirm your authenticator and try again.",
    code: "STEP_UP_REQUIRED",
    max_age_seconds: maxAgeSec,
  }, 403);
}

/**
 * US-2353 AC5: step-up with the SHORT window, for the irreversible tier.
 *
 * `requireStepUp` uses a working-day window, which is right for ordinary
 * sensitive actions and wrong for these: moving money, voiding issued grades,
 * flipping a kill switch, executing an agent-authored write. For those,
 * "you verified this morning" is not evidence that you are at the keyboard now.
 *
 * Same failure shape as requireStepUp — returns a 403 Response to RETURN, and
 * null when the caller may proceed. The client handles STEP_UP_REQUIRED
 * centrally, so a shorter window costs a prompt, not a broken surface.
 */
export function requireFreshStepUp(c: Context): Response | null {
  return requireStepUp(c, STEP_UP_FRESH_SEC);
}
