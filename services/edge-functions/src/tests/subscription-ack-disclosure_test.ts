// US-2122 — the post-purchase acknowledgement must disclose auto-renewal and
// how to cancel.
//
// WHY THIS IS TESTED AT ALL. Every assertion here is about EMAIL COPY, which is
// exactly the kind of thing a well-meaning tidy-up shortens. The email already
// stated plan, amount, frequency and a "Next charge" date — genuinely better
// than the purchase surfaces — and still failed the requirement, because a bare
// future date does not tell a person the charge repeats forever. The words
// auto-renew, recurring and automatically appeared nowhere, and the only CTA was
// a generic "Go to Billing".
//
// LEGAL CONTEXT (from the story, not legal advice, and NOT the reason to keep
// this): the FTC's 2024 Click-to-Cancel Negative Option Rule was vacated by the
// Eighth Circuit on 2025-07-08 and is not in force; a successor is in flux. So
// these assertions are not pinned to a live federal rule — they are pinned
// because telling someone the amount and date of a recurring charge, and how to
// stop it, is what an honest acknowledgement of a recurring charge contains.
// A future deregulation does not make a silent auto-renewal a good idea.
//
// Asserted against the rendered HTML rather than the source, so a refactor that
// moves the copy around still passes and a refactor that DROPS it fails.

import { assert } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const emailSrc = Deno.readTextFileSync(
  new URL("../lib/email.ts", import.meta.url),
);

/** The body of sendSubscriptionStartedEmail, isolated from its neighbours. */
function startedEmailBody(): string {
  const start = emailSrc.indexOf("export async function sendSubscriptionStartedEmail");
  assert(start > -1, "sendSubscriptionStartedEmail not found — renamed?");
  const end = emailSrc.indexOf("export async function", start + 10);
  return emailSrc.slice(start, end > -1 ? end : undefined);
}

const body = startedEmailBody();

Deno.test("US-2122 AC1: states that renewal is AUTOMATIC, in words", () => {
  assert(
    /renews automatically|automatically renew/i.test(body),
    "the acknowledgement must SAY the subscription renews automatically — a " +
      '"Next charge" date implies one future charge, not an indefinite series',
  );
  assert(
    /until you cancel/i.test(body),
    "must state the renewal continues UNTIL CANCELLED — otherwise a reader can " +
      "reasonably assume it lapses on its own",
  );
});

Deno.test("US-2122 AC2: links to the cancellation FLOW, not merely to Billing", () => {
  assert(
    body.includes("/dashboard/billing?cancel=1"),
    'must deep-link the cancellation flow. "Go to Billing" leaves the reader to ' +
      "find the control, which is the half of the requirement a date cannot cover " +
      "(src/pages/billing.tsx consumes ?cancel=1 and opens the dialog)",
  );
  assert(
    /cancel anytime|how to cancel|cancel your/i.test(body),
    "the link needs cancellation wording — a bare URL is not an instruction",
  );
});

Deno.test("US-2122: says what cancelling DOES, not just that it is possible", () => {
  // The common and costly misconception is that cancelling forfeits the period
  // already paid for, which pushes people to keep paying out of caution.
  assert(
    /until the end of the period|keeps your plan active|stops future charges/i.test(body),
    "must explain that cancelling stops FUTURE charges and preserves the " +
      "already-paid period",
  );
});

Deno.test("US-2122 AC3: amount, frequency and date all survive", () => {
  assert(body.includes("dollars(data.priceCents)"), "must state the amount");
  assert(
    /data\.interval === "yearly"/.test(body),
    "must state the billing frequency, and derive it rather than hardcoding",
  );
  assert(
    body.includes("formatDate(data.periodEnd)"),
    "must state the renewal date",
  );
});

Deno.test("US-2122: stays TRANSACTIONAL — a marketing opt-out must not drop it", () => {
  // The defect US-2120 fixed for the trial notice: routing a required
  // acknowledgement through the drip engine lets an opt-out, a suppression entry
  // or a frequency cap silently swallow it.
  assert(
    body.includes('category: "subscription_started"'),
    "must send under the transactional subscription_started category",
  );
  assert(
    !/sendDripStepEmail|dripStep|unsubscribe/i.test(body),
    "must not route through the drip/marketing engine, where an opt-out or " +
      "frequency cap can suppress it",
  );
});

Deno.test("US-2122 AC4: fires on trial conversion and in-place upgrade, not just .created", () => {
  const webhooks = Deno.readTextFileSync(
    new URL("../routes/webhooks.ts", import.meta.url),
  );
  // Both were real purchase paths that acknowledged nothing: each arrives as
  // subscription.UPDATED, never .created.
  assert(
    /const trialConverted =/.test(webhooks),
    "trial → paid conversion must be detected (arrives as .updated)",
  );
  assert(
    /const planChanged =/.test(webhooks),
    "in-place upgrade must be detected (also .updated; per US-2118 the click IS " +
      "the purchase, so this email is the only artifact confirming it)",
  );
  // Detection must come from a STATE TRANSITION — acknowledging every .updated
  // would spam users on renewals and payment-method changes.
  assert(
    /event\.type === "customer\.subscription\.updated" && \(trialConverted \|\| planChanged\)/
      .test(webhooks),
    "must gate on the transition, not on the event type alone",
  );
});
