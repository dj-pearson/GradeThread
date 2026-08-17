// Runtime environment detection + security debug-flag gating (US-266).
//
// Any flag that WEAKENS security — skips a signature check, logs raw request
// payloads, disables an auth step — MUST be read through isDebugAllowed() so
// it is guaranteed inert in production, regardless of how the env is set.

/**
 * Resolve the deploy environment. Defaults to "production" when unset so a
 * misconfigured container fails CLOSED (debug bypasses off) rather than open.
 *
 * ⚠ BLANK COUNTS AS UNSET, and that is the whole point of this helper.
 *
 * This used to be `Deno.env.get("EDGE_ENV") ?? Deno.env.get("DENO_ENV") ??
 * "production"`. `??` falls through on null/undefined and NEVER on an empty
 * string — so `EDGE_ENV=` (a blank field in the Coolify UI, or a trailing `=`
 * in an env file) resolved to `""`, which is not "production", and the service
 * silently stopped believing it was in production. Measured 2026-08-16:
 *
 *   EDGE_ENV absent  → edgeEnv()="production", missingRequiredEnv() lists
 *                      STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *                      FLIPDESK_INTERNAL_JOB_SECRET, EDGE_ENCRYPTION_KEY,
 *                      CERT_SIGNING_KEY, API_KEY_PEPPER
 *   EDGE_ENV=""      → edgeEnv()="",           missingRequiredEnv() returns []
 *
 * So a blank value made /health/ready report READY with none of those secrets,
 * turned off the `pages_origin_bypass` reporting US-2612 is waiting on, made
 * `isProduction()` false everywhere it gates behaviour, and short-circuited
 * `assertAdminMfaConfig` below — which exists to refuse to boot with admin MFA
 * disabled.
 *
 * This is the same defect the release identity had (see lib/release-identity.ts,
 * whose header states the rule: fall through on a placeholder VALUE, not merely
 * on an unset key). That fix did not reach here.
 */
export function resolveEdgeEnv(
  get: (k: string) => string | undefined = (k) => Deno.env.get(k),
): string {
  const first = (get("EDGE_ENV") ?? "").trim();
  if (first) return first.toLowerCase();
  const second = (get("DENO_ENV") ?? "").trim();
  if (second) return second.toLowerCase();
  return "production";
}

export function edgeEnv(): string {
  return resolveEdgeEnv();
}

/**
 * Every environment name this repository actually uses, read off the deploy
 * files rather than invented: `production` (docker-compose.coolify.yml),
 * `staging` (docker-compose.staging.yml, .env.staging.example), `development`
 * (docker-compose.dev.yml) and `test` (the tenant-isolation and money-cert
 * workflows).
 */
export const KNOWN_EDGE_ENVS = [
  "production",
  "staging",
  "development",
  "test",
] as const;

export function isKnownEdgeEnv(env: string = edgeEnv()): boolean {
  return (KNOWN_EDGE_ENVS as readonly string[]).includes(env);
}

/**
 * ⚠ AN UNRECOGNISED VALUE COUNTS AS PRODUCTION (US-2660 AC3).
 *
 * The blank-value bug this sits on top of had a sibling nobody had decided
 * about: any non-empty string was accepted as-is, so `EDGE_ENV=prod` — an
 * entirely plausible typo in a hand-edited Coolify field, and the field IS
 * hand-edited (US-2665) — was not "production" and therefore switched off the
 * required-secret checks, admin-MFA boot enforcement, HTTPS in the SSRF guard,
 * live-mode Stripe filtering, rate limiting and the CORS localhost exclusion.
 * Exactly what the blank did, by exactly the same route.
 *
 * WHY THIS IS NOT THE WHITELIST THAT WAS REJECTED. The objection recorded
 * against a whitelist was that it "breaks staging and any future environment
 * name", and it would — if an unrecognised name were REFUSED. This one is not
 * refused: it boots, it keeps its name in `edgeEnv()` and in every log and
 * Sentry tag, and it gets production's caution. A future environment gets a
 * service that is too strict and says so at the top of its logs, which someone
 * fixes in a minute. The alternative is a service that is too permissive and
 * says nothing, which is what this cost.
 *
 * The asymmetry is the whole argument: a wrong guess toward production is a
 * false alarm, a wrong guess away from it is a silent hole.
 */
export function isProductionEnv(env: string): boolean {
  return env === "production" || !isKnownEdgeEnv(env);
}

export function isProduction(): boolean {
  return isProductionEnv(edgeEnv());
}

/**
 * Loud, non-fatal boot warning for an environment name nothing recognises.
 *
 * Non-fatal on purpose. Refusing to boot on an unknown name would make adding a
 * new environment a production-shaped outage, and `isProduction()` above has
 * already made the value safe. This exists so the operator learns about the
 * typo from the first ten lines of the log rather than from behaviour.
 */
export function assertKnownEdgeEnv(env: string = edgeEnv()): void {
  if (isKnownEdgeEnv(env)) return;
  console.error(
    `[SECURITY] EDGE_ENV="${env}" is not one of ${KNOWN_EDGE_ENVS.join(", ")}. ` +
      `Treating it as PRODUCTION so no security control is silently disabled — ` +
      `every production-only check is active. If this is a real new environment, ` +
      `add it to KNOWN_EDGE_ENVS; if it is a typo (prod, PRODUCTION, produciton), fix it.`,
  );
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
  // Through the shared resolver AND the shared predicate, so neither a blank
  // EDGE_ENV nor an unrecognised one can skip this check. It carried its own
  // copy of the `??` chain, which meant `EDGE_ENV=` returned here early and the
  // boot-time refusal to start with admin MFA disabled simply did not run; the
  // bare `!== "production"` had the same effect for `EDGE_ENV=prod`.
  const env = resolveEdgeEnv(getEnv);
  if (!isProductionEnv(env)) return;

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
// US-2353 AC5: the SHORT window, for the tier where 24 hours is not a control.
//
// STEP_UP_MAX_AGE_SEC below is deliberately a working-day window — re-prompting
// for an authenticator on every ordinary sensitive action trains people to keep
// the app open and defeats itself. But that makes step-up a once-a-day gate, and
// for the actions that move money, void issued grades, flip a kill switch or
// execute an agent-authored write, "you verified this morning" is not evidence
// that you are at the keyboard now.
//
// So there are two tiers rather than one changed default. `requireFreshStepUp`
// uses this; everything else keeps the day window. Five minutes is long enough
// to finish a multi-step action without re-prompting mid-flow and short enough
// that a walked-away session cannot be used.
export const STEP_UP_FRESH_SEC = (() => {
  const raw = Number(Deno.env.get("ADMIN_STEP_UP_FRESH_SEC"));
  return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 5 * 60;
})();

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
