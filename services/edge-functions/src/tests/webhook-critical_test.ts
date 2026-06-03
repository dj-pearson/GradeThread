// US-397: money-moving Stripe events must be classified as CRITICAL so a
// handler failure releases the idempotency claim and returns 5xx (Stripe
// retries) instead of being swallowed as a 200. Non-money events ack 200.
// This pins the classification that drives that fork.

import { assert } from "@std/assert";
import { isCriticalEvent } from "../routes/webhooks.ts";

Deno.test("money-moving events are critical (retry on failure)", () => {
  for (
    const t of [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.payment_succeeded",
      "invoice.payment_failed",
      "checkout.session.completed",
      "charge.refunded",
      "charge.dispute.created",
    ]
  ) {
    assert(isCriticalEvent(t), `${t} must be critical`);
  }
});

Deno.test("non-money / unhandled events are not critical (ack 200)", () => {
  for (
    const t of [
      "customer.created",
      "payment_intent.succeeded",
      "invoice.upcoming",
      "some.future.event",
    ]
  ) {
    assert(!isCriticalEvent(t), `${t} must NOT be critical`);
  }
});
