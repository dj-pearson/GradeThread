import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { accrueSubscriptionCommission } from "../lib/affiliate-payout.ts";
import { deleteCertImages } from "../lib/cloudflare-purge.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import {
  claimWebhookEvent,
  failIfDbError,
  isTransientWebhookError,
  releaseWebhookEvent,
} from "../lib/webhook-idempotency.ts";
import {
  sendCreditPackPurchasedEmail,
  sendPaymentActionRequiredEmail,
  sendPaymentFailedEmail,
  sendRenewalReminderEmail,
  sendTrialExpiringEmail,
  sendSubscriptionCanceledEmail,
  sendSubscriptionPausedEmail,
  sendSubscriptionResumedEmail,
  sendSubscriptionStartedEmail,
  sendSubscriptionRenewalReceiptEmail,
} from "../lib/email.ts";
import { captureServer } from "../lib/posthog.ts";
import { emitEvent } from "../lib/user-events.ts";
import { recordMetric } from "../lib/observability.ts";
import { nextPastDueSince } from "../lib/grade-pricing.ts";
import { getPlanMatrix } from "../lib/pricing-config.ts";
import { isProduction } from "../lib/env.ts";
import { reconcileCustomerLink } from "../lib/stripe-customer.ts";
import { shouldClearPendingDowngrade } from "../lib/pending-downgrade.ts";
import { maybeQualifyReferral } from "../lib/referrals.ts";
import { getStripe } from "../lib/stripe-client.ts";
import { classifyPerGradeFlip } from "../lib/per-grade-flip.ts";
import { recordWebhookDeadLetter } from "../lib/webhook-dead-letter.ts";
import { captureException } from "../lib/observability.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";
import { recordAgreedTerms } from "../lib/agreed-terms.ts";
import { buyerEventType } from "../lib/billing-reconciliation.ts";
import { safeSendEmail, userDisplayName } from "../lib/email-helpers.ts";
import { notifyPlanDowngrade } from "../lib/plan-change-notify.ts";
import { applySesFeedback } from "../lib/email-suppression.ts";
import { type SnsMessage, verifySnsSignature } from "../lib/sns-verify.ts";
import { recordDripConversion } from "../lib/drip-conversion.ts";
import { consumeSubscriptionDiscount } from "../lib/rewards-tangible.ts";
import {
  paymentIntentIdOf,
  resolveChargeMetadata,
  resolveDisputeMetadata,
  type PaymentIntentMetadataFetcher,
} from "../lib/stripe-metadata.ts";

// Fire-and-forget email helper — webhook MUST NOT fail if email fails.
export const webhookRoutes = new Hono();

// ── Stripe webhook (US-206) ──────────────────────────────────────
//
// All billing-state mutations flow through this endpoint. Idempotency: the
// authoritative claim is claimWebhookEvent (processed_webhook_events, PK
// provider+event_id), made ONCE below before any side effect (US-390). A
// duplicate delivery is skipped; a claim-write failure fails CLOSED (500) so
// Stripe re-delivers. Money side effects are also individually idempotent on
// the Stripe object id (submission payment_status guard; grant_grade_credits
// dedupes on the payment_intent) as defense in depth.
//
// Handler-internal errors currently log + return 200 (a code bug won't be
// fixed by a Stripe retry); durable handler-failure retry is US-397.
// Signature failures DO return 400 so Stripe surfaces a real misconfiguration.
webhookRoutes.post("/stripe", async (c) => {
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!stripeSecretKey || !webhookSecret) {
    console.error("[Webhook] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not configured");
    return c.json({ error: "Webhook not configured" }, 503);
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-04-10", timeout: 20_000, maxNetworkRetries: 2 });

  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook] Signature verification failed: ${message}`);
    return c.json({ error: "Webhook signature verification failed" }, 400);
  }

  console.log(`[Webhook] ${event.type} (${event.id})`);

  // Test-mode guard: in production, NEVER apply entitlement/money side effects
  // from a Stripe TEST event. A lingering test-mode webhook endpoint (or a test
  // signing secret left in STRIPE_WEBHOOK_SECRET) can otherwise flip a real
  // user's plan and fire a "welcome to <plan>" email off a sandbox subscription
  // that does not exist under the live keys — which is exactly how a comped
  // Super Admin got silently reset to `starter`. Ack with 200 so Stripe's test
  // endpoint stops retrying, and record it so the stray endpoint is visible.
  if (isProduction() && event.livemode === false) {
    recordMetric("webhook.testmode_rejected", 1, { provider: "stripe", topic: event.type });
    console.warn(
      `[Webhook] rejected TEST-mode ${event.type} (${event.id}) in production — ignoring`,
    );
    return c.json({ received: true, ignored: "test_mode_in_production" });
  }

  // Idempotency: the SINGLE authoritative claim before any side effects run.
  // Stripe retries the same event.id for up to 72h, so dedup (not timestamp
  // rejection) is the correct replay defense. (US-277/US-390)
  //   • duplicate → skip (2xx).
  //   • error (claim couldn't be written) → FAIL CLOSED with 500 so Stripe
  //     re-delivers. Every Stripe event we handle moves money/entitlement, so
  //     processing without a durable claim risks a double-apply on the retry.
  const claim = await claimWebhookEvent("stripe", event.id, event.type);
  if (claim === "duplicate") {
    console.log(`[Webhook] duplicate ${event.type} (${event.id}) — skipping`);
    return c.json({ received: true, duplicate: true });
  }
  if (claim === "error") {
    // US-509: Stripe events move money/entitlement → fail CLOSED (500 so Stripe
    // re-delivers). Record the decision so a spike of claim-write failures is
    // visible rather than buried in a console line.
    recordMetric("webhook.fail_closed", 1, { provider: "stripe", topic: event.type });
    console.error(
      `[Webhook] idempotency claim failed for ${event.type} (${event.id}) — asking Stripe to retry`,
    );
    return c.json({ error: "Could not record event; please retry." }, 500);
  }

  try {
    await dispatchStripeEvent(event);
  } catch (err) {
    // US-397/US-772: classify the failure (transient vs code-bug), release the
    // claim + retry on transient, or durably dead-letter + 200 on a code bug.
    const decision = await handleWebhookDispatchError(err, event);
    if (decision.retry) {
      return c.json({ error: "Temporary error processing event; please retry." }, 500);
    }
    // dropped → fall through to 200 (the dead letter + alert are the record).
  }

  return c.json({ received: true });
});

// ── Amazon SES bounce/complaint feedback via SNS (US-1057) ───────────
//
// SES publishes bounce/complaint notifications to an SNS topic that posts here.
// A HARD bounce (bounceType=Permanent) or a complaint adds the recipient to the
// suppression list, which email.ts checks before every send (protecting SES
// sender reputation). The endpoint handles the SNS subscription handshake and
// the notification envelope (Message is a JSON string carrying the SES payload).
//
// Optional hardening: set SES_SNS_TOPIC_ARN to the feedback topic's ARN and only
// matching messages are honored (cheap defense against forged suppression posts;
// full SNS signature verification can layer on later). Always returns 2xx so SNS
// doesn't storm retries for a payload we deliberately ignore.
webhookRoutes.post("/ses", async (c) => {
  let envelope: Record<string, unknown>;
  try {
    envelope = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // If configured, reject envelopes that don't come from the expected topic.
  const expectedArn = Deno.env.get("SES_SNS_TOPIC_ARN")?.trim();
  if (expectedArn && envelope.TopicArn !== expectedArn) {
    console.warn(`[Webhook] SES/SNS message from unexpected TopicArn=${String(envelope.TopicArn ?? "?")}`);
    return c.json({ received: true, ignored: true });
  }

  // Signature verification (fail closed). This endpoint is unauthenticated and
  // acts on arbitrary recipient addresses, so a forged bounce/complaint would be
  // a deliverability DoS (suppress an arbitrary recipient). Mirrors the canonical
  // /api/email/ses-notifications receiver; verifying the SNS signature here also
  // makes the SubscribeURL fetch below safe (the URL is then AWS-attested).
  //
  // The skip flag is gated on !isProduction() so a stray
  // SES_SNS_SKIP_VERIFICATION=true in prod cannot turn this public endpoint into
  // a forgeable one. US-1641 added that gate to the sibling receiver in
  // email-sns.ts but not here, even though the comment above already claimed the
  // two mirrored each other — so this half stayed disableable in production.
  const skipVerify = !isProduction() &&
    Deno.env.get("SES_SNS_SKIP_VERIFICATION")?.trim() === "true";
  if (!skipVerify) {
    const valid = await verifySnsSignature(envelope as SnsMessage);
    if (!valid) {
      recordMetric("email.sns_signature_rejected", 1);
      console.warn(`[Webhook] Rejected SES/SNS message with invalid signature (type=${String(envelope.Type ?? "?")})`);
      return c.json({ error: "Invalid SNS signature" }, 403);
    }
  }

  const snsType =
    c.req.header("x-amz-sns-message-type") ?? (envelope.Type as string | undefined);

  // SNS subscription handshake: confirm the subscription by fetching SubscribeURL.
  // Safe to fetch directly only because the envelope signature was verified above.
  if (snsType === "SubscriptionConfirmation") {
    const subscribeUrl = envelope.SubscribeURL as string | undefined;
    if (subscribeUrl) {
      try {
        const res = await fetch(subscribeUrl);
        await res.body?.cancel();
      } catch (err) {
        captureException(err, { route: "webhook.ses.confirm" });
      }
    }
    return c.json({ received: true, confirmed: !!subscribeUrl });
  }

  if (snsType === "UnsubscribeConfirmation") {
    return c.json({ received: true });
  }

  // Notification: SES payload lives in the JSON-string `Message` field. Some
  // setups deliver the SES notification at the top level — fall back to that.
  let message: unknown = envelope.Message;
  if (typeof message === "string") {
    try {
      message = JSON.parse(message);
    } catch {
      message = undefined;
    }
  }

  let suppressed: string[] = [];
  try {
    suppressed = await applySesFeedback(message ?? envelope);
  } catch (err) {
    captureException(err, { route: "webhook.ses.feedback" });
  }
  if (suppressed.length > 0) {
    recordMetric("email.sns_suppressed", suppressed.length);
    console.log(`[Webhook] SES feedback suppressed ${suppressed.length} recipient(s)`);
  }
  return c.json({ received: true, suppressed: suppressed.length });
});

// The Stripe event → handler routing, extracted from the route so the unified
// dead-letter console (US-882) can re-dispatch a dropped event through the exact
// same handlers when an operator hits "retry". The handlers are individually
// idempotent on the Stripe object id (submission payment_status guard,
// grant_grade_credits dedupes on the payment_intent), so a replay can't
// double-apply — which is what makes a console retry safe without re-claiming
// the processed_webhook_events row. A handler throwing surfaces to the caller
// (the route's dispatch-error policy on the live path; a failed replay on the
// console path), never a swallowed error.
export async function dispatchStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await handleSubscriptionChange(event);
      break;

    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event);
      break;

    case "invoice.payment_succeeded":
      await handleInvoicePaymentSucceeded(event);
      break;

    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(event);
      break;

    case "checkout.session.completed":
      await handleCheckoutCompleted(event);
      break;

    case "charge.refunded":
      await handleChargeRefunded(event);
      break;

    case "charge.dispute.created":
      await handleChargeDisputeCreated(event);
      break;

    case "charge.dispute.closed":
      await handleChargeDisputeClosed(event);
      break;

    // US-2128: SCA / 3-D Secure. Stripe could not take the payment because the
    // bank wants the cardholder to authenticate. Nothing retries this on its
    // own — the customer must act — so dropping it into the default branch
    // meant the user saw an unexplained loss of service with no idea why or
    // what to do. That is the same end state as a failed payment, which we DO
    // notify on, reached by a path we were silent about.
    // US-2119: the ADVANCE renewal notice. Stripe fires invoice.upcoming ahead
    // of a renewal; before this it fell through to the default log-and-drop, so
    // the first contact about a charge was the receipt AFTER it.
    case "invoice.upcoming":
      await handleInvoiceUpcoming(event);
      break;

    // US-2119 AC4. NOTE these are DISJOINT populations, which is why both can
    // exist without double-sending: our signup trial has NO Stripe subscription
    // (handle_new_user grants it directly) and is covered by the trial-expiry
    // cron (US-2120), which filters flipdesk_subscription_id IS NULL. This event
    // only fires for a STRIPE-managed trial, i.e. someone who started a paid
    // subscription with a trial period — a user the cron deliberately skips.
    case "customer.subscription.trial_will_end":
      await handleTrialWillEnd(event);
      break;

    case "invoice.payment_action_required":
      await handleInvoicePaymentActionRequired(event);
      break;

    default:
      // US-2128: the default branch now means KNOWN-IGNORED, not unexamined.
      // Every Stripe event we receive and deliberately drop is listed in
      // INTENTIONALLY_IGNORED_EVENTS with a reason; anything NOT on that list
      // is logged as genuinely unexpected so a newly-enabled Stripe feature
      // (a new payment method, a new lifecycle event) surfaces instead of
      // disappearing into a log line nobody greps for.
      if (isIntentionallyIgnored(event.type)) {
        console.log(`[Webhook] Ignored (known): ${event.type}`);
      } else {
        console.warn(
          `[Webhook] UNEXPECTED event type: ${event.type} — not handled and not ` +
            `on the known-ignored list. If this is expected, add it to ` +
            `INTENTIONALLY_IGNORED_EVENTS with a reason.`,
        );
        recordMetric("webhook.unexpected_event", 1, { type: event.type });
      }
  }
}

// US-397 + US-772: the /stripe dispatcher's error policy, extracted so it can be
// unit-tested with injected fakes (the route always uses the real deps).
//
//   • TRANSIENT (a DB write blip, TransientWebhookError) → release the
//     idempotency claim so Stripe's retry re-processes (side effects are
//     idempotent on the object id, US-390); the caller returns 500.
//   • NON-TRANSIENT (a code bug a retry can't fix) → KEEP the claim so Stripe
//     doesn't storm a permanently-failing event, capture an alert, durably
//     DEAD-LETTER the event BEFORE returning, and the caller returns 200.
//
// The dead-letter write never throws (US-772), so the 200 path holds even when
// the durable write itself fails — only the error-tracker capture + console line
// remain in that case.
export interface WebhookDispatchDeps {
  release: (eventId: string) => Promise<void>;
  capture: (eventId: string, eventType: string) => void;
  deadLetter: (args: {
    eventId: string;
    eventType: string;
    payload: unknown;
    errorMessage: string;
  }) => Promise<void>;
}

const defaultDispatchDeps: WebhookDispatchDeps = {
  release: (eventId) => releaseWebhookEvent("stripe", eventId),
  capture: (eventId, eventType) => {
    void captureServer(eventId, "billing.webhook_dropped", {
      event_type: eventType,
      event_id: eventId,
    });
  },
  deadLetter: async ({ eventId, eventType, payload, errorMessage }) => {
    await recordWebhookDeadLetter({
      provider: "stripe",
      eventId,
      eventType,
      payload,
      errorMessage,
    });
  },
};

export async function handleWebhookDispatchError(
  err: unknown,
  event: Pick<Stripe.Event, "id" | "type" | "data">,
  deps: WebhookDispatchDeps = defaultDispatchDeps,
): Promise<{ retry: boolean }> {
  if (isTransientWebhookError(err)) {
    await deps.release(event.id);
    console.error(
      `[Webhook] transient failure on ${event.type} (${event.id}): ${err.message} — released claim, asking Stripe to retry`,
    );
    return { retry: true };
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[Webhook] DROPPED ${event.type} (${event.id}) — non-transient handler error: ${message}`,
  );
  deps.capture(event.id, event.type);
  // Durable dead-letter capture BEFORE the 200 so the dropped event can never
  // vanish with only a console line.
  await deps.deadLetter({
    eventId: event.id,
    eventType: event.type,
    payload: (event.data as { object?: unknown } | undefined)?.object ?? event,
    errorMessage: message,
  });
  return { retry: false };
}

// ── Subscription audit trail ─────────────────────────────────────
type FlipdeskPlan = "free" | "starter" | "pro" | "business";

// US-390: AUDIT-ONLY. The authoritative idempotency claim is now
// claimWebhookEvent (processed_webhook_events), called once at the top of the
// /stripe handler. recordEvent only writes the human-readable subscription
// audit trail (flipdesk_subscription_events). A duplicate stripe_event_id here
// is expected to be impossible (the claim already deduped) and is logged, not
// used to gate processing — it no longer returns a "should I proceed" boolean.
async function recordEvent(
  userId: string,
  eventType: string,
  stripeEventId: string,
  fromPlan: FlipdeskPlan | null,
  toPlan: FlipdeskPlan | null,
  rawPayload: Record<string, unknown>,
  // US-2117 AC3: monthly|yearly. Optional so the other four call sites (which
  // are not plan changes) need no argument.
  billingInterval?: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("flipdesk_subscription_events")
    .insert({
      user_id: userId,
      stripe_event_id: stripeEventId,
      event_type: eventType,
      billing_interval: billingInterval ?? null,
      from_plan: fromPlan,
      to_plan: toPlan,
      raw_payload: rawPayload,
    });

  if (error && error.code !== "23505") {
    console.error(`[Webhook] Failed to write audit row for ${stripeEventId}:`, error);
  }
}

// US-2453: buyer_subscription_status and buyer_cancel_at_period_end are here so
// applyBuyerSubscriptionChange can compare PRIOR state against the incoming
// subscription. The lifecycle emails are edge-triggered — "did they just become
// paid", "did cancellation just get scheduled" — and without the previous values
// the only alternative is to key off the event type, which US-2122 AC4 already
// showed is wrong: a trial conversion and an in-place upgrade both arrive as
// subscription.updated.
const USER_SELECT =
  "id, email, full_name, flipdesk_plan, stripe_customer_id, trial_ends_at, flipdesk_subscription_id, flipdesk_cancel_at_period_end, pending_flipdesk_plan, pending_flipdesk_interval, pending_schedule_id, pending_effective_at, flipdesk_pause_until, cancellation_reason, subscription_status, past_due_since, buyer_plan, buyer_subscription_id, buyer_subscription_status, buyer_cancel_at_period_end, buyer_past_due_since";

async function loadUserByCustomerId(customerId: string) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select(USER_SELECT)
    .eq("stripe_customer_id", customerId)
    .single();
  if (error || !data) {
    console.error(`[Webhook] No user for stripe_customer_id=${customerId}`);
    return null;
  }
  return data;
}

async function loadUserById(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select(USER_SELECT)
    .eq("id", userId)
    .single();
  if (error || !data) {
    console.error(`[Webhook] No user for id=${userId}`);
    return null;
  }
  return data;
}

// US-391: idempotently link a Stripe customer to a user and reconcile the
// "one user → multiple customers" case. Sets the id when unset; no-ops when it
// already matches; on a MISMATCH keeps the stored (canonical) id and ALERTS for
// manual reconciliation rather than silently flapping the link between
// duplicate customers (which would scatter the user's billing history).
async function linkStripeCustomer(userId: string, customerId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("stripe_customer_id")
    .eq("id", userId)
    .single();
  const current =
    (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null;

  switch (reconcileCustomerLink(current, customerId)) {
    case "noop":
      return;
    case "set":
      await supabaseAdmin
        .from("users")
        .update({ stripe_customer_id: customerId })
        .eq("id", userId)
        .is("stripe_customer_id", null);
      return;
    case "conflict":
      console.error(
        `[Webhook] user ${userId} maps to multiple Stripe customers: stored=${current} incoming=${customerId} — keeping stored`,
      );
      void captureServer(userId, "billing.multiple_stripe_customers", {
        stored_customer: current,
        incoming_customer: customerId,
      });
      return;
  }
}

// ── Subscription handlers ────────────────────────────────────────

async function handleSubscriptionChange(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const userIdFromMeta = sub.metadata?.user_id;

  // Prefer metadata user_id (set at checkout) — falls back to customer-id lookup
  // for legacy subs that predate metadata.
  let user = userIdFromMeta ? await loadUserById(userIdFromMeta) : null;
  if (!user) user = await loadUserByCustomerId(customerId);
  if (!user) return;

  // US-1799: a BUYER subscription rides on the same customer as the seller sub.
  // Resolve the product FIRST and, when it's the buyer product, write ONLY the
  // buyer_* columns and return — never touch flipdesk_* or run the seller-only
  // side effects (grade/AI resets, trial conversion, drip, downgrade schedule).
  if (subscriptionIsBuyer(sub)) {
    // US-2453: the event is passed so the lifecycle acknowledgements can tell a
    // purchase from a renewal. Everything else about this branch is unchanged.
    await applyBuyerSubscriptionChange(user, sub, customerId, event);
    return;
  }

  // US-396: fail closed on an unmappable price — grant NO paid caps (treat as
  // 'free') and alert so the missing metadata.plan / lookup_key gets fixed,
  // instead of silently mis-entitling via an amount heuristic.
  const resolvedPlan = mapSubscriptionToFlipdeskPlan(sub);
  if (!resolvedPlan) {
    const priceId = sub.items?.data?.[0]?.price?.id ?? "unknown";
    console.error(
      `[Webhook] Unmappable subscription price ${priceId} on sub ${sub.id} ` +
        `(no metadata.plan / lookup_key) — failing closed to Free, no entitlement`,
    );
    void captureServer(user.id, "billing.unmappable_price", {
      subscription_id: sub.id,
      price_id: priceId,
    });
    // US-2011: ALSO page. This demotes a PAYING customer to Free because a
    // price is missing its metadata — revenue loss and a support ticket in one
    // — and Sentry was the only signal, on routing that is itself unverified
    // (US-2003). Same reasoning as the dead-letter emit: fire-and-forget, since
    // this sits on the webhook's ack path and a slow alert sink must never
    // delay the 200 that stops Stripe retrying.
    void emitOpsEvent("billing.unmappable_price", "critical", {
      title: `Subscription price ${priceId} has no plan mapping — customer demoted to Free`,
      source: "webhook.unmappable_price",
      actorUserId: user.id,
      data: { subscription_id: sub.id, price_id: priceId, user_id: user.id },
    });
    // US-776: keep the Sentry alert so ops fixes the price metadata...
    captureException(
      new Error(`Unmappable subscription price ${priceId} on sub ${sub.id} — demoting to Free`),
      {
        level: "error",
        route: "webhook.unmappable_price",
        userId: user.id,
        tags: { subscription_id: sub.id, price_id: priceId },
      },
    );
    // ...AND tell the user, since a paid→Free demotion is otherwise silent. Only
    // when they WERE on a paid plan (no message if they were already Free).
    if (user.flipdesk_plan && user.flipdesk_plan !== "free") {
      void notifyPlanDowngrade({
        userId: user.id,
        email: user.email,
        userName: userDisplayName(user.email, user.full_name),
        fromPlan: user.flipdesk_plan.charAt(0).toUpperCase() + user.flipdesk_plan.slice(1),
      });
    }
  }
  const plan: FlipdeskPlan = resolvedPlan ?? "free";
  const interval = mapSubscriptionInterval(sub);
  // pause_collection pauses billing but leaves Stripe's status as "active", so
  // mapSubscriptionStatus(sub.status) would never report "paused". Derive it
  // from pause_collection directly so the UI's paused banner reflects reality.
  const status = sub.pause_collection
    ? "paused"
    : mapSubscriptionStatus(sub.status);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const pauseUntil = sub.pause_collection?.resumes_at
    ? new Date(sub.pause_collection.resumes_at * 1000).toISOString()
    : null;

  await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    plan,
    { subscription_id: sub.id, status: sub.status, plan, interval },
    // US-2117 AC3: the gap 00215's own comment recorded. from_plan/to_plan
    // alone cannot distinguish a monthly→yearly switch from a no-op, so a plan
    // change was ambiguous in the ledger.
    interval,
  );

  // US-2117 AC1: snapshot the agreed terms, immutably, at purchase.
  //
  // Price is otherwise resolved LIVE from a mutable pricing_plans row, so a
  // later price change silently rewrites what this user "agreed to". Written
  // here rather than at checkout because this handler sees the authoritative
  // subscription object (amount, interval and trial as Stripe actually applied
  // them) — checkout.session sees what was requested, which is not the same.
  //
  // Best-effort: a compliance record must never be the reason entitlement
  // fails. The insert is idempotent via uniq_subscription_agreements_stripe, so
  // a webhook redelivery cannot mint a second "agreement" for one purchase.
  await recordAgreedTerms(user.id, sub, plan);

  // If Stripe set trial_end on a new subscription, persist it (one trial ever).
  const trialEndsAtUpdate =
    sub.trial_end && !user.trial_ends_at
      ? new Date(sub.trial_end * 1000).toISOString()
      : undefined;

  // US-402: clear a pending downgrade based on the Stripe SCHEDULE lifecycle +
  // the resolved plan/interval — NOT a plan-string match. Stripe releases the
  // schedule (sub.schedule → null) once phase 2 activates; clearing on the
  // schedule being gone + the target reached fixes interval-only downgrades
  // (pro/monthly → pro/yearly, where the plan string never changes) and avoids
  // clearing prematurely when a schedule is merely attached.
  const incomingScheduleId = sub.schedule
    ? (typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id)
    : null;
  const pendingCleared = shouldClearPendingDowngrade(
    {
      pendingPlan: user.pending_flipdesk_plan,
      pendingInterval: user.pending_flipdesk_interval,
      pendingScheduleId: user.pending_schedule_id,
      pendingEffectiveAt: user.pending_effective_at,
    },
    plan,
    interval,
    incomingScheduleId,
  );

  // US-391: reconcile the customer link separately (set-if-null / alert-on-
  // mismatch) instead of blindly overwriting stripe_customer_id below, which
  // could silently repoint a user at a duplicate customer.
  await linkStripeCustomer(user.id, customerId);

  const { error } = await supabaseAdmin
    .from("users")
    .update({
      flipdesk_plan: plan,
      flipdesk_interval: interval,
      subscription_status: status,
      flipdesk_subscription_id: sub.id,
      // US-1618 / C5: stamp the processor. This handler only runs for Stripe
      // subscription events, so the user demonstrably bills via Stripe. Without
      // it, billing_source stayed null/appstore — so the Play "active Stripe"
      // double-billing gate never fired, and a former iOS subscriber who moved
      // to Stripe stayed flagged 'appstore' (409 on every plan change; the Apple
      // expiry sweep could force-lapse a paying Stripe customer).
      billing_source: "stripe",
      flipdesk_period_end: periodEnd,
      flipdesk_pause_until: pauseUntil,
      flipdesk_cancel_at_period_end: sub.cancel_at_period_end ?? false,
      // US-395: anchor/clear the dunning grace clock across this transition
      // (preserves the original anchor across retries; clears on recovery).
      past_due_since: nextPastDueSince(
        user.subscription_status,
        user.past_due_since,
        status,
      ),
      // US-216: a fresh subscription means the user came back — clear any churn
      // reason left over from a prior cancellation.
      // US-1070: also consume any referral free-month coupon now that it's been
      // applied to this newly-created subscription (one-time offer).
      // US-942: likewise consume any win-back drip incentive coupon (one-time).
      ...(event.type === "customer.subscription.created"
        ? {
            cancellation_reason: null,
            pending_referral_coupon: null,
            pending_drip_coupon: null,
            pending_drip_coupon_expires_at: null,
          }
        : {}),
      ...(trialEndsAtUpdate ? { trial_ends_at: trialEndsAtUpdate } : {}),
      ...(pendingCleared
        ? {
            pending_flipdesk_plan: null,
            pending_flipdesk_interval: null,
            pending_schedule_id: null,
            pending_effective_at: null,
          }
        : {}),
    })
    .eq("id", user.id);

  // US-397: a failed subscription-state transition is critical — throw so the
  // dispatcher releases the claim and Stripe retries (the update is idempotent).
  failIfDbError(error, `subscription update for user ${user.id}`);

  console.log(
    `[Webhook] User ${user.id} → plan=${plan} interval=${interval} status=${status}`,
  );

  // US-219: a trialing user just attached a real subscription → trial.converted.
  // The trial has no Stripe sub, so its creation is the conversion signal.
  if (
    event.type === "customer.subscription.created" &&
    user.subscription_status === "trialing"
  ) {
    void captureServer(user.id, "trial.converted", { to_plan: plan, interval });
  }

  // US-932: record subscription creation to the internal event stream (drip
  // trigger substrate) so a conversion exit-condition can fire off it. Emitted
  // for ALL subscription.created (trial conversion or fresh paid). Fire-and-forget.
  if (event.type === "customer.subscription.created") {
    void emitEvent(user.id, "subscription_created", { properties: { plan, interval } });
  }

  // US-1853: consume any milestone-earned subscription discount now that it has
  // ridden a real subscription. Same moment the referral and drip coupons are
  // cleared above, and for the same reason: consuming it at checkout-session
  // creation would burn the reward on a checkout the user abandoned. Best-effort
  // — a reward bookkeeping failure must never fail a billing webhook.
  if (event.type === "customer.subscription.created") {
    void consumeSubscriptionDiscount(user.id);
  }

  // US-937: attribute this conversion to the trial-conversion drip step/email
  // that drove it (first/last touch, days-to-convert, plan MRR), then exit the
  // enrollment — which pauses all remaining win-back/nurture. No-ops when the
  // user was never in the drip; idempotent on the enrollment so a duplicate
  // webhook never double-counts. Best-effort (analytics must not fail billing).
  // The 'Welcome to Pro' confirmation email is the subscription-started send above.
  if (event.type === "customer.subscription.created") {
    recordDripConversion({
      userId: user.id,
      stripeSubscriptionId: sub.id,
      mrrCents: subscriptionMrrCents(sub),
      convertedAtMs: Date.now(),
    }).catch((err) => {
      console.error(
        "[Webhook] drip conversion attribution failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  // Emails (best-effort, never fail the webhook).
  if (user.email) {
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    const name = userDisplayName(user.email, user.full_name);

    // First-time subscription → welcome-to-paid email (skip when the price was
    // unmappable — we didn't entitle a paid plan, so don't send a paid welcome).
    //
    // US-2122 AC4: this used to fire ONLY on `subscription.created` with a
    // non-trialing status — so two real purchase paths acknowledged nothing:
    //
    //   • TRIAL → PAID conversion. The user adds a card during the trial and is
    //     charged for the first time, and that arrives as subscription.UPDATED
    //     (trialing → active), never .created. The one moment they most need a
    //     receipt was the one moment they got none.
    //   • IN-PLACE UPGRADE. Also .updated, and per US-2118 the click IS the
    //     purchase with no checkout page — so this email was the only artifact
    //     that could have confirmed it, and it never sent.
    //
    // Both are detected from a STATE TRANSITION rather than the event type,
    // using the stored previous values the handler already loaded. That matters:
    // subscription.updated fires for many things (renewals, cancel-at-period-end
    // toggles, payment-method changes), so acknowledging every update would spam
    // a user on events that are not purchases at all.
    const wasTrialing = user.subscription_status === "trialing";
    const trialConverted = wasTrialing && status === "active";
    const planChanged = !!resolvedPlan && user.flipdesk_plan !== plan;
    const isNewPurchase =
      (event.type === "customer.subscription.created" && status !== "trialing") ||
      (event.type === "customer.subscription.updated" && (trialConverted || planChanged));

    if (isNewPurchase && resolvedPlan) {
      const priceCents = sub.items?.data?.[0]?.price?.unit_amount ?? 0;
      safeSendEmail(
        sendSubscriptionStartedEmail(user.email, {
          userName: name,
          plan: planLabel,
          interval,
          priceCents,
          periodEnd: periodEnd ?? new Date().toISOString(),
          product: "flipdesk",
        }),
        "subscription_started",
      );
    }

    // Cancel just got scheduled (transition false → true on an update).
    if (
      event.type === "customer.subscription.updated" &&
      sub.cancel_at_period_end &&
      !user.flipdesk_cancel_at_period_end
    ) {
      safeSendEmail(
        sendSubscriptionCanceledEmail(user.email, {
          userName: name,
          plan: planLabel,
          endsAt: periodEnd ?? new Date().toISOString(),
          product: "flipdesk",
        }),
        "subscription_canceled_scheduled",
      );
    }

    // Pause / resume. We use pause_collection, which fires
    // customer.subscription.updated (Stripe leaves status "active"), NOT the
    // dedicated .paused/.resumed events — so detect the transition by comparing
    // the newly-derived pauseUntil against the prior DB value. This is
    // edge-triggered: a later .updated while still paused finds pause_until
    // already set and won't re-send.
    if (pauseUntil && !user.flipdesk_pause_until) {
      safeSendEmail(
        sendSubscriptionPausedEmail(user.email, {
          userName: name,
          plan: planLabel,
          resumesAt: pauseUntil,
        }),
        "subscription_paused",
      );
    }
    if (!pauseUntil && user.flipdesk_pause_until) {
      // If the resume landed on/after the originally-scheduled date, treat it as
      // automatic; an earlier clear means the user hit "Resume now".
      const auto =
        new Date(user.flipdesk_pause_until).getTime() <= Date.now() + 60_000;
      safeSendEmail(
        sendSubscriptionResumedEmail(user.email, {
          userName: name,
          plan: planLabel,
          auto,
        }),
        "subscription_resumed",
      );
    }
  }
}

// US-1799: apply a buyer subscription lifecycle change. Writes ONLY the buyer_*
// column family (00402) so it can never collide with the seller sub on the
// shared customer. Fail-closed to Free on an unmappable buyer price.
async function applyBuyerSubscriptionChange(
  user: {
    id: string;
    email?: string | null;
    full_name?: string | null;
    buyer_plan?: string | null;
    // US-2453: PRIOR state, for the edge-triggered lifecycle emails below.
    buyer_subscription_status?: string | null;
    buyer_cancel_at_period_end?: boolean | null;
    /** US-2458 AC5: the prior dunning anchor, preserved across retries. */
    buyer_past_due_since?: string | null;
  },
  sub: Stripe.Subscription,
  customerId: string,
  event?: Stripe.Event,
) {
  const plan = mapSubscriptionToBuyerPlan(sub) ?? "free";
  const interval = mapSubscriptionInterval(sub);
  const status = sub.pause_collection ? "paused" : mapSubscriptionStatus(sub.status);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  // Reconcile the shared customer link (set-if-null / alert-on-mismatch).
  await linkStripeCustomer(user.id, customerId);

  const { error } = await supabaseAdmin
    .from("users")
    .update({
      buyer_plan: plan,
      buyer_interval: interval,
      buyer_subscription_status: status,
      buyer_subscription_id: sub.id,
      buyer_period_end: periodEnd,
      buyer_cancel_at_period_end: sub.cancel_at_period_end ?? false,
      // US-2458 AC5: the buyer dunning anchor. Same helper and same lifecycle
      // as the seller clock - set on the FIRST entry into past_due, preserved
      // across retries so it can actually elapse, cleared on recovery.
      //
      // Stamped HERE and nowhere else, on customer.subscription.updated, for
      // the reason the invoice handlers already record: writing buyer status
      // from an invoice event would make the stored state depend on Stripe's
      // delivery order. This column follows the status it anchors.
      buyer_past_due_since: nextPastDueSince(
        user.buyer_subscription_status ?? null,
        user.buyer_past_due_since ?? null,
        status,
      ),
      // US-1804: tag the processor so an IAP buyer sub and a Stripe one don't
      // collide, and the buyer IAP verify can refuse to double-bill.
      buyer_billing_source: "stripe",
    })
    .eq("id", user.id);
  failIfDbError(error, `buyer subscription update for user ${user.id}`);

  // US-2117 AC1: buyer subscribers get an agreement row too.
  //
  // This handler RETURNS before the seller path's recordAgreedTerms call, so
  // until now a Guard/Connoisseur subscriber had no record of what they agreed
  // to while a FlipDesk subscriber did — two paying populations with different
  // evidentiary standing for the same question, which is the exact asymmetry
  // US-2116 AC6 closed for App Store and Play purchases.
  //
  // SKIPPED WHEN THE PLAN IS "free": that value is the ?? fallback for a price
  // this build cannot map, so the row would be both meaningless (nobody agrees
  // to a free plan at checkout) and ambiguous — subscription_agreements.plan is
  // free text with no product column, so a buyer "free" and a seller "free" are
  // indistinguishable on the record. guard/connoisseur cannot collide with
  // starter/pro/business, so the named plans are safe to write as they are.
  if (plan !== "free") {
    await recordAgreedTerms(user.id, sub, plan);
  }

  // US-2453: the lifecycle acknowledgements. Every one of these lived below the
  // `return` in handleSubscriptionChange, so a buyer's first purchase produced
  // nothing from us and cancelling produced no confirmation of what was
  // cancelled or when access ends.
  //
  // Edge-triggered from the PRIOR row, not from the event type. That is
  // US-2122 AC4's lesson repeated for the buyer product: a trial conversion and
  // an in-place plan change both arrive as subscription.updated, so keying off
  // `.created` misses the two moments a purchase most needs acknowledging —
  // while acknowledging every `.updated` would mail someone on renewals and
  // cancel-toggle changes that are not purchases at all.
  //
  // NO PAUSE / RESUME EMAILS, deliberately. Those two are keyed on
  // flipdesk_pause_until, a seller column; there is no buyer_pause_until, no
  // buyer pause UI, and mapSubscriptionStatus only ever reports "paused" for a
  // buyer if someone paused collection in the Stripe dashboard by hand. An
  // email about a state a buyer cannot enter through the product is worse than
  // no email. buyer-lifecycle-emails_test.ts pins this absence so it reads as a
  // decision rather than another oversight.
  if (user.email && plan !== "free") {
    const name = userDisplayName(user.email, user.full_name ?? null);
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

    const wasTrialing = user.buyer_subscription_status === "trialing";
    const trialConverted = wasTrialing && status === "active";
    const planChanged = (user.buyer_plan ?? "free") !== plan;
    const isNewPurchase =
      (event?.type === "customer.subscription.created" && status !== "trialing") ||
      (event?.type === "customer.subscription.updated" && (trialConverted || planChanged));

    if (isNewPurchase) {
      safeSendEmail(
        sendSubscriptionStartedEmail(user.email, {
          userName: name,
          plan: planLabel,
          interval,
          priceCents: sub.items?.data?.[0]?.price?.unit_amount ?? 0,
          periodEnd: periodEnd ?? new Date().toISOString(),
          product: "buyer",
        }),
        "subscription_started",
      );
    }

    // Cancellation just scheduled: false → true on an update. Edge-triggered,
    // so a later update while still cancelling does not re-send.
    if (
      event?.type === "customer.subscription.updated" &&
      sub.cancel_at_period_end &&
      !user.buyer_cancel_at_period_end
    ) {
      safeSendEmail(
        sendSubscriptionCanceledEmail(user.email, {
          userName: name,
          plan: planLabel,
          endsAt: periodEnd ?? new Date().toISOString(),
          product: "buyer",
        }),
        "subscription_canceled_scheduled",
      );
    }
  }

  console.log(`[Webhook] User ${user.id} BUYER → plan=${plan} interval=${interval} status=${status}`);
}

async function handleSubscriptionDeleted(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const user = await loadUserByCustomerId(customerId);
  if (!user) return;

  // US-1799: a buyer-sub deletion must reset ONLY the buyer_* columns — never
  // free the seller plan on the shared customer.
  if (subscriptionIsBuyer(sub)) {
    // US-2453: this branch returned before recordEvent, so a buyer's FINAL
    // cancellation left no audit row while the seller path wrote one — the same
    // asymmetry, on the one event that ends a paid relationship. No email: the
    // seller path sends none here either, because the confirmation was already
    // sent when the cancellation was scheduled.
    await recordEvent(
      user.id,
      // US-2457: namespaced, or the reconciler reads a buyer cancellation as a
      // seller one and flags a healthy FlipDesk account for a destructive resync.
      buyerEventType(event.type),
      event.id,
      // Typed public.flipdesk_plan; the buyer tier rides in the payload.
      user.flipdesk_plan,
      user.flipdesk_plan,
      {
        subscription_id: sub.id,
        product: "buyer",
        from_buyer_plan: (user as { buyer_plan?: string | null }).buyer_plan ?? null,
        to_buyer_plan: "free",
      },
    );
    const { error: buyerErr } = await supabaseAdmin
      .from("users")
      .update({
        buyer_plan: "free",
        buyer_interval: null,
        buyer_subscription_status: "canceled",
        buyer_subscription_id: null,
        buyer_period_end: null,
        buyer_cancel_at_period_end: false,
      })
      .eq("id", user.id);
    failIfDbError(buyerErr, `buyer downgrade for user ${user.id}`);
    console.log(`[Webhook] User ${user.id} BUYER → free (canceled)`);
    return;
  }

  await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    "free",
    { subscription_id: sub.id },
  );

  const { error } = await supabaseAdmin
    .from("users")
    .update({
      flipdesk_plan: "free",
      flipdesk_interval: null,
      subscription_status: "canceled",
      flipdesk_subscription_id: null,
      flipdesk_period_end: null,
      flipdesk_pause_until: null,
      flipdesk_cancel_at_period_end: false,
    })
    .eq("id", user.id);

  // US-397: critical downgrade transition — retry on a transient DB failure.
  failIfDbError(error, `downgrade for user ${user.id}`);

  // Credit balance intentionally untouched (US-200 / US-216).
  console.log(`[Webhook] User ${user.id} → free (canceled)`);

  // US-216: subscription actually terminated (period end reached). Fire the
  // server-side analytics event with the reason captured at cancel time.
  void captureServer(user.id, "subscription.ended", {
    from_plan: user.flipdesk_plan,
    reason: user.cancellation_reason ?? null,
  });
}

// ── Invoice handlers ─────────────────────────────────────────────

/**
 * US-2451: the buyer half of the renewal receipt.
 *
 * Deliberately its OWN function rather than a branch inside
 * handleInvoicePaymentSucceeded. That handler's buyer skip protects the seller
 * cycle resets — grade and AI counters, subscription_status — which must not
 * fire for a buyer invoice, and the receipt was simply sitting inside the
 * protected region. Widening the skip to let the receipt through would have
 * meant threading `isBuyer` past every reset below it, and one missed branch
 * there resets a seller's quota on a buyer's renewal.
 *
 * Sends only for `subscription_cycle`. The FIRST charge is covered by the
 * subscription-started path, exactly as on the seller side, so receipting a
 * `subscription_create` here would double up on signup.
 */
async function sendBuyerRenewalReceipt(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  customerId: string,
) {
  if (invoice.billing_reason !== "subscription_cycle") return;

  const user = await loadUserByCustomerId(customerId);
  if (!user?.email) return;

  // A lapsed buyer has nothing to receipt, and naming "Free" on a charge
  // confirmation is worse than sending nothing.
  const buyerPlan = (user as { buyer_plan?: string | null }).buyer_plan ?? "free";
  if (buyerPlan === "free") return;

  const interval = invoice.lines?.data?.[0]?.price?.recurring?.interval === "year"
    ? "yearly"
    : "monthly";

  // Recorded for the same reason the advance notice is: a buyer renewal left no
  // trace in the subscription event log at all, and an audit gap is what kept
  // this whole class of buyer-only omission invisible. Plan columns stay the
  // user's real flipdesk_plan — they are typed public.flipdesk_plan and a buyer
  // tier raises 22P02 — with the buyer detail in the jsonb payload.
  //
  // US-2457: namespaced. invoice.payment_succeeded derives to {active, toPlan},
  // so an un-namespaced buyer renewal would assert a live FlipDesk plan for
  // someone who may hold none.
  await recordEvent(
    user.id,
    buyerEventType(event.type),
    event.id,
    user.flipdesk_plan,
    user.flipdesk_plan,
    {
      invoice_id: invoice.id,
      billing_reason: invoice.billing_reason,
      product: "buyer",
      buyer_plan: buyerPlan,
    },
  );

  void sendSubscriptionRenewalReceiptEmail(user.email, {
    userName: user.full_name?.trim() || "there",
    plan: buyerPlan.charAt(0).toUpperCase() + buyerPlan.slice(1),
    interval,
    amountCents: invoice.amount_paid ?? 0,
    periodEnd: invoice.period_end
      ? new Date(invoice.period_end * 1000).toISOString()
      : new Date().toISOString(),
    invoiceNumber: invoice.number ?? null,
    product: "buyer",
  });
}

/**
 * US-2452: tell a buyer their payment is in trouble.
 *
 * One function for both problems because they share everything except the
 * template: the same lookup, the same lapsed-plan guard, the same audit row,
 * and — the part that matters — the same rule that NOTHING here may touch the
 * buyer's status. `buyer_subscription_status` and the US-395 dunning clock are
 * owned by customer.subscription.updated; writing them from an invoice event
 * would make the recorded state depend on Stripe's delivery order.
 *
 * The two templates stay separate, and that separation is deliberate upstream:
 * a declined card is fixed by updating a card, a bank challenge is fixed by the
 * cardholder answering it, and sending the wrong one points someone at a remedy
 * that will not work while the real one goes undone.
 */
async function sendBuyerBillingProblem(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  customerId: string,
  kind: "payment_failed" | "action_required",
) {
  const user = await loadUserByCustomerId(customerId);
  if (!user?.email) return;

  // A buyer already on free has no buyer subscription to save.
  const buyerPlan = (user as { buyer_plan?: string | null }).buyer_plan ?? "free";
  if (buyerPlan === "free") return;
  const planLabel = buyerPlan.charAt(0).toUpperCase() + buyerPlan.slice(1);

  await recordEvent(
    user.id,
    // US-2457: namespaced. This one was the sharpest — invoice.payment_failed
    // derives to {past_due, toPlan}, so an un-namespaced buyer row would put a
    // seller in good standing into the operator dunning queue.
    buyerEventType(event.type),
    event.id,
    // Typed public.flipdesk_plan, so a buyer tier cannot go here — the buyer
    // detail rides in the jsonb payload instead.
    user.flipdesk_plan,
    user.flipdesk_plan,
    {
      invoice_id: invoice.id,
      amount_due: invoice.amount_due,
      attempt_count: invoice.attempt_count,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
      product: "buyer",
      buyer_plan: buyerPlan,
    },
  );

  if (kind === "payment_failed") {
    safeSendEmail(
      sendPaymentFailedEmail(user.email, {
        userName: userDisplayName(user.email, user.full_name),
        plan: planLabel,
        amountCents: invoice.amount_due ?? 0,
        attemptCount: invoice.attempt_count ?? 1,
        retryAt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000).toISOString()
          : null,
        product: "buyer",
      }),
      "payment_failed",
    );
    return;
  }

  safeSendEmail(
    sendPaymentActionRequiredEmail(user.email, {
      userName: userDisplayName(user.email, user.full_name),
      plan: planLabel,
      amountCents: invoice.amount_due ?? 0,
      // Without the hosted page the email names a problem and offers no way to
      // fix it, which on this notice is the whole content.
      actionUrl: invoice.hosted_invoice_url ?? null,
      product: "buyer",
    }),
    "payment_action_required",
  );
}

async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer as Stripe.Customer | null)?.id;
  if (!customerId) return;

  const billingReason = invoice.billing_reason;

  // US-1799: a BUYER invoice must not trigger the seller cycle resets (grade/AI
  // counters) or flip the seller's subscription_status. Buyer status transitions
  // arrive via customer.subscription.updated (applyBuyerSubscriptionChange).
  //
  // US-2451: the RECEIPT was inside that skipped body, and nothing else sends
  // one — so a buyer was charged on renewal and heard nothing afterwards. The
  // send is lifted out ABOVE the skip rather than the skip being widened,
  // because everything below it genuinely must not run for a buyer invoice.
  if (invoiceIsBuyer(invoice)) {
    await sendBuyerRenewalReceipt(event, invoice, customerId);
    return;
  }

  const user = await loadUserByCustomerId(customerId);
  if (!user) return;

  await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    user.flipdesk_plan,
    { invoice_id: invoice.id, billing_reason: billingReason },
  );

  // On subscription create or renewal, reset the included-grades + AI counters
  // for the new billing cycle. Other invoice reasons (manual, upcoming, etc.)
  // don't reset.
  if (billingReason === "subscription_create" || billingReason === "subscription_cycle") {
    const now = new Date().toISOString();
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1);
    // US-885 (AC#5): snapshot the live included-grade cap for the new period so an
    // admin editing the plan's included count mid-cycle takes effect on the NEXT
    // reset, never retroactively. Best-effort — a read hiccup leaves it null and
    // the resolver falls back to the live cap.
    let includedSnapshot: number | null = null;
    try {
      const matrix = await getPlanMatrix();
      includedSnapshot =
        matrix[user.flipdesk_plan as keyof typeof matrix]?.includedStandardGradesPerMonth ?? null;
    } catch {
      includedSnapshot = null;
    }
    const { error } = await supabaseAdmin
      .from("users")
      .update({
        grades_used_this_month: 0,
        grade_reset_at: nextReset.toISOString(),
        included_grades_this_period: includedSnapshot,
        ai_actions_used_this_month: 0,
        ai_actions_reset_at: now,
        subscription_status: "active",
      })
      .eq("id", user.id);

    // US-397: a missed cycle reset would over/under-charge entitlement — retry.
    failIfDbError(error, `cycle reset for user ${user.id}`);
    console.log(`[Webhook] User ${user.id} cycle reset (${billingReason})`);

    // US-9212: a creator's share of this invoice. Best-effort and silent on
    // refusal -- the accrual must never be able to fail a billing webhook,
    // because a thrown error here would make Stripe redeliver the whole event
    // and re-run the cycle reset above it. The engine ships off and refuses
    // every account that is not an admitted creator, so the normal outcome is
    // a named skip and no row.
    try {
      const commission = await accrueSubscriptionCommission({
        referredUserId: user.id,
        invoiceId: invoice.id ?? `evt_${event.id}`,
        invoiceAmountCents: invoice.amount_paid ?? 0,
        paidAt: new Date((invoice.status_transitions?.paid_at ?? event.created) * 1000)
          .toISOString(),
      });
      if (commission.accrued) {
        console.log(
          `[Webhook] creator commission accrued ${commission.amount} cents on invoice ${invoice.id}`,
        );
      }
    } catch (err) {
      console.error("[Webhook] creator commission accrual threw:", err);
    }

    // US-222: send a receipt for each RECURRING renewal charge (the first charge
    // is covered by sendSubscriptionStartedEmail on subscription.created).
    // Best-effort — the email retry outbox (US-498/801) covers transient failures.
    if (billingReason === "subscription_cycle" && user.email) {
      const periodEndIso = invoice.period_end
        ? new Date(invoice.period_end * 1000).toISOString()
        : nextReset.toISOString();
      const interval =
        invoice.lines?.data?.[0]?.price?.recurring?.interval === "year"
          ? "yearly"
          : "monthly";
      void sendSubscriptionRenewalReceiptEmail(user.email, {
        userName: user.full_name?.trim() || "there",
        plan: user.flipdesk_plan ?? "Pro",
        interval,
        amountCents: invoice.amount_paid ?? 0,
        periodEnd: periodEndIso,
        invoiceNumber: invoice.number ?? null,
        product: "flipdesk",
      });
    }
  } else {
    // Any successful payment clears past_due → active (and the US-395 dunning
    // grace clock).
    const { error } = await supabaseAdmin
      .from("users")
      .update({ subscription_status: "active", past_due_since: null })
      .eq("id", user.id);
    failIfDbError(error, `past_due→active clear for user ${user.id}`);
  }
}

async function handleInvoicePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer as Stripe.Customer | null)?.id;
  if (!customerId) return;

  // US-1799: buyer past_due is carried by subscription.updated → skip the seller
  // dunning transition for a buyer invoice.
  //
  // US-2452: the EMAIL was inside that skipped body and nothing else sent one,
  // so a buyer's card was declined and they were never told — they simply went
  // past_due and then canceled. The send is lifted out ABOVE the skip; the
  // status write and the US-395 grace clock stay below it, because those are
  // owned by customer.subscription.updated for a buyer.
  if (invoiceIsBuyer(invoice)) {
    await sendBuyerBillingProblem(event, invoice, customerId, "payment_failed");
    return;
  }

  const user = await loadUserByCustomerId(customerId);
  if (!user) return;

  await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    user.flipdesk_plan,
    {
      invoice_id: invoice.id,
      amount_due: invoice.amount_due,
      attempt_count: invoice.attempt_count,
    },
  );

  const { error: pastDueErr } = await supabaseAdmin
    .from("users")
    .update({
      subscription_status: "past_due",
      // US-395: start the dunning grace clock on the FIRST failure; preserve it
      // across subsequent retry failures so it can actually elapse.
      past_due_since: nextPastDueSince(
        user.subscription_status,
        user.past_due_since,
        "past_due",
      ),
    })
    .eq("id", user.id);
  // US-397: a missed past_due transition would keep dunning entitlement — retry.
  failIfDbError(pastDueErr, `past_due transition for user ${user.id}`);

  console.log(
    `[Webhook] User ${user.id} → past_due (invoice ${invoice.id}, attempt ${invoice.attempt_count})`,
  );

  // Dunning email (US-218 + US-222). Stripe's Smart Retries drive the cadence;
  // we send on each failed attempt and rely on Stripe to schedule retries.
  if (user.email) {
    const planLabel = user.flipdesk_plan.charAt(0).toUpperCase() + user.flipdesk_plan.slice(1);
    const retryAt = invoice.next_payment_attempt
      ? new Date(invoice.next_payment_attempt * 1000).toISOString()
      : null;
    safeSendEmail(
      sendPaymentFailedEmail(user.email, {
        userName: userDisplayName(user.email, user.full_name),
        plan: planLabel,
        amountCents: invoice.amount_due ?? 0,
        attemptCount: invoice.attempt_count ?? 1,
        retryAt,
        product: "flipdesk",
      }),
      "payment_failed",
    );
  }
}

// ── Checkout completion handlers ─────────────────────────────────

// US-1929: entitlement must require settled funds. Every checkout today is
// created with `payment_method_types: ["card"]` (synchronous), so a `completed`
// event implies the money cleared — but if an async method (bank debit) or
// `automatic_payment_methods` is ever enabled, `completed` can fire while
// `payment_status` is still "unpaid"/"processing" (the real grant would then be
// `checkout.session.async_payment_succeeded`). Gate here so a future
// payment-method change can never grant credits/entitlement on unsettled funds.
// "no_payment_required" is a legitimate fully-discounted (100%-off) session.
// Exported for the guard test.
export function checkoutFundsSettled(
  paymentStatus: Stripe.Checkout.Session["payment_status"] | null | undefined,
): boolean {
  return paymentStatus === "paid" || paymentStatus === "no_payment_required";
}

async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const product = session.metadata?.product;
  const userId = session.metadata?.user_id;

  if (!userId) {
    console.error(`[Webhook] checkout.session.completed missing user_id metadata (session=${session.id})`);
    return;
  }

  // Subscription-mode sessions are handled by customer.subscription.created.
  // We still want to attach the customer id to the user the first time. (US-391:
  // reconcile rather than blind-set, so a stray duplicate customer is flagged.)
  if (session.mode === "subscription" && session.customer) {
    const customerId = typeof session.customer === "string"
      ? session.customer
      : session.customer.id;
    await linkStripeCustomer(userId, customerId);
    return;
  }

  if (session.mode !== "payment") return;

  // US-1929: don't grant entitlement on unsettled funds (see checkoutFundsSettled).
  if (!checkoutFundsSettled(session.payment_status)) {
    console.warn(
      `[Webhook] checkout.session.completed not granting entitlement — payment_status=${session.payment_status} session=${session.id}`,
    );
    return;
  }

  // Attach customer id on first one-time purchase too. (US-391: reconcile.)
  if (session.customer) {
    const customerId = typeof session.customer === "string"
      ? session.customer
      : session.customer.id;
    await linkStripeCustomer(userId, customerId);
  }

  if (product === "credit_pack") {
    await handleCreditPackPurchase(event, session, userId);
  } else if (product === "per_grade") {
    await handlePerGradePurchase(event, session, userId);
  } else if (product === "api_overage") {
    await handleApiOveragePurchase(session, userId);
  } else {
    console.warn(`[Webhook] checkout.session.completed unknown product=${product} session=${session.id}`);
  }
}

// US-1792: grant B2B API overage credits on a completed pack purchase. Idempotent
// on the Stripe session id (grant_api_credits no-ops a duplicate session), so a
// webhook replay grants once.
async function handleApiOveragePurchase(session: Stripe.Checkout.Session, userId: string) {
  const credits = Number(session.metadata?.credits ?? 0);
  const pack = session.metadata?.pack ?? "";
  if (!Number.isFinite(credits) || credits <= 0) {
    console.error(`[Webhook] api_overage missing/invalid credits metadata (session=${session.id})`);
    return;
  }
  const { error } = await supabaseAdmin.rpc("grant_api_credits", {
    p_user_id: userId,
    p_credits: credits,
    p_reason: "api_overage_purchase",
    p_session_id: session.id,
    p_notes: `pack=${pack}`,
  });
  failIfDbError(error, `grant_api_credits for user ${userId}`);
  console.log(`[Webhook] User ${userId} granted ${credits} API overage credits (pack ${pack})`);
}

async function handleCreditPackPurchase(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  userId: string,
) {
  const creditsStr = session.metadata?.credits;
  const credits = Number.parseInt(creditsStr ?? "", 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    console.error(`[Webhook] credit_pack missing/invalid credits metadata (session=${session.id})`);
    return;
  }

  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;

  // US-1641: a 100%-discount pack (a 100%-off promo code) settles with NO
  // PaymentIntent (payment_intent = null). grant_grade_credits only dedups when
  // p_stripe_payment_intent IS NOT NULL, so a null token defeated the grant's
  // idempotency — a re-delivered webhook could double-grant. Fall back to the
  // Checkout Session id (stable + unique per purchase); the 'cs_' prefix never
  // collides with a 'pi_' payment-intent id in the shared column.
  const grantIdempotencyToken = paymentIntentId ?? session.id;

  await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "credit_pack", credits, payment_intent: paymentIntentId, grant_token: grantIdempotencyToken },
  );

  const { data, error } = await supabaseAdmin.rpc("grant_grade_credits", {
    p_user_id: userId,
    p_credits: credits,
    p_reason: "pack_purchase",
    p_stripe_payment_intent: grantIdempotencyToken,
    p_notes: `Pack of ${credits} credits via session ${session.id}`,
  });

  // US-397: a dropped credit grant cheats a paying customer — retry on a
  // transient failure (the grant is idempotent on the payment_intent, US-390).
  failIfDbError(error, `grant_grade_credits for user ${userId}`);
  const newBalance = typeof data === "number" ? data : credits;
  console.log(`[Webhook] Granted ${credits} credits to user ${userId}, new balance=${newBalance}`);

  // US-629: a paid action qualifies a pending referral for this user.
  void maybeQualifyReferral(userId);

  // Receipt email (US-222). Look up the user lazily so the happy path isn't
  // slowed by an extra round trip when emails are disabled.
  const user = await loadUserById(userId);
  if (user?.email) {
    safeSendEmail(
      sendCreditPackPurchasedEmail(user.email, {
        userName: userDisplayName(user.email, user.full_name),
        credits,
        amountCents: session.amount_total ?? 0,
        newBalance,
      }),
      "credit_pack_purchased",
    );
  }
}

async function handlePerGradePurchase(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  userId: string,
) {
  const submissionId = session.metadata?.submission_id;
  const tier = session.metadata?.tier;
  // US-1637: the submission belongs to the workspace OWNER (a member's per-grade
  // purchase pays for the owner's submission). Fall back to userId (the payer)
  // for solo purchases and any in-flight session minted before this field
  // existed, preserving the prior behavior.
  const submissionOwnerId = session.metadata?.submission_owner_id ?? userId;

  if (!submissionId || !tier) {
    console.error(`[Webhook] per_grade missing submission_id or tier (session=${session.id})`);
    return;
  }

  await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "per_grade", submission_id: submissionId, tier },
  );

  // US-771: store the PaymentIntent so an ungraded paid submission can be
  // auto-refunded later without hunting for the charge.
  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;

  const { data: flipped, error: updateError } = await supabaseAdmin
    .from("submissions")
    .update({
      payment_status: "paid_stripe",
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", submissionId)
    .eq("user_id", submissionOwnerId) // US-1637: owner-scoped, not the payer
    .eq("payment_status", "unpaid") // idempotency — don't overwrite if already paid
    .select("id")
    .maybeSingle();

  // US-397: a dropped "paid" flip leaves a paid grade unprocessed — retry on a
  // transient failure (the update is idempotent: it only matches 'unpaid').
  failIfDbError(updateError, `mark submission ${submissionId} paid`);

  // US-1640: the paid-flip matched 0 rows. The Stripe dispatcher already deduped
  // this event by event.id, so this is NOT a re-delivery — the submission is
  // already paid by a DIFFERENT Checkout Session. Because the per-grade
  // idempotency key is tier-scoped, one submission can mint up to 3 payable
  // sessions, so a user can genuinely pay twice for the same grade. Refund THIS
  // charge (a duplicate) instead of silently keeping the money + re-kicking
  // grading. Never touch the submission's own payment state — the ORIGINAL
  // charge legitimately paid for the grade.
  if (!flipped) {
    const { data: existingRaw } = await supabaseAdmin
      .from("submissions")
      .select("id, payment_status, stripe_payment_intent_id")
      .eq("id", submissionId)
      .eq("user_id", submissionOwnerId)
      .maybeSingle();
    const existing = existingRaw as
      | { payment_status: string; stripe_payment_intent_id: string | null }
      | null;
    const outcome = classifyPerGradeFlip({
      flipped: false,
      existing,
      currentPaymentIntentId: paymentIntentId,
    });
    if (outcome === "duplicate") {
      await refundDuplicatePerGrade(
        submissionOwnerId,
        submissionId,
        paymentIntentId,
        session.id,
      );
    } else if (outcome === "missing") {
      console.warn(
        `[Webhook] per_grade: submission ${submissionId} not found for owner ${submissionOwnerId} — nothing to flip`,
      );
    } else {
      // Same PI (a stray re-process) or a concurrent flip — no duplicate charge.
      console.warn(
        `[Webhook] per_grade: no-op flip for ${submissionId} (status=${existing?.payment_status ?? "?"}) — no duplicate refund`,
      );
    }
    return; // already paid — don't re-kick grading
  }

  console.log(`[Webhook] Submission ${submissionId} paid (${tier}); kicking grading pipeline`);

  // US-629: a paid grade qualifies a pending referral for this user.
  void maybeQualifyReferral(userId);

  // Fire-and-forget grading run.
  processSubmission(submissionId).catch((err) => {
    console.error(
      `[Webhook] Grading pipeline error for ${submissionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

// US-1640: refund a DUPLICATE per-grade payment. Refunds the CURRENT session's
// charge (paymentIntentId) — NOT the submission's stored PI, which paid for the
// grade the user keeps — keyed on the PI so a retry can't double-refund. On any
// failure, alert loudly for operator follow-up rather than silently keeping the
// duplicate charge. Never marks the submission refunded (the grade stays valid).
async function refundDuplicatePerGrade(
  ownerId: string,
  submissionId: string,
  paymentIntentId: string | null,
  sessionId: string,
): Promise<void> {
  if (!paymentIntentId) {
    console.error(
      `[Webhook] per_grade DUPLICATE for ${submissionId} (session ${sessionId}) has no payment_intent to refund — needs manual review`,
    );
    void captureServer(ownerId, "billing.per_grade_duplicate_unrefundable", {
      submission_id: submissionId,
      session_id: sessionId,
    });
    return;
  }
  const stripe = getStripe();
  if (!stripe) {
    console.error(
      `[Webhook] per_grade DUPLICATE for ${submissionId}: Stripe not configured — cannot refund ${paymentIntentId}`,
    );
    void captureServer(ownerId, "billing.per_grade_duplicate_unrefundable", {
      submission_id: submissionId,
      payment_intent: paymentIntentId,
    });
    return;
  }
  try {
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason: "duplicate",
        metadata: { submission_id: submissionId, refund_reason: "duplicate_per_grade" },
      },
      { idempotencyKey: `dup-per-grade:${paymentIntentId}` },
    );
    console.warn(
      `[Webhook] per_grade DUPLICATE for ${submissionId}: refunded duplicate charge ${paymentIntentId} → ${refund.id}`,
    );
    void captureServer(ownerId, "billing.per_grade_duplicate_refunded", {
      submission_id: submissionId,
      payment_intent: paymentIntentId,
      refund_id: refund.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // US-2011: ALSO page. The log line below says "needs operator follow-up" —
    // and until now the only thing that could bring an operator was Sentry, on
    // routing that is itself unverified (US-2003). This state is a customer who
    // was charged TWICE and whose refund then failed: the most expensive
    // silence in the webhook surface. Fire-and-forget for the same reason as
    // the dead-letter emit (this is on the ack path).
    void emitOpsEvent("billing.duplicate_refund_failed", "critical", {
      title: `Duplicate per-grade charge could NOT be refunded — customer is double-charged`,
      source: "webhooks.refundDuplicatePerGrade",
      actorUserId: ownerId,
      data: {
        submission_id: submissionId,
        payment_intent: paymentIntentId,
        // Truncated: the ops feed is a signal surface, not a log store.
        error: msg.slice(0, 300),
      },
    });
    captureException(err, {
      route: "webhooks.refundDuplicatePerGrade",
      tags: { submissionId },
    });
    console.error(
      `[Webhook] per_grade DUPLICATE refund FAILED for ${submissionId} (${paymentIntentId}): ${msg} — needs operator follow-up`,
    );
    void captureServer(ownerId, "billing.per_grade_duplicate_refund_failed", {
      submission_id: submissionId,
      payment_intent: paymentIntentId,
      error: msg.slice(0, 200),
    });
  }
}

// ── Refund handler ───────────────────────────────────────────────

// US-1414/US-1419: lazy Stripe client used ONLY to retrieve a PaymentIntent's
// metadata when a Charge/Dispute doesn't carry our app metadata (Checkout puts
// it on the PaymentIntent, not the Charge). Same apiVersion as the route's
// client. Cached across events in the warm isolate.
let _metaStripe: Stripe | null = null;
function metaStripe(): Stripe | null {
  if (_metaStripe) return _metaStripe;
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  _metaStripe = new Stripe(key, {
    apiVersion: "2024-04-10",
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
  return _metaStripe;
}

const fetchPaymentIntentMetadata: PaymentIntentMetadataFetcher = async (id) => {
  const stripe = metaStripe();
  if (!stripe) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(id);
    return (pi.metadata ?? {}) as Record<string, string>;
  } catch (err) {
    console.error(
      `[Webhook] failed to retrieve PaymentIntent ${id} for metadata:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
};

/**
 * US-2040 / US-2033 — decide WHICH refund a `charge.refunded` event should claw
 * back, how much, and under what idempotency key.
 *
 * This is the whole bug surface of US-2033, so it is pure and exported. The
 * original defect was subtle in exactly the way that survives review: the AMOUNT
 * was computed from `charge.amount_refunded` (cumulative for the charge) while
 * the ledger KEY was the charge id. `revoke_grade_credits` no-ops on a repeated
 * key, so a second partial refund computed the right number and then skipped the
 * write — the customer kept the remaining credits AND all their money.
 *
 * Rules, each of which has a test:
 *  - Pick the NEWEST refund by `created`, breaking ties on id. List order is not
 *    guaranteed by Stripe, and a tie-break makes redeliveries of the same event
 *    resolve identically instead of flapping between refunds.
 *  - Use THAT refund's amount (the increment), not the cumulative total.
 *  - Key on the refund id, so each refund claims its own key. admin-billing
 *    keys its direct ledger call the same way, preserving US-892's
 *    whichever-path-runs-first-wins dedup at per-refund granularity.
 *  - If Stripe omitted the refunds list, fall back to cumulative + charge id.
 *    That under-claws a multi-refund charge (the OLD bug) but still claws back
 *    something, which beats skipping the reversal entirely.
 */
export function resolveRefundClawback(charge: {
  id: string;
  amount_refunded: number;
  refunds?: { data?: Array<{ id: string; amount: number; created: number }> } | null;
}): { incremental: number; idempotencyKey: string; refundId: string | null } {
  const refunds = charge.refunds?.data ?? [];
  const latest = refunds.length
    ? refunds.reduce((a, b) =>
      b.created > a.created || (b.created === a.created && b.id > a.id) ? b : a
    )
    : null;
  return {
    incremental: latest?.amount ?? charge.amount_refunded,
    idempotencyKey: latest ? `pack-refund:${latest.id}` : `pack-refund:${charge.id}`,
    refundId: latest?.id ?? null,
  };
}

async function handleChargeRefunded(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  // US-1414: charge.metadata is EMPTY for Checkout payments (metadata lives on
  // the PaymentIntent). Resolve it so credit-pack clawbacks + per-grade cert
  // withholding actually fire on Dashboard/admin-initiated refunds.
  const meta = await resolveChargeMetadata(charge, fetchPaymentIntentMetadata);
  const userId = meta.user_id;
  const product = meta.product;

  // US-385: a refunded per-grade purchase must withhold the grade it paid for.
  if (userId && product === "per_grade") {
    await refundPerGrade(event, charge.id, userId, meta);
    return;
  }

  // US-2293: a refunded API overage pack must give the credits back too.
  // checkout.session.completed grants api_overage in its own branch; this path
  // had no matching arm, so the money was returned and the credits were kept.
  if (userId && product === "api_overage") {
    await clawbackApiOverage(event, charge, userId, meta);
    return;
  }

  if (!userId || product !== "credit_pack") {
    // Subscription refunds: Stripe handles them; we just log the event.
    console.log(`[Webhook] charge.refunded product=${product ?? "?"} user=${userId ?? "?"} — no DB change`);
    return;
  }

  const creditsStr = meta.credits;
  const credits = Number.parseInt(creditsStr ?? "", 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    console.error(`[Webhook] charge.refunded credit_pack invalid credits metadata`);
    return;
  }

  const paymentIntentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id ?? null;

  // US-2033: claw back PER REFUND, not per charge.
  //
  // The previous version computed the clawback from `charge.amount_refunded`
  // (CUMULATIVE for the charge) but keyed the ledger reversal on the CHARGE id.
  // Stripe fires `charge.refunded` once per refund, and revoke_grade_credits
  // no-ops on a repeated key — so on a second, partial refund the amount was
  // right and the write was skipped. Concretely, on a $50 / 50-credit pack:
  // refund $10 (10 credits revoked, key claimed), later refund the remaining
  // $40 (clawback computes 50, key already used, NO-OP). The customer keeps all
  // $50 AND 40 credits. admin-billing's `admin-refund:<charge>:<amount>` path
  // deliberately permits exactly that second partial refund.
  //
  // Keying on the REFUND makes each event claim its own key and move its own
  // increment. US-892's property is preserved and sharpened: admin-billing now
  // keys its direct ledger call on the same refund id, so whichever path runs
  // first still wins and the other no-ops — now per refund rather than per
  // charge.
  // US-2040: the decision is extracted + exported so it can actually be TESTED.
  // Previously all of this lived inline in an unexported handler, so the fix for
  // US-2033 (the real bug) was unreachable from any test — reverting the key to
  // charge.id would have kept every suite green while a customer kept both the
  // credits and the money.
  const { incremental, idempotencyKey, refundId } = resolveRefundClawback(charge);
  if (!refundId) {
    console.warn(
      `[Webhook] charge.refunded ${charge.id} carried no refunds list — ` +
        `falling back to the cumulative per-charge clawback`,
    );
  }

  const revoked = proportionalClawback(credits, incremental, charge.amount);
  if (revoked <= 0) {
    console.log(`[Webhook] charge.refunded credit_pack refunded=${incremental}/${charge.amount} — nothing to claw back`);
    return;
  }

  await clawbackCreditPack(
    event,
    userId,
    revoked,
    charge.id,
    paymentIntentId,
    idempotencyKey,
    `Refund reversal for charge ${charge.id}` +
      (refundId ? ` (refund ${refundId})` : ""),
  );
}

// US-1919: scale a credit-pack clawback to the fraction actually refunded /
// charged back. Stripe fires `charge.refunded` for PARTIAL refunds too (the
// Dashboard path per US-1414), so a $10 refund on a $50 / 50-credit pack must
// revoke 10 credits, not all 50. `revoked = round(granted * refunded / total)`,
// integer credits, half-up, clamped to [0, granted]. Exported for the guard test.
//   - refunded <= 0  → 0 (nothing was refunded, revoke nothing; also the $0-charge
//                        refund case, which avoids a divide-by-zero)
//   - refunded >= total → full pack (a full refund / full chargeback)
//   - total <= 0 while refunded > 0 → defensive full clawback (no basis to scale;
//                        can't actually happen — you can't refund more than $0)
export function proportionalClawback(
  granted: number,
  refunded: number,
  total: number,
): number {
  if (!Number.isFinite(granted) || granted <= 0) return 0;
  if (!Number.isFinite(refunded) || refunded <= 0) return 0;
  if (!Number.isFinite(total) || total <= 0) return granted;
  if (refunded >= total) return granted;
  const revoked = Math.round((granted * refunded) / total);
  return Math.max(0, Math.min(granted, revoked));
}

/**
 * US-2293: how many API overage credits a refund can actually take back.
 *
 * The bug this closes: `charge.refunded` dispatched on `per_grade` and
 * `credit_pack` and logged everything else as "no DB change" — so a refunded
 * API overage pack returned the money and left the credits in the wallet.
 * api_overage was granted by a THIRD branch of checkout.session.completed that
 * the refund path never grew a matching arm for.
 *
 * Clamped to the CURRENT balance, not the granted amount, because API credits
 * are spent as they are used: a customer who bought 1,000, used 900, and then
 * refunded can only give back the 100 they still hold. Taking 1,000 would drive
 * the wallet negative and bill them for calls they already paid for.
 *
 * The shortfall is returned rather than swallowed. It is the number a human
 * needs — "we refunded a pack whose credits were already consumed" is a real
 * commercial event (and a plausible abuse signal), and a clawback that silently
 * takes what it can get and reports success hides it.
 */
export function planApiOverageClawback(args: {
  granted: number;
  /** The refund increment for THIS event, in minor units. */
  refunded: number;
  /** The charge total, in minor units. */
  total: number;
  /** The wallet balance right now. */
  balance: number;
}): { revoke: number; shortfall: number } {
  const owed = proportionalClawback(args.granted, args.refunded, args.total);
  if (owed <= 0) return { revoke: 0, shortfall: 0 };
  const balance = Number.isFinite(args.balance) ? Math.max(0, args.balance) : 0;
  const revoke = Math.min(owed, balance);
  return { revoke, shortfall: owed - revoke };
}

// US-384 / US-1443: DEBIT clawed-back credits from the wallet (not just append a
// ledger row). The row-locked RPC subtracts from grade_credit_balance, clamps at
// zero, writes a balance-consistent ledger row, and reports any shortfall
// (credits already spent) for reconciliation. Idempotent on p_idempotency_key,
// so the refund path and the lost-dispute path can BOTH run for one charge and
// the wallet is debited exactly once. Shared so the dispute lifecycle reuses the
// exact refund clawback rather than duplicating it.
async function clawbackCreditPack(
  event: Stripe.Event,
  userId: string,
  credits: number,
  chargeId: string,
  paymentIntentId: string | null,
  idempotencyKey: string,
  notes: string,
): Promise<void> {
  await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "credit_pack", credits, charge_id: chargeId },
  );

  const { data, error } = await supabaseAdmin.rpc("revoke_grade_credits", {
    p_user_id: userId,
    p_credits: credits,
    p_stripe_payment_intent: paymentIntentId,
    p_notes: notes,
    p_idempotency_key: idempotencyKey,
  });

  // US-397: a dropped clawback leaves the credits in the wallet — retry on a
  // transient failure (revoke is row-locked + clamped, US-384/398).
  failIfDbError(error, `revoke_grade_credits for user ${userId}`);

  const result = (data ?? {}) as {
    revoked?: number;
    shortfall?: number;
    balance_after?: number;
  };
  if ((result.shortfall ?? 0) > 0) {
    // Credits were already spent — the wallet can't go negative, so flag for
    // ops to reconcile (e.g. comp/write-off) rather than failing the clawback.
    console.warn(
      `[Webhook] Credit clawback for user ${userId}: revoked ${result.revoked ?? 0}/${credits} ` +
        `credits, ${result.shortfall} already spent (balance_after=${result.balance_after ?? 0}) — needs reconciliation`,
    );
  } else {
    console.log(
      `[Webhook] Credit clawback for user ${userId}: -${result.revoked ?? credits} credits ` +
        `(balance_after=${result.balance_after ?? 0})`,
    );
  }
}

// US-385: a refunded per-grade purchase. Mark the submission refunded, flag it
// for review, and WITHHOLD its public certificate (clearing certificate_id makes
// the public_grade_reports view stop resolving it — US-348). The grade row is
// retained so a human can reconcile; we don't hard-delete a paid artifact.
/**
 * US-2293: reverse an API overage grant when its charge is refunded.
 *
 * Deliberately NOT routed through `revoke_grade_credits`: API overage credits
 * live in a different wallet (`api_credit_wallet`, 00415) from grading credits,
 * and revoking the wrong one would take credits the customer still paid for
 * while leaving the refunded ones in place — a second money bug wearing the
 * first one's fix.
 *
 * Idempotency comes from the webhook envelope: `claimWebhookEvent` runs ONCE
 * before any side effect (US-390), so a Stripe redelivery of this event never
 * reaches here. Two SEPARATE partial refunds are two distinct events and each
 * correctly claws back its own increment — the same shape as the credit-pack
 * path after US-2033.
 */
async function clawbackApiOverage(
  event: Stripe.Event,
  charge: Stripe.Charge,
  userId: string,
  meta: Record<string, string | undefined>,
): Promise<void> {
  const granted = Number.parseInt(meta.credits ?? "", 10);
  if (!Number.isFinite(granted) || granted <= 0) {
    console.error(
      `[Webhook] charge.refunded api_overage invalid credits metadata (charge=${charge.id})`,
    );
    return;
  }

  // Same increment rule as the credit-pack path (US-2033): the NEWEST refund's
  // own amount, not the cumulative total — so two partial refunds claw back
  // their own halves instead of the second one recomputing the whole thing.
  // Stripe.Charge already satisfies resolveRefundClawback's structural
  // parameter, so it goes straight in — the same call the credit-pack path
  // makes. Re-mapping refunds.data by hand (as this first did) lost the element
  // type and failed `deno check src/main.ts` with an implicit any.
  const { incremental } = resolveRefundClawback(charge);

  const { data: walletRow } = await supabaseAdmin
    .from("api_credit_wallet")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  const balance = Number((walletRow as { balance?: number } | null)?.balance ?? 0);

  const { revoke, shortfall } = planApiOverageClawback({
    granted,
    refunded: incremental,
    total: charge.amount,
    balance,
  });

  await recordEvent(userId, event.type, event.id, null, null, {
    product: "api_overage",
    granted,
    revoke,
    shortfall,
    charge_id: charge.id,
  });

  if (revoke <= 0) {
    // Nothing recoverable. Still worth a line: a refund whose credits were all
    // spent is a commercial event, not a no-op.
    console.log(
      `[Webhook] charge.refunded api_overage charge=${charge.id} user=${userId} ` +
        `balance=${balance} — nothing to claw back (shortfall=${shortfall})`,
    );
    return;
  }

  const { data, error } = await supabaseAdmin.rpc("debit_api_credits", {
    p_user_id: userId,
    p_credits: revoke,
    p_notes: `api_overage refund clawback (charge ${charge.id})`,
  });
  // US-397 shape: a dropped clawback leaves the credits in the wallet, so a
  // transient DB failure must retry rather than be swallowed.
  failIfDbError(error, `debit_api_credits for user ${userId}`);
  if (data === -1) {
    // The balance moved between the read and the debit (a concurrent API call
    // spent it). Not an error — it is the shortfall case, discovered a moment
    // later — but it must be visible rather than logged as success.
    console.warn(
      `[Webhook] charge.refunded api_overage charge=${charge.id} user=${userId} ` +
        `debit of ${revoke} lost a race with a concurrent spend — nothing revoked`,
    );
    return;
  }
  if (shortfall > 0) {
    console.warn(
      `[Webhook] charge.refunded api_overage charge=${charge.id} user=${userId} ` +
        `revoked ${revoke}, SHORTFALL ${shortfall} credits already spent`,
    );
  }
  console.log(
    `[Webhook] charge.refunded api_overage charge=${charge.id} user=${userId} ` +
      `revoked ${revoke} credit(s), balance now ${data}`,
  );
}

async function refundPerGrade(
  event: Stripe.Event,
  chargeId: string,
  userId: string,
  meta: Record<string, string>,
) {
  // US-1414: submission_id comes from the resolved metadata (PaymentIntent),
  // not charge.metadata, which is empty for Checkout payments.
  const submissionId = meta.submission_id;
  if (!submissionId) {
    console.error(`[Webhook] per_grade refund missing submission_id (charge=${chargeId})`);
    return;
  }
  // US-1637: withhold the grade from the OWNER's submission (member per-grade).
  // Falls back to the payer for solo purchases / pre-field PaymentIntents.
  const submissionOwnerId = meta.submission_owner_id ?? userId;

  await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "per_grade", submission_id: submissionId, charge_id: chargeId },
  );

  // Tenant-scoped by user_id (US-268). maybeSingle + select confirms the
  // submission actually belongs to this workspace before we touch its grade.
  const { data: updated, error } = await supabaseAdmin
    .from("submissions")
    .update({
      refunded_at: new Date().toISOString(),
      flagged: true,
      flag_reason: "payment_refunded",
    })
    .eq("id", submissionId)
    .eq("user_id", submissionOwnerId)
    .select("id")
    .maybeSingle();

  // US-397: a dropped refund flag would keep a refunded grade live — retry on a
  // transient failure (the update is idempotent on submission_id+user_id).
  failIfDbError(error, `per_grade refund submission update (${submissionId})`);
  if (!updated) {
    console.warn(`[Webhook] per_grade refund: submission ${submissionId} not found for owner ${submissionOwnerId}`);
    return;
  }

  // Withhold the public certificate. The submission was just verified as owned,
  // so updating its grade_reports by submission_id is tenant-safe. Capture the
  // cert ids first so we can drop their edge-stored rendered images.
  const { data: preCerts } = await supabaseAdmin
    .from("grade_reports")
    .select("certificate_id")
    .eq("submission_id", submissionId)
    .not("certificate_id", "is", null);
  const { error: certErr } = await supabaseAdmin
    .from("grade_reports")
    .update({ certificate_id: null })
    .eq("submission_id", submissionId);
  for (const row of (preCerts ?? []) as Array<{ certificate_id: string | null }>) {
    if (row.certificate_id) deleteCertImages(row.certificate_id).catch(() => {});
  }
  // US-397: keeping a refunded grade's certificate live is a trust hole — retry.
  failIfDbError(certErr, `per_grade refund certificate withhold (${submissionId})`);

  console.log(
    `[Webhook] per_grade refund: submission ${submissionId} marked refunded, flagged, cert withheld`,
  );
}

// US-385: chargeback/dispute opened. A dispute can still be WON, so we don't
// auto-revoke here — we record it, flag the submission for review, and surface
// a clear alert for manual handling (evidence submission / decide whether to
// withhold). The terminal charge.dispute.closed reconciliation (claw back on
// lost / clear the flag on won) is handled by handleChargeDisputeClosed (US-1443).
async function handleChargeDisputeCreated(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  const charge = dispute.charge;
  const chargeId = typeof charge === "string" ? charge : charge?.id ?? null;

  // US-1419: in a raw charge.dispute.created webhook, dispute.payment_intent is
  // an UNEXPANDED string id — so reading dispute.payment_intent.metadata always
  // yielded {} and the submission was never flagged for review. Resolve via the
  // PaymentIntent (where Checkout actually stores our metadata).
  const meta = await resolveDisputeMetadata(dispute, fetchPaymentIntentMetadata);
  const userId = meta.user_id;
  const product = meta.product;
  const submissionId = meta.submission_id;

  console.warn(
    `[Webhook] charge.dispute.created reason=${dispute.reason} amount=${dispute.amount} ` +
      `product=${product ?? "?"} user=${userId ?? "?"} charge=${chargeId ?? "?"} — needs manual review`,
  );

  if (userId && product === "per_grade" && submissionId) {
    await recordEvent(
      userId,
      event.type,
      event.id,
      null,
      null,
      { product, submission_id: submissionId, dispute_id: dispute.id, reason: dispute.reason },
    );

    await supabaseAdmin
      .from("submissions")
      .update({ flagged: true, flag_reason: "payment_disputed" })
      .eq("id", submissionId)
      // US-1637: owner-scoped (member per-grade); falls back to the payer.
      .eq("user_id", meta.submission_owner_id ?? userId);
  }

  void captureServer(userId ?? "unknown", "billing.dispute_created", {
    product: product ?? null,
    dispute_id: dispute.id,
    reason: dispute.reason,
  });
}

// US-1443: what a closed dispute means for our records.
//   • lost → the money is gone → claw back (reuse the refund clawback path).
//   • won  → we kept the money → clear the review flag set on dispute.created.
//   • none → non-terminal close (e.g. warning_closed) → no financial action.
export type DisputeClosedAction = "clawback" | "clear_flag" | "none";

export function disputeClosedAction(status: string): DisputeClosedAction {
  if (status === "lost") return "clawback";
  if (status === "won") return "clear_flag";
  return "none";
}

// US-1443: complete the dispute lifecycle. dispute.created only FLAGS for review
// (a dispute can still be won); on CLOSE we reconcile automatically. Idempotent:
// the credit clawback dedupes on p_idempotency_key, the per-grade cert-withhold
// and the flag-clear are no-ops on replay, and the dispatcher already claims the
// event id — so a Stripe re-delivery can't double-apply.
async function handleChargeDisputeClosed(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = typeof dispute.charge === "string"
    ? dispute.charge
    : dispute.charge?.id ?? null;
  const action = disputeClosedAction(dispute.status);

  const meta = await resolveDisputeMetadata(dispute, fetchPaymentIntentMetadata);
  const userId = meta.user_id;
  const product = meta.product;
  const submissionId = meta.submission_id;

  console.warn(
    `[Webhook] charge.dispute.closed status=${dispute.status} action=${action} ` +
      `product=${product ?? "?"} user=${userId ?? "?"} charge=${chargeId ?? "?"}`,
  );

  void captureServer(userId ?? "unknown", "billing.dispute_closed", {
    product: product ?? null,
    dispute_id: dispute.id,
    status: dispute.status,
  });

  if (action === "none") return;

  if (action === "clawback") {
    if (userId && product === "per_grade" && submissionId) {
      // A lost per-grade chargeback withholds the certificate, exactly like a
      // refund — reuse that path (charge id unavailable → fall back to the
      // dispute id for the log/event trail).
      await refundPerGrade(event, chargeId ?? dispute.id, userId, meta);
    } else if (userId && product === "credit_pack") {
      const credits = Number.parseInt(meta.credits ?? "", 10);
      if (!Number.isFinite(credits) || credits <= 0) {
        console.error(`[Webhook] dispute.closed lost credit_pack invalid credits metadata`);
        return;
      }
      // US-1919: scale the clawback to the DISPUTED fraction (Stripe permits a
      // partial dispute). The fraction needs the original charge total, which
      // isn't on the dispute object — fetch it; if unavailable, fall back to the
      // full pack (the row-locked RPC clamps at zero, so this never over-revokes
      // the wallet — it just preserves the prior conservative behavior).
      let chargeTotal = 0;
      if (chargeId) {
        try {
          const ch = await getStripe().charges.retrieve(chargeId);
          chargeTotal = typeof ch.amount === "number" ? ch.amount : 0;
        } catch {
          console.error(
            `[Webhook] dispute.closed could not fetch charge ${chargeId} — falling back to full clawback`,
          );
        }
      }
      const revoked = chargeTotal > 0
        ? proportionalClawback(credits, dispute.amount, chargeTotal)
        : credits;
      if (revoked <= 0) {
        console.log(
          `[Webhook] dispute.closed lost credit_pack disputed=${dispute.amount}/${chargeTotal} — nothing to claw back`,
        );
        return;
      }
      // Distinct idempotency key from the refund path so a lost dispute AFTER a
      // partial refund still reconciles; the row-locked RPC clamps at zero.
      await clawbackCreditPack(
        event,
        userId,
        revoked,
        chargeId ?? dispute.id,
        paymentIntentIdOf(dispute.payment_intent ?? null),
        `dispute-lost:${dispute.id}`,
        `Chargeback lost for dispute ${dispute.id}`,
      );
    } else {
      console.log(`[Webhook] dispute.closed lost — no clawback for product=${product ?? "?"}`);
    }
    return;
  }

  // action === "clear_flag" (won): clear ONLY the dispute review flag we set on
  // created, so we don't clobber an unrelated flag_reason.
  if (userId && product === "per_grade" && submissionId) {
    const { error } = await supabaseAdmin
      .from("submissions")
      .update({ flagged: false, flag_reason: null })
      .eq("id", submissionId)
      // US-1637: owner-scoped (member per-grade); falls back to the payer.
      .eq("user_id", meta.submission_owner_id ?? userId)
      .eq("flag_reason", "payment_disputed");
    // US-397: a dropped flag-clear leaves a won grade needlessly flagged — retry.
    failIfDbError(error, `dispute won flag clear (${submissionId})`);
  }
}

// ── Mappers ──────────────────────────────────────────────────────

// US-396: resolve the tier from explicit, interval-independent signals only —
// the metadata.plan we set at checkout (US-204), then the price lookup_key.
// Returns null when neither resolves; the old amount>=9900 heuristic mapped
// EVERY yearly price (e.g. $59/yr pro = 5900¢… or $590 = 59000¢ ≥ 9900) to
// business and defaulted unknowns to a paid tier. Unmappable now FAILS CLOSED
// (no entitlement + alert) so a price-config gap is fixed, not silently
// mis-entitled.
export function mapSubscriptionToFlipdeskPlan(sub: Stripe.Subscription): FlipdeskPlan | null {
  const meta = sub.metadata?.plan;
  if (meta === "starter" || meta === "pro" || meta === "business") return meta;

  const item = sub.items?.data?.[0];
  const lookupKey = item?.price?.lookup_key ?? "";
  if (lookupKey.startsWith("flipdesk_business")) return "business";
  if (lookupKey.startsWith("flipdesk_pro")) return "pro";
  if (lookupKey.startsWith("flipdesk_starter")) return "starter";

  return null;
}

// US-1799: buyer subscriptions ride on the SAME Stripe customer as the seller
// sub, so every handler must resolve WHICH product a subscription/invoice is by
// its price/metadata — never "the customer's subscription". This resolver
// mirrors mapSubscriptionToFlipdeskPlan: metadata.plan first (set at checkout),
// then the price lookup_key (buyer_guard_* / buyer_connoisseur_*, set by
// setup-stripe-pricing.mjs) so a portal-created sub with no metadata still maps.
export function mapSubscriptionToBuyerPlan(sub: Stripe.Subscription): "guard" | "connoisseur" | null {
  const meta = sub.metadata?.plan;
  if (meta === "guard" || meta === "connoisseur") return meta;

  const lookupKey = sub.items?.data?.[0]?.price?.lookup_key ?? "";
  if (lookupKey.startsWith("buyer_connoisseur")) return "connoisseur";
  if (lookupKey.startsWith("buyer_guard")) return "guard";

  return null;
}

/** True when a subscription belongs to the BUYER product (not the seller sub). */
export function subscriptionIsBuyer(sub: Stripe.Subscription): boolean {
  return sub.metadata?.product === "buyer" || mapSubscriptionToBuyerPlan(sub) !== null;
}

/** True when an invoice is for the BUYER product (by its line-item price key). */
export function invoiceIsBuyer(invoice: Stripe.Invoice): boolean {
  const lines = (invoice.lines?.data ?? []) as Stripe.InvoiceLineItem[];
  return lines.some((l) => (l.price?.lookup_key ?? "").startsWith("buyer_"));
}

export function mapSubscriptionInterval(sub: Stripe.Subscription): "monthly" | "yearly" {
  const intvl = sub.items?.data?.[0]?.price?.recurring?.interval;
  return intvl === "year" ? "yearly" : "monthly";
}

// US-937: monthly recurring value of the subscription, in cents — the ROI figure
// the drip attribution ledger associates with a conversion (US-946). A yearly
// price is normalized to a monthly amount so MRR is comparable across intervals.
export function subscriptionMrrCents(sub: Stripe.Subscription): number {
  const item = sub.items?.data?.[0];
  const unit = item?.price?.unit_amount ?? 0;
  const qty = item?.quantity ?? 1;
  const gross = unit * qty;
  if (gross <= 0) return 0;
  const recurring = item?.price?.recurring;
  const count = recurring?.interval_count && recurring.interval_count > 0
    ? recurring.interval_count
    : 1;
  switch (recurring?.interval) {
    case "year":
      return Math.round(gross / (12 * count));
    case "week":
      return Math.round((gross * 52) / (12 * count));
    case "day":
      return Math.round((gross * 365) / (12 * count));
    case "month":
    default:
      return Math.round(gross / count);
  }
}

export function mapSubscriptionStatus(
  status: Stripe.Subscription.Status,
): "none" | "trialing" | "active" | "past_due" | "paused" | "canceled" {
  switch (status) {
    case "trialing": return "trialing";
    case "active": return "active";
    case "past_due":
    case "unpaid": return "past_due";
    case "paused": return "paused";
    case "canceled":
    case "incomplete_expired": return "canceled";
    // US-392: `incomplete` = checkout created but the first payment hasn't
    // cleared. Do NOT entitle it (the old `→ active` fallback granted paid caps
    // before any money moved). Map to the non-entitling 'none' — effectivePlanFor
    // treats it as Free; invoice.payment_succeeded flips it to 'active'. Unknown
    // future statuses fail closed the same way rather than silently entitling.
    case "incomplete":
    default: return "none";
  }
}

// ── US-2128: SCA / 3-D Secure authentication required ────────────────
//
// `invoice.payment_action_required` fires when the bank demands cardholder
// authentication before it will take the money. Two things make this worse than
// an ordinary failed payment:
//
//   1. NOTHING RETRIES IT. Stripe's Smart Retries drive the dunning cadence for
//      `invoice.payment_failed`, so that path self-heals or escalates on its
//      own. This one waits on a HUMAN who has not been told anything.
//   2. The end state looks identical to the user — service degrades — but the
//      remedy is completely different: they must complete a 3DS challenge, not
//      update a card.
//
// So it was silence on the one path where silence guarantees the problem
// persists. This mirrors the payment-failed handler deliberately (same customer
// resolution, same buyer skip, same event ledger, same safeSendEmail) rather
// than inventing a parallel shape.
//
// NOT flipping subscription_status to past_due here: Stripe will send
// `invoice.payment_failed` if the authentication is never completed and the
// invoice ultimately fails, and THAT is the event that owns the dunning clock.
// Starting the grace period twice from two events would make `past_due_since`
// depend on delivery order.
async function handleInvoicePaymentActionRequired(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer as Stripe.Customer | null)?.id;
  if (!customerId) return;

  // US-1799: buyer invoices are carried by subscription.updated — same skip as
  // the payment-failed handler.
  //
  // US-2452: the original reason written here was "so a buyer doesn't get a
  // seller-shaped email", which was an honest statement of intent and produced
  // silence instead. This is the ONLY notice of a state that never resolves
  // without the user, so silence means the renewal simply fails. The copy is
  // product-aware now, and the send happens before the return.
  if (invoiceIsBuyer(invoice)) {
    await sendBuyerBillingProblem(event, invoice, customerId, "action_required");
    return;
  }

  const user = await loadUserByCustomerId(customerId);
  if (!user) return;

  await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    user.flipdesk_plan,
    {
      invoice_id: invoice.id,
      amount_due: invoice.amount_due,
      // The hosted page is where the customer completes the 3DS challenge —
      // recorded so support can hand it to them directly.
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    },
  );

  if (user.email) {
    const planLabel = user.flipdesk_plan.charAt(0).toUpperCase() +
      user.flipdesk_plan.slice(1);
    safeSendEmail(
      sendPaymentActionRequiredEmail(user.email, {
        userName: userDisplayName(user.email, user.full_name),
        plan: planLabel,
        amountCents: invoice.amount_due ?? 0,
        // Stripe's hosted invoice page carries the authentication flow. Without
        // a link the email would tell someone their payment needs action and
        // give them no way to take it.
        actionUrl: invoice.hosted_invoice_url ?? null,
        product: "flipdesk",
      }),
      "payment_action_required",
    );
  }
}

// ── US-2128: the known-ignored list ──────────────────────────────────
//
// Before this, the switch's default branch logged "Unhandled event type" for
// BOTH events we deliberately don't care about and events we'd simply never
// considered. Those are very different facts, and collapsing them meant a newly
// enabled Stripe feature could start firing an unhandled consequential event
// and read exactly like the routine noise beside it.
//
// Anything on this list is a decision. Anything NOT on it now warns and records
// a metric, so it surfaces.
const INTENTIONALLY_IGNORED_EVENTS = new Set<string>([
  // Informational duplicates of state we already derive from the subscription
  // or invoice objects we DO handle.
  "invoice.created",
  "invoice.finalized",
  "invoice.updated",
  "invoice.paid", // we act on invoice.payment_succeeded
  "payment_intent.succeeded", // charge/checkout handlers carry the outcome
  "payment_intent.created",
  "payment_method.attached",
  "payment_method.detached",
  "customer.updated",
  "customer.created",
  "charge.succeeded", // checkout.session.completed carries what we need
  "invoiceitem.created",
  "billing_portal.session.created",
  "checkout.session.expired", // an abandoned checkout needs no server action
]);

export function isIntentionallyIgnored(eventType: string): boolean {
  return INTENTIONALLY_IGNORED_EVENTS.has(eventType);
}

/** Exposed for the test that pins the list is non-empty and documented. */
export const INTENTIONALLY_IGNORED_EVENT_LIST: readonly string[] = [
  ...INTENTIONALLY_IGNORED_EVENTS,
];

// ── US-2119: advance renewal notice + Stripe-managed trial ending ────

/**
 * `invoice.upcoming` — Stripe's advance warning that it is about to bill.
 *
 * Sends the ONLY contact a subscriber gets before their card is charged. An
 * annual subscriber was previously charged a full year's fee with no prior
 * notice at all: the first message was the receipt, after the money moved.
 *
 * Buyer invoices are skipped for the same reason as the payment-failed handler
 * (US-1799) — their lifecycle is carried by subscription.updated, and a
 * seller-shaped renewal email would be wrong for them.
 */
async function handleInvoiceUpcoming(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer as Stripe.Customer | null)?.id;
  if (!customerId) return;
  // US-2119: NO invoiceIsBuyer SKIP HERE, and that is the point.
  //
  // The other three handlers skip a buyer invoice because the buyer equivalent
  // of their work arrives on customer.subscription.updated — the seller cycle
  // resets, the dunning transition and the payment-failed email all have a
  // buyer path elsewhere. This handler has none. It only sends a notice, and
  // nothing else sends one, so skipping the buyer here meant a buyer on an
  // ANNUAL plan was charged a full year's fee with no prior contact at all:
  // exactly the defect this story is named for, still live on the other
  // product. Same shape as the US-2118 confirmation gate, which also shipped
  // for FlipDesk only.
  const isBuyer = invoiceIsBuyer(invoice);

  const user = await loadUserByCustomerId(customerId);
  if (!user) return;

  // Stripe puts the billing date on next_payment_attempt for an upcoming
  // invoice. Without a date the notice cannot say WHEN — and "you will be
  // charged at some point" is not a notice, so decline rather than send
  // something uselessly vague.
  const renewsAtSec = invoice.next_payment_attempt ?? invoice.period_end;
  if (typeof renewsAtSec !== "number") return;

  const interval =
    invoice.lines?.data?.[0]?.price?.recurring?.interval === "year"
      ? "yearly"
      : "monthly";

  // A buyer whose subscription lapsed to free has nothing renewing; the invoice
  // would be for a plan they no longer hold, and naming "Free" in a charge
  // notice is worse than staying quiet.
  const buyerPlan = (user as { buyer_plan?: string | null }).buyer_plan ?? "free";
  if (isBuyer && buyerPlan === "free") return;

  await recordEvent(
    user.id,
    // US-2457: a buyer row must be namespaced or the reconciler reads it as a
    // seller signal — see BUYER_EVENT_PREFIX.
    isBuyer ? buyerEventType(event.type) : event.type,
    event.id,
    // The plan columns are typed public.flipdesk_plan, so a buyer tier cannot
    // go in them (the same enum trap as US-2118's consent artifact). These stay
    // the user's real FlipDesk plan — a true statement either way — and the
    // buyer detail goes in the payload, which is jsonb.
    user.flipdesk_plan,
    user.flipdesk_plan,
    {
      invoice_id: invoice.id,
      amount_due: invoice.amount_due,
      renews_at: new Date(renewsAtSec * 1000).toISOString(),
      product: isBuyer ? "buyer" : "flipdesk",
      ...(isBuyer ? { buyer_plan: buyerPlan } : {}),
    },
    interval,
  );

  if (user.email) {
    const rawPlan = isBuyer ? buyerPlan : user.flipdesk_plan;
    const planLabel = rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1);
    safeSendEmail(
      sendRenewalReminderEmail(user.email, {
        userName: userDisplayName(user.email, user.full_name),
        plan: planLabel,
        amountCents: invoice.amount_due ?? 0,
        renewsAt: new Date(renewsAtSec * 1000).toISOString(),
        interval,
        product: isBuyer ? "buyer" : "flipdesk",
      }),
      "subscription_renewal_reminder",
    );
  }
}

/**
 * `customer.subscription.trial_will_end` — a STRIPE-managed trial is ending.
 *
 * Disjoint from the trial-expiry cron (US-2120): our signup trial has no Stripe
 * subscription at all, and that cron filters `flipdesk_subscription_id IS NULL`.
 * This fires only for someone who started a PAID subscription with a trial
 * period — exactly the user that cron skips. Neither path can double-send.
 *
 * Reuses sendTrialExpiringEmail, which is transactional, rather than minting a
 * second trial template: two near-identical trial emails would drift.
 */
async function handleTrialWillEnd(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === "string"
    ? sub.customer
    : (sub.customer as Stripe.Customer | null)?.id;
  if (!customerId || typeof sub.trial_end !== "number") return;

  const user = await loadUserByCustomerId(customerId);
  if (!user?.email) return;

  const trialEndsAt = new Date(sub.trial_end * 1000).toISOString();
  const daysLeft = Math.max(
    1,
    Math.ceil((sub.trial_end * 1000 - Date.now()) / 86_400_000),
  );

  // US-2119 AC4, second pass: this handler was not product-aware, so a BUYER
  // subscription with a Stripe-managed trial would have been sent
  // sendTrialExpiringEmail — copy that names a "14-day FlipDesk Pro trial",
  // offers to keep "your Pro features", and links to the seller billing page.
  // The inverse of the five buyer omissions fixed alongside this: not silence,
  // but confidently wrong.
  //
  // A buyer is skipped rather than given new copy, because A BUYER STRIPE TRIAL
  // IS NOT A PRODUCT STATE TODAY — POST /buyer/subscribe builds its Checkout
  // session with no trial_period_days and no subscription_data.trial_end, so
  // one can only exist if a price is configured with a trial in the Stripe
  // dashboard. Writing a notice for a flow that does not exist would be
  // guessing at what it should say. Same call as the buyer pause/resume
  // decision in US-2453, and guarded the same way: buyer-lifecycle-emails_test
  // fails the moment /buyer/subscribe grows a trial, so this decision gets
  // revisited instead of quietly outliving its premise.
  if (subscriptionIsBuyer(sub)) {
    console.warn(
      `[Webhook] BUYER trial_will_end for user ${user.id} (sub ${sub.id}) — no ` +
        "buyer trial copy exists; see US-2119 AC4. Nothing sent.",
    );
    return;
  }

  await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    user.flipdesk_plan,
    { subscription_id: sub.id, trial_ends_at: trialEndsAt },
  );

  safeSendEmail(
    sendTrialExpiringEmail(user.email, {
      userName: userDisplayName(user.email, user.full_name),
      daysLeft,
      trialEndsAt,
      // No userId — see US-2120: that adds a marketing unsubscribe link to a
      // notice whose opt-out we do not honour.
    }),
    "trial_expiring",
  );
}
