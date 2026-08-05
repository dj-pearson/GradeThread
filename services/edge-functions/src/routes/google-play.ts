import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  type GooglePlayBillingUser,
  type GooglePlayDeps,
  isGooglePlayConfigured,
  processGooglePlayPurchase,
  verifyGooglePlayPurchase,
} from "../lib/google-play/verify.ts";
import type { GoogleUsersBillingUpdate } from "../lib/google-play/products.ts";
import { captureException } from "../lib/observability.ts";

// Google Play Billing verification — the Android counterpart to
// /api/payments/appstore/verify. Pattern: verify (impure) → classify/compute
// (pure, tested) → write (impure). Reconciles into the SAME users columns +
// credit ledger the Stripe/App Store flows drive.
//
//   POST /api/payments/google/verify   (auth) — client reports a Play purchase
//
// Google Play Real-time Developer Notifications (renewals/cancellations) are a
// separate webhook, not handled here.

type AuthEnv = { Variables: { userId: string } };

export const googlePlayVerifyRoutes = new Hono<AuthEnv>();

// Real dependencies wired to supabase + the Play Developer API.
const deps: GooglePlayDeps = {
  verifyPurchase: (productId, purchaseToken, kind) =>
    verifyGooglePlayPurchase(productId, purchaseToken, kind),

  loadBillingUser: async (userId) => {
    const { data } = await supabaseAdmin
      .from("users")
      .select(
        "flipdesk_plan, subscription_status, billing_source, grade_credit_balance, flipdesk_subscription_id",
      )
      .eq("id", userId)
      .maybeSingle();
    return (data as GooglePlayBillingUser | null) ?? null;
  },

  findSubscriptionTokenOwner: async (purchaseToken) => {
    // Who currently holds this Play subscription token? A row means the token is
    // already bound to that account (US-1614). Scoped by the token itself, which
    // is unique via idx_users_google_purchase_token.
    const { data } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("google_purchase_token", purchaseToken)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  },

  applySubscription: async (userId, update: GoogleUsersBillingUpdate) => {
    const { error } = await supabaseAdmin.from("users").update(update).eq("id", userId);
    if (error) throw new Error(`google play subscription update failed: ${error.message}`);
  },

  claimConsumable: async (userId, productId, purchaseToken, credits, orderId) => {
    // INSERT ... ON CONFLICT (purchase_token) DO NOTHING via PostgREST upsert
    // with ignoreDuplicates: a returned row means WE claimed it (own the grant).
    const { data, error } = await supabaseAdmin
      .from("google_processed_purchases")
      .upsert(
        {
          purchase_token: purchaseToken,
          user_id: userId,
          product_id: productId,
          credits,
          order_id: orderId,
        },
        { onConflict: "purchase_token", ignoreDuplicates: true },
      )
      .select("purchase_token");
    if (error) throw new Error(`google_processed_purchases claim failed: ${error.message}`);
    return (data?.length ?? 0) > 0;
  },

  grantCredits: async (userId, credits, purchaseToken) => {
    const { data, error } = await supabaseAdmin.rpc("grant_grade_credits", {
      p_user_id: userId,
      p_credits: credits,
      p_reason: "pack_purchase",
      // The Play token doubles as the RPC's own dedup key (belt + suspenders
      // alongside the google_processed_purchases gate).
      p_stripe_payment_intent: `googleplay:${purchaseToken}`,
      p_notes: "Google Play credit pack",
    });
    if (error) throw new Error(`grant_grade_credits failed: ${error.message}`);
    return (data as number | null) ?? null;
  },

  recordEvent: async (userId, eventId, fromPlan, toPlan, raw) => {
    const { error } = await supabaseAdmin.from("flipdesk_subscription_events").insert({
      user_id: userId,
      stripe_event_id: `googleplay:${eventId}`,
      event_type: "googleplay.verify",
      from_plan: fromPlan,
      to_plan: toPlan,
      raw_payload: raw,
    });
    if (error && error.code !== "23505") {
      console.error(`[googleplay] audit write failed for ${eventId}:`, error);
    }
  },
};

googlePlayVerifyRoutes.post("/verify", async (c) => {
  const userId = c.get("userId");

  if (!isGooglePlayConfigured()) {
    return c.json({ error: "Google Play billing is not configured." }, 503);
  }

  let body: { productId?: unknown; purchaseToken?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  const purchaseToken = typeof body.purchaseToken === "string" ? body.purchaseToken.trim() : "";
  if (!productId || !purchaseToken) {
    return c.json({ error: "productId and purchaseToken are required." }, 400);
  }

  let result;
  try {
    result = await processGooglePlayPurchase(
      { userId, productId, purchaseToken },
      deps,
      Date.now(),
    );
  } catch (e) {
    console.error("[googleplay] verify failed:", e);
    return c.json({ error: "Could not verify the purchase." }, 400);
  }

  if (!result.ok) {
    switch (result.reason) {
      case "unknown_product":
        return c.json({ error: `Unknown product: ${productId}` }, 400);
      case "user_not_found":
        return c.json({ error: "User not found." }, 404);
      case "blocked_active_stripe":
        return c.json(
          { error: "ACTIVE_STRIPE_SUBSCRIPTION", action: "cancel_stripe_first" },
          409,
        );
      case "blocked_active_appstore":
        // US-2126: an App Store subscription already entitles this user — manage
        // it in the iOS app rather than start a second bill on Google Play.
        return c.json(
          { error: "ACTIVE_APPSTORE_SUBSCRIPTION", action: "manage_in_app" },
          409,
        );
      case "account_mismatch":
        // The purchase belongs to a different account (obfuscated id mismatch or
        // the token is already claimed elsewhere) — never entitle the caller.
        return c.json({ error: "PURCHASE_NOT_OWNED_BY_ACCOUNT" }, 403);
      case "product_mismatch":
        // US-2285: the client asked for a tier Google's verified purchase does
        // not include. Unlike the other refusals this one cannot happen by
        // accident — the Play client sends back the productId it was given — so
        // it is logged as a security signal rather than an ordinary 4xx.
        captureException(
          new Error("google play: client productId not in the verified purchase"),
          {
            route: "POST /api/payments/google/verify",
            userId,
            tags: {
              claimed_product_id: productId,
              verified_product_ids: (result.verifiedProductIds ?? []).join(","),
            },
          },
        );
        console.error(
          `[googleplay][security] user=${userId} claimed=${productId} ` +
            `verified=${(result.verifiedProductIds ?? []).join(",") || "none"}`,
        );
        // Same body as the ownership refusal on purpose: telling the caller
        // which product Google says they own is a hint they have no use for
        // except to try again with it.
        return c.json({ error: "PURCHASE_NOT_OWNED_BY_ACCOUNT" }, 403);
      case "invalid_purchase":
      default:
        return c.json({ error: "INVALID_PURCHASE" }, 400);
    }
  }

  return c.json({
    plan: result.plan ?? "free",
    interval: result.interval ?? null,
    status: result.status ?? "none",
    credits_balance: result.creditsBalance ?? 0,
  });
});
