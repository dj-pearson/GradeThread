// Runtime environment detection + security debug-flag gating (US-266).
//
// Any flag that WEAKENS security — skips a signature check, logs raw request
// payloads, disables an auth step — MUST be read through isDebugAllowed() so
// it is guaranteed inert in production, regardless of how the env is set.

// Resolve the deploy environment. Defaults to "production" when unset so a
// misconfigured container fails CLOSED (debug bypasses off) rather than open.
export function edgeEnv(): string {
  return (Deno.env.get("EDGE_ENV") ?? Deno.env.get("DENO_ENV") ?? "production")
    .trim()
    .toLowerCase();
}

export function isProduction(): boolean {
  return edgeEnv() === "production";
}

// US-270: whether admin endpoints require AAL2 (MFA) and destructive actions
// require a fresh step-up. Enforced by DEFAULT (fail-closed); set
// ADMIN_MFA_ENFORCED=false ONLY during the initial enrollment window so the
// team can enroll TOTP before the gate turns on. Re-enable immediately after.
export function isAdminMfaEnforced(): boolean {
  return (Deno.env.get("ADMIN_MFA_ENFORCED") ?? "true").trim().toLowerCase() !==
    "false";
}

// US-357: startup assertion. In production, ADMIN_MFA_ENFORCED=false silently
// disables the entire admin-MFA gate (AAL2 requirement + destructive step-up),
// so a misconfigured flag must not pass quietly. We FAIL LOUD: throw at boot,
// crashing the container, unless the operator has set an explicit, documented
// enrollment-window escape hatch (which itself logs a loud warning). Pure +
// injectable (env getter) so it is unit-testable. Returns void; throws on a
// fatal misconfiguration.
export function assertAdminMfaConfig(
  getEnv: (k: string) => string | undefined = (k) => Deno.env.get(k),
): void {
  const env = (getEnv("EDGE_ENV") ?? getEnv("DENO_ENV") ?? "production")
    .trim().toLowerCase();
  if (env !== "production") return;

  const enforced =
    (getEnv("ADMIN_MFA_ENFORCED") ?? "true").trim().toLowerCase() !== "false";
  if (enforced) return;

  const enrollmentWindow =
    (getEnv("ADMIN_MFA_ENROLLMENT_WINDOW") ?? "false").trim().toLowerCase() ===
      "true";
  if (enrollmentWindow) {
    // Deliberate, temporary opt-out — allowed, but never silent.
    console.error(
      "[SECURITY] ADMIN_MFA_ENFORCED=false in production with " +
        "ADMIN_MFA_ENROLLMENT_WINDOW=true — admin MFA is OFF for the enrollment " +
        "window only. Re-enable (unset both) the moment the team has enrolled.",
    );
    return;
  }

  throw new Error(
    "[SECURITY] ADMIN_MFA_ENFORCED=false in production but no enrollment window " +
      "is declared. Refusing to start with admin MFA disabled. Set " +
      "ADMIN_MFA_ENFORCED=true (or, only for the initial TOTP-enrollment window, " +
      "set ADMIN_MFA_ENROLLMENT_WINDOW=true explicitly).",
  );
}

// Step-up freshness window for destructive super-admin actions (seconds).
// US-270: how long a fresh MFA step-up stays valid before the next DESTRUCTIVE
// admin action (refund, credit grant, role change, prompt-version activation,
// deletion) re-prompts for the authenticator. Default 24h: one verification per
// working day, and signing out ends it regardless (the window is measured off
// the SESSION's `amr` timestamp, so a new session always starts unverified).
// Override with ADMIN_STEP_UP_MAX_AGE_SEC (whole seconds, floored to a 60s
// minimum). Setting it very high effectively disables the fresh-re-auth
// protection on those actions.
export const STEP_UP_MAX_AGE_SEC = (() => {
  const raw = Number(Deno.env.get("ADMIN_STEP_UP_MAX_AGE_SEC"));
  return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 24 * 60 * 60;
})();

// True only when the named flag is "true" AND we are not in production.
export function isDebugAllowed(flag: string): boolean {
  if (isProduction()) return false;
  return Deno.env.get(flag) === "true";
}

// Flags that bypass a security control if left enabled. Audited at startup.
const SECURITY_DEBUG_FLAGS = ["WEBHOOK_PAYOUT_DEBUG"];

// Loud, non-fatal warning at boot if a security-weakening flag is set while in
// production. The flag is already ignored by isDebugAllowed(); this just makes
// the misconfiguration visible in logs. (No Sentry in the edge service.)
export function assertNoProdDebugFlags(): void {
  if (!isProduction()) return;
  for (const flag of SECURITY_DEBUG_FLAGS) {
    if (Deno.env.get(flag) === "true") {
      console.error(
        `[SECURITY] ${flag}=true is set but EDGE_ENV=production — the flag is ` +
          `being IGNORED (no verification bypass / payload logging). Unset it.`,
      );
    }
  }
}
