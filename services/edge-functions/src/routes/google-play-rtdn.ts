import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  classifyRtdn,
  decodeDeveloperNotification,
  type PubSubPushEnvelope,
  pubSubMessageId,
  type RtdnAction,
  rtdnSecretOk,
} from "../lib/google-play/rtdn.ts";
import {
  claimWebhookEvent,
  failIfDbError,
  isTransientWebhookError,
  releaseWebhookEvent,
  TransientWebhookError,
} from "../lib/webhook-idempotency.ts";
import { recordWebhookDeadLetter } from "../lib/webhook-dead-letter.ts";
import {
  classifyAndroidProduct,
  computeGoogleUserUpdate,
  type GoogleUsersBillingUpdate,
} from "../lib/google-play/products.ts";
import { type PlayPurchaseInfo, verifyGooglePlayPurchase } from "../lib/google-play/verify.ts";
import { buildLapseUpdate } from "../lib/appstore/expiry-sweep.ts";
import { captureException } from "../lib/observability.ts";

// US-1650 / C6: Google Play Real-time Developer Notifications (RTDN) webhook.
//
// Completes the C6 server-side-lapse work: the daily expiry-sweep (US-1619) is
// the backstop; THIS is the real-time path + refund reconciliation. Delivered
// over Cloud Pub/Sub PUSH to POST /api/webhooks/google-play. Verified by a
// shared secret (GOOGLE_RTDN_WEBHOOK_SECRET presented as ?token= or the
// Authorization header — the way requireJobSecret does), then the pure router
// (lib/google-play/rtdn.ts) decodes + classifies and this glue reconciles.
//
// Idempotency + failure policy mirror the Stripe (webhooks.ts) + App Store
// (appstore.ts) dispatchers: claim the Pub/Sub messageId BEFORE side effects; a
// transient DB failure RELEASES the claim + 5xx so Pub/Sub retries; a
// non-transient (code-bug) failure DEAD-LETTERS + 200 so Pub/Sub stops storming.

export const googlePlayRtdnRoutes = new Hono();

// ── Reconciliation (dependency-injected so the dispatch is unit-testable) ─────

export interface RtdnReconcileDeps {
  /** The user bound to a subscription purchase token (users.google_purchase_token). */
  resolveSubscriptionUser(
    purchaseToken: string,
  ): Promise<{ userId: string; fromPlan: string | null } | null>;
  /** The processed consumable purchase for a token (google_processed_purchases). */
  resolveConsumablePurchase(
    purchaseToken: string,
  ): Promise<{ userId: string; credits: number } | null>;
  verifySubscription(
    subscriptionId: string,
    purchaseToken: string,
  ): Promise<PlayPurchaseInfo>;
  applySubscriptionUpdate(userId: string, update: GoogleUsersBillingUpdate): Promise<void>;
  lapseUser(userId: string, nowIso: string): Promise<void>;
  clawbackConsumable(userId: string, purchaseToken: string, credits: number): Promise<void>;
  recordEvent(
    userId: string,
    eventId: string,
    eventType: string,
    fromPlan: string | null,
    toPlan: string | null,
    raw: Record<string, unknown>,
  ): Promise<void>;
}

export interface RtdnReconcileResult {
  outcome: "reverified" | "lapsed" | "clawed_back" | "ignored";
  reason?: string;
}

/**
 * Execute one classified RTDN action. Pure control-flow over injected effects.
 * Throws TransientWebhookError (via the deps' failIfDbError) on a transient DB
 * failure so the route releases the claim and Pub/Sub retries.
 */
export async function reconcileRtdn(
  action: RtdnAction,
  eventId: string,
  deps: RtdnReconcileDeps,
  now: number,
): Promise<RtdnReconcileResult> {
  const nowIso = new Date(now).toISOString();

  if (action.kind === "test" || action.kind === "ignore") {
    return { outcome: "ignored", reason: action.kind === "ignore" ? action.reason : "test" };
  }

  if (action.kind === "sub_lapse") {
    const user = await deps.resolveSubscriptionUser(action.purchaseToken);
    if (!user) return { outcome: "ignored", reason: "no_bound_user" };
    await deps.lapseUser(user.userId, nowIso);
    await deps.recordEvent(user.userId, eventId, "googleplay.rtdn.lapse", user.fromPlan, "free", {
      subscription_id: action.subscriptionId,
    });
    return { outcome: "lapsed" };
  }

  if (action.kind === "sub_reverify") {
    const user = await deps.resolveSubscriptionUser(action.purchaseToken);
    if (!user) return { outcome: "ignored", reason: "no_bound_user" };
    const mapping = classifyAndroidProduct(action.subscriptionId);
    if (!mapping || mapping.kind !== "subscription") {
      return { outcome: "ignored", reason: "unknown_subscription_product" };
    }
    const info = await deps.verifySubscription(action.subscriptionId, action.purchaseToken);
    if (!info.valid) {
      // Recovered/renewed notification but the token no longer verifies as active
      // (already expired/revoked by the time we processed) — lapse to be safe.
      await deps.lapseUser(user.userId, nowIso);
      await deps.recordEvent(
        user.userId, eventId, "googleplay.rtdn.lapse", user.fromPlan, "free",
        { subscription_id: action.subscriptionId, note: "reverify_invalid" },
      );
      return { outcome: "lapsed", reason: "reverify_invalid" };
    }
    const update = computeGoogleUserUpdate({
      mapping,
      productId: action.subscriptionId,
      purchaseToken: action.purchaseToken,
      expiryMillis: info.expiryMillis,
      autoRenewing: info.autoRenewing,
      now,
    });
    await deps.applySubscriptionUpdate(user.userId, update);
    await deps.recordEvent(
      user.userId, eventId, "googleplay.rtdn.reverify", user.fromPlan, update.flipdesk_plan,
      { subscription_id: action.subscriptionId },
    );
    return { outcome: "reverified" };
  }

  // action.kind === "void"
  if (action.productType === 1) {
    // A voided (refunded/charged-back) SUBSCRIPTION — drop entitlement now.
    const user = await deps.resolveSubscriptionUser(action.purchaseToken);
    if (!user) return { outcome: "ignored", reason: "no_bound_user" };
    await deps.lapseUser(user.userId, nowIso);
    await deps.recordEvent(user.userId, eventId, "googleplay.rtdn.void_sub", user.fromPlan, "free", {});
    return { outcome: "lapsed", reason: "voided_subscription" };
  }
  // A voided one-time (consumable / credit pack) — claw the credits back.
  const purchase = await deps.resolveConsumablePurchase(action.purchaseToken);
  if (!purchase) return { outcome: "ignored", reason: "no_consumable_record" };
  await deps.clawbackConsumable(purchase.userId, action.purchaseToken, purchase.credits);
  await deps.recordEvent(
    purchase.userId, eventId, "googleplay.rtdn.void_consumable", null, null,
    { credits: purchase.credits },
  );
  return { outcome: "clawed_back" };
}

// ── Production deps ───────────────────────────────────────────────────────────

const prodDeps: RtdnReconcileDeps = {
  resolveSubscriptionUser: async (purchaseToken) => {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id, flipdesk_plan")
      .eq("google_purchase_token", purchaseToken)
      .maybeSingle();
    failIfDbError(error, "rtdn resolveSubscriptionUser");
    const row = data as { id: string; flipdesk_plan: string | null } | null;
    return row ? { userId: row.id, fromPlan: row.flipdesk_plan } : null;
  },
  resolveConsumablePurchase: async (purchaseToken) => {
    const { data, error } = await supabaseAdmin
      .from("google_processed_purchases")
      .select("user_id, credits")
      .eq("purchase_token", purchaseToken)
      .maybeSingle();
    failIfDbError(error, "rtdn resolveConsumablePurchase");
    const row = data as { user_id: string; credits: number } | null;
    return row ? { userId: row.user_id, credits: row.credits } : null;
  },
  verifySubscription: async (subscriptionId, purchaseToken) => {
    try {
      return await verifyGooglePlayPurchase(subscriptionId, purchaseToken, "subscription");
    } catch (err) {
      // Treat a Play Developer API failure as TRANSIENT so Pub/Sub retries.
      // Dead-lettering a RENEWED reverify would leave period_end un-extended and
      // let the daily sweep falsely lapse a still-active subscription.
      throw new TransientWebhookError(
        `play verify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
  applySubscriptionUpdate: async (userId, update) => {
    const { error } = await supabaseAdmin.from("users").update(update).eq("id", userId);
    failIfDbError(error, "rtdn applySubscriptionUpdate");
  },
  lapseUser: async (userId, nowIso) => {
    // Scope the lapse to a still-googleplay-billed, still-entitled row so a
    // concurrent Stripe switch or client re-verify isn't clobbered (mirrors the
    // expiry sweep's guarded UPDATE).
    const { error } = await supabaseAdmin
      .from("users")
      .update(buildLapseUpdate(nowIso))
      .eq("id", userId)
      .eq("billing_source", "googleplay")
      .in("subscription_status", ["active", "trialing"]);
    failIfDbError(error, "rtdn lapseUser");
  },
  clawbackConsumable: async (userId, purchaseToken, credits) => {
    // Debit the granted credits (clamped at zero, row-locked). Idempotency-keyed
    // on the void so a Pub/Sub redelivery claws back exactly once — distinct from
    // the grant key (googleplay:<token>) so a void after the grant reconciles.
    const { error } = await supabaseAdmin.rpc("revoke_grade_credits", {
      p_user_id: userId,
      p_credits: credits,
      p_stripe_payment_intent: `googleplay-void:${purchaseToken}`,
      p_notes: "Google Play refund/void clawback",
      p_idempotency_key: `googleplay-void:${purchaseToken}`,
    });
    failIfDbError(error, "rtdn clawbackConsumable");
  },
  recordEvent: async (userId, eventId, eventType, fromPlan, toPlan, raw) => {
    const { error } = await supabaseAdmin.from("flipdesk_subscription_events").insert({
      user_id: userId,
      stripe_event_id: `googleplay:rtdn:${eventId}`,
      event_type: eventType,
      from_plan: fromPlan,
      to_plan: toPlan,
      raw_payload: raw,
    });
    // 23505 = a duplicate audit row (redelivery) — expected + harmless.
    if (error && error.code !== "23505") {
      console.error(`[googleplay-rtdn] audit write failed for ${eventId}:`, error);
    }
  },
};

// ── Route ────────────────────────────────────────────────────────────────────

googlePlayRtdnRoutes.post("/", async (c) => {
  // Verify the Pub/Sub push secret (fail closed when unconfigured).
  const url = new URL(c.req.url);
  const presented = url.searchParams.get("token") ??
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!rtdnSecretOk(presented, Deno.env.get("GOOGLE_RTDN_WEBHOOK_SECRET"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: PubSubPushEnvelope;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const messageId = pubSubMessageId(body);
  if (!messageId) return c.json({ error: "Missing message id" }, 400);

  const note = decodeDeveloperNotification(body);
  if (!note) {
    // Undecodable data — ACK so Pub/Sub doesn't retry a permanently-bad message.
    console.warn(`[googleplay-rtdn] undecodable message ${messageId} — acking`);
    return c.json({ ok: true, ignored: "undecodable" });
  }
  const action = classifyRtdn(note);

  // Idempotency: claim the messageId BEFORE any side effect (fail CLOSED).
  const claim = await claimWebhookEvent("googleplay", messageId, action.kind);
  if (claim === "duplicate") return c.json({ ok: true, duplicate: true });
  if (claim === "error") return c.json({ error: "claim failed" }, 500);

  try {
    const result = await reconcileRtdn(action, messageId, prodDeps, Date.now());
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (isTransientWebhookError(err)) {
      await releaseWebhookEvent("googleplay", messageId);
      console.error(
        `[googleplay-rtdn] transient failure on ${action.kind} (${messageId}): ${err.message} — released claim, Pub/Sub will retry`,
      );
      return c.json({ error: "Temporary error; please retry." }, 500);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[googleplay-rtdn] DROPPED ${action.kind} (${messageId}) — non-transient: ${message}`);
    captureException(err, { route: "googleplay-rtdn", tags: { action: action.kind } });
    await recordWebhookDeadLetter({
      provider: "googleplay",
      eventId: messageId,
      eventType: action.kind,
      payload: note,
      errorMessage: message,
    });
    return c.json({ ok: true, deadLettered: true });
  }
});
