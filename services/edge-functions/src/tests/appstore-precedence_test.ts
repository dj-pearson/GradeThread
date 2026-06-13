// Pure double-billing precedence.

import { assertEquals } from "@std/assert";
import {
  appstoreSubscriptionBlocksStripe,
  decideAppstorePrecedence,
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
