// US-2286: which store environment produced an in-app-purchase entitlement.
//
// THE GAP THIS CLOSES, AND WHAT IT DELIBERATELY DOES NOT DO. Apple's verifier
// falls back from Production to Sandbox and that fallback is CORRECT and stays:
// App Review always exercises IAP in the sandbox, even against a Production
// build in the store, so a deploy that refuses Sandbox JWS fails review. The
// rationale is written out at appstore/verify.ts:37-45 and is not being
// reversed here. Nor is it an open abuse vector — a valid Sandbox JWS can only
// be produced by a sandbox tester the developer provisions in App Store
// Connect.
//
// The real defect is narrower: the resulting grant was recorded with NO MARKER
// of which environment produced it. A sandbox-granted Business Yearly was
// byte-identical on the users row to one somebody paid for, so it was
// indistinguishable in revenue reporting, in plan-distribution metrics, in the
// expiry sweeps, and in any manual "why is this account on Pro" investigation.
// You cannot exclude what you never marked. This module is the marker.
//
// WHY A SHARED MODULE RATHER THAN A STRING IN EACH STORE'S CODE. Apple says
// "Sandbox"/"Production" and Google says testPurchase/purchaseType=0. Two
// vocabularies for one question, and the thing downstream needs is one answer
// in one spelling. Normalising at each call site is how the two halves drift.
//
// WHY IT IS ITS OWN FILE. appstore/verify.ts wraps Apple's SignedDataVerifier
// and cannot be unit-tested without real Apple-signed data (its own header says
// so, which is why verify-config.ts exists). Keeping the classification pure
// and separate means the rule that decides whether money is real is testable
// without booting either store's SDK.

/**
 * The store environment an entitlement came from, in ONE spelling.
 *
 * Stored as text rather than a boolean `is_sandbox` to match the in-repo
 * precedent at 00375 (`push_device_tokens.environment` text + CHECK) and
 * because a third value (Apple has historically shipped others, and TestFlight
 * is arguably its own thing) stays addable without a column rename.
 */
export type BillingEnvironment = "production" | "sandbox";

/**
 * Apple reports the environment in two independent places, and they are not
 * equally trustworthy:
 *
 *   - the verifier that ANSWERED — which root chain actually validated the
 *     signature. This is the strong signal.
 *   - `payload.environment` — a field INSIDE the signed payload. Also
 *     Apple-signed, so not attacker-forgeable, but it describes what Apple
 *     said rather than what we proved.
 *
 * When they disagree we resolve to `sandbox`, and the asymmetry is the whole
 * point: a false "sandbox" costs one row wrongly left out of a revenue report,
 * which is visible and correctable. A false "production" books a free
 * entitlement as revenue, which is invisible and compounds every time the
 * report is read. Fail toward not-money.
 */
export function resolveAppleEnvironment(params: {
  /** Environment name of the verifier that successfully decoded the JWS. */
  verifiedBy: string | null | undefined;
  /** `environment` as reported inside the decoded payload, when present. */
  claimedInPayload?: string | null;
}): BillingEnvironment {
  const verified = normalizeAppleName(params.verifiedBy);
  const claimed = normalizeAppleName(params.claimedInPayload);

  // Either source saying sandbox is enough. Includes the unknown/unparseable
  // case: normalizeAppleName returns null for anything it does not recognise,
  // and an unrecognised environment is not evidence of a real payment.
  if (verified === "sandbox" || claimed === "sandbox") return "sandbox";
  if (verified === "production" || claimed === "production") return "production";
  return "sandbox";
}

/**
 * Apple's SDK spells these "Sandbox" and "Production"; the Environment enum's
 * string values and the payload field both use that casing. Compared
 * case-insensitively anyway, because this normalises data crossing a network
 * boundary and a casing change in Apple's SDK should not silently reclassify
 * every grant as sandbox.
 */
function normalizeAppleName(raw: string | null | undefined): BillingEnvironment | null {
  const value = raw?.trim().toLowerCase();
  if (value === "sandbox") return "sandbox";
  if (value === "production") return "production";
  return null;
}

/**
 * Google's two purchase APIs flag a test purchase differently, and neither
 * field is present on a normal purchase:
 *
 *   - subscriptionsv2 returns a `testPurchase` OBJECT (`{}`) when the purchase
 *     was made by a licence-tester account. Its presence is the signal; it has
 *     no useful contents.
 *   - purchases.products returns `purchaseType` where 0 = Test, 1 = Promo,
 *     2 = Rewarded, and the field is ABSENT for an ordinary paid purchase.
 *
 * The absent-means-real shape is why this takes both fields and defaults to
 * production only when it has actually seen the response. A caller that cannot
 * observe either field should pass `undefined` for both and will get
 * "production" — which is correct for the ordinary purchase and is the reason
 * the Play parsers below feed it the raw response rather than a pre-digested
 * boolean.
 *
 * purchaseType 1 (Promo) and 2 (Rewarded) are NOT classed as sandbox. They are
 * genuinely-granted entitlements in the production store; they are simply not
 * paid-for. Conflating "free" with "not real" would hide promo redemptions from
 * the very reporting this exists to make honest.
 */
export function resolvePlayEnvironment(params: {
  /** `testPurchase` from a subscriptionsv2 response, if the key was present. */
  testPurchase?: unknown;
  /** `purchaseType` from a products response, if the key was present. */
  purchaseType?: number | null;
}): BillingEnvironment {
  if (params.testPurchase !== undefined && params.testPurchase !== null) return "sandbox";
  if (params.purchaseType === 0) return "sandbox";
  return "production";
}

/**
 * True when an entitlement should count toward revenue, MRR, plan-distribution
 * and ARPU reporting.
 *
 * NULL means production on purpose. Every grant that predates this column was
 * written before the marker existed, and the overwhelming majority of them are
 * real paid subscriptions; defaulting the backfill-less past to "not revenue"
 * would silently zero out historical MRR the first time this predicate is used.
 * The sandbox grants hiding in that history are found by the US-2286 AC5 audit,
 * not by a guess encoded here.
 */
export function countsAsRevenue(environment: string | null | undefined): boolean {
  return environment !== "sandbox";
}
