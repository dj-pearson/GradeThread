import { Hono } from "hono";
import type { Context } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { isProduction } from "../lib/env.ts";
import { captureServer } from "../lib/posthog.ts";
import { emitEvent } from "../lib/user-events.ts";
import { customerCreateIdempotencyKey } from "../lib/stripe-customer.ts";
import { getBuyerPriceIds, getFlipdeskPriceIds } from "../lib/pricing-config.ts";
import { effectiveAiActionsUsed } from "../lib/ai-metering.ts";
import { API_OVERAGE_PACKS, isApiOveragePackKey } from "../lib/api-overage-packs.ts";
import { appstoreSubscriptionBlocksStripe } from "../lib/appstore/precedence.ts";
import { CATALOG_VERSION, serializeCatalog } from "../lib/appstore/products.ts";

type PaymentsEnv = {
  Variables: {
    userId: string;
    // US-1637: set by workspaceMiddleware (mounted on /api/payments/*). Equals
    // userId for a solo user / the owner; for a member acting in someone else's
    // workspace it's the OWNER's id. Per-grade checkout scopes the submission
    // ownership check + the paid-flip to this, so a member's submissions (stored
    // user_id = ownerId) aren't stranded with a 404.
    workspaceOwnerId?: string;
  };
};

export const paymentRoutes = new Hono<PaymentsEnv>();

// US-394: deterministic idempotency key for per-grade Checkout. A submission is
// single-use (status leaves 'pending' once paid), so keying on
// (user, submission, tier) makes a double-click or retry within Stripe's 24h
// window reuse ONE session instead of creating duplicate payable sessions.
export function perGradeIdempotencyKey(
  userId: string,
  submissionId: string,
  tier: string,
): string {
  return `per-grade:${userId}:${submissionId}:${tier}`;
}

// US-1469: credit packs are *repeatable* purchases, so — unlike per-grade and
// subscribe — a stable key would wrongly dedupe a legitimate later repurchase
// within Stripe's 24h replay window. Instead we floor time into a short coarse
// bucket: a double-click / client retry within the same window collapses to ONE
// session, while a deliberate repurchase in a later window gets a fresh key. The
// window is intentionally short so an intentional second buy only has to wait it
// out, but a sub-second double-submit is reliably absorbed.
export const CREDIT_PACK_IDEMPOTENCY_WINDOW_MS = 60_000;

export function creditPackIdempotencyKey(
  userId: string,
  packSize: string | number,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / CREDIT_PACK_IDEMPOTENCY_WINDOW_MS);
  return `credit-pack:${userId}:${packSize}:${bucket}`;
}

// ── Catalog (mirrors src/lib/constants.ts US-202 / scripts/setup-stripe-pricing.mjs US-203) ──
//
// US-587: FlipDesk subscription price IDs are now data-driven — loaded per-request
// via getFlipdeskPriceIds() (DB pricing_plans with env fallback) so a price-ID
// change in admin doesn't need a redeploy. Per-grade + credit-pack price IDs stay
// env-driven below (not yet plan-editable).

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
  return new Stripe(key, { apiVersion: "2024-04-10", timeout: 20_000, maxNetworkRetries: 2 });
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
      "id, email, full_name, stripe_customer_id, flipdesk_plan, subscription_status, trial_ends_at, flipdesk_subscription_id, billing_source, pending_referral_coupon, pending_drip_coupon, pending_drip_coupon_expires_at, buyer_plan, buyer_interval, buyer_subscription_status, buyer_subscription_id, buyer_period_end, buyer_cancel_at_period_end",
    )
    .eq("id", userId)
    .single();
}

// True when a Stripe error is "this object doesn't exist under the current
// API keys" — i.e. a stored id that 404s. The canonical signal is the live →
// test (or test → live) key switch: every test-mode `cus_…` reads back as
// resource_missing under live keys. A genuinely deleted customer is the same.
function isStripeResourceMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "resource_missing"
  );
}

// US-391: lazily ensure EXACTLY ONE Stripe customer per user, persisted before
// the first Checkout and reused on every later session. Two concurrent first
// checkouts previously each omitted `customer`, so Stripe minted two customers
// and the post-hoc back-fill (.is(null)) kept only one — orphaning the other
// and risking a lost customer↔user link. Now:
//   • If we already have a customer id, reuse it ONLY if it still resolves
//     under the current Stripe keys; otherwise heal the stale id (below).
//   • Otherwise create one with a STABLE idempotency key (`customer-create:<uid>`)
//     so even a true race resolves to a SINGLE Stripe customer, then persist it
//     conditionally; if another request won the race, adopt the persisted id.
async function ensureStripeCustomer(
  stripe: Stripe,
  user: {
    id: string;
    email: string | null;
    full_name?: string | null;
    stripe_customer_id: string | null;
  },
): Promise<string> {
  // Self-heal stale customer ids. After the Stripe test→live cutover, every
  // sandbox `cus_…` we persisted 404s under the live keys, which would make
  // checkout / subscribe / billing-portal throw "No such customer". Validate
  // the stored id; on resource_missing (or a deleted customer) mint a fresh
  // live customer and overwrite the stale id. Transient/other Stripe errors
  // bubble up unchanged (never silently re-create on a network blip).
  if (user.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(user.stripe_customer_id);
      if (!(existing as Stripe.DeletedCustomer).deleted) {
        return user.stripe_customer_id;
      }
    } catch (err) {
      if (!isStripeResourceMissing(err)) throw err;
    }
    const replacement = await stripe.customers.create({
      email: user.email ?? undefined,
      name: user.full_name ?? undefined,
      metadata: { user_id: user.id },
    });
    await supabaseAdmin
      .from("users")
      .update({ stripe_customer_id: replacement.id })
      .eq("id", user.id);
    console.warn(
      `[stripe] user ${user.id}: stored customer ${user.stripe_customer_id} ` +
        `not found under current keys; re-linked to ${replacement.id}`,
    );
    return replacement.id;
  }

  const customer = await stripe.customers.create(
    {
      email: user.email ?? undefined,
      name: user.full_name ?? undefined,
      metadata: { user_id: user.id },
    },
    { idempotencyKey: customerCreateIdempotencyKey(user.id) },
  );

  // Persist only if still unset. If our conditional update matches no row,
  // another concurrent request already linked a customer — adopt that one. The
  // shared idempotency key means Stripe returned the SAME customer to both
  // racers, so there is no orphaned duplicate.
  const { data: linked } = await supabaseAdmin
    .from("users")
    .update({ stripe_customer_id: customer.id })
    .eq("id", user.id)
    .is("stripe_customer_id", null)
    .select("stripe_customer_id")
    .maybeSingle();
  if (linked?.stripe_customer_id) return linked.stripe_customer_id;

  const { data: fresh } = await supabaseAdmin
    .from("users")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .single();
  return fresh?.stripe_customer_id ?? customer.id;
}

// US-400: the shape the billing UI renders for the next charge.
export interface UpcomingInvoice {
  amount_cents: number;
  currency: string;
  next_payment_at: string | null;
}

// US-400: fetch the subscription's real upcoming invoice from Stripe so the UI
// shows what will ACTUALLY be billed (coupons, grandfathered prices, prorations)
// rather than the static FLIPDESK_PLANS table. Returns null for users without a
// subscription and degrades gracefully (null) if Stripe is unavailable — the UI
// then falls back to the plan-table price.
async function fetchUpcomingInvoice(
  customerId: string | null,
  subscriptionId: string | null,
): Promise<UpcomingInvoice | null> {
  if (!customerId || !subscriptionId) return null;
  const stripe = getStripe();
  if (!stripe) return null;
  try {
    // stripe-node v15: invoices.retrieveUpcoming. Scope to the subscription so a
    // customer with multiple products gets the right line.
    const inv = await stripe.invoices.retrieveUpcoming({
      customer: customerId,
      subscription: subscriptionId,
    });
    const nextAt = inv.next_payment_attempt ?? inv.period_end ?? null;
    return {
      amount_cents: inv.amount_due,
      currency: inv.currency,
      next_payment_at: nextAt ? new Date(nextAt * 1000).toISOString() : null,
    };
  } catch (err) {
    // No upcoming invoice (canceled/ended) or a transient Stripe error → null.
    console.error("[billing-summary] upcoming invoice fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
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
  // US-2118: an in-place upgrade charges a prorated amount immediately. Unlike a
  // new subscription (which passes through Stripe Checkout's price disclosure),
  // this path has no interstitial, so the mutation MUST NOT fire until the client
  // has shown the confirmation dialog and echoes back confirmUpgrade:true.
  const confirmUpgrade = (body as { confirmUpgrade?: boolean }).confirmUpgrade === true;

  if (plan !== "starter" && plan !== "pro" && plan !== "business") {
    return c.json({
      error: "plan must be one of: starter, pro, business",
    }, 400);
  }
  if (interval !== "monthly" && interval !== "yearly") {
    return c.json({ error: "interval must be 'monthly' or 'yearly'" }, 400);
  }

  const FLIPDESK_PRICE_IDS = await getFlipdeskPriceIds();
  const priceId = FLIPDESK_PRICE_IDS[plan][interval];
  if (!priceId) {
    console.error(`Missing Stripe price ID for ${plan} ${interval}`);
    return c.json({ error: "Pricing not configured" }, 503);
  }

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }

  // Don't let a Stripe subscription stack on top of an active App Store one
  // (avoids double-billing). The user must manage that plan in the iOS app.
  if (appstoreSubscriptionBlocksStripe(user)) {
    return c.json({ error: "ACTIVE_APPSTORE_SUBSCRIPTION", action: "manage_in_app" }, 409);
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
      // US-2118: the price is actually changing, so this click WOULD charge a
      // prorated amount now. Refuse until the client has disclosed the amount and
      // captured consent (confirmUpgrade:true). The click alone can no longer buy.
      if (!confirmUpgrade) {
        return c.json({
          error: "Confirmation required before an in-place plan change.",
          code: "UPGRADE_CONFIRMATION_REQUIRED",
          requiresConfirmation: true,
        }, 409);
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
      // US-2118 (AC2): record the affirmative-consent artifact for the in-place
      // change — the equivalent of the disclosure a new subscriber sees on the
      // Stripe Checkout page. Best-effort: the plan change already succeeded, so a
      // logging failure must not fail the request (captured, not thrown).
      const { error: consentErr } = await supabaseAdmin
        .from("flipdesk_subscription_events")
        .insert({
          user_id: userId,
          event_type: "in_place_change_confirmed",
          from_plan: (user as { flipdesk_plan?: string | null }).flipdesk_plan ?? null,
          to_plan: plan,
          raw_payload: {
            interval,
            new_price_id: priceId,
            previous_price_id: currentPriceId,
            proration_behavior: "create_prorations",
            confirmed: true,
            source: "flipdesk_plan_picker",
          },
        });
      if (consentErr) {
        console.error("[flipdesk/subscribe] consent-artifact insert failed:", consentErr.message);
      }
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
      // US-389: automatic_tax needs a customer address to compute tax. A brand
      // new customer has none on file, so require it at checkout.
      billing_address_collection: "required",
      allow_promotion_codes: true,
      tax_id_collection: { enabled: true },
    };

    // US-1070: a referred new user may carry a free-month coupon from their
    // signup incentive. Apply it as a session discount so the welcome offer is
    // reflected at checkout. Stripe rejects `discounts` + `allow_promotion_codes`
    // together, so the auto-applied incentive takes precedence over a manual
    // promo box for this first subscription. The webhook clears the pending
    // coupon once the subscription is created, so it's a one-time offer.
    const pendingCoupon = (user as { pending_referral_coupon?: string | null })
      .pending_referral_coupon;
    if (pendingCoupon) {
      delete sessionParams.allow_promotion_codes;
      sessionParams.discounts = [{ coupon: pendingCoupon }];
    }

    // US-942: a win-back drip recipient may carry a time-boxed conversion
    // incentive coupon. Pre-apply it for one-click conversion — but only if the
    // referral incentive didn't already claim the single discount slot, the
    // offer hasn't expired, and the user isn't already paid (the same
    // post-trial-only / never-already-paid guardrail the engine enforces). The
    // webhook clears it once the subscription is created (one-time offer).
    if (!sessionParams.discounts) {
      const dripUser = user as {
        pending_drip_coupon?: string | null;
        pending_drip_coupon_expires_at?: string | null;
      };
      const dripCoupon = dripUser.pending_drip_coupon;
      const dripExpiry = dripUser.pending_drip_coupon_expires_at;
      const notExpired = !dripExpiry || new Date(dripExpiry).getTime() > Date.now();
      const notAlreadyPaid = user.subscription_status !== "active";
      if (dripCoupon && notExpired && notAlreadyPaid) {
        delete sessionParams.allow_promotion_codes;
        sessionParams.discounts = [{ coupon: dripCoupon }];
      }
    }

    // US-391: always bind the session to the user's single Stripe customer
    // (created lazily here if needed) so every session reuses one customer.
    sessionParams.customer = await ensureStripeCustomer(stripe, user);
    sessionParams.customer_update = { name: "auto", address: "auto" };

    // US-391: stable idempotency key dedupes a double-clicked subscribe within
    // Stripe's 24h window (a user has at most one active subscription, so this
    // can't block a legitimate distinct purchase the way it would for packs).
    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: `flipdesk-subscribe:${userId}:${plan}:${interval}`,
    });
    // US-932: record checkout intent to the internal event stream (drip trigger
    // substrate) — drives a "started but didn't convert" nudge. Fire-and-forget.
    void emitEvent(userId, "checkout_started", {
      properties: { kind: "subscribe", plan, interval },
    });
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("FlipDesk subscribe checkout failed:", err);
    return c.json({ error: "Failed to create subscription checkout" }, 500);
  }
});

// US-2118: proration preview for an in-place plan change. The plan picker calls
// this BEFORE the (now confirmation-gated) /flipdesk/subscribe so the dialog can
// disclose the real amount charged today, the new recurring amount + interval,
// and the next renewal date — the numbers a new subscriber sees on Stripe
// Checkout. Returns { inPlace:false } when there's no live subscription to
// modify (that's a fresh Checkout, which discloses on its own hosted page).
paymentRoutes.post("/flipdesk/upgrade-preview", async (c) => {
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
    return c.json({ error: "plan must be one of: starter, pro, business" }, 400);
  }
  if (interval !== "monthly" && interval !== "yearly") {
    return c.json({ error: "interval must be 'monthly' or 'yearly'" }, 400);
  }

  const FLIPDESK_PRICE_IDS = await getFlipdeskPriceIds();
  const priceId = FLIPDESK_PRICE_IDS[plan][interval];
  if (!priceId) return c.json({ error: "Pricing not configured" }, 503);

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);

  // No live subscription → a fresh Checkout will disclose the price itself.
  if (!user.flipdesk_subscription_id || user.subscription_status === "canceled") {
    return c.json({ inPlace: false });
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const existing = await stripe.subscriptions.retrieve(user.flipdesk_subscription_id);
    const item = existing.items.data[0];
    if (!item) return c.json({ error: "Subscription has no line item" }, 500);
    const currentPriceId = typeof item.price === "string" ? item.price : item.price?.id;
    if (currentPriceId === priceId) {
      return c.json({ inPlace: true, unchanged: true });
    }

    // Simulate the item swap so amount_due reflects the immediate proration.
    const preview = await stripe.invoices.retrieveUpcoming({
      customer: typeof existing.customer === "string"
        ? existing.customer
        : existing.customer.id,
      subscription: existing.id,
      subscription_items: [{ id: item.id, price: priceId }],
      subscription_proration_behavior: "create_prorations",
    });
    // The new recurring amount is the target price's unit amount (proration is a
    // one-off; this is what recurs each period after).
    const newPrice = await stripe.prices.retrieve(priceId);

    return c.json({
      inPlace: true,
      amount_due_today_cents: preview.amount_due,
      currency: preview.currency,
      new_recurring_cents: newPrice.unit_amount ?? null,
      interval,
      next_renewal_at: existing.current_period_end
        ? new Date(existing.current_period_end * 1000).toISOString()
        : null,
    });
  } catch (err) {
    console.error("FlipDesk upgrade-preview failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Couldn't preview the plan change" }, 502);
  }
});

// US-1799: buyer subscription checkout (Guard / Connoisseur). Mirrors the
// FlipDesk subscribe path but writes the BUYER product on the SAME Stripe
// customer, keyed off buyer_subscription_id — so a person can hold a buyer AND a
// seller sub without collision. metadata.product="buyer" lets the webhook branch.
paymentRoutes.post("/buyer/subscribe", async (c) => {
  const userId = c.get("userId");

  let body: { plan?: string; interval?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const plan = body.plan;
  const interval = body.interval ?? "monthly";
  if (plan !== "guard" && plan !== "connoisseur") {
    return c.json({ error: "plan must be one of: guard, connoisseur" }, 400);
  }
  if (interval !== "monthly" && interval !== "yearly") {
    return c.json({ error: "interval must be 'monthly' or 'yearly'" }, 400);
  }

  const priceId = getBuyerPriceIds()[plan][interval];
  if (!priceId) {
    console.error(`Missing Stripe price ID for buyer ${plan} ${interval}`);
    return c.json({ error: "Pricing not configured" }, 503);
  }

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  // In-place upgrade / interval change when a live buyer sub already exists —
  // keyed off buyer_subscription_id so it can NEVER mutate the seller sub.
  if (user.buyer_subscription_id && user.buyer_subscription_status !== "canceled") {
    try {
      const existing = await stripe.subscriptions.retrieve(user.buyer_subscription_id);
      const item = existing.items.data[0];
      if (!item) return c.json({ error: "Subscription has no line item to update" }, 500);
      const currentPriceId = typeof item.price === "string" ? item.price : item.price?.id;
      if (currentPriceId === priceId) return c.json({ ok: true, updated: true, unchanged: true });
      if (existing.schedule) {
        const scheduleId = typeof existing.schedule === "string" ? existing.schedule : existing.schedule.id;
        await stripe.subscriptionSchedules.release(scheduleId);
      }
      await stripe.subscriptions.update(user.buyer_subscription_id, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: "create_prorations",
        metadata: { ...existing.metadata, user_id: userId, product: "buyer", plan, interval },
      });
      return c.json({ ok: true, updated: true });
    } catch (err) {
      console.error("Buyer subscription update (upgrade) failed:", err);
      return c.json({ error: "Failed to update subscription" }, 500);
    }
  }

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: userId, product: "buyer", plan, interval },
      subscription_data: { metadata: { user_id: userId, product: "buyer", plan, interval } },
      success_url: `${siteUrl()}/buyer/billing?checkout=success&product=buyer`,
      cancel_url: `${siteUrl()}/buyer/billing?checkout=cancelled`,
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      allow_promotion_codes: true,
      tax_id_collection: { enabled: true },
    };
    // SAME single customer as the seller sub (created lazily if needed).
    sessionParams.customer = await ensureStripeCustomer(stripe, user);
    sessionParams.customer_update = { name: "auto", address: "auto" };

    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: `buyer-subscribe:${userId}:${plan}:${interval}`,
    });
    void emitEvent(userId, "checkout_started", {
      properties: { kind: "buyer_subscribe", plan, interval },
    });
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Buyer subscribe checkout failed:", err);
    return c.json({ error: "Failed to create subscription checkout" }, 500);
  }
});

// US-1799: cancel the buyer subscription at period end (keeps access until the
// paid period ends; the webhook flips buyer_cancel_at_period_end + eventually
// deletes → free). Scoped to buyer_subscription_id.
paymentRoutes.post("/buyer/cancel", async (c) => {
  const userId = c.get("userId");
  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.buyer_subscription_id || user.buyer_subscription_status === "canceled") {
    return c.json({ error: "No active buyer subscription" }, 400);
  }
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);
  try {
    await stripe.subscriptions.update(user.buyer_subscription_id, { cancel_at_period_end: true });
    // Optimistic — the subscription.updated webhook is authoritative.
    await supabaseAdmin.from("users").update({ buyer_cancel_at_period_end: true }).eq("id", userId);
    return c.json({ ok: true, cancel_at_period_end: true });
  } catch (err) {
    console.error("Buyer cancel failed:", err);
    return c.json({ error: "Failed to cancel subscription" }, 500);
  }
});

// US-1799: undo a scheduled buyer cancellation before the period ends.
paymentRoutes.post("/buyer/uncancel", async (c) => {
  const userId = c.get("userId");
  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  if (!user.buyer_subscription_id) return c.json({ error: "No buyer subscription" }, 400);
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);
  try {
    await stripe.subscriptions.update(user.buyer_subscription_id, { cancel_at_period_end: false });
    await supabaseAdmin.from("users").update({ buyer_cancel_at_period_end: false }).eq("id", userId);
    return c.json({ ok: true, cancel_at_period_end: false });
  } catch (err) {
    console.error("Buyer uncancel failed:", err);
    return c.json({ error: "Failed to resume subscription" }, 500);
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
      // US-389: collect a billing address so automatic_tax can be computed.
      billing_address_collection: "required",
      allow_promotion_codes: true,
    };

    // US-391: bind to the single Stripe customer (created/validated lazily)
    // instead of letting Checkout mint a fresh one. ensureStripeCustomer also
    // self-heals a stale test-mode id after the live cutover.
    sessionParams.customer = await ensureStripeCustomer(stripe, user);
    sessionParams.customer_update = { name: "auto", address: "auto" };

    // US-1469: short-window idempotency key (user, packSize, coarse time bucket)
    // so a double-submit or client retry reuses ONE Checkout Session instead of
    // creating multiple distinct payable sessions, while a deliberate later
    // repurchase still gets its own session. See creditPackIdempotencyKey above.
    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: creditPackIdempotencyKey(userId, packSize),
    });
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Credit pack checkout failed:", err);
    return c.json({ error: "Failed to create credit pack checkout" }, 500);
  }
});

// ── POST /api-overage/checkout (US-1792) ─────────────────────────
//
// Body: { pack: "10"|"50"|"100"|"200" }. One-time Checkout for a B2B API overage
// credit pack; on success the webhook (handleCheckoutCompleted, product=
// "api_overage") grants api_credit_wallet credits that a key draws down when it
// exceeds its monthly quota. Never-expiring, volume-discounted (API_OVERAGE_PACKS).
paymentRoutes.post("/api-overage/checkout", async (c) => {
  const userId = c.get("userId");

  let body: { pack?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const packKey = String(body.pack ?? "");
  if (!isApiOveragePackKey(packKey)) {
    return c.json({ error: "pack must be one of: 10, 50, 100, 200" }, 400);
  }
  const pack = API_OVERAGE_PACKS[packKey];
  const priceId = Deno.env.get(pack.priceEnv) || "";
  if (!priceId) {
    console.error(`Missing Stripe price ID for API overage pack ${packKey}`);
    return c.json({ error: "Pricing not configured" }, 503);
  }

  const { data: user, error: userError } = await loadUser(userId);
  if (userError || !user) return c.json({ error: "User not found" }, 404);
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_id: userId,
        product: "api_overage",
        pack: packKey,
        credits: String(pack.credits),
      },
      payment_intent_data: {
        metadata: { user_id: userId, product: "api_overage", pack: packKey, credits: String(pack.credits) },
      },
      success_url: `${siteUrl()}/dashboard/api-keys?checkout=success&product=api_overage&pack=${packKey}`,
      cancel_url: `${siteUrl()}/dashboard/api-keys?checkout=cancelled`,
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      allow_promotion_codes: true,
    };
    sessionParams.customer = await ensureStripeCustomer(stripe, user);
    sessionParams.customer_update = { name: "auto", address: "auto" };

    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: `api-overage:${userId}:${packKey}:${Math.floor(Date.now() / 60000)}`,
    });
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("API overage checkout failed:", err);
    return c.json({ error: "Failed to create overage checkout" }, 500);
  }
});

// ── POST /gradethread/per-grade (US-205) ─────────────────────────
//
// Body: { submissionId, tier: 'standard'|'premium'|'express' }
// One-time Checkout that, on success, unlocks just this submission.
async function perGradeCheckout(c: Ctx) {
  const userId = c.get("userId");
  // US-1637: the submission belongs to the workspace OWNER — a member's
  // submissions are stored user_id = ownerId. Scope the ownership check + the
  // downstream paid-flip to the owner so a member's per-grade checkout no longer
  // 404s. The PAYER stays the member (their Stripe customer is charged); only
  // the submission is owner-scoped, carried to the webhook via submission_owner_id.
  const ownerId = c.get("workspaceOwnerId") ?? userId;

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
    // US-401: the inline price_data fallback disables automatic_tax (a one-off
    // ad-hoc price can't be tax-coded), so it must NEVER run in production —
    // that would mint an untaxed charge and break tax compliance. Fail closed
    // with 503 (mirrors /subscribe + /credit-pack), and alert. The fallback is
    // kept ONLY for local/dev where price IDs aren't configured.
    if (isProduction()) {
      console.error(
        `[payments] PROD missing GRADE_PRICE_IDS[${tier}] — refusing the untaxed inline fallback.`,
      );
      void captureServer(userId, "billing.missing_grade_price_id", { tier });
      return c.json({ error: "Pricing not configured" }, 503);
    }
    console.warn(
      `Missing Stripe price ID for grade tier ${tier}; using inline price_data (dev only)`,
    );
  }

  // Verify the submission belongs to this workspace (owner-scoped) and isn't
  // already paid.
  const { data: submission, error: submissionError } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, status")
    .eq("id", submissionId)
    .eq("user_id", ownerId)
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
        // user_id = PAYER (drives customer linking + billing attribution in the
        // webhook); submission_owner_id = whose submission this unlocks (US-1637).
        user_id: userId,
        submission_owner_id: ownerId,
        product: "per_grade",
        submission_id: submissionId,
        tier,
        credits_equivalent: String(TIER_CREDIT_COST[tier]),
      },
      payment_intent_data: {
        metadata: {
          // Mirror onto the PaymentIntent — Checkout stores app metadata here,
          // so the refund/dispute handlers (which read PI metadata) can resolve
          // the submission owner too.
          user_id: userId,
          submission_owner_id: ownerId,
          product: "per_grade",
          submission_id: submissionId,
          tier,
        },
      },
      success_url: `${siteUrl()}/dashboard/submissions/${submissionId}?payment=success`,
      cancel_url: `${siteUrl()}/dashboard/submissions?payment=cancelled`,
      automatic_tax: priceId ? { enabled: true } : undefined,
      // US-389: when tax is computed, require a billing address so a new
      // customer's tax can be calculated.
      ...(priceId ? { billing_address_collection: "required" as const } : {}),
      allow_promotion_codes: true,
    };

    // US-391: bind to the single Stripe customer (created lazily) so the
    // per-grade purchase reuses the user's one customer instead of minting a
    // new one when none exists yet.
    sessionParams.customer = await ensureStripeCustomer(stripe, user);
    sessionParams.customer_update = { name: "auto", address: "auto" };

    // US-394: key the session on (submission, tier) so a double-click or retry
    // reuses ONE Checkout Session instead of creating duplicates that could
    // each be paid. Stripe replays the original response for 24h on the same
    // key. The submission is single-use (status flips off 'pending' once paid),
    // so the key never needs to outlive that window.
    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: perGradeIdempotencyKey(userId, submissionId, tier),
    });
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

  const FLIPDESK_PRICE_IDS = await getFlipdeskPriceIds();
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
      // US-389: collect a billing address so automatic_tax can be computed.
      billing_address_collection: "required",
      allow_promotion_codes: true,
    };

    // US-391: bind to the single Stripe customer (created lazily) instead of
    // letting Checkout mint a fresh one.
    sessionParams.customer = await ensureStripeCustomer(stripe, user);
    sessionParams.customer_update = { name: "auto", address: "auto" };

    const session = await stripe.checkout.sessions.create(sessionParams);
    return c.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Legacy subscribe checkout failed:", err);
    return c.json({ error: "Failed to create subscription checkout" }, 500);
  }
});

// ── GET /catalog ─────────────────────────────────────────────────
//
// US-808: the canonical IAP product catalog, derived from the single
// server-side source (lib/appstore/products.ts). The iOS client fetches +
// caches this for tier/credit mapping and offline-fallback display; its
// hardcoded IAPProduct.swift entries are kept only as the offline fallback and
// are asserted in sync by iap-catalog-drift_test.ts. Apple controls the real
// charged price in App Store Connect — `referencePrice*` is reference only.
// Reference data, no per-user fields, but mounted under the authed
// /api/payments/* prefix (consumed post-signup on the paywall step).
paymentRoutes.get("/catalog", (c) => {
  return c.json({ version: CATALOG_VERSION, products: serializeCatalog() });
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
        "trial_ends_at, grade_credit_balance, grades_used_this_month, grade_reset_at, " +
        "ai_actions_used_this_month, ai_actions_reset_at, ai_action_limit, stripe_customer_id, flipdesk_subscription_id, " +
        "pending_flipdesk_plan, pending_flipdesk_interval, pending_effective_at, " +
        "usage_alert_thresholds, last_warning_at, billing_source, appstore_product_id, " +
        "buyer_plan, buyer_interval, buyer_subscription_status, buyer_period_end, buyer_cancel_at_period_end",
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
    flipdesk_subscription_id: string | null;
    pending_flipdesk_plan: string | null;
    pending_flipdesk_interval: string | null;
    pending_effective_at: string | null;
    grade_credit_balance: number | null;
    grades_used_this_month: number | null;
    grade_reset_at: string | null;
    ai_actions_used_this_month: number | null;
    ai_actions_reset_at: string | null;
    ai_action_limit: number | null;
    usage_alert_thresholds: number[] | null;
    last_warning_at: Record<string, string> | null;
    billing_source: string | null;
    appstore_product_id: string | null;
    buyer_plan: string | null;
    buyer_interval: string | null;
    buyer_subscription_status: string | null;
    buyer_period_end: string | null;
    buyer_cancel_at_period_end: boolean | null;
  };

  const [
    activeListingsResult,
    marketplacesResult,
    ledgerResult,
    upcomingInvoice,
    buyerMeterResult,
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
    // US-400: the REAL next charge from Stripe (honors coupons / grandfathered
    // prices), fetched in parallel. Returns null for free users and degrades
    // gracefully if Stripe is unavailable (UI falls back to the plan table).
    fetchUpcomingInvoice(u.stripe_customer_id, u.flipdesk_subscription_id),
    // US-1801: buyer metered-action usage for the buyer billing usage meters.
    supabaseAdmin
      .from("buyer_meter_usage")
      .select("usage, reset_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  const buyerUsage = (buyerMeterResult.data as { usage?: Record<string, number>; reset_at?: string | null } | null);
  const bmUsage = buyerUsage?.usage ?? {};

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
      // US-400: actual upcoming Stripe charge, or null (free / Stripe down).
      upcoming_invoice: upcomingInvoice,
      // US-807: which processor owns the subscription. 'appstore' → the web UI
      // hides plan-change/cancel CTAs and shows "managed in the iOS app".
      billing_source: u.billing_source,
      appstore_product_id: u.appstore_product_id,
    },
    // US-1799: the buyer SUBSCRIPTION state (Free/Guard/Connoisseur). The
    // effective entitlement (higher of this and the seller-derived tier, US-1887)
    // is resolved separately by useBuyerEntitlements — this is just the sub the
    // buyer pays for directly, for the buyer billing page.
    buyer: {
      plan: u.buyer_plan ?? "free",
      interval: u.buyer_interval,
      status: u.buyer_subscription_status ?? "none",
      period_end: u.buyer_period_end,
      cancel_at_period_end: u.buyer_cancel_at_period_end ?? false,
      // US-1801: metered-action usage this period (0 until the metered buyer
      // features ship). Caps come from BUYER_PLANS on the client.
      usage: {
        extension_checks: bmUsage.extension_checks ?? 0,
        authenticity_credits: bmUsage.authenticity_credits ?? 0,
        video_grades: bmUsage.video_grades ?? 0,
      },
      usage_reset_at: buyerUsage?.reset_at ?? null,
    },
    grades: {
      credit_balance: u.grade_credit_balance,
      // US-393: honor the monthly rollover so a Free user (who never gets an
      // invoice.payment_succeeded reset) sees 0 used once the boundary passes.
      included_used_this_month:
        u.grade_reset_at && new Date(u.grade_reset_at).getTime() <= Date.now()
          ? 0
          : (u.grades_used_this_month ?? 0),
      // The reset boundary, so the UI can show a correct date even for Free.
      reset_at: u.grade_reset_at,
    },
    usage: {
      active_listings: activeListingsResult.count ?? 0,
      marketplaces_connected: marketplacesResult.count ?? 0,
      // US-2179: apply the lazy monthly rollover, exactly as the grades counter
      // above already did. reserve_ai_action only zeroes the column the next time
      // it runs, so reading it raw showed a seller who ended last month at their
      // cap as still 25/25 on the 1st — which drove the usage meter to 100% and
      // fired the at-cap upgrade toast for an allowance that had already reset.
      ai_actions_used_this_month: effectiveAiActionsUsed(
        u.ai_actions_used_this_month,
        u.ai_actions_reset_at,
      ),
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

// ── GET /ledger (US-211) ─────────────────────────────────────────
//
// Full grade-credit transaction history for the "View all activity" dialog on
// the Billing page (the billing-summary only carries the last 5). User-scoped.
// Capped + paginated to keep the payload bounded.
paymentRoutes.get("/ledger", async (c) => {
  const userId = c.get("userId");

  const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
  const offsetRaw = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const { data, error } = await supabaseAdmin
    .from("grade_credit_transactions")
    .select("id, delta, reason, balance_after, submission_id, notes, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[ledger] query failed:", error);
    return c.json({ error: "Failed to load activity" }, 500);
  }

  return c.json({ entries: data ?? [], limit, offset });
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
    // Persist the reason on the user row too (US-216) so the period-end
    // subscription.deleted webhook can read it for the 'subscription.ended'
    // analytics event and for churn reporting. Best-effort — never fail the
    // cancel over this.
    if (reason) {
      await supabaseAdmin
        .from("users")
        .update({ cancellation_reason: reason })
        .eq("id", userId);
    }
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

  // An App Store subscriber has no Stripe subscription to reschedule — their
  // plan is managed in the iOS app. Reject before touching Stripe (US-807).
  if (appstoreSubscriptionBlocksStripe(user)) {
    return c.json({ error: "ACTIVE_APPSTORE_SUBSCRIPTION", action: "manage_in_app" }, 409);
  }

  if (!user.flipdesk_subscription_id) {
    return c.json({ error: "No subscription to downgrade" }, 400);
  }

  const FLIPDESK_PRICE_IDS = await getFlipdeskPriceIds();
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
    // A stale test-mode customer id (pre live-cutover) 404s here. Treat it the
    // same as "no customer": the portal needs a real Stripe customer, which
    // only exists once they start a live subscription/purchase.
    if (isStripeResourceMissing(err)) {
      return c.json({ error: "No active subscription found" }, 400);
    }
    console.error("Stripe portal session creation failed:", err);
    return c.json({ error: "Failed to create billing portal session" }, 500);
  }
});
