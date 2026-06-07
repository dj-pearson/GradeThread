// Pure subscription reconciler + consumable grant extraction.

import { assertEquals } from "@std/assert";
import { computeUserUpdate } from "../lib/appstore/reconcile.ts";
import { computeConsumableGrant } from "../lib/appstore/grant-decision.ts";
import type { DecodedTransactionLite } from "../lib/appstore/types.ts";

const NOW = 1_700_000_000_000; // epoch ms
const FUTURE = NOW + 30 * 24 * 60 * 60 * 1000;
const PAST = NOW - 24 * 60 * 60 * 1000;

const proMonthly = { kind: "subscription", plan: "pro", interval: "monthly" } as const;

function txn(overrides: Partial<DecodedTransactionLite> = {}): DecodedTransactionLite {
  return {
    productId: "com.gradethread.sub.pro.monthly",
    originalTransactionId: "orig-1",
    transactionId: "txn-1",
    expiresDate: FUTURE,
    ...overrides,
  };
}

Deno.test("active subscription entitles the plan", () => {
  const u = computeUserUpdate({ mapping: proMonthly, txn: txn(), action: "sub_active", now: NOW });
  assertEquals(u.flipdesk_plan, "pro");
  assertEquals(u.flipdesk_interval, "monthly");
  assertEquals(u.subscription_status, "active");
  assertEquals(u.flipdesk_cancel_at_period_end, false);
  assertEquals(u.billing_source, "appstore");
  assertEquals(u.appstore_original_transaction_id, "orig-1");
  assertEquals(u.flipdesk_period_end, new Date(FUTURE).toISOString());
});

Deno.test("autoRenewStatus 0 marks cancel-at-period-end", () => {
  const u = computeUserUpdate({
    mapping: proMonthly,
    txn: txn(),
    renewal: { autoRenewStatus: 0 },
    action: "sub_active",
    now: NOW,
  });
  assertEquals(u.flipdesk_cancel_at_period_end, true);
  assertEquals(u.subscription_status, "active");
});

Deno.test("sub_renew_off keeps entitlement but flags cancellation", () => {
  const u = computeUserUpdate({ mapping: proMonthly, txn: txn(), action: "sub_renew_off", now: NOW });
  assertEquals(u.flipdesk_plan, "pro");
  assertEquals(u.subscription_status, "active");
  assertEquals(u.flipdesk_cancel_at_period_end, true);
});

Deno.test("EXPIRED action lapses to free/canceled", () => {
  const u = computeUserUpdate({ mapping: proMonthly, txn: txn(), action: "sub_expired", now: NOW });
  assertEquals(u.flipdesk_plan, "free");
  assertEquals(u.flipdesk_interval, null);
  assertEquals(u.subscription_status, "canceled");
  assertEquals(u.flipdesk_cancel_at_period_end, false);
});

Deno.test("a past expiresDate lapses even on a sub_active action", () => {
  const u = computeUserUpdate({
    mapping: proMonthly,
    txn: txn({ expiresDate: PAST }),
    action: "sub_active",
    now: NOW,
  });
  assertEquals(u.flipdesk_plan, "free");
  assertEquals(u.subscription_status, "canceled");
});

Deno.test("revoke drops entitlement now", () => {
  const u = computeUserUpdate({ mapping: proMonthly, txn: txn(), action: "revoke", now: NOW });
  assertEquals(u.flipdesk_plan, "free");
  assertEquals(u.subscription_status, "canceled");
});

Deno.test("computeConsumableGrant extracts credits + ids", () => {
  const grant = computeConsumableGrant(
    { productId: "com.gradethread.credits.25", originalTransactionId: "o9", transactionId: "t9" },
    { kind: "consumable", credits: 25 },
  );
  assertEquals(grant, {
    credits: 25,
    transactionId: "t9",
    originalTransactionId: "o9",
    productId: "com.gradethread.credits.25",
  });
});
