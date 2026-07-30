// Pure double-billing precedence.

import { assertEquals } from "@std/assert";
import {
  appstoreLapseSkippedByStripe,
  appstoreSubscriptionActive,
  appstoreSubscriptionBlocksStripe,
  decideAppstorePrecedence,
  googleplaySubscriptionActive,
} from "../lib/appstore/precedence.ts";

Deno.test("consumables always proceed, even with an active Stripe sub", () => {
  assertEquals(
    decideAppstorePrecedence(
      { flipdesk_subscription_id: "sub_x", subscription_status: "active", billing_source: "stripe" },
      "consumable",
    ),
    "proceed",
  );
});

Deno.test("subscription blocked when an entitling Stripe sub exists", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assertEquals(
      decideAppstorePrecedence(
        { flipdesk_subscription_id: "sub_x", subscription_status: status, billing_source: "stripe" },
        "subscription",
      ),
      "block_active_stripe",
    );
  }
});

Deno.test("subscription proceeds when no entitling Stripe sub", () => {
  // No sub at all.
  assertEquals(decideAppstorePrecedence({}, "subscription"), "proceed");
  // Canceled Stripe sub.
  assertEquals(
    decideAppstorePrecedence(
      { flipdesk_subscription_id: "sub_x", subscription_status: "canceled", billing_source: "stripe" },
      "subscription",
    ),
    "proceed",
  );
  // Already on App Store (renewal re-verify shouldn't self-block).
  assertEquals(
    decideAppstorePrecedence(
      { flipdesk_subscription_id: null, subscription_status: "active", billing_source: "appstore" },
      "subscription",
    ),
    "proceed",
  );
});

// ── Reverse direction (US-807): web Stripe mutation blocked by App Store ──

Deno.test("Stripe subscribe/downgrade blocked by an entitling App Store sub", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assertEquals(
      appstoreSubscriptionBlocksStripe({
        billing_source: "appstore",
        subscription_status: status,
      }),
      true,
    );
  }
});

Deno.test("Stripe mutation proceeds when App Store sub is not entitling", () => {
  // Lapsed App Store subscription.
  assertEquals(
    appstoreSubscriptionBlocksStripe({
      billing_source: "appstore",
      subscription_status: "canceled",
    }),
    false,
  );
  // Stripe-billed user (the common case) — never blocked by this guard.
  for (const status of ["active", "trialing", "past_due"]) {
    assertEquals(
      appstoreSubscriptionBlocksStripe({ billing_source: "stripe", subscription_status: status }),
      false,
    );
  }
  // Free / never-subscribed user (no billing source).
  assertEquals(appstoreSubscriptionBlocksStripe({}), false);
  assertEquals(
    appstoreSubscriptionBlocksStripe({ billing_source: null, subscription_status: "active" }),
    false,
  );
});

// ── US-1640: a delayed Apple EXPIRED/REVOKE must skip lapse when Stripe is live ──

Deno.test("US-1640: delayed Apple lapse is skipped when a live Stripe sub exists", () => {
  const stripeUser = {
    flipdesk_subscription_id: "sub_x",
    subscription_status: "active",
    billing_source: "stripe",
  };
  // A lapsing notification (EXPIRED/REVOKE → canceled) must be a no-op.
  assertEquals(appstoreLapseSkippedByStripe(true, stripeUser), true);
  // A non-lapse (renewal / re-entitle) is never skipped by this guard.
  assertEquals(appstoreLapseSkippedByStripe(false, stripeUser), false);
});

Deno.test("US-1640: Apple lapse still applies for a genuine App Store user", () => {
  const appleUser = {
    flipdesk_subscription_id: null,
    subscription_status: "active",
    billing_source: "appstore",
  };
  // No Stripe sub → the lapse must proceed (not skipped).
  assertEquals(appstoreLapseSkippedByStripe(true, appleUser), false);
  // A canceled Stripe sub doesn't protect against a lapse either.
  assertEquals(
    appstoreLapseSkippedByStripe(true, {
      flipdesk_subscription_id: "sub_x",
      subscription_status: "canceled",
      billing_source: "stripe",
    }),
    false,
  );
});

// ── US-2126: Google Play joins the cross-processor precedence matrix ──
//
// The server side for Google Play is live, but billing_source='googleplay'
// appeared in neither precedence guard, so a Play subscriber could stack an App
// Store OR a Stripe subscription and be double-charged. These pin the two new
// pure predicates that the three purchase paths (App Store verify, Google Play
// verify, Stripe subscribe) now consult.

Deno.test("googleplaySubscriptionActive: true only for an entitling Play sub", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assertEquals(
      googleplaySubscriptionActive({ billing_source: "googleplay", subscription_status: status }),
      true,
    );
  }
  // Lapsed Play sub.
  assertEquals(
    googleplaySubscriptionActive({ billing_source: "googleplay", subscription_status: "canceled" }),
    false,
  );
  // Other processors are NOT Google Play.
  for (const src of ["stripe", "appstore", null]) {
    assertEquals(
      googleplaySubscriptionActive({ billing_source: src, subscription_status: "active" }),
      false,
    );
  }
  // Free / never-subscribed.
  assertEquals(googleplaySubscriptionActive({}), false);
});

Deno.test("appstoreSubscriptionActive mirrors the App Store block predicate", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    const u = { billing_source: "appstore", subscription_status: status };
    assertEquals(appstoreSubscriptionActive(u), true);
    // The public block name delegates to it — same answer, no drift.
    assertEquals(appstoreSubscriptionBlocksStripe(u), true);
  }
  // A Google Play sub is not an App Store sub, and vice versa — the two mobile
  // predicates never overlap, so the matrix has no double-block cell.
  assertEquals(
    appstoreSubscriptionActive({ billing_source: "googleplay", subscription_status: "active" }),
    false,
  );
  assertEquals(
    googleplaySubscriptionActive({ billing_source: "appstore", subscription_status: "active" }),
    false,
  );
});
