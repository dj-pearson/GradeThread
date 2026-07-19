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

// ── US-2011: money-critical webhook failures must PAGE, not just log ──
//
// recordWebhookDeadLetter was fixed to emit a critical ops event. But the
// story's own description named other captureException-only sites in
// webhooks.ts, and two of them are the same failure class by a different route:
//
//   • an unmappable subscription price DEMOTES A PAYING CUSTOMER to Free
//   • a failed duplicate-refund leaves a customer DOUBLE-CHARGED — its own log
//     line says "needs operator follow-up", and until now the only thing that
//     could bring an operator was Sentry, whose routing is unverified (US-2003)
//
// Source-asserted rather than behavioural: these sit inside webhook handlers
// that talk to Stripe and the service-role client with no injection seam, so
// driving them would need a live DB. The property that matters — "this path
// reaches the on-call fan-out at all" — is visible in the source.

const WEBHOOKS_SRC = await Deno.readTextFile(
  new URL("../routes/webhooks.ts", import.meta.url),
);

Deno.test("US-2011: a paying customer demoted by an unmappable price pages", () => {
  assert(
    /emitOpsEvent\(\s*"billing\.unmappable_price",\s*"critical"/.test(WEBHOOKS_SRC),
    "an unmappable price demotes a PAYING customer to Free — Sentry alone is not " +
      "enough when its routing is itself unverified",
  );
});

Deno.test("US-2011: a failed duplicate refund pages", () => {
  assert(
    /emitOpsEvent\(\s*"billing\.duplicate_refund_failed",\s*"critical"/.test(WEBHOOKS_SRC),
    "this state is a customer charged twice whose refund failed — the log line " +
      "already says 'needs operator follow-up', so something must actually fetch one",
  );
});

// Both sit on the webhook ACK path. Awaiting a slow alert sink would delay the
// 200 that stops Stripe retrying — which is the retry storm the dead-letter
// path exists to prevent, caused by the alert about it.
Deno.test("US-2011: those emits are fire-and-forget, never awaited", () => {
  for (const type of ["billing.unmappable_price", "billing.duplicate_refund_failed"]) {
    const at = WEBHOOKS_SRC.indexOf(`emitOpsEvent("${type}"`);
    assert(at > -1, `${type} emit not found`);
    const preceding = WEBHOOKS_SRC.slice(Math.max(0, at - 12), at);
    assert(
      preceding.includes("void "),
      `${type} must be fire-and-forget (void) — awaiting it on the ack path can ` +
        `delay the 200 and trigger the Stripe retries the alert is warning about`,
    );
  }
});
