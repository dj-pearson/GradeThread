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

// Accept only same-origin relative paths ("/dashboard/...") for checkout
// return URLs. Rejects absolute URLs, protocol-relative ("//evil.com"), and
// anything not starting with a single "/" to prevent open-redirects.
function sanitizeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.includes("\\") || /[\r\n]/.test(path)) return null;
  return path;
}

// Append query params to a path that may already carry a query string.
function appendQuery(path: string, query: string): string {
  return path.includes("?") ? `${path}&${query}` : `${path}?${query}`;
}

async function loadUser(userId: string) {
  return await supabaseAdmin
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

  // If the user already has a live Stripe subscription, an upgrade or interval
  // change must modify it in place (immediate + prorated) rather than open a
  // second parallel subscription via Checkout. This fires
  // customer.subscription.updated, which the webhook uses to persist the new
  // plan. (Downgrades route through /flipdesk/downgrade instead.)
  if (user.flipdesk_subscription_id && user.subscription_status !== "canceled") {
    try {
      const existing = await stripe.subscriptions.retrieve(
        user.flipdesk_subscription_id,
      );
      const item = existing.items.data[0];
      if (!item) {
        return c.json({ error: "Subscription has no line item to update" }, 500);
      }
      const currentPriceId =
        typeof item.price === "string" ? item.price : item.price?.id;
      if (currentPriceId === priceId) {
        return c.json({ ok: true, updated: true, unchanged: true });
      }
      // An upgrade supersedes any pending downgrade. Stripe rejects mutating a
      // subscription that's still attached to a schedule ("cannot migrate a
      // subscription that is already attached to a schedule"), so release it
      // first — this also cancels the pending downgrade, which is the intent.
      if (existing.schedule) {
        const scheduleId = typeof existing.schedule === "string"
          ? existing.schedule
          : existing.schedule.id;
        await stripe.subscriptionSchedules.release(scheduleId);
      }
      await stripe.subscriptions.update(user.flipdesk_subscription_id, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: "create_prorations",
        // Overwrite plan/interval so mapSubscriptionToFlipdeskPlan reads the new
        // tier from metadata (it prefers metadata.plan over the price lookup_key).
        metadata: {
          ...existing.metadata,
          user_id: userId,
          product: "flipdesk",
          plan,
          interval,
        },
      });
      // Clear any pending downgrade we just superseded (the webhook also clears
      // it when the new plan matches, but do it here so the UI is correct even
      // if that event lags).
      await supabaseAdmin
        .from("users")
        .update({
          pending_flipdesk_plan: null,
          pending_flipdesk_interval: null,
          pending_schedule_id: null,
          pending_effective_at: null,
        })
        .eq("id", userId);
      return c.json({ ok: true, updated: true });
    } catch (err) {
      console.error("FlipDesk subscription update (upgrade) failed:", err);
      return c.json({ error: "Failed to update subscription" }, 500);
    }
  }

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

  let body: { packSize?: unknown; returnPath?: unknown };
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

  // Optional caller-supplied return path (US-207 mid-flow pack purchase): when
  // the user buys a pack from inside the new-submission flow we send them back
  // to the submission so it can auto-retry the payment precedence. Restricted
  // to same-origin relative paths to prevent open-redirects; falls back to the
  // standard Billing return (US-213) otherwise.
  const returnPath = sanitizeReturnPath(body.returnPath);
  const successUrl = returnPath
    ? `${siteUrl()}${appendQuery(returnPath, `checkout=success&product=credit_pack&credits=${packSize}`)}`
    : `${siteUrl()}/dashboard/billing?checkout=success&product=credit_pack&credits=${packSize}`;
  const cancelUrl = returnPath
    ? `${siteUrl()}${appendQuery(returnPath, "checkout=cancelled")}`
    : `${siteUrl()}/dashboard/billing?checkout=cancelled`;

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
      success_url: successUrl,
      cancel_url: cancelUrl,
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
        "pending_flipdesk_plan, pending_flipdesk_interval, pending_effective_at, " +
        "usage_alert_thresholds, last_warning_at",
    )
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }
  // The select list is concatenated (widens to `string`), so Supabase can't
  // infer the row type — cast to the shape we selected.
  const u = user as unknown as {
    flipdesk_plan: string | null;
    flipdesk_interval: string | null;
    subscription_status: string | null;
    flipdesk_period_end: string | null;
    flipdesk_pause_until: string | null;
    flipdesk_cancel_at_period_end: boolean | null;
    trial_ends_at: string | null;
    stripe_customer_id: string | null;
    pending_flipdesk_plan: string | null;
    pending_flipdesk_interval: string | null;
    pending_effective_at: string | null;
    grade_credit_balance: number | null;
    grades_used_this_month: number | null;
    ai_actions_used_this_month: number | null;
    ai_action_limit: number | null;
    usage_alert_thresholds: number[] | null;
    last_warning_at: Record<string, string> | null;
  };

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
      plan: u.flipdesk_plan,
      interval: u.flipdesk_interval,
      status: u.subscription_status,
      period_end: u.flipdesk_period_end,
      pause_until: u.flipdesk_pause_until,
      cancel_at_period_end: u.flipdesk_cancel_at_period_end,
      trial_ends_at: u.trial_ends_at,
      stripe_customer_id: u.stripe_customer_id,
      pending_plan: u.pending_flipdesk_plan,
      pending_interval: u.pending_flipdesk_interval,
      pending_effective_at: u.pending_effective_at,
    },
    grades: {
      credit_balance: u.grade_credit_balance,
      included_used_this_month: u.grades_used_this_month,
    },
    usage: {
      active_listings: activeListingsResult.count ?? 0,
      marketplaces_connected: marketplacesResult.count ?? 0,
      ai_actions_used_this_month: u.ai_actions_used_this_month,
      ai_action_limit: u.ai_action_limit,
    },
    // Soft-upgrade-trigger config (US-209). thresholds default to [80] when the
    // user hasn't customized; last_warning is the per-(cap:threshold) month
    // dedup ledger so the frontend watcher won't re-toast within a month.
    alerts: {
      thresholds: Array.isArray(u.usage_alert_thresholds) && u.usage_alert_thresholds.length > 0
        ? u.usage_alert_thresholds
        : [80],
      last_warning: u.last_warning_at ?? {},
    },
    recent_ledger: ledgerResult.data ?? [],
  });
});

// ── POST /usage-alerts (US-209) ──────────────────────────────────
//
// Body: { thresholds: number[] } — the percentages (out of 100) at which the
// user wants a soft upgrade toast. The Settings chooser offers 50 / 80 / 95.
// We validate the set, dedupe + sort, and persist to users.usage_alert_thresholds.
// An empty array falls back to the default [80] on read.
const ALLOWED_THRESHOLDS = new Set([50, 80, 95]);

paymentRoutes.post("/usage-alerts", async (c) => {
  const userId = c.get("userId");

  let body: { thresholds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.thresholds)) {
    return c.json({ error: "thresholds must be an array of numbers" }, 400);
  }

  const cleaned = Array.from(
    new Set(
      body.thresholds
        .map((t) => Math.round(Number(t)))
        .filter((t) => Number.isFinite(t) && ALLOWED_THRESHOLDS.has(t)),
    ),
  ).sort((a, b) => a - b);

  if (body.thresholds.length > 0 && cleaned.length === 0) {
    return c.json(
      { error: "thresholds must each be one of: 50, 80, 95" },
      400,
    );
  }

  const { error } = await supabaseAdmin
    .from("users")
    .update({ usage_alert_thresholds: cleaned } as never)
    .eq("id", userId);

  if (error) {
    console.error("[usage-alerts] update failed:", error);
    return c.json({ error: "Failed to save usage alert settings" }, 500);
  }

  return c.json({ ok: true, thresholds: cleaned.length > 0 ? cleaned : [80] });
});

// ── POST /usage-alerts/fired (US-209) ────────────────────────────
//
// Body: { cap: string, threshold: number }
// Records that the soft toast for (cap, threshold) fired this calendar month so
// it won't re-fire across devices. The frontend mirrors this to localStorage
// for instant dedup; this server write is the cross-device source of truth.
// Idempotent — re-recording the same (cap, threshold) in the same month is a
// no-op that just rewrites the same value.
paymentRoutes.post("/usage-alerts/fired", async (c) => {
  const userId = c.get("userId");

  let body: { cap?: unknown; threshold?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const cap = typeof body.cap === "string" ? body.cap : "";
  const threshold = Math.round(Number(body.threshold));
  if (!cap || !Number.isFinite(threshold)) {
    return c.json({ error: "cap and threshold are required" }, 400);
  }

  // Read-modify-write the JSON map. Concurrent firings for *different* caps in
  // the same request window could race, but the dedup is best-effort (the
  // localStorage mirror is the primary guard) so a lost write only risks one
  // extra toast — acceptable, and far simpler than a jsonb_set RPC.
  const { data: row, error: readError } = await supabaseAdmin
    .from("users")
    .select("last_warning_at")
    .eq("id", userId)
    .single();

  if (readError || !row) {
    return c.json({ error: "User not found" }, 404);
  }

  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const existing =
    (row as { last_warning_at: Record<string, string> | null }).last_warning_at ?? {};
  const next = { ...existing, [`${cap}:${threshold}`]: month };

  const { error: writeError } = await supabaseAdmin
    .from("users")
    .update({ last_warning_at: next } as never)
    .eq("id", userId);

  if (writeError) {
    console.error("[usage-alerts/fired] update failed:", writeError);
    return c.json({ error: "Failed to record warning" }, 500);
  }

  return c.json({ ok: true, month });
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
    // If a schedule is already attached (a prior pending downgrade), release it
    // first — Stripe rejects creating a second schedule on the same
    // subscription ("cannot migrate a subscription that is already attached to
    // a schedule"). Releasing returns the sub to its current plan with no
    // pending change, which we then re-schedule below to the new target.
    const current = await stripe.subscriptions.retrieve(
      user.flipdesk_subscription_id,
    );
    if (current.schedule) {
      const scheduleId = typeof current.schedule === "string"
        ? current.schedule
        : current.schedule.id;
      await stripe.subscriptionSchedules.release(scheduleId);
    }

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
          items: existingPhase.items.map(
            (it: { price: string | { id: string }; quantity?: number | null }) => ({
              // SDK union: item.price can be string | Price; normalize.
              price: typeof it.price === "string" ? it.price : it.price.id,
              quantity: it.quantity ?? 1,
            }),
          ),
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
