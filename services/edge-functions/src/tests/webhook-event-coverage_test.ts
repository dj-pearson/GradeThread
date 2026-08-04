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

// An event deferred to another story must be an explicit DECISION on the list,
// not an unexamined gap — and when that story lands, it must GRADUATE off the
// list into a real handler.
//
// invoice.upcoming and customer.subscription.trial_will_end were both listed
// here pending US-2119; they are now handled, and the assertions covering them
// live in the US-2119 block below (which checks the opposite: that they are NOT
// ignored). This test caught that transition rather than letting the list keep
// claiming they were dropped — which is exactly what it is for.
Deno.test("deferred events are an explicit decision, not an unexamined gap", () => {
  // Everything on the list must carry a reason in the source beside it.
  const src = Deno.readTextFileSync(new URL("../routes/webhooks.ts", import.meta.url));
  const block = src.slice(
    src.indexOf("const INTENTIONALLY_IGNORED_EVENTS"),
    src.indexOf("export function isIntentionallyIgnored"),
  );
  // Counts LINE-START comments (group headers). Inline trailing comments on
  // individual entries are additional annotation and are not counted here.
  const commentLines = (block.match(/^\s*\/\//gm) ?? []).length;
  assert(
    commentLines >= 2,
    "the ignored list must stay annotated — an unexplained entry is the same " +
      "unexamined gap the list replaced",
  );
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

// ── US-2119: the advance renewal notice ─────────────────────────────
//
// The first contact a subscriber received about a renewal was the RECEIPT,
// sent after the money moved. Yearly price IDs exist for every paid tier and
// flow through the identical path — interval only changes a display string — so
// an annual subscriber was charged a full year's fee with no prior contact.

const { TRANSACTIONAL_CATEGORIES, resolveIsMarketing } = await import(
  "../lib/email-transport.ts"
);

Deno.test("US-2119: invoice.upcoming is HANDLED, not ignored", () => {
  assertEquals(
    isIntentionallyIgnored("invoice.upcoming"),
    false,
    "it was on the known-ignored list pending this story; now it has a handler " +
      "and must not be BOTH — that combination makes the list untrue",
  );
  assert(
    /case "invoice\.upcoming":/.test(WEBHOOKS_SRC),
    "invoice.upcoming must have a case in the switch",
  );
});

Deno.test("US-2119 AC4: trial_will_end is HANDLED, not ignored", () => {
  assertEquals(isIntentionallyIgnored("customer.subscription.trial_will_end"), false);
  assert(/case "customer\.subscription\.trial_will_end":/.test(WEBHOOKS_SRC));
});

// AC3. If this category is ever classified marketing, an opt-out silently drops
// the only advance warning of a charge — the exact defect, restored.
Deno.test("US-2119 AC3: the renewal reminder is TRANSACTIONAL and cannot be marketing", () => {
  assert(TRANSACTIONAL_CATEGORIES.has("subscription_renewal_reminder"));
  assertEquals(
    resolveIsMarketing({ category: "subscription_renewal_reminder", marketing: true }),
    false,
    "a known-transactional category must be force-classified transactional even " +
      "when marketing is explicitly requested",
  );
});

// A notice that cannot say WHEN is not a notice. Declining beats sending
// something uselessly vague.
Deno.test("US-2119: no billing date means no reminder is sent", () => {
  const handler = WEBHOOKS_SRC.slice(
    WEBHOOKS_SRC.indexOf("async function handleInvoiceUpcoming"),
    WEBHOOKS_SRC.indexOf("async function handleTrialWillEnd"),
  );
  assert(
    /typeof renewsAtSec !== "number"[\s\S]{0,40}return;/.test(handler),
    "the handler must return when it has no date to state",
  );
  assert(
    /amount_due/.test(handler) && /renewsAt/.test(handler),
    "the notice must carry BOTH the amount and the date — AC1 requires stating " +
      "what will be charged and when",
  );
});

// The two trial paths must stay disjoint or a Stripe-trial user gets two emails.
Deno.test("US-2119/US-2120: the two trial notices cannot both fire for one user", async () => {
  const cron = await Deno.readTextFile(
    new URL("../routes/jobs-trial-expiry.ts", import.meta.url),
  );
  assert(
    /\.is\("flipdesk_subscription_id", null\)/.test(cron),
    "the cron must exclude Stripe-managed subscriptions — trial_will_end covers " +
      "those, and without this filter both would fire for the same user",
  );
});

// ── US-2122 AC4: acknowledge EVERY purchase path ────────────────────
//
// The acknowledgement fired only on subscription.created with a non-trialing
// status, so two real purchase paths acknowledged nothing:
//
//   • TRIAL → PAID: the user adds a card during the trial and is charged for
//     the first time. That arrives as subscription.UPDATED (trialing → active),
//     never .created — the moment they most need a receipt was the one moment
//     they got none.
//   • IN-PLACE UPGRADE: also .updated, and per US-2118 the click IS the purchase
//     with no checkout page, so this email was the only possible artifact.
//
// Detected from a STATE TRANSITION, not the event type: subscription.updated
// also fires for renewals, cancel-at-period-end toggles and payment-method
// changes, so acknowledging every update would mail users about non-purchases.

Deno.test("US-2122: the acknowledgement is not gated on .created alone", () => {
  const handler = WEBHOOKS_SRC.slice(
    WEBHOOKS_SRC.indexOf("const wasTrialing"),
    WEBHOOKS_SRC.indexOf("const wasTrialing") + 900,
  );
  assert(
    /customer\.subscription\.updated/.test(handler),
    "an in-place upgrade and a trial conversion both arrive as .updated — " +
      "gating on .created alone is what made them silent",
  );
});

Deno.test("US-2122: a trial conversion and a plan change each qualify", () => {
  const handler = WEBHOOKS_SRC.slice(
    WEBHOOKS_SRC.indexOf("const wasTrialing"),
    WEBHOOKS_SRC.indexOf("const wasTrialing") + 900,
  );
  assert(/trialConverted/.test(handler), "trial → paid must acknowledge");
  assert(/planChanged/.test(handler), "an in-place upgrade must acknowledge");
});

// The guard against the opposite failure: mailing on every update.
Deno.test("US-2122: a bare .updated with no transition does NOT acknowledge", () => {
  const handler = WEBHOOKS_SRC.slice(
    WEBHOOKS_SRC.indexOf("const wasTrialing"),
    WEBHOOKS_SRC.indexOf("const wasTrialing") + 900,
  );
  // The .updated branch must be conditioned on a transition, never bare.
  assert(
    /customer\.subscription\.updated"\s*&&\s*\(trialConverted \|\| planChanged\)/.test(handler),
    "the .updated branch must require a transition — renewals, cancel toggles " +
      "and payment-method changes are all .updated and are NOT purchases",
  );
});

// ── US-2128 AC2: the async-payment tripwire, ENFORCED rather than described ──
//
// AC2 says "handle the async payment-method events BEFORE enabling any non-card
// payment method". The trigger has not fired — every checkout is created with
// payment_method_types: ["card"] — so the handlers are correctly NOT written:
// pre-building them for a payment method nobody has turned on is the speculative
// work that produced this codebase's dead modules.
//
// But "documented tripwire" was doing a lot of work. A previous pass recorded
// AC2 as satisfied because the async events are "gated at webhooks.ts:1105", and
// a fresh read shows that overstates it: `checkoutFundsSettled` (US-1929) stops
// `checkout.session.completed` GRANTING on unsettled funds, which is a different
// and genuinely important guarantee. It does not handle the async events and it
// does not stop anyone enabling a non-card method.
//
// What actually happens today if someone flips one on: the buyer pays by bank
// debit, `completed` fires with payment_status "processing", the funds gate
// correctly withholds entitlement — and then `async_payment_succeeded` arrives,
// matches no case, is not on the known-ignored list, and lands in the UNEXPECTED
// branch. So the customer has paid and received nothing, and the only trace is a
// metric someone has to be watching.
//
// This case turns that into a build failure at the exact moment AC2 names. It is
// green while checkouts stay card-only and goes red the instant they do not,
// which is the whole point: the deferral is safe only for as long as its
// precondition holds, and nothing was checking the precondition.
Deno.test("US-2128 AC2: async-payment handlers are required once checkout stops being card-only", () => {
  const payments = Deno.readTextFileSync(
    new URL("../routes/payments.ts", import.meta.url),
  );
  const webhooks = Deno.readTextFileSync(
    new URL("../routes/webhooks.ts", import.meta.url),
  );

  // Every checkout creation site, read from the source rather than assumed.
  const declared = [...payments.matchAll(/payment_method_types:\s*(\[[^\]]*\])/g)]
    .map((m) => m[1]!.replace(/\s+/g, ""));
  assert(
    declared.length > 0,
    "no payment_method_types found in payments.ts — either checkout moved, or " +
      "it now relies on Stripe defaults, and this guard has stopped watching " +
      "the thing it exists to watch",
  );

  const cardOnly = declared.every((d) => d === '["card"]');
  // `automatic_payment_methods` lets Stripe enable non-card methods from the
  // Dashboard, with no code change here at all — the quietest way to trip this.
  const automatic = /automatic_payment_methods/.test(payments);

  if (cardOnly && !automatic) return; // precondition holds; deferral stands.

  const handled = (t: string) =>
    webhooks.includes(`case "${t}"`) || isIntentionallyIgnored(t);
  const missing = [
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
  ].filter((t) => !handled(t));

  assertEquals(
    missing,
    [],
    "a non-card payment method is now reachable, so these events can fire. " +
      "Until they are handled, a customer whose bank debit SETTLES has paid " +
      "and receives nothing: the funds gate correctly withholds entitlement on " +
      "`completed`, and the event that should grant it falls through to the " +
      "unexpected branch. Handle them, or put them on the known-ignored list " +
      "with the reason.",
  );
});

Deno.test("US-2128 AC2: the funds gate that makes the deferral safe still exists", () => {
  // The deferral rests on TWO things, and this is the other one. If
  // checkoutFundsSettled stopped gating, an async method would grant
  // entitlement on UNSETTLED funds — money not yet received, service given.
  // That is worse than the missing handler and it is a silent change.
  const webhooks = Deno.readTextFileSync(
    new URL("../routes/webhooks.ts", import.meta.url),
  );
  assert(
    /export function checkoutFundsSettled/.test(webhooks),
    "checkoutFundsSettled is gone — entitlement no longer requires settled funds",
  );
  assert(
    /checkoutFundsSettled\(/.test(webhooks.slice(webhooks.indexOf("async function handleCheckoutCompleted"))),
    "handleCheckoutCompleted no longer calls the funds gate, so a future " +
      "non-card method would grant on money that has not arrived",
  );
});
