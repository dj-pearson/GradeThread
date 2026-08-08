// US-2286 AC4: regression cover for the store-environment marker, both stores.
//
// The story was filed as "Apple sandbox purchases grant production plans" and
// the premise was CONTESTED BY THE CODE — appstore/verify.ts:37-45 argues, in a
// comment written when the fallback was added, that App Review always exercises
// IAP in the sandbox and a Production deploy refusing Sandbox JWS fails review.
// That defence is right. What it does not cover is that the grant was recorded
// with NO MARKER of which environment produced it, so a sandbox entitlement was
// indistinguishable from a paid one in revenue reporting, the expiry sweeps and
// any manual investigation.
//
// So these tests pin the REFRAMED behaviour: sandbox is ACCEPTED and MARKED.
// A test asserting sandbox is refused would be asserting the App Review outage.
// That is stated here because it is the kind of thing a later reader "fixes".
import { assertEquals } from "@std/assert";
import {
  countsAsRevenue,
  resolveAppleEnvironment,
  resolvePlayEnvironment,
} from "../lib/billing-environment.ts";
import { parseProductPurchase, parseSubscriptionV2 } from "../lib/google-play/verify.ts";
import { computeGoogleUserUpdate } from "../lib/google-play/products.ts";
import { computeBuyerUserUpdate, computeUserUpdate } from "../lib/appstore/reconcile.ts";
import type { DecodedTransactionLite } from "../lib/appstore/types.ts";

const NOW = Date.UTC(2026, 0, 1);

// ── Apple: which environment answered ───────────────────────────────

Deno.test("US-2286 apple: the verifier that answered decides", () => {
  assertEquals(
    resolveAppleEnvironment({ verifiedBy: "Production", claimedInPayload: "Production" }),
    "production",
  );
  assertEquals(
    resolveAppleEnvironment({ verifiedBy: "Sandbox", claimedInPayload: "Sandbox" }),
    "sandbox",
  );
});

Deno.test("US-2286 apple: casing from Apple's SDK does not reclassify a grant", () => {
  // Compared case-insensitively on purpose. If Apple's SDK ever changed the
  // casing of its Environment enum values, a case-SENSITIVE match would return
  // null for both sources and silently reclassify EVERY production grant as
  // sandbox — which would zero out revenue reporting rather than fail loudly.
  assertEquals(
    resolveAppleEnvironment({ verifiedBy: "PRODUCTION", claimedInPayload: "production" }),
    "production",
  );
});

Deno.test("US-2286 apple: disagreement resolves to sandbox, not production", () => {
  // THE ASYMMETRY IS THE POINT. Wrongly excluding one row from a revenue report
  // is visible and correctable. Wrongly booking a free entitlement as revenue is
  // neither — it inflates MRR quietly and compounds every time it is read.
  assertEquals(
    resolveAppleEnvironment({ verifiedBy: "Production", claimedInPayload: "Sandbox" }),
    "sandbox",
  );
  assertEquals(
    resolveAppleEnvironment({ verifiedBy: "Sandbox", claimedInPayload: "Production" }),
    "sandbox",
  );
});

Deno.test("US-2286 apple: unknown or missing environment is NOT production", () => {
  assertEquals(resolveAppleEnvironment({ verifiedBy: null }), "sandbox");
  assertEquals(resolveAppleEnvironment({ verifiedBy: undefined }), "sandbox");
  assertEquals(resolveAppleEnvironment({ verifiedBy: "" }), "sandbox");
  assertEquals(resolveAppleEnvironment({ verifiedBy: "Xcode" }), "sandbox");
});

// ── Apple: the marker reaches the users row ─────────────────────────

function appleTxn(over: Partial<DecodedTransactionLite> = {}): DecodedTransactionLite {
  return {
    productId: "flipdesk_pro_monthly",
    originalTransactionId: "orig-1",
    transactionId: "txn-1",
    expiresDate: NOW + 86_400_000,
    ...over,
  };
}

Deno.test("US-2286 apple: a sandbox transaction lands marked on the users row", () => {
  const update = computeUserUpdate({
    mapping: { kind: "subscription", plan: "pro", interval: "monthly" },
    txn: appleTxn({ verifiedEnvironment: "sandbox" }),
    action: "sub_active",
    now: NOW,
  });
  // Still ENTITLED — this is the App Review path and it must keep working.
  assertEquals(update.subscription_status, "active");
  assertEquals(update.flipdesk_plan, "pro");
  // ...and marked, which is the whole fix.
  assertEquals(update.billing_environment, "sandbox");
  assertEquals(countsAsRevenue(update.billing_environment), false);
});

Deno.test("US-2286 apple: a production transaction is marked production and counts", () => {
  const update = computeUserUpdate({
    mapping: { kind: "subscription", plan: "pro", interval: "monthly" },
    txn: appleTxn({ verifiedEnvironment: "production" }),
    action: "sub_active",
    now: NOW,
  });
  assertEquals(update.billing_environment, "production");
  assertEquals(countsAsRevenue(update.billing_environment), true);
});

Deno.test("US-2286 apple: an UNMARKED transaction defaults to sandbox, not production", () => {
  // The fail-closed direction at the reconciler. A transaction that reached the
  // pure layer without the verify boundary stamping it is one we cannot vouch
  // for, and "cannot vouch for" must not silently become revenue.
  const update = computeUserUpdate({
    mapping: { kind: "subscription", plan: "pro", interval: "monthly" },
    txn: appleTxn(),
    action: "sub_active",
    now: NOW,
  });
  assertEquals(update.billing_environment, "sandbox");
});

Deno.test("US-2286 apple: the BUYER family is marked too", () => {
  // The seller and buyer entitlements are separate column sets. A marker on
  // only one of them leaves the other exactly as unaccountable as before.
  const update = computeBuyerUserUpdate({
    mapping: { kind: "buyer_subscription", plan: "guard", interval: "monthly" },
    txn: appleTxn({ verifiedEnvironment: "sandbox" }),
    action: "sub_active",
    now: NOW,
  });
  assertEquals(update.buyer_billing_environment, "sandbox");
});

// ── Google Play: the test-purchase signal ───────────────────────────

Deno.test("US-2286 play: subscriptionsv2 testPurchase marks sandbox", () => {
  // The field is an EMPTY OBJECT when present; its presence is the signal, so
  // a truthiness check on its contents would miss every test purchase.
  const info = parseSubscriptionV2({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    testPurchase: {},
    lineItems: [{ productId: "flipdesk_pro_monthly", expiryTime: "2026-02-01T00:00:00Z" }],
  });
  assertEquals(info.valid, true);
  assertEquals(info.environment, "sandbox");
});

Deno.test("US-2286 play: an ordinary subscription has no testPurchase key and is production", () => {
  const info = parseSubscriptionV2({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    lineItems: [{ productId: "flipdesk_pro_monthly", expiryTime: "2026-02-01T00:00:00Z" }],
  });
  assertEquals(info.environment, "production");
});

Deno.test("US-2286 play: products purchaseType 0 is a test purchase", () => {
  assertEquals(parseProductPurchase({ purchaseState: 0, purchaseType: 0 }).environment, "sandbox");
});

Deno.test("US-2286 play: purchaseType absent means an ordinary paid purchase", () => {
  assertEquals(parseProductPurchase({ purchaseState: 0 }).environment, "production");
});

Deno.test("US-2286 play: Promo and Rewarded are NOT sandbox", () => {
  // purchaseType 1 = Promo, 2 = Rewarded. Both are genuinely-granted production
  // entitlements that simply were not paid for in cash. Classing them as
  // sandbox would hide promo redemptions from the reporting this exists to make
  // honest — "free" and "not real" are different claims.
  assertEquals(parseProductPurchase({ purchaseState: 0, purchaseType: 1 }).environment, "production");
  assertEquals(parseProductPurchase({ purchaseState: 0, purchaseType: 2 }).environment, "production");
});

Deno.test("US-2286 play: resolvePlayEnvironment ignores an absent field, not a zero", () => {
  // Guards the `?? null` / `!== undefined` boundary: purchaseType 0 is FALSY,
  // so any implementation that tested truthiness would call a test purchase
  // ordinary — the exact bug, inverted.
  assertEquals(resolvePlayEnvironment({}), "production");
  assertEquals(resolvePlayEnvironment({ purchaseType: 0 }), "sandbox");
  assertEquals(resolvePlayEnvironment({ purchaseType: null }), "production");
  assertEquals(resolvePlayEnvironment({ testPurchase: {} }), "sandbox");
  assertEquals(resolvePlayEnvironment({ testPurchase: undefined }), "production");
});

Deno.test("US-2286 play: the marker reaches the users-row update", () => {
  const update = computeGoogleUserUpdate({
    mapping: { kind: "subscription", plan: "pro", interval: "monthly" },
    productId: "flipdesk_pro_monthly",
    purchaseToken: "tok",
    expiryMillis: NOW + 86_400_000,
    autoRenewing: true,
    now: NOW,
    environment: "sandbox",
  });
  assertEquals(update.subscription_status, "active");
  assertEquals(update.billing_environment, "sandbox");
});

Deno.test("US-2286 play: an omitted environment defaults to sandbox", () => {
  const update = computeGoogleUserUpdate({
    mapping: { kind: "subscription", plan: "pro", interval: "monthly" },
    productId: "flipdesk_pro_monthly",
    purchaseToken: "tok",
    expiryMillis: NOW + 86_400_000,
    autoRenewing: true,
    now: NOW,
  });
  assertEquals(update.billing_environment, "sandbox");
});

// ── The revenue predicate ───────────────────────────────────────────

Deno.test("US-2286: NULL counts as revenue — the pre-marker past is not zeroed", () => {
  // Three states, not two. Every grant that predates the column is NULL, and
  // the overwhelming majority of them are real paid subscriptions. Treating
  // NULL as not-revenue would silently zero historical MRR the first time a
  // revenue query used this predicate. The sandbox grants hiding in that
  // history are found by the AC5 prod audit, not guessed at here.
  assertEquals(countsAsRevenue(null), true);
  assertEquals(countsAsRevenue(undefined), true);
  assertEquals(countsAsRevenue("production"), true);
  assertEquals(countsAsRevenue("sandbox"), false);
});
