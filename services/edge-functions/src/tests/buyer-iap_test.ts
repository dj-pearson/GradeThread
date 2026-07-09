// US-1804: buyer subscription IAP reconcilers (pure). App Store + Google Play
// verified buyer purchases must write ONLY the buyer_* columns so entitlement
// resolution treats them identically to a Stripe buyer sub.
import { assertEquals } from "@std/assert";
import { classifyProduct } from "../lib/appstore/products.ts";
import { computeBuyerUserUpdate } from "../lib/appstore/reconcile.ts";
import { classifyAndroidProduct, computeGoogleBuyerUserUpdate } from "../lib/google-play/products.ts";

const NOW = Date.UTC(2026, 0, 15, 0, 0, 0);
const FUTURE = Date.UTC(2026, 1, 15, 0, 0, 0);
const PAST = Date.UTC(2026, 0, 1, 0, 0, 0);

function txn(over: Record<string, unknown> = {}) {
  return {
    productId: "com.gradethread.buyer.guard.monthly",
    originalTransactionId: "orig-1",
    transactionId: "txn-1",
    expiresDate: FUTURE,
    ...over,
  } as never;
}

Deno.test("classifyProduct maps Apple buyer ids to buyer_subscription", () => {
  assertEquals(classifyProduct("com.gradethread.buyer.guard.monthly"), {
    kind: "buyer_subscription",
    plan: "guard",
    interval: "monthly",
  });
  assertEquals(classifyProduct("com.gradethread.buyer.connoisseur.yearly"), {
    kind: "buyer_subscription",
    plan: "connoisseur",
    interval: "yearly",
  });
  // Seller ids still classify as seller subscriptions (unchanged).
  assertEquals(classifyProduct("com.gradethread.sub.pro.monthly")?.kind, "subscription");
  assertEquals(classifyProduct("nope"), null);
});

Deno.test("Android buyer ids are NOT wired yet — classify returns null (clean reject)", () => {
  assertEquals(classifyAndroidProduct("buyer_guard_monthly"), null);
  assertEquals(classifyAndroidProduct("flipdesk_pro_monthly")?.kind, "subscription");
});

Deno.test("computeBuyerUserUpdate (Apple): active purchase writes buyer_* only", () => {
  const u = computeBuyerUserUpdate({
    mapping: { kind: "buyer_subscription", plan: "guard", interval: "monthly" },
    txn: txn(),
    action: "sub_active",
    now: NOW,
  });
  assertEquals(u.buyer_plan, "guard");
  assertEquals(u.buyer_interval, "monthly");
  assertEquals(u.buyer_subscription_status, "active");
  assertEquals(u.buyer_billing_source, "appstore");
  assertEquals(u.buyer_appstore_product_id, "com.gradethread.buyer.guard.monthly");
  // No flipdesk_* keys.
  assertEquals("flipdesk_plan" in u, false);
});

Deno.test("computeBuyerUserUpdate (Apple): expiry/revoke lapses to free", () => {
  const expired = computeBuyerUserUpdate({
    mapping: { kind: "buyer_subscription", plan: "connoisseur", interval: "yearly" },
    txn: txn({ expiresDate: PAST }),
    action: "sub_active",
    now: NOW,
  });
  assertEquals(expired.buyer_plan, "free");
  assertEquals(expired.buyer_subscription_status, "canceled");

  const revoked = computeBuyerUserUpdate({
    mapping: { kind: "buyer_subscription", plan: "guard", interval: "monthly" },
    txn: txn(),
    action: "revoke",
    now: NOW,
  });
  assertEquals(revoked.buyer_plan, "free");
});

Deno.test("computeGoogleBuyerUserUpdate: active + expired", () => {
  const active = computeGoogleBuyerUserUpdate({
    mapping: { kind: "buyer_subscription", plan: "guard", interval: "monthly" },
    productId: "buyer_guard_monthly",
    purchaseToken: "tok-1",
    expiryMillis: FUTURE,
    autoRenewing: true,
    now: NOW,
  });
  assertEquals(active.buyer_plan, "guard");
  assertEquals(active.buyer_subscription_status, "active");
  assertEquals(active.buyer_cancel_at_period_end, false);
  assertEquals(active.buyer_billing_source, "googleplay");

  const expired = computeGoogleBuyerUserUpdate({
    mapping: { kind: "buyer_subscription", plan: "guard", interval: "monthly" },
    productId: "buyer_guard_monthly",
    purchaseToken: "tok-1",
    expiryMillis: PAST,
    autoRenewing: false,
    now: NOW,
  });
  assertEquals(expired.buyer_plan, "free");
  assertEquals(expired.buyer_subscription_status, "canceled");
});
