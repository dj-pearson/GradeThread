// Pure double-billing precedence.

import { assertEquals } from "@std/assert";
import { decideAppstorePrecedence } from "../lib/appstore/precedence.ts";

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
