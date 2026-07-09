// US-392 + US-396: Stripe → FlipDesk mapping must (1) never entitle an unpaid
// `incomplete` subscription, and (2) resolve the tier from explicit signals
// (metadata.plan / lookup_key) regardless of billing interval — never from an
// amount heuristic that mapped every yearly price to Business.
//
// Imports the pure mappers from webhooks.ts. No DB/Stripe calls are made; we
// hand the mappers minimal subscription shapes.

import { assertEquals } from "@std/assert";
import type Stripe from "stripe";

// webhooks.ts imports the service-role supabase client at load, so set dummy
// env BEFORE the dynamic import (same pattern as the other tests). This file
// previously leaned on ANOTHER test file having evaluated that module first —
// which broke the moment that file stopped importing it statically.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  mapSubscriptionStatus,
  mapSubscriptionToFlipdeskPlan,
  mapSubscriptionToBuyerPlan,
  subscriptionIsBuyer,
  invoiceIsBuyer,
} = await import("../routes/webhooks.ts");

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

// US-1799: buyer subscriptions share the customer with the seller sub, so the
// webhook must route by product/price. These guards make that safe.
Deno.test("mapSubscriptionToBuyerPlan resolves buyer tiers, fails closed", () => {
  assertEquals(mapSubscriptionToBuyerPlan(sub({ metadata: { plan: "guard" } })), "guard");
  assertEquals(mapSubscriptionToBuyerPlan(sub({ metadata: { plan: "connoisseur" } })), "connoisseur");
  assertEquals(mapSubscriptionToBuyerPlan(sub({ lookupKey: "buyer_guard_monthly" })), "guard");
  assertEquals(mapSubscriptionToBuyerPlan(sub({ lookupKey: "buyer_connoisseur_yearly" })), "connoisseur");
  // A seller price is NOT a buyer plan.
  assertEquals(mapSubscriptionToBuyerPlan(sub({ lookupKey: "flipdesk_pro_monthly" })), null);
  assertEquals(mapSubscriptionToBuyerPlan(sub({})), null);
});

Deno.test("subscriptionIsBuyer / mapSubscriptionToFlipdeskPlan never collide", () => {
  // A buyer sub (metadata.product=buyer) is recognized as buyer AND is NOT
  // mis-mapped to a seller plan — so the webhook branch fires and flipdesk_* is
  // untouched.
  const buyerSub = sub({ metadata: { product: "buyer", plan: "guard" }, lookupKey: "buyer_guard_monthly" });
  assertEquals(subscriptionIsBuyer(buyerSub), true);
  assertEquals(mapSubscriptionToFlipdeskPlan(buyerSub), null);

  // A portal-created buyer sub with NO metadata still routes by lookup_key.
  const portalBuyer = sub({ lookupKey: "buyer_connoisseur_monthly" });
  assertEquals(subscriptionIsBuyer(portalBuyer), true);

  // A seller sub is not buyer.
  assertEquals(subscriptionIsBuyer(sub({ metadata: { product: "flipdesk", plan: "pro" }, lookupKey: "flipdesk_pro_monthly" })), false);
  // Unmappable sub → not buyer (seller path fails closed to Free).
  assertEquals(subscriptionIsBuyer(sub({})), false);
});

Deno.test("invoiceIsBuyer routes invoices by line-item price key", () => {
  const invoice = (lookupKey: string | null): Stripe.Invoice =>
    ({ lines: { data: [{ price: { lookup_key: lookupKey } }] } }) as unknown as Stripe.Invoice;
  assertEquals(invoiceIsBuyer(invoice("buyer_guard_monthly")), true);
  assertEquals(invoiceIsBuyer(invoice("buyer_connoisseur_yearly")), true);
  assertEquals(invoiceIsBuyer(invoice("flipdesk_pro_monthly")), false);
  assertEquals(invoiceIsBuyer(invoice(null)), false);
  assertEquals(invoiceIsBuyer({ lines: { data: [] } } as unknown as Stripe.Invoice), false);
});
