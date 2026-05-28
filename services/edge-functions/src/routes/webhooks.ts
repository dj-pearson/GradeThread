import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import { claimWebhookEvent } from "../lib/webhook-idempotency.ts";
import {
  sendCreditPackPurchasedEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCanceledEmail,
  sendSubscriptionPausedEmail,
  sendSubscriptionResumedEmail,
  sendSubscriptionStartedEmail,
} from "../lib/email.ts";

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
// All billing-state mutations flow through this endpoint. Idempotency: every
// event we handle is recorded in public.flipdesk_subscription_events with
// stripe_event_id UNIQUE — duplicate deliveries short-circuit early.
//
// Handlers must be best-effort: log + return 200 on internal errors so
// Stripe doesn't pile up retries that won't succeed without code changes.
// Signature failures DO return 400 so Stripe surfaces a real misconfiguration.
webhookRoutes.post("/stripe", async (c) => {
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!stripeSecretKey || !webhookSecret) {
    console.error("[Webhook] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not configured");
    return c.json({ error: "Webhook not configured" }, 503);
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-04-10" });

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

  // Idempotency: skip duplicate deliveries before any side effects run. Stripe
  // retries the same event.id for up to 72h, so dedup (not timestamp rejection)
  // is the correct replay defense here. (US-277)
  if (!(await claimWebhookEvent("stripe", event.id, event.type))) {
    console.log(`[Webhook] duplicate ${event.type} (${event.id}) — skipping`);
    return c.json({ received: true, duplicate: true });
  }

  try {
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

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook] Error handling ${event.type} (${event.id}): ${message}`);
    // 200 anyway — Stripe retrying won't fix code-level bugs.
  }

  return c.json({ received: true });
});

// ── Idempotency helper ───────────────────────────────────────────
type FlipdeskPlan = "free" | "starter" | "pro" | "business";

/**
 * Records the event and returns true if this is the first time we've seen
 * the event_id. Returns false on duplicate delivery so the caller can skip.
 */
async function recordEvent(
  userId: string,
  eventType: string,
  stripeEventId: string,
  fromPlan: FlipdeskPlan | null,
  toPlan: FlipdeskPlan | null,
  rawPayload: Record<string, unknown>,
): Promise<boolean> {
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

  if (error) {
    // 23505 = unique_violation on stripe_event_id → already processed.
    if (error.code === "23505") {
      console.log(`[Webhook] Duplicate event ${stripeEventId} — skipping`);
      return false;
    }
    console.error(`[Webhook] Failed to record event ${stripeEventId}:`, error);
    // Continue processing anyway — better to act than to drop.
  }
  return true;
}

const USER_SELECT =
  "id, email, full_name, flipdesk_plan, stripe_customer_id, trial_ends_at, flipdesk_subscription_id, flipdesk_cancel_at_period_end, pending_flipdesk_plan, flipdesk_pause_until";

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

  const plan = mapSubscriptionToFlipdeskPlan(sub);
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

  const proceed = await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    plan,
    { subscription_id: sub.id, status: sub.status, plan, interval },
  );
  if (!proceed) return;

  // If Stripe set trial_end on a new subscription, persist it (one trial ever).
  const trialEndsAtUpdate =
    sub.trial_end && !user.trial_ends_at
      ? new Date(sub.trial_end * 1000).toISOString()
      : undefined;

  // Clear a pending downgrade ONLY when the plan has actually transitioned to
  // the scheduled target (the Subscription Schedule's phase 2 activated —
  // US-217). Comparing the new plan against the stored pending plan avoids the
  // false positive where merely *attaching* a schedule fires
  // subscription.updated while the current plan is still unchanged — the old
  // `metadata.plan === plan` check matched there (business === business) and
  // wiped the pending state before the user ever saw the "Downgrade scheduled"
  // banner.
  const pendingCleared =
    !!user.pending_flipdesk_plan && plan === user.pending_flipdesk_plan;

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
      stripe_customer_id: customerId,
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

  if (error) {
    console.error(`[Webhook] Failed to update user ${user.id} subscription:`, error);
    return;
  }

  console.log(
    `[Webhook] User ${user.id} → plan=${plan} interval=${interval} status=${status}`,
  );

  // Emails (best-effort, never fail the webhook).
  if (user.email) {
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    const name = userDisplayName(user.email, user.full_name);

    // First-time subscription → welcome-to-paid email.
    if (event.type === "customer.subscription.created" && status !== "trialing") {
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

  const proceed = await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    "free",
    { subscription_id: sub.id },
  );
  if (!proceed) return;

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

  if (error) {
    console.error(`[Webhook] Failed to downgrade user ${user.id}:`, error);
    return;
  }

  // Credit balance intentionally untouched (US-200 / US-216).
  console.log(`[Webhook] User ${user.id} → free (canceled)`);
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

  const proceed = await recordEvent(
    user.id,
    event.type,
    event.id,
    user.flipdesk_plan,
    user.flipdesk_plan,
    { invoice_id: invoice.id, billing_reason: billingReason },
  );
  if (!proceed) return;

  // On subscription create or renewal, reset the included-grades + AI counters
  // for the new billing cycle. Other invoice reasons (manual, upcoming, etc.)
  // don't reset.
  if (billingReason === "subscription_create" || billingReason === "subscription_cycle") {
    const now = new Date().toISOString();
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1);
    const { error } = await supabaseAdmin
      .from("users")
      .update({
        grades_used_this_month: 0,
        grade_reset_at: nextReset.toISOString(),
        ai_actions_used_this_month: 0,
        ai_actions_reset_at: now,
        subscription_status: "active",
      })
      .eq("id", user.id);

    if (error) {
      console.error(`[Webhook] Failed to reset monthly counters for ${user.id}:`, error);
      return;
    }
    console.log(`[Webhook] User ${user.id} cycle reset (${billingReason})`);
  } else {
    // Any successful payment clears past_due → active.
    await supabaseAdmin
      .from("users")
      .update({ subscription_status: "active" })
      .eq("id", user.id);
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

  const proceed = await recordEvent(
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
  if (!proceed) return;

  await supabaseAdmin
    .from("users")
    .update({ subscription_status: "past_due" })
    .eq("id", user.id);

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
  // We still want to attach the customer id to the user the first time.
  if (session.mode === "subscription" && session.customer) {
    const customerId = typeof session.customer === "string"
      ? session.customer
      : session.customer.id;
    await supabaseAdmin
      .from("users")
      .update({ stripe_customer_id: customerId })
      .eq("id", userId)
      .is("stripe_customer_id", null);
    return;
  }

  if (session.mode !== "payment") return;

  // Attach customer id on first one-time purchase too.
  if (session.customer) {
    const customerId = typeof session.customer === "string"
      ? session.customer
      : session.customer.id;
    await supabaseAdmin
      .from("users")
      .update({ stripe_customer_id: customerId })
      .eq("id", userId)
      .is("stripe_customer_id", null);
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

  const proceed = await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "credit_pack", credits, payment_intent: paymentIntentId },
  );
  if (!proceed) return;

  const { data, error } = await supabaseAdmin.rpc("grant_grade_credits", {
    p_user_id: userId,
    p_credits: credits,
    p_reason: "pack_purchase",
    p_stripe_payment_intent: paymentIntentId,
    p_notes: `Pack of ${credits} credits via session ${session.id}`,
  });

  if (error) {
    console.error(`[Webhook] grant_grade_credits failed for user ${userId}:`, error);
    return;
  }
  const newBalance = typeof data === "number" ? data : credits;
  console.log(`[Webhook] Granted ${credits} credits to user ${userId}, new balance=${newBalance}`);

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

  const proceed = await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "per_grade", submission_id: submissionId, tier },
  );
  if (!proceed) return;

  const { error: updateError } = await supabaseAdmin
    .from("submissions")
    .update({
      payment_status: "paid_stripe",
      paid_at: new Date().toISOString(),
    })
    .eq("id", submissionId)
    .eq("user_id", userId)
    .eq("payment_status", "unpaid"); // idempotency — don't overwrite if already paid

  if (updateError) {
    console.error(`[Webhook] Failed to mark submission ${submissionId} paid:`, updateError);
    return;
  }

  console.log(`[Webhook] Submission ${submissionId} paid (${tier}); kicking grading pipeline`);

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

  const proceed = await recordEvent(
    userId,
    event.type,
    event.id,
    null,
    null,
    { product: "credit_pack", credits, charge_id: charge.id },
  );
  if (!proceed) return;

  // Ledger reversal. NOTE: this could push balance negative if the user has
  // already spent the credits. The DB CHECK constraint will block that, so
  // we attempt the debit and log if it fails; ops can comp manually.
  const { error } = await supabaseAdmin
    .from("grade_credit_transactions")
    .insert({
      user_id: userId,
      delta: -credits,
      reason: "refund",
      // balance_after is computed by the function for grants/debits; for
      // direct reversal inserts we just snapshot the current balance.
      balance_after: 0,
      stripe_payment_intent_id: typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id ?? null,
      notes: `Refund reversal for charge ${charge.id}`,
    });

  if (error) {
    console.error(`[Webhook] Refund reversal insert failed for user ${userId}:`, error);
  } else {
    console.log(`[Webhook] Refund reversal logged for user ${userId}: -${credits} credits`);
  }
}

// ── Mappers ──────────────────────────────────────────────────────

function mapSubscriptionToFlipdeskPlan(sub: Stripe.Subscription): FlipdeskPlan {
  // Prefer the metadata.plan we set at checkout (US-204).
  const meta = sub.metadata?.plan;
  if (meta === "starter" || meta === "pro" || meta === "business") return meta;

  // Fall back to lookup_key on the first price.
  const item = sub.items?.data?.[0];
  const lookupKey = item?.price?.lookup_key ?? "";
  if (lookupKey.startsWith("flipdesk_business")) return "business";
  if (lookupKey.startsWith("flipdesk_pro")) return "pro";
  if (lookupKey.startsWith("flipdesk_starter")) return "starter";

  // Last resort: amount-based heuristic.
  const amount = item?.price?.unit_amount ?? 0;
  if (amount >= 9900) return "business";
  if (amount >= 5900) return "pro";
  if (amount >= 2900) return "starter";
  console.warn(`[Webhook] Unmapped subscription price ${item?.price?.id} (amount=${amount}); defaulting to starter`);
  return "starter";
}

function mapSubscriptionInterval(sub: Stripe.Subscription): "monthly" | "yearly" {
  const intvl = sub.items?.data?.[0]?.price?.recurring?.interval;
  return intvl === "year" ? "yearly" : "monthly";
}

function mapSubscriptionStatus(
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
    case "incomplete":
    default: return "active"; // Stripe will transition this shortly.
  }
}
