import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import {
  claimWebhookEvent,
  failIfDbError,
  isTransientWebhookError,
  releaseWebhookEvent,
} from "../lib/webhook-idempotency.ts";
import {
  sendCreditPackPurchasedEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCanceledEmail,
  sendSubscriptionPausedEmail,
  sendSubscriptionResumedEmail,
  sendSubscriptionStartedEmail,
  sendSubscriptionRenewalReceiptEmail,
} from "../lib/email.ts";
import { captureServer } from "../lib/posthog.ts";
import { recordMetric } from "../lib/observability.ts";
import { nextPastDueSince } from "../lib/grade-pricing.ts";
import { getPlanMatrix } from "../lib/pricing-config.ts";
import { reconcileCustomerLink } from "../lib/stripe-customer.ts";
import { shouldClearPendingDowngrade } from "../lib/pending-downgrade.ts";
import { maybeQualifyReferral } from "../lib/referrals.ts";
import { recordWebhookDeadLetter } from "../lib/webhook-dead-letter.ts";
import { captureException } from "../lib/observability.ts";
import { notifyPlanDowngrade } from "../lib/plan-change-notify.ts";
import { applySesFeedback } from "../lib/email-suppression.ts";

// Fire-and-forget email helper — webhook MUST NOT fail if email fails.
function safeSendEmail(promise: Promise<boolean>, label: string) {
  promise.catch((err) => {
    console.error(`[Webhook] ${label} email send failed:`, err instanceof Error ? err.message : err);
  });
}

function userDisplayName(email: string | null | undefined, fullName: string | null | undefined): string {
  if (fullName && fullName.trim()) return fullName.trim().split(/\s+/)[0]!;
  if (email) return email.split("@")[0]!;
  return "there";
}

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

  const snsType =
    c.req.header("x-amz-sns-message-type") ?? (envelope.Type as string | undefined);

  // SNS subscription handshake: confirm the subscription by fetching SubscribeURL.
  if (snsType === "SubscriptionConfirmation") {
    const subscribeUrl = envelope.SubscribeURL as string | undefined;
    if (subscribeUrl) {
      try {
        await fetch(subscribeUrl);
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

    default:
      console.log(`[Webhook] Unhandled event type: ${event.type}`);
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
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("flipdesk_subscription_events")
    .insert({
      user_id: userId,
      stripe_event_id: stripeEventId,
      event_type: eventType,
      from_plan: fromPlan,
      to_plan: toPlan,
      raw_payload: rawPayload,
    });

  if (error && error.code !== "23505") {
    console.error(`[Webhook] Failed to write audit row for ${stripeEventId}:`, error);
  }
}

const USER_SELECT =
  "id, email, full_name, flipdesk_plan, stripe_customer_id, trial_ends_at, flipdesk_subscription_id, flipdesk_cancel_at_period_end, pending_flipdesk_plan, pending_flipdesk_interval, pending_schedule_id, pending_effective_at, flipdesk_pause_until, cancellation_reason, subscription_status, past_due_since";

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
  );

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
      ...(event.type === "customer.subscription.created"
        ? { cancellation_reason: null, pending_referral_coupon: null }
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

  // Emails (best-effort, never fail the webhook).
  if (user.email) {
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    const name = userDisplayName(user.email, user.full_name);

    // First-time subscription → welcome-to-paid email (skip when the price was
    // unmappable — we didn't entitle a paid plan, so don't send a paid welcome).
    if (event.type === "customer.subscription.created" && status !== "trialing" && resolvedPlan) {
      const priceCents = sub.items?.data?.[0]?.price?.unit_amount ?? 0;
      safeSendEmail(
        sendSubscriptionStartedEmail(user.email, {
          userName: name,
          plan: planLabel,
          interval,
          priceCents,
          periodEnd: periodEnd ?? new Date().toISOString(),
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

async function handleSubscriptionDeleted(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const user = await loadUserByCustomerId(customerId);
  if (!user) return;

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

async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer as Stripe.Customer | null)?.id;
  if (!customerId) return;

  const billingReason = invoice.billing_reason;

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
      }),
      "payment_failed",
    );
  }
}

// ── Checkout completion handlers ─────────────────────────────────

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
  } else {
    console.warn(`[Webhook] checkout.session.completed unknown product=${product} session=${session.id}`);
  }
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

  await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "credit_pack", credits, payment_intent: paymentIntentId },
  );

  const { data, error } = await supabaseAdmin.rpc("grant_grade_credits", {
    p_user_id: userId,
    p_credits: credits,
    p_reason: "pack_purchase",
    p_stripe_payment_intent: paymentIntentId,
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

  const { error: updateError } = await supabaseAdmin
    .from("submissions")
    .update({
      payment_status: "paid_stripe",
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", submissionId)
    .eq("user_id", userId)
    .eq("payment_status", "unpaid"); // idempotency — don't overwrite if already paid

  // US-397: a dropped "paid" flip leaves a paid grade unprocessed — retry on a
  // transient failure (the update is idempotent: it only matches 'unpaid').
  failIfDbError(updateError, `mark submission ${submissionId} paid`);

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

// ── Refund handler ───────────────────────────────────────────────

async function handleChargeRefunded(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  const userId = charge.metadata?.user_id;
  const product = charge.metadata?.product;

  // US-385: a refunded per-grade purchase must withhold the grade it paid for.
  if (userId && product === "per_grade") {
    await refundPerGrade(event, charge, userId);
    return;
  }

  if (!userId || product !== "credit_pack") {
    // Subscription refunds: Stripe handles them; we just log the event.
    console.log(`[Webhook] charge.refunded product=${product ?? "?"} user=${userId ?? "?"} — no DB change`);
    return;
  }

  const creditsStr = charge.metadata?.credits;
  const credits = Number.parseInt(creditsStr ?? "", 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    console.error(`[Webhook] charge.refunded credit_pack invalid credits metadata`);
    return;
  }

  await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "credit_pack", credits, charge_id: charge.id },
  );

  // US-384: clawing back the credits must actually DEBIT the wallet, not just
  // append a ledger row. The row-locked RPC subtracts from grade_credit_balance,
  // clamps at zero, writes a balance-consistent ledger row, and reports any
  // shortfall (credits already spent before the refund) for reconciliation.
  const paymentIntentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id ?? null;

  const { data, error } = await supabaseAdmin.rpc("revoke_grade_credits", {
    p_user_id: userId,
    p_credits: credits,
    p_stripe_payment_intent: paymentIntentId,
    p_notes: `Refund reversal for charge ${charge.id}`,
    // US-892: share the per-charge idempotency key with the admin-initiated
    // pack-refund flow so the wallet is clawed back EXACTLY ONCE no matter
    // which path runs first (the other no-ops).
    p_idempotency_key: `pack-refund:${charge.id}`,
  });

  // US-397: a dropped refund reversal leaves clawed-back credits in the wallet —
  // retry on a transient failure (revoke is row-locked + clamped, US-384/398).
  failIfDbError(error, `revoke_grade_credits for user ${userId}`);

  const result = (data ?? {}) as {
    revoked?: number;
    shortfall?: number;
    balance_after?: number;
  };
  if ((result.shortfall ?? 0) > 0) {
    // Credits were already spent — the wallet can't go negative, so flag for
    // ops to reconcile (e.g. comp/write-off) rather than failing the refund.
    console.warn(
      `[Webhook] Refund reversal for user ${userId}: revoked ${result.revoked ?? 0}/${credits} ` +
        `credits, ${result.shortfall} already spent (balance_after=${result.balance_after ?? 0}) — needs reconciliation`,
    );
  } else {
    console.log(
      `[Webhook] Refund reversal for user ${userId}: -${result.revoked ?? credits} credits ` +
        `(balance_after=${result.balance_after ?? 0})`,
    );
  }
}

// US-385: a refunded per-grade purchase. Mark the submission refunded, flag it
// for review, and WITHHOLD its public certificate (clearing certificate_id makes
// the public_grade_reports view stop resolving it — US-348). The grade row is
// retained so a human can reconcile; we don't hard-delete a paid artifact.
async function refundPerGrade(
  event: Stripe.Event,
  charge: Stripe.Charge,
  userId: string,
) {
  const submissionId = charge.metadata?.submission_id;
  if (!submissionId) {
    console.error(`[Webhook] per_grade refund missing submission_id (charge=${charge.id})`);
    return;
  }

  await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "per_grade", submission_id: submissionId, charge_id: charge.id },
  );

  // Tenant-scoped by user_id (US-268). maybeSingle + select confirms the
  // submission actually belongs to this user before we touch its grade.
  const { data: updated, error } = await supabaseAdmin
    .from("submissions")
    .update({
      refunded_at: new Date().toISOString(),
      flagged: true,
      flag_reason: "payment_refunded",
    })
    .eq("id", submissionId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();

  // US-397: a dropped refund flag would keep a refunded grade live — retry on a
  // transient failure (the update is idempotent on submission_id+user_id).
  failIfDbError(error, `per_grade refund submission update (${submissionId})`);
  if (!updated) {
    console.warn(`[Webhook] per_grade refund: submission ${submissionId} not found for user ${userId}`);
    return;
  }

  // Withhold the public certificate. The submission was just verified as owned,
  // so updating its grade_reports by submission_id is tenant-safe.
  const { error: certErr } = await supabaseAdmin
    .from("grade_reports")
    .update({ certificate_id: null })
    .eq("submission_id", submissionId);
  // US-397: keeping a refunded grade's certificate live is a trust hole — retry.
  failIfDbError(certErr, `per_grade refund certificate withhold (${submissionId})`);

  console.log(
    `[Webhook] per_grade refund: submission ${submissionId} marked refunded, flagged, cert withheld`,
  );
}

// US-385: chargeback/dispute opened. A dispute can still be WON, so we don't
// auto-revoke here — we record it, flag the submission for review, and surface
// a clear alert for manual handling (evidence submission / decide whether to
// withhold). charge.dispute.closed reconciliation is handled out-of-band by
// ops per the billing runbook.
async function handleChargeDisputeCreated(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  const charge = dispute.charge;
  const chargeId = typeof charge === "string" ? charge : charge?.id ?? null;

  // The dispute carries the PaymentIntent; its metadata mirrors the charge's.
  const meta = (dispute.payment_intent &&
      typeof dispute.payment_intent !== "string"
    ? dispute.payment_intent.metadata
    : undefined) ?? {};
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
      .eq("user_id", userId);
  }

  void captureServer(userId ?? "unknown", "billing.dispute_created", {
    product: product ?? null,
    dispute_id: dispute.id,
    reason: dispute.reason,
  });
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

export function mapSubscriptionInterval(sub: Stripe.Subscription): "monthly" | "yearly" {
  const intvl = sub.items?.data?.[0]?.price?.recurring?.interval;
  return intvl === "year" ? "yearly" : "monthly";
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
