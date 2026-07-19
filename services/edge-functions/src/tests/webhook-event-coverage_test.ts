// US-2128: the webhook default branch must mean KNOWN-IGNORED, not unexamined.
//
// Before this, one log line covered two very different facts: "we receive this
// and deliberately do nothing" and "we have never considered this". Collapsing
// them meant a newly-enabled Stripe feature could start firing a consequential
// event and read exactly like the routine noise beside it.
//
//   deno test --allow-env src/tests/webhook-event-coverage_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isIntentionallyIgnored, INTENTIONALLY_IGNORED_EVENT_LIST } = await import(
  "../routes/webhooks.ts"
);

Deno.test("the known-ignored list is populated", () => {
  assert(
    INTENTIONALLY_IGNORED_EVENT_LIST.length > 5,
    "an empty list would make every unhandled event 'unexpected' and re-create " +
      "the noise this replaced",
  );
});

Deno.test("events we deliberately drop are recognised as ignored", () => {
  for (const t of ["invoice.created", "payment_intent.succeeded", "customer.updated"]) {
    assertEquals(isIntentionallyIgnored(t), true, `${t} should be known-ignored`);
  }
});

// The whole point: something we have NOT considered must not look routine.
Deno.test("an unrecognised event is NOT treated as known-ignored", () => {
  for (
    const t of [
      "invoice.payment_action_required.v2",
      "customer.subscription.pending_update_applied",
      "some.future.stripe.event",
    ]
  ) {
    assertEquals(isIntentionallyIgnored(t), false, `${t} must surface as unexpected`);
  }
});

// The events that have their OWN stories must not be silently absorbed into
// "ignored" — they are ignored HERE, deliberately, because another surface owns
// them. Keeping them listed is what records that distinction.
Deno.test("story-owned events are on the list, not merely absent", () => {
  for (const t of ["invoice.upcoming", "customer.subscription.trial_will_end"]) {
    assertEquals(
      isIntentionallyIgnored(t),
      true,
      `${t} is owned by its own story — it must be an explicit decision here, ` +
        `not an unexamined gap`,
    );
  }
});

// A handled event must never ALSO be on the ignored list: that combination is
// contradictory and would mean someone added a handler without removing the
// entry, leaving the list lying about what happens.
Deno.test("handled events are not also listed as ignored", () => {
  for (
    const t of [
      "invoice.payment_succeeded",
      "invoice.payment_failed",
      "invoice.payment_action_required",
      "charge.refunded",
      "checkout.session.completed",
      "customer.subscription.deleted",
    ]
  ) {
    assertEquals(
      isIntentionallyIgnored(t),
      false,
      `${t} IS handled — listing it as ignored would make the list untrue`,
    );
  }
});
