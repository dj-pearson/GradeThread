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
