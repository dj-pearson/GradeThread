// Pure env-handling for the App Store JWS verifier (US-788). Split out of
// verify.ts — which wraps Apple's SignedDataVerifier and so can't be unit-tested
// without real Apple-signed data — so the gnarly env parsing (the `Number("") === 0`
// trap that silently broke Production validation) IS covered by tests.
// See verify-config_test.ts.

export type AppstoreEnvironmentName = "Sandbox" | "Production";

/** Parse APPLE_APP_APPLE_ID into the numeric Apple ID, or `undefined` when it's
 * unset / blank / non-numeric / non-positive.
 *
 * The trap this guards: `Number("")` and `Number("   ")` are `0` — a FINITE
 * number — so a naive `Number(raw ?? "")` + `Number.isFinite` check passed `0`
 * (not `undefined`) when the var was unset, which silently degraded Apple's
 * strict transaction/notification validation in Production. Treat unset and any
 * non-positive value as "not provided". */
export function parseAppleAppId(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Anything but the exact string "Sandbox" means Production (fail-safe toward the
 * stricter environment). */
export function resolveAppstoreEnvironmentName(
  raw: string | undefined,
): AppstoreEnvironmentName {
  return raw?.trim() === "Sandbox" ? "Sandbox" : "Production";
}

/** Production fully validates the JWS only with the app's Apple ID; Sandbox does
 * not require it. So a Production deploy with APPLE_APP_APPLE_ID unset is a
 * degraded (but bootable) state worth a loud warning. */
export function shouldWarnMissingAppleAppId(
  env: AppstoreEnvironmentName,
  appAppleId: number | undefined,
): boolean {
  return env === "Production" && appAppleId === undefined;
}
