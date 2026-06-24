import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { claimWebhookEvent } from "../lib/webhook-idempotency.ts";
import { classifyProduct } from "../lib/appstore/products.ts";
import { computeUserUpdate, type UsersBillingUpdate } from "../lib/appstore/reconcile.ts";
import { computeConsumableGrant } from "../lib/appstore/grant-decision.ts";
import { decideAppstorePrecedence } from "../lib/appstore/precedence.ts";
import { routeNotification } from "../lib/appstore/notifications.ts";
import { verifyNotification, verifyTransaction } from "../lib/appstore/verify.ts";
import type { DecodedTransactionLite } from "../lib/appstore/types.ts";

// Apple StoreKit 2 IAP endpoints. Pattern: verify (impure) → classify/route/
// compute (pure, tested) → write (impure). Reconciles into the SAME users
// columns + credit ledger the Stripe flow drives (plan-gate unchanged).
//
//   POST /api/payments/appstore/verify   (auth) — client reports a purchase
//   POST /api/webhooks/appstore          (no auth) — App Store Server Notifs V2

type AuthEnv = { Variables: { userId: string } };

// ── Shared glue (impure) ─────────────────────────────────────────

interface BillingUser {
  id: string;
  flipdesk_plan: string | null;
  subscription_status: string | null;
  flipdesk_subscription_id: string | null;
  billing_source: string | null;
  grade_credit_balance: number | null;
}

async function loadBillingUser(userId: string): Promise<BillingUser | null> {
  const { data } = await supabaseAdmin
    .from("users")
    .select(
      "id, flipdesk_plan, subscription_status, flipdesk_subscription_id, billing_source, grade_credit_balance",
    )
    .eq("id", userId)
    .maybeSingle();
  return (data as BillingUser | null) ?? null;
}

/** Resolve the owning user from a transaction: appAccountToken (== users.id)
 * first, else the stored original_transaction_id. */
async function resolveUserId(txn: DecodedTransactionLite): Promise<string | null> {
  if (txn.appAccountToken) {
    const { data } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("id", txn.appAccountToken)
      .maybeSingle();
    if ((data as { id: string } | null)?.id) return (data as { id: string }).id;
  }
  const { data } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("appstore_original_transaction_id", txn.originalTransactionId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function applySubscription(userId: string, update: UsersBillingUpdate): Promise<void> {
  const { error } = await supabaseAdmin.from("users").update(update).eq("id", userId);
  if (error) throw new Error(`appstore subscription update failed: ${error.message}`);
}

async function grantCredits(
  userId: string,
  txn: DecodedTransactionLite,
  credits: number,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin.rpc("grant_appstore_credits", {
    p_user_id: userId,
    p_credits: credits,
    p_transaction_id: txn.transactionId,
    p_original_transaction_id: txn.originalTransactionId,
    p_product_id: txn.productId,
  });
  if (error) throw new Error(`grant_appstore_credits failed: ${error.message}`);
  return (data as number | null) ?? null;
}

/** Audit row reusing flipdesk_subscription_events (stripe_event_id namespaced). */
async function recordAppstoreEvent(
  userId: string,
  eventType: string,
  eventId: string,
  fromPlan: string | null,
  toPlan: string | null,
  raw: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin.from("flipdesk_subscription_events").insert({
    user_id: userId,
    stripe_event_id: `appstore:${eventId}`,
    event_type: `appstore.${eventType}`,
    from_plan: fromPlan,
    to_plan: toPlan,
    raw_payload: raw,
  });
  if (error && error.code !== "23505") {
    console.error(`[appstore] audit write failed for ${eventId}:`, error);
  }
}

// ── POST /api/payments/appstore/verify (auth) ────────────────────

export const appstoreVerifyRoutes = new Hono<AuthEnv>();

appstoreVerifyRoutes.post("/verify", async (c) => {
  const userId = c.get("userId");

  let body: { jws?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const jws = body.jws;
  if (typeof jws !== "string" || jws.length === 0) {
    return c.json({ error: "Missing signed transaction (jws)." }, 400);
  }

  let txn: DecodedTransactionLite;
  try {
    txn = await verifyTransaction(jws);
  } catch (e) {
    console.error("[appstore] verifyTransaction failed:", e);
    return c.json({ error: "Could not verify the transaction." }, 400);
  }

  // Defense in depth (audit 2026-06-24): the client stamps appAccountToken with
  // the purchaser's own user id (PaywallStore passes userId →
  // StoreKit .appAccountToken). This interactive path already grants only to the
  // authenticated caller, but a JWS whose appAccountToken belongs to a DIFFERENT
  // account is anomalous (a replayed or cross-account transaction) — reject it so
  // a transaction can only be self-claimed by the account it was purchased under,
  // and so its transaction_id dedup can't be burned against the rightful owner.
  // Apple normalizes the token to lowercase; compare case-insensitively. Older
  // purchases without an appAccountToken fall through (the unauthenticated
  // webhook resolves those by appstore_original_transaction_id).
  if (
    txn.appAccountToken &&
    txn.appAccountToken.toLowerCase() !== userId.toLowerCase()
  ) {
    console.error(
      `[appstore] verify: appAccountToken ${txn.appAccountToken} != caller ${userId}`,
    );
    return c.json({ error: "TRANSACTION_OWNERSHIP_MISMATCH" }, 403);
  }

  const mapping = classifyProduct(txn.productId);
  if (!mapping) {
    return c.json({ error: `Unknown product: ${txn.productId}` }, 400);
  }

  const user = await loadBillingUser(userId);
  if (!user) return c.json({ error: "User not found." }, 404);

  if (decideAppstorePrecedence(user, mapping.kind) === "block_active_stripe") {
    return c.json(
      { error: "ACTIVE_STRIPE_SUBSCRIPTION", action: "cancel_stripe_first" },
      409,
    );
  }

  if (mapping.kind === "subscription") {
    const update = computeUserUpdate({ mapping, txn, action: "sub_active", now: Date.now() });
    await applySubscription(userId, update);
    await recordAppstoreEvent(userId, "verify", txn.transactionId, user.flipdesk_plan, update.flipdesk_plan, {
      product_id: txn.productId,
    });
    return c.json({
      plan: update.flipdesk_plan,
      interval: update.flipdesk_interval,
      status: update.subscription_status,
      credits_balance: user.grade_credit_balance ?? 0,
    });
  }

  // Consumable credit pack.
  const grant = computeConsumableGrant(txn, mapping);
  const balance = await grantCredits(userId, txn, grant.credits);
  return c.json({
    plan: user.flipdesk_plan ?? "free",
    interval: null,
    status: user.subscription_status ?? "none",
    credits_balance: balance ?? user.grade_credit_balance ?? 0,
  });
});

// ── POST /api/webhooks/appstore (no auth) ────────────────────────

export const appstoreWebhookRoutes = new Hono();

appstoreWebhookRoutes.post("/", async (c) => {
  let body: { signedPayload?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const signedPayload = body.signedPayload;
  if (typeof signedPayload !== "string") {
    return c.json({ error: "Missing signedPayload." }, 400);
  }

  let note;
  try {
    note = await verifyNotification(signedPayload);
  } catch (e) {
    console.error("[appstore] verifyNotification failed:", e);
    return c.json({ error: "Could not verify the notification." }, 400);
  }

  // Idempotency: fail CLOSED on a claim error so Apple retries (mirrors Stripe).
  const claim = await claimWebhookEvent("appstore", note.notificationUUID, note.notificationType);
  if (claim === "duplicate") return c.json({ ok: true });
  if (claim === "error") return c.json({ error: "claim failed" }, 500);

  const action = routeNotification(note.notificationType, note.subtype);
  const txn = note.transaction;
  if (action === "ignore" || !txn) return c.json({ ok: true });

  const mapping = classifyProduct(txn.productId);
  if (!mapping) return c.json({ ok: true });

  const userId = await resolveUserId(txn);
  if (!userId) {
    console.error(`[appstore] webhook: no user for txn ${txn.originalTransactionId}`);
    return c.json({ ok: true });
  }

  if (mapping.kind === "consumable") {
    if (action === "consumable_grant") {
      await grantCredits(userId, txn, computeConsumableGrant(txn, mapping).credits);
    }
    return c.json({ ok: true });
  }

  const user = await loadBillingUser(userId);
  const update = computeUserUpdate({
    mapping,
    txn,
    renewal: note.renewal,
    action,
    now: Date.now(),
  });
  await applySubscription(userId, update);
  await recordAppstoreEvent(
    userId,
    note.notificationType,
    note.notificationUUID,
    user?.flipdesk_plan ?? null,
    update.flipdesk_plan,
    { subtype: note.subtype },
  );
  return c.json({ ok: true });
});
