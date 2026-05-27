import { Hono } from "hono";
import type { Context } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";

type PaymentsEnv = {
  Variables: {
    userId: string;
  };
};

export const paymentRoutes = new Hono<PaymentsEnv>();

// ── Catalog (mirrors src/lib/constants.ts US-202 / scripts/setup-stripe-pricing.mjs US-203) ──

const FLIPDESK_PRICE_IDS: Record<
  "starter" | "pro" | "business",
  Record<"monthly" | "yearly", string>
> = {
  starter: {
    monthly: Deno.env.get("STRIPE_PRICE_FLIPDESK_STARTER_MONTHLY") || "",
    yearly:  Deno.env.get("STRIPE_PRICE_FLIPDESK_STARTER_YEARLY")  || "",
  },
  pro: {
    monthly: Deno.env.get("STRIPE_PRICE_FLIPDESK_PRO_MONTHLY") || "",
    yearly:  Deno.env.get("STRIPE_PRICE_FLIPDESK_PRO_YEARLY")  || "",
  },
  business: {
    monthly: Deno.env.get("STRIPE_PRICE_FLIPDESK_BUSINESS_MONTHLY") || "",
    yearly:  Deno.env.get("STRIPE_PRICE_FLIPDESK_BUSINESS_YEARLY")  || "",
  },
};

const GRADE_PRICE_IDS: Record<"standard" | "premium" | "express", string> = {
  standard: Deno.env.get("STRIPE_PRICE_GRADE_STANDARD") || "",
  premium:  Deno.env.get("STRIPE_PRICE_GRADE_PREMIUM")  || "",
  express:  Deno.env.get("STRIPE_PRICE_GRADE_EXPRESS")  || "",
};

const CREDIT_PACK_PRICE_IDS: Record<"10" | "25" | "50" | "100", string> = {
  10:  Deno.env.get("STRIPE_PRICE_CREDITS_10")  || "",
  25:  Deno.env.get("STRIPE_PRICE_CREDITS_25")  || "",
  50:  Deno.env.get("STRIPE_PRICE_CREDITS_50")  || "",
  100: Deno.env.get("STRIPE_PRICE_CREDITS_100") || "",
} as Record<"10" | "25" | "50" | "100", string>;

// Credit-equivalent costs by tier (1 credit = 1 Standard grade).
const TIER_CREDIT_COST: Record<"standard" | "premium" | "express", number> = {
  standard: 1,
  premium: 3,
  express: 5,
};

// Legacy per-grade unit prices kept for /checkout-session backward-compat.
const LEGACY_TIER_PRICES: Record<string, number> = {
  standard: 299,
  premium: 799,
  express: 1299,
};

const LEGACY_TIER_NAMES: Record<string, string> = {
  standard: "Standard Grade",
  premium: "Premium Grade",
  express: "Express Grade",
};

// ── Helpers ──────────────────────────────────────────────────────

type Ctx = Context<PaymentsEnv>;

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    console.error("STRIPE_SECRET_KEY not configured");
    return null;
  }
  return new Stripe(key, { apiVersion: "2024-04-10" });
}

function siteUrl(): string {
  return Deno.env.get("SITE_URL") || "https://gradethread.com";
}

async function loadUser(userId: string) {
  return supabaseAdmin
    .from("users")
    .select(
      "id, email, stripe_customer_id, flipdesk_plan, subscription_status, trial_ends_at, flipdesk_subscription_id",
    )
    .eq("id", userId)
    .single();
}

// ── POST /flipdesk/subscribe (US-204) ────────────────────────────
//
// Body: { plan: 'starter'|'pro'|'business', interval: 'monthly'|'yearly' }
// Creates a Stripe Checkout Session for the matching recurring price.
// If the user has trial_ends_at in the future and never used it, carries
// the remaining trial forward via subscription_data.trial_end (US-219).
paymentRoutes.post("/flipdesk/subscribe", async (c) => {
  const userId = c.get("userId");

  let body: { plan?: string; interval?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const plan = body.plan;
  const interval = body.interval ?? "monthly";

  if (plan !== "starter" && plan !== "pro" && plan !== "business") {
    return c.json({
      error: "plan must be one of: starter, pro, business",
    }, 400);
  }
  if (interval !== "monthly" && interval !== "yearly") {
    return c.json({ error: "interval must be 'monthly' or 'yearly'" }, 400);
  }

  const priceId = FLIPDESK_PRICE_IDS[plan][interval];
  if (!priceId) {
    console.error(`Missing Stripe price ID for ${plan} ${interval}`);
    return c.json({ error: "Pricing not configured" }, 503);
  }

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  // Carry trial forward if the user still has time left and hasn't used a
  // paid subscription yet. flipdesk_subscription_id present = trial was
  // already converted, so we don't grant a second trial.
  let trialEndUnix: number | undefined;
  if (
    user.trial_ends_at &&
    !user.flipdesk_subscription_id &&
    new Date(user.trial_ends_at).getTime() > Date.now()
  ) {
    trialEndUnix = Math.floor(new Date(user.trial_ends_at).getTime() / 1000);
  }

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_id: userId,
        product: "flipdesk",
        plan,
        interval,
      },
      subscription_data: {
        metadata: {
          user_id: userId,
          product: "flipdesk",
          plan,
          interval,
        },
        ...(trialEndUnix ? { trial_end: trialEndUnix } : {}),
      },
      success_url: `${siteUrl()}/dashboard/billing?checkout=success&product=flipdesk`,
      cancel_url: `${siteUrl()}/dashboard/billing?checkout=cancelled`,
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,
      tax_id_collection: { enabled: true },
    };

    if (user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
      sessionParams.customer_update = { name: "auto", address: "auto" };
    } else {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("FlipDesk subscribe checkout failed:", err);
    return c.json({ error: "Failed to create subscription checkout" }, 500);
  }
});

// ── POST /gradethread/credit-pack (US-205) ───────────────────────
//
// Body: { packSize: 10|25|50|100 }
// One-time Checkout that, on success, the webhook (US-206) calls
// grant_grade_credits to add to the user's wallet.
paymentRoutes.post("/gradethread/credit-pack", async (c) => {
  const userId = c.get("userId");

  let body: { packSize?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const packSize = String(body.packSize ?? "") as "10" | "25" | "50" | "100";
  if (!CREDIT_PACK_PRICE_IDS[packSize]) {
    return c.json({
      error: "packSize must be one of: 10, 25, 50, 100",
    }, 400);
  }

  const priceId = CREDIT_PACK_PRICE_IDS[packSize];
  if (!priceId) {
    console.error(`Missing Stripe price ID for credit pack ${packSize}`);
    return c.json({ error: "Pricing not configured" }, 503);
  }

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_id: userId,
        product: "credit_pack",
        credits: packSize,
      },
      payment_intent_data: {
        metadata: {
          user_id: userId,
          product: "credit_pack",
          credits: packSize,
        },
      },
      success_url: `${siteUrl()}/dashboard/billing?checkout=success&product=credit_pack&credits=${packSize}`,
      cancel_url: `${siteUrl()}/dashboard/billing?checkout=cancelled`,
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,
    };

    if (user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
      sessionParams.customer_update = { name: "auto", address: "auto" };
    } else {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Credit pack checkout failed:", err);
    return c.json({ error: "Failed to create credit pack checkout" }, 500);
  }
});

// ── POST /gradethread/per-grade (US-205) ─────────────────────────
//
// Body: { submissionId, tier: 'standard'|'premium'|'express' }
// One-time Checkout that, on success, unlocks just this submission.
async function perGradeCheckout(c: Ctx) {
  const userId = c.get("userId");

  let body: { submissionId?: string; tier?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { submissionId, tier } = body;
  if (!submissionId || typeof submissionId !== "string") {
    return c.json({ error: "submissionId is required" }, 400);
  }
  if (tier !== "standard" && tier !== "premium" && tier !== "express") {
    return c.json({
      error: "tier must be one of: standard, premium, express",
    }, 400);
  }

  const priceId = GRADE_PRICE_IDS[tier];
  if (!priceId) {
    // Pre-Stripe-setup fallback: build a one-off price_data line so
    // local/dev environments without configured price IDs still work.
    console.warn(`Missing Stripe price ID for grade tier ${tier}; using inline price_data`);
  }

  // Verify the submission belongs to this user and isn't already paid.
  const { data: submission, error: submissionError } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, status")
    .eq("id", submissionId)
    .eq("user_id", userId)
    .single();

  if (submissionError || !submission) {
    return c.json({ error: "Submission not found or access denied" }, 404);
  }
  if (submission.status !== "pending") {
    return c.json({ error: "Submission already paid or processing" }, 409);
  }

  const { data: user } = await loadUser(userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: priceId
        ? [{ price: priceId, quantity: 1 }]
        : [{
            price_data: {
              currency: "usd",
              unit_amount: LEGACY_TIER_PRICES[tier],
              product_data: {
                name: LEGACY_TIER_NAMES[tier],
                description: `GradeThread ${LEGACY_TIER_NAMES[tier]}`,
              },
            },
            quantity: 1,
          }],
      metadata: {
        user_id: userId,
        product: "per_grade",
        submission_id: submissionId,
        tier,
        credits_equivalent: String(TIER_CREDIT_COST[tier]),
      },
      payment_intent_data: {
        metadata: {
          user_id: userId,
          product: "per_grade",
          submission_id: submissionId,
          tier,
        },
      },
      success_url: `${siteUrl()}/dashboard/submissions/${submissionId}?payment=success`,
      cancel_url: `${siteUrl()}/dashboard/submissions?payment=cancelled`,
      automatic_tax: priceId ? { enabled: true } : undefined,
      allow_promotion_codes: true,
    };

    if (user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
      sessionParams.customer_update = { name: "auto", address: "auto" };
    } else {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Per-grade checkout failed:", err);
    return c.json({ error: "Failed to create checkout session" }, 500);
  }
}

paymentRoutes.post("/gradethread/per-grade", perGradeCheckout);

// ── Legacy compat aliases ────────────────────────────────────────
// Old frontend code may still POST /api/payments/checkout-session and
// /api/payments/subscribe. Keep them working for one release window.

// Old: POST /checkout-session { submissionId, tier } → identical to /gradethread/per-grade.
paymentRoutes.post("/checkout-session", perGradeCheckout);

// Old: POST /subscribe { plan: 'starter'|'professional' } → maps to the new
// FlipDesk subscribe (professional → pro), monthly interval.
paymentRoutes.post("/subscribe", async (c) => {
  let body: { plan?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const legacy = body.plan;
  const mapped: "starter" | "pro" | "business" | undefined =
    legacy === "professional"
      ? "pro"
      : legacy === "enterprise"
        ? "business"
        : legacy === "starter" || legacy === "pro" || legacy === "business"
          ? legacy
          : undefined;

  if (!mapped) {
    return c.json({
      error: "plan must be one of: starter, professional, enterprise",
    }, 400);
  }

  const userId = c.get("userId");
  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);

  const priceId = FLIPDESK_PRICE_IDS[mapped]?.monthly;
  if (!priceId) {
    console.error(`Missing Stripe price ID for ${mapped} monthly`);
    return c.json({ error: "Pricing not configured" }, 503);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    let trialEndUnix: number | undefined;
    if (
      user.trial_ends_at &&
      !user.flipdesk_subscription_id &&
      new Date(user.trial_ends_at).getTime() > Date.now()
    ) {
      trialEndUnix = Math.floor(new Date(user.trial_ends_at).getTime() / 1000);
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_id: userId,
        product: "flipdesk",
        plan: mapped,
        interval: "monthly",
        legacy_alias: "true",
      },
      subscription_data: {
        metadata: { user_id: userId, product: "flipdesk", plan: mapped, interval: "monthly" },
        ...(trialEndUnix ? { trial_end: trialEndUnix } : {}),
      },
      success_url: `${siteUrl()}/dashboard/billing?checkout=success&product=flipdesk`,
      cancel_url: `${siteUrl()}/dashboard/billing?checkout=cancelled`,
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,
    };

    if (user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
      sessionParams.customer_update = { name: "auto", address: "auto" };
    } else {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Legacy subscribe checkout failed:", err);
    return c.json({ error: "Failed to create subscription checkout" }, 500);
  }
});

// ── GET /billing-summary ─────────────────────────────────────────
//
// Single source of truth for the billing UI (US-211, US-214). Returns:
//   • subscription state (plan, interval, status, period_end, pause_until,
//     cancel_at_period_end, trial_ends_at)
//   • credits balance + included-grades counter
//   • live usage (active listings, marketplaces connected, AI actions)
//   • the last 5 ledger entries
//
// Single round-trip, all RLS-bypassing reads — frontend gets one cache key.
paymentRoutes.get("/billing-summary", async (c) => {
  const userId = c.get("userId");

  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select(
      "flipdesk_plan, flipdesk_interval, subscription_status, " +
        "flipdesk_period_end, flipdesk_pause_until, flipdesk_cancel_at_period_end, " +
        "trial_ends_at, grade_credit_balance, grades_used_this_month, " +
        "ai_actions_used_this_month, ai_action_limit, stripe_customer_id, " +
        "pending_flipdesk_plan, pending_flipdesk_interval, pending_effective_at",
    )
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }

  const [
    activeListingsResult,
    marketplacesResult,
    ledgerResult,
  ] = await Promise.all([
    supabaseAdmin
      .from("inventory_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "listed"),
    supabaseAdmin
      .from("marketplace_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_active", true),
    supabaseAdmin
      .from("grade_credit_transactions")
      .select("id, delta, reason, balance_after, submission_id, notes, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (activeListingsResult.error) {
    console.error("[billing-summary] activeListings query failed:", activeListingsResult.error);
  }
  if (marketplacesResult.error) {
    console.error("[billing-summary] marketplaces query failed:", marketplacesResult.error);
  }
  if (ledgerResult.error) {
    console.error("[billing-summary] ledger query failed:", ledgerResult.error);
  }

  return c.json({
    subscription: {
      plan: user.flipdesk_plan,
      interval: user.flipdesk_interval,
      status: user.subscription_status,
      period_end: user.flipdesk_period_end,
      pause_until: user.flipdesk_pause_until,
      cancel_at_period_end: user.flipdesk_cancel_at_period_end,
      trial_ends_at: user.trial_ends_at,
      stripe_customer_id: user.stripe_customer_id,
      pending_plan: user.pending_flipdesk_plan,
      pending_interval: user.pending_flipdesk_interval,
      pending_effective_at: user.pending_effective_at,
    },
    grades: {
      credit_balance: user.grade_credit_balance,
      included_used_this_month: user.grades_used_this_month,
    },
    usage: {
      active_listings: activeListingsResult.count ?? 0,
      marketplaces_connected: marketplacesResult.count ?? 0,
      ai_actions_used_this_month: user.ai_actions_used_this_month,
      ai_action_limit: user.ai_action_limit,
    },
    recent_ledger: ledgerResult.data ?? [],
  });
});

// ── POST /flipdesk/pause (US-215) ────────────────────────────────
//
// Body: { months: 1 | 2 | 3 }
// Pauses the user's active subscription for N months via Stripe's
// pause_collection. While paused, the user keeps their data + credits but
// their plan-gate caps fall back to Free (handled in services/edge-functions/src/lib/plan-gate.ts).
paymentRoutes.post("/flipdesk/pause", async (c) => {
  const userId = c.get("userId");

  let body: { months?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const months = Number(body.months);
  if (![1, 2, 3].includes(months)) {
    return c.json({ error: "months must be 1, 2, or 3" }, 400);
  }

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.flipdesk_subscription_id) {
    return c.json({ error: "No active subscription to pause" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  const resumesAt = new Date();
  resumesAt.setMonth(resumesAt.getMonth() + months);
  const resumesAtUnix = Math.floor(resumesAt.getTime() / 1000);

  try {
    await stripe.subscriptions.update(user.flipdesk_subscription_id, {
      pause_collection: {
        behavior: "mark_uncollectible",
        resumes_at: resumesAtUnix,
      },
    });
    // Webhook (customer.subscription.updated → paused status) will set the
    // DB columns. We return early; frontend invalidates billing_summary.
    return c.json({ ok: true, resumesAt: resumesAt.toISOString() });
  } catch (err) {
    console.error("Subscription pause failed:", err);
    return c.json({ error: "Failed to pause subscription" }, 500);
  }
});

// ── POST /flipdesk/resume (US-215) ───────────────────────────────
paymentRoutes.post("/flipdesk/resume", async (c) => {
  const userId = c.get("userId");

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.flipdesk_subscription_id) {
    return c.json({ error: "No subscription to resume" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    // Passing pause_collection: '' to subscriptions.update clears the pause.
    // The Stripe Node SDK requires an empty string here (not null/undefined).
    await stripe.subscriptions.update(user.flipdesk_subscription_id, {
      pause_collection: "",
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error("Subscription resume failed:", err);
    return c.json({ error: "Failed to resume subscription" }, 500);
  }
});

// ── POST /flipdesk/cancel (US-216) ───────────────────────────────
//
// Body: { reason?: string }
// Schedules the subscription to cancel at the end of the current period.
// Until then, the user keeps full access. The customer.subscription.deleted
// webhook drops them to Free when the period ends.
paymentRoutes.post("/flipdesk/cancel", async (c) => {
  const userId = c.get("userId");

  let body: { reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : null;

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.flipdesk_subscription_id) {
    return c.json({ error: "No subscription to cancel" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const sub = await stripe.subscriptions.update(user.flipdesk_subscription_id, {
      cancel_at_period_end: true,
      ...(reason
        ? { metadata: { cancellation_reason: reason } }
        : {}),
    });
    // Webhook will reflect cancel_at_period_end=true on the user row.
    return c.json({
      ok: true,
      ends_at: sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null,
    });
  } catch (err) {
    console.error("Subscription cancel failed:", err);
    return c.json({ error: "Failed to cancel subscription" }, 500);
  }
});

// ── POST /flipdesk/downgrade (US-217) ────────────────────────────
//
// Body: { plan: 'starter'|'pro'|'business', interval: 'monthly'|'yearly' }
//
// Creates a Stripe Subscription Schedule with two phases:
//   Phase 1: current plan, ends at current_period_end (preserves what
//            the user already paid for).
//   Phase 2: new (cheaper) plan, starts at current_period_end and runs
//            indefinitely.
//
// The customer.subscription.updated webhook fires when phase 2 activates
// — that's when our DB column flipdesk_plan flips to the new value and
// pending_* columns get cleared.
paymentRoutes.post("/flipdesk/downgrade", async (c) => {
  const userId = c.get("userId");

  let body: { plan?: unknown; interval?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const plan = body.plan as string | undefined;
  const interval = (body.interval as string | undefined) ?? "monthly";

  if (plan !== "starter" && plan !== "pro" && plan !== "business") {
    return c.json({ error: "plan must be one of: starter, pro, business" }, 400);
  }
  if (interval !== "monthly" && interval !== "yearly") {
    return c.json({ error: "interval must be 'monthly' or 'yearly'" }, 400);
  }

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.flipdesk_subscription_id) {
    return c.json({ error: "No subscription to downgrade" }, 400);
  }

  const newPriceId = FLIPDESK_PRICE_IDS[plan][interval];
  if (!newPriceId) {
    return c.json({ error: "Pricing not configured" }, 503);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    // Create a schedule that wraps the current subscription. This copies
    // the current price into phase 1 with a 1-cycle end date (current
    // period end) so we don't have to compute it ourselves.
    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: user.flipdesk_subscription_id,
    });

    const existingPhase = schedule.phases[0];
    if (!existingPhase) {
      return c.json({ error: "Stripe schedule has no initial phase" }, 500);
    }

    // Append a second phase starting where the first one ends.
    const updated = await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release",
      phases: [
        {
          items: existingPhase.items.map((it) => ({
            // SDK union: item.price can be string | Price; normalize.
            price: typeof it.price === "string" ? it.price : it.price.id,
            quantity: it.quantity ?? 1,
          })),
          start_date: existingPhase.start_date,
          end_date: existingPhase.end_date ?? undefined,
        },
        {
          items: [{ price: newPriceId, quantity: 1 }],
          // start_date defaults to previous phase end (proration_behavior=none).
          proration_behavior: "none",
          metadata: {
            user_id: userId,
            product: "flipdesk",
            plan,
            interval,
          },
        },
      ],
      metadata: {
        user_id: userId,
        downgrade_target_plan: plan,
        downgrade_target_interval: interval,
      },
    });

    const effectiveAt = existingPhase.end_date
      ? new Date(existingPhase.end_date * 1000).toISOString()
      : null;

    // Mirror to DB so billing UI can show "Downgrades to <plan> on <date>"
    // without re-querying Stripe on every render.
    await supabaseAdmin
      .from("users")
      .update({
        pending_flipdesk_plan: plan,
        pending_flipdesk_interval: interval,
        pending_schedule_id: updated.id,
        pending_effective_at: effectiveAt,
      })
      .eq("id", userId);

    return c.json({
      ok: true,
      schedule_id: updated.id,
      effective_at: effectiveAt,
      target_plan: plan,
      target_interval: interval,
    });
  } catch (err) {
    console.error("Subscription downgrade failed:", err);
    return c.json({ error: "Failed to schedule downgrade" }, 500);
  }
});

// ── POST /flipdesk/undowngrade (US-217) ──────────────────────────
//
// Releases the schedule so the current subscription continues without
// the phase 2 swap. Stripe lets us release the schedule cleanly.
paymentRoutes.post("/flipdesk/undowngrade", async (c) => {
  const userId = c.get("userId");

  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, pending_schedule_id")
    .eq("id", userId)
    .single();

  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.pending_schedule_id) {
    return c.json({ error: "No pending downgrade to undo" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    await stripe.subscriptionSchedules.release(user.pending_schedule_id);

    await supabaseAdmin
      .from("users")
      .update({
        pending_flipdesk_plan: null,
        pending_flipdesk_interval: null,
        pending_schedule_id: null,
        pending_effective_at: null,
      })
      .eq("id", userId);

    return c.json({ ok: true });
  } catch (err) {
    console.error("Subscription undowngrade failed:", err);
    return c.json({ error: "Failed to undo downgrade" }, 500);
  }
});

// ── POST /flipdesk/uncancel (US-216) ─────────────────────────────
paymentRoutes.post("/flipdesk/uncancel", async (c) => {
  const userId = c.get("userId");

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.flipdesk_subscription_id) {
    return c.json({ error: "No subscription to undo" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    await stripe.subscriptions.update(user.flipdesk_subscription_id, {
      cancel_at_period_end: false,
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error("Subscription undo-cancel failed:", err);
    return c.json({ error: "Failed to undo cancellation" }, 500);
  }
});

// ── POST /portal ──────────────────────────────────────────────────
// Stripe Customer Portal for users who want raw access (escape hatch from
// the in-app billing UI in US-211).
paymentRoutes.post("/portal", async (c) => {
  const userId = c.get("userId");

  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, stripe_customer_id")
    .eq("id", userId)
    .single();

  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.stripe_customer_id) {
    return c.json({ error: "No active subscription found" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${siteUrl()}/dashboard/billing`,
    });
    return c.json({ url: portalSession.url });
  } catch (err) {
    console.error("Stripe portal session creation failed:", err);
    return c.json({ error: "Failed to create billing portal session" }, 500);
  }
});
