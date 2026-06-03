// US-392 + US-396: Stripe → FlipDesk mapping must (1) never entitle an unpaid
// `incomplete` subscription, and (2) resolve the tier from explicit signals
// (metadata.plan / lookup_key) regardless of billing interval — never from an
// amount heuristic that mapped every yearly price to Business.
//
// Imports the pure mappers from webhooks.ts. No DB/Stripe calls are made; we
// hand the mappers minimal subscription shapes.

import { assertEquals } from "@std/assert";
import type Stripe from "stripe";
import {
  mapSubscriptionStatus,
  mapSubscriptionToFlipdeskPlan,
} from "../routes/webhooks.ts";

function sub(partial: {
  metadata?: Record<string, string>;
  lookupKey?: string;
  amount?: number;
  interval?: "month" | "year";
}): Stripe.Subscription {
  return {
    metadata: partial.metadata ?? {},
    items: {
      data: [
        {
          price: {
            id: "price_test",
            lookup_key: partial.lookupKey ?? null,
            unit_amount: partial.amount ?? null,
            recurring: { interval: partial.interval ?? "month" },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

Deno.test("incomplete subscriptions are NOT entitled (US-392)", () => {
  assertEquals(mapSubscriptionStatus("incomplete"), "none");
  // Unknown/future statuses fail closed to 'none', never 'active'.
  assertEquals(
    mapSubscriptionStatus("some_future_status" as Stripe.Subscription.Status),
    "none",
  );
  // Verified-paid + lifecycle states are unchanged.
  assertEquals(mapSubscriptionStatus("active"), "active");
  assertEquals(mapSubscriptionStatus("trialing"), "trialing");
  assertEquals(mapSubscriptionStatus("past_due"), "past_due");
  assertEquals(mapSubscriptionStatus("incomplete_expired"), "canceled");
});

Deno.test("plan mapping is interval-independent and fails closed (US-396)", () => {
  // metadata.plan wins regardless of amount/interval — a $590/yr Pro price
  // (59000¢) used to map to Business via the amount>=9900 heuristic.
  assertEquals(
    mapSubscriptionToFlipdeskPlan(
      sub({ metadata: { plan: "pro" }, amount: 59000, interval: "year" }),
    ),
    "pro",
  );
  // lookup_key resolves a yearly Starter price correctly.
  assertEquals(
    mapSubscriptionToFlipdeskPlan(
      sub({ lookupKey: "flipdesk_starter_yearly", amount: 28800, interval: "year" }),
    ),
    "starter",
  );
  // No metadata + no lookup_key → fail closed (null = no entitlement), even for
  // a large yearly amount that the old heuristic would have called Business.
  assertEquals(
    mapSubscriptionToFlipdeskPlan(sub({ amount: 99900, interval: "year" })),
    null,
  );
});
