import { Hono } from "hono";
import Stripe from "stripe";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requireScope } from "../lib/scope-guard.ts";
import {
  remainingFraction as prorationRemainingFraction,
  unusedProrationCents,
} from "../lib/proration.ts";
import { getFlipdeskPriceIds } from "../lib/pricing-config.ts";
import { findLedgerInvariantViolation } from "../lib/credit-ledger.ts";
import { nextPastDueSince } from "../lib/grade-pricing.ts";
import {
  mapSubscriptionInterval,
  mapSubscriptionStatus,
  mapSubscriptionToFlipdeskPlan,
} from "./webhooks.ts";
import { sendAdminMessageEmail } from "../lib/email.ts";
import { resolveChargeMetadata } from "../lib/stripe-metadata.ts";
import {
  normalizeRefundAmount,
  refundIdempotencyKey,
} from "../lib/refund-amount.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://gradethread.com";

// Admin billing routes (US-221). All endpoints require admin role —
// mounted with both authMiddleware + adminAuthMiddleware in main.ts.
//
// Each action writes to admin_audit_log + flipdesk_subscription_events so
// the user-facing billing history shows admin actions alongside organic events.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminBillingRoutes = new Hono<AdminEnv>();

// US-908: every billing endpoint additionally requires the billing:write scope
// (on top of the inherited admin role + AAL2 + per-action step-up). admin and
// super_admin both hold it in the seed, so this is no behavior change at launch;
// it lets a scoped admin be granted/denied billing without changing their role.
//
// US-2377: the scope is attached PER ROUTE, never as adminBillingRoutes.use("*").
// This router is mounted at the bare /api/admin prefix (its own paths are a mix
// of /users/*, /billing/*, /coupons and /charges/*), and hono's app.route()
// rewrites a sub-app's use("*") into a plain wildcard on the PARENT router. A
// router-wide guard here therefore registered as ALL /api/admin/* and ran ahead
// of all 54 sibling admin routers — revoking billing:write from a role would
// have 403'd that role out of the entire admin surface. Keep it per route.

// US-587: FlipDesk price IDs are data-driven (DB pricing_plans + env fallback),
// loaded via getFlipdeskPriceIds() so a price-ID change in admin needs no deploy.

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    console.error("[admin-billing] STRIPE_SECRET_KEY not configured");
    return null;
  }
  return new Stripe(key, { apiVersion: "2024-04-10", timeout: 20_000, maxNetworkRetries: 2 });
}

// Thin wrapper over the shared writeAuditLog (US-269) so billing actions get
// uniform actor_role / ip / user_agent capture. Kept positional to preserve the
// existing call sites; just threads the request Context through.
function auditLog(
  c: Context,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  return writeAuditLog(c, { action, targetType, targetId, details });
}

type FlipdeskPlan = "free" | "starter" | "pro" | "business";

// Mirrors the organic webhook trail (webhooks.ts recordEvent) so admin-initiated
// plan changes show up in the user's billing history alongside Stripe events.
// stripe_event_id is left null (nullable UNIQUE column — Postgres permits many
// nulls); the acting admin's user_id is stamped in raw_payload (US-221 AC).
async function recordAdminEvent(
  userId: string,
  adminId: string,
  fromPlan: FlipdeskPlan | null,
  toPlan: FlipdeskPlan | null,
  details: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("flipdesk_subscription_events")
    .insert({
      user_id: userId,
      stripe_event_id: null,
      event_type: "admin_change",
      from_plan: fromPlan,
      to_plan: toPlan,
      raw_payload: { admin_id: adminId, ...details },
    });
  if (error) {
    console.error("[admin-billing] failed to record subscription event:", error);
  }
}

// ── POST /users/:id/change-plan ──────────────────────────────────
//
// Body: { plan: 'free'|'starter'|'pro'|'business', interval?: 'monthly'|'yearly' }
//
// For paid → paid: subscription_data.proration_behavior='create_prorations'
// and the new price is swapped in immediately. For paid → free: cancels the
// existing Stripe subscription. For free → paid: errors (admin should email
// the user a magic-link to Checkout — we don't store cards on file).
adminBillingRoutes.post("/users/:id/change-plan", requireScope("billing:write"), async (c) => {
  // US-399: changing a paying customer's plan (incl. an immediate cancel) is
  // destructive — require a fresh MFA step-up like refunds.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const targetUserId = c.req.param("id");

  let body: { plan?: unknown; interval?: unknown; prorate?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const plan = body.plan as string | undefined;
  const interval = (body.interval as string | undefined) ?? "monthly";
  // US-399: when true, automatically refund the unused-time proration on an
  // immediate paid→free cancel. Default false: the proration is still computed
  // and SURFACED in the response + audit log so the admin can act on it.
  const prorate = body.prorate === true;

  if (plan !== "free" && plan !== "starter" && plan !== "pro" && plan !== "business") {
    return c.json({ error: "plan must be one of: free, starter, pro, business" }, 400);
  }
  if (interval !== "monthly" && interval !== "yearly") {
    return c.json({ error: "interval must be 'monthly' or 'yearly'" }, 400);
  }

  const { data: targetUser, error: userError } = await supabaseAdmin
    .from("users")
    .select(
      "id, email, flipdesk_plan, flipdesk_interval, flipdesk_subscription_id, stripe_customer_id",
    )
    .eq("id", targetUserId)
    .single();

  if (userError || !targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const fromPlan = targetUser.flipdesk_plan;

  // ─ Case 1: free → paid (no Stripe subscription, no card) ─
  if (fromPlan === "free" && plan !== "free") {
    return c.json({
      error:
        "Free users have no card on file. Send them a magic link to /dashboard/billing to subscribe themselves.",
    }, 400);
  }

  // ─ Case 2: paid → free (cancel subscription immediately) ─
  if (plan === "free" && targetUser.flipdesk_subscription_id) {
    const stripe = getStripe();
    if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

    const subId = targetUser.flipdesk_subscription_id;

    // US-399: SURFACE the proration so the customer isn't silently uncredited.
    // Compute the unused-time value from the REAL amount paid on the latest
    // invoice (so coupons / grandfathered prices are reflected, not the list
    // price). Best-effort: a preview failure must NOT block the cancel.
    let unusedCents = 0;
    let basePaidCents = 0;
    let remainingFraction = 0;
    let prorationComputed = false;
    let paymentIntentId: string | null = null;
    try {
      const sub = await stripe.subscriptions.retrieve(subId, {
        expand: ["latest_invoice"],
      });
      const nowSec = Math.floor(Date.now() / 1000);
      const start = sub.current_period_start ?? nowSec;
      const end = sub.current_period_end ?? nowSec;
      const inv = sub.latest_invoice && typeof sub.latest_invoice !== "string"
        ? sub.latest_invoice
        : null;
      basePaidCents = inv?.amount_paid ?? (sub.items.data[0]?.price?.unit_amount ?? 0);
      paymentIntentId = inv?.payment_intent
        ? (typeof inv.payment_intent === "string" ? inv.payment_intent : inv.payment_intent.id)
        : null;
      remainingFraction = prorationRemainingFraction(start, end, nowSec);
      unusedCents = unusedProrationCents({
        basePaidCents,
        periodStartSec: start,
        periodEndSec: end,
        nowSec,
      });
      prorationComputed = true;
    } catch (err) {
      console.error("[admin-billing] proration preview failed:", err);
    }

    try {
      // Cancel immediately. Webhook sets flipdesk_plan='free' + status='canceled'.
      await stripe.subscriptions.cancel(subId);
    } catch (err) {
      console.error("[admin-billing] cancel failed:", err);
      return c.json({ error: "Stripe cancel failed" }, 500);
    }

    // US-399: optionally AUTOMATE the refund of the unused portion.
    let refundId: string | null = null;
    let refundError: string | null = null;
    if (prorate && unusedCents > 0 && paymentIntentId) {
      try {
        // US-2033: every other Stripe money-mover in this codebase carries an
        // idempotency key (pack-refund:, admin-refund:, grade-refund:,
        // guarantee-remedy:, dup-per-grade:, consignor_payout_,
        // affiliate_payout_). This one did not. It is currently protected only
        // by ACCIDENT — the subscription cancel above throws on a retry before
        // execution reaches here — which is not a guarantee, just an ordering
        // that nobody is obliged to preserve. Key it on the intent + amount so
        // a retry (or a future reordering) returns the same refund instead of
        // refunding the customer twice.
        const r = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          amount: unusedCents,
          reason: "requested_by_customer",
          metadata: { admin_changed_by: adminId, purpose: "plan_downgrade_proration" },
        }, {
          idempotencyKey: `downgrade-proration:${paymentIntentId}:${unusedCents}`,
        });
        refundId = r.id;
      } catch (err) {
        refundError = err instanceof Error ? err.message : String(err);
        console.error("[admin-billing] proration refund failed:", err);
      }
    }

    const proration = {
      unused_cents: unusedCents,
      base_paid_cents: basePaidCents,
      remaining_fraction: Number(remainingFraction.toFixed(4)),
      computed: prorationComputed,
    };
    const outcome = {
      from_plan: fromPlan,
      to_plan: "free",
      method: "stripe_cancel_immediate",
      proration,
      prorate_requested: prorate,
      refunded: Boolean(refundId),
      refund_id: refundId,
      refund_amount_cents: refundId ? unusedCents : null,
      refund_error: refundError,
    };
    await auditLog(c, "admin.change_plan", "user", targetUserId, outcome);
    await recordAdminEvent(targetUserId, adminId, fromPlan, "free", outcome);
    return c.json({
      ok: true,
      method: "stripe_cancel_immediate",
      proration,
      prorate_requested: prorate,
      refunded: Boolean(refundId),
      refund_id: refundId,
      refund_amount_cents: refundId ? unusedCents : null,
      refund_error: refundError,
    });
  }

  // ─ Case 3: paid → paid (swap subscription price) ─
  if (plan !== "free" && targetUser.flipdesk_subscription_id) {
    const FLIPDESK_PRICE_IDS = await getFlipdeskPriceIds();
    const priceId = FLIPDESK_PRICE_IDS[plan][interval];
    if (!priceId) {
      return c.json({ error: "Pricing not configured" }, 503);
    }

    const stripe = getStripe();
    if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

    try {
      const sub = await stripe.subscriptions.retrieve(
        targetUser.flipdesk_subscription_id,
      );
      const itemId = sub.items.data[0]?.id;
      if (!itemId) {
        return c.json({ error: "Stripe subscription has no items" }, 500);
      }

      await stripe.subscriptions.update(targetUser.flipdesk_subscription_id, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: "create_prorations",
        metadata: {
          ...sub.metadata,
          plan,
          interval,
          admin_changed_by: adminId,
        },
      });
    } catch (err) {
      console.error("[admin-billing] subscription update failed:", err);
      return c.json({ error: "Stripe update failed" }, 500);
    }

    // Webhook (customer.subscription.updated) will sync the user row.
    await auditLog(c, "admin.change_plan", "user", targetUserId, {
      from_plan: fromPlan,
      to_plan: plan,
      from_interval: targetUser.flipdesk_interval,
      to_interval: interval,
      method: "stripe_subscription_update",
    });
    await recordAdminEvent(targetUserId, adminId, fromPlan, plan, {
      from_interval: targetUser.flipdesk_interval,
      to_interval: interval,
      method: "stripe_subscription_update",
    });
    return c.json({ ok: true, method: "stripe_subscription_update" });
  }

  // ─ Case 4: free → free (no-op DB touch) ─
  return c.json({ ok: true, method: "noop" });
});

// ── POST /users/:id/comp-credits ─────────────────────────────────
//
// Body: { credits: number, reason: string }
// Adds credits to a user's GradeThread balance using the existing
// grant_grade_credits RPC with reason='admin_grant'. The reason text is
// stored in the ledger notes column for audit.
adminBillingRoutes.post("/users/:id/comp-credits", requireScope("billing:write"), async (c) => {
  // US-399: granting credits mints value — require a fresh MFA step-up like refunds.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const targetUserId = c.req.param("id");

  let body: { credits?: unknown; reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const credits = Number(body.credits);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  if (!Number.isFinite(credits) || credits <= 0) {
    return c.json({ error: "credits must be a positive integer" }, 400);
  }
  if (credits > 1000) {
    return c.json({ error: "credits must be <= 1000 per grant" }, 400);
  }
  if (!reason) {
    return c.json({ error: "reason is required" }, 400);
  }

  // Confirm target exists.
  const { data: targetUser, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, email, grade_credit_balance")
    .eq("id", targetUserId)
    .single();

  if (userError || !targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const { data: newBalance, error: grantError } = await supabaseAdmin.rpc(
    "grant_grade_credits",
    {
      p_user_id: targetUserId,
      p_credits: credits,
      p_reason: "admin_grant",
      p_stripe_payment_intent: null,
      p_notes: `Admin comp by ${adminId}: ${reason}`,
    },
  );

  if (grantError) {
    console.error("[admin-billing] grant failed:", grantError);
    return c.json({ error: "Failed to grant credits" }, 500);
  }

  await auditLog(c, "admin.comp_credits", "user", targetUserId, {
    credits,
    reason,
    previous_balance: targetUser.grade_credit_balance,
    new_balance: newBalance,
  });

  return c.json({ ok: true, newBalance });
});

// ── Credit ledger & adjustments (US-892) ─────────────────────────
//
// GET  /billing/users/:id/ledger      — paginated append-only ledger + balance
// POST /billing/users/:id/adjust      — audited manual credit/debit/correction
// POST /billing/users/:id/refund-pack — Stripe pack refund + offsetting ledger
//
// These EXTEND the comp-credits/charge-refund endpoints above (US-892 AC#4) —
// the ledger is the read surface, /adjust covers signed corrections the
// positive-only /comp-credits can't, and /refund-pack does the Stripe refund AND
// the ledger reversal in one idempotent flow.

// GET /billing/users/:id/ledger — append-only ledger with running balance_after,
// server-side paginated (newest-first for display). Tenant-scoped by user_id.
adminBillingRoutes.get("/billing/users/:id/ledger", requireScope("billing:write"), async (c) => {
  const targetUserId = c.req.param("id");

  const limitRaw = Number(c.req.query("limit"));
  const offsetRaw = Number(c.req.query("offset"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
    : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.trunc(offsetRaw) : 0;

  const { data: targetUser, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, email, grade_credit_balance")
    .eq("id", targetUserId)
    .single();
  if (userError || !targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const { data, count, error } = await supabaseAdmin
    .from("grade_credit_transactions")
    .select(
      "id, delta, reason, balance_after, submission_id, stripe_payment_intent_id, notes, idempotency_key, created_at",
      { count: "exact" },
    )
    .eq("user_id", targetUserId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[admin-billing] ledger query failed:", error);
    return c.json({ error: "Failed to load ledger" }, 500);
  }

  const rows = (data ?? []) as Array<{ delta: number; balance_after: number | null }>;
  const total = count ?? rows.length;

  // Defense-in-depth: when this single page covers the WHOLE ledger we can verify
  // the running per-row invariant (oldest-first). Null when paginated — the
  // running sum can't be computed from a partial slice.
  let invariantOk: boolean | null = null;
  if (offset === 0 && rows.length === total) {
    const oldestFirst = [...rows].reverse();
    invariantOk = findLedgerInvariantViolation(oldestFirst) === null;
  }

  return c.json({
    user: {
      id: targetUser.id,
      email: targetUser.email,
      grade_credit_balance: targetUser.grade_credit_balance,
    },
    data: data ?? [],
    page: { limit, offset, total },
    invariant_ok: invariantOk,
  });
});

// POST /billing/users/:id/adjust — audited signed adjustment. Body:
//   { delta: number (non-zero int), reason: 'admin_grant'|'refund'|'correction',
//     notes: string }
// Writes a NEW ledger row updating grade_credit_balance atomically; never
// mutates history. Destructive (mints/burns value) → fresh MFA step-up.
adminBillingRoutes.post("/billing/users/:id/adjust", requireScope("billing:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const targetUserId = c.req.param("id");

  let body: { delta?: unknown; reason?: unknown; notes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const delta = Number(body.delta);
  const reason = typeof body.reason === "string" ? body.reason : "";
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";

  if (!Number.isInteger(delta) || delta === 0) {
    return c.json({ error: "delta must be a non-zero integer" }, 400);
  }
  if (Math.abs(delta) > 10000) {
    return c.json({ error: "delta magnitude must be <= 10000 per adjustment" }, 400);
  }
  if (reason !== "admin_grant" && reason !== "refund" && reason !== "correction") {
    return c.json({ error: "reason must be one of: admin_grant, refund, correction" }, 400);
  }
  if (!notes) {
    return c.json({ error: "notes (reason text) is required" }, 400);
  }

  const { data: targetUser, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, email, grade_credit_balance")
    .eq("id", targetUserId)
    .single();
  if (userError || !targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const { data, error } = await supabaseAdmin.rpc("admin_adjust_credits", {
    p_user_id: targetUserId,
    p_delta: delta,
    p_reason: reason,
    p_actor_id: adminId,
    p_notes: notes,
  });

  if (error) {
    const msg = (error.message ?? "").toString();
    if (msg.includes("INSUFFICIENT_CREDITS")) {
      return c.json(
        { error: "Adjustment would drive the balance negative." },
        422,
      );
    }
    console.error("[admin-billing] adjust failed:", error);
    return c.json({ error: "Failed to adjust credits" }, 500);
  }

  const result = (data ?? {}) as {
    transaction_id?: string;
    balance_after?: number;
    delta?: number;
  };

  await auditLog(c, "admin.credit_adjust", "user", targetUserId, {
    delta,
    reason,
    notes,
    previous_balance: targetUser.grade_credit_balance,
    new_balance: result.balance_after ?? null,
    transaction_id: result.transaction_id ?? null,
  });

  return c.json({
    ok: true,
    newBalance: result.balance_after ?? null,
    transactionId: result.transaction_id ?? null,
  });
});

// POST /billing/users/:id/refund-pack — refund a credit-pack charge AND write
// the offsetting ledger reversal in one idempotent flow. Body: { charge_id,
// reason? }. The Stripe refund + the wallet claw-back share a per-charge
// idempotency key so a retry — or the charge.refunded webhook — can't
// double-refund. Destructive → fresh MFA step-up.
adminBillingRoutes.post("/billing/users/:id/refund-pack", requireScope("billing:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const targetUserId = c.req.param("id");

  let body: { charge_id?: unknown; reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const chargeId = typeof body.charge_id === "string" ? body.charge_id.trim() : "";
  const reasonNote = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  if (!chargeId) {
    return c.json({ error: "charge_id is required" }, 400);
  }

  const { data: targetUser, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, email, stripe_customer_id")
    .eq("id", targetUserId)
    .single();
  if (userError || !targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  // Load the charge to verify ownership + read the granted credit count.
  let charge: Stripe.Charge;
  try {
    charge = await stripe.charges.retrieve(chargeId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Charge lookup failed: ${msg}` }, 404);
  }

  // US-1414: charge.metadata is empty for Checkout payments (metadata lives on
  // the PaymentIntent), so resolve it before the ownership/product/credits
  // checks — otherwise every pack refund wrongly 403s/422s ("not a credit-pack
  // charge") because the fields read as undefined.
  const meta = await resolveChargeMetadata(charge, async (id) => {
    try {
      const pi = await stripe.paymentIntents.retrieve(id);
      return (pi.metadata ?? {}) as Record<string, string>;
    } catch (err) {
      console.error("[admin-billing] PaymentIntent metadata lookup failed:", err);
      return null;
    }
  });

  // Tenant scoping (CLAUDE.md US-268): the charge MUST belong to this user —
  // by the user_id stamped on the pack checkout, or its Stripe customer.
  const chargeUserId = meta.user_id ?? null;
  const customerId = typeof charge.customer === "string"
    ? charge.customer
    : charge.customer?.id ?? null;
  const ownsByMetadata = chargeUserId === targetUserId;
  const ownsByCustomer = Boolean(targetUser.stripe_customer_id) &&
    customerId === targetUser.stripe_customer_id;
  if (!ownsByMetadata && !ownsByCustomer) {
    return c.json({ error: "Charge does not belong to this user." }, 403);
  }
  if (meta.product !== "credit_pack") {
    return c.json(
      { error: "Not a credit-pack charge. Use Recent charges → Refund for other charges." },
      422,
    );
  }
  if (charge.refunded) {
    return c.json({ error: "Charge is already fully refunded." }, 409);
  }

  const credits = Number.parseInt(meta.credits ?? "", 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    return c.json({ error: "Charge has no valid credit count in metadata." }, 422);
  }

  // (1) Stripe refund — idempotency key keyed on the charge so a retry returns
  // the SAME refund object instead of refunding the money twice.
  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(
      {
        charge: chargeId,
        reason: "requested_by_customer",
        metadata: {
          admin_id: adminId,
          product: "credit_pack",
          ...(reasonNote ? { admin_reason: reasonNote } : {}),
        },
      },
      { idempotencyKey: `pack-refund:${chargeId}` },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin-billing] pack refund (stripe) failed:", msg);
    return c.json({ error: `Refund failed: ${msg}` }, 500);
  }

  // (2) Offsetting ledger reversal — the SAME idempotency key the
  // charge.refunded webhook will use, so the wallet is clawed back exactly once
  // no matter which path runs first (the other no-ops).
  //
  // US-2033: that shared key is now keyed on the REFUND, not the charge. Keying
  // per charge silently under-clawed a second, partial refund on the same
  // charge: the webhook computed the right amount and then skipped the write
  // because the key was already claimed. Per refund, each refund moves its own
  // increment, and this path and the webhook still dedupe against each other —
  // Stripe's own idempotency above guarantees a retry returns the SAME refund
  // object, so `refund.id` is stable across retries of this handler.
  const paymentIntentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id ?? null;
  const { data: revokeData, error: revokeErr } = await supabaseAdmin.rpc(
    "revoke_grade_credits",
    {
      p_user_id: targetUserId,
      p_credits: credits,
      p_stripe_payment_intent: paymentIntentId,
      p_notes: `Admin pack refund for charge ${chargeId} by ${adminId} (refund ${refund.id})`,
      p_idempotency_key: `pack-refund:${refund.id}`,
    },
  );

  if (revokeErr) {
    // The money refund SUCCEEDED — surface the ledger gap loudly (the webhook
    // will also retry the reversal under the same idempotency key).
    console.error("[admin-billing] pack refund ledger reversal failed:", revokeErr);
    await auditLog(c, "admin.pack_refund", "charge", chargeId, {
      user_id: targetUserId,
      refund_id: refund.id,
      credits,
      ledger_error: (revokeErr.message ?? "").toString().slice(0, 500),
    });
    return c.json(
      {
        error: "Refund issued, but the ledger reversal failed — reconcile manually.",
        refund_id: refund.id,
      },
      500,
    );
  }

  const result = (revokeData ?? {}) as {
    revoked?: number;
    shortfall?: number;
    balance_after?: number;
    idempotent_replay?: boolean;
  };

  await auditLog(c, "admin.pack_refund", "charge", chargeId, {
    user_id: targetUserId,
    refund_id: refund.id,
    refund_amount_cents: refund.amount,
    credits,
    revoked: result.revoked ?? null,
    shortfall: result.shortfall ?? null,
    balance_after: result.balance_after ?? null,
    idempotent_replay: result.idempotent_replay ?? false,
  });

  return c.json({
    ok: true,
    refund_id: refund.id,
    refund_amount_cents: refund.amount,
    revoked: result.revoked ?? null,
    shortfall: result.shortfall ?? null,
    newBalance: result.balance_after ?? null,
  });
});

// ── POST /users/:id/set-trial ────────────────────────────────────
//
// Body: { trial_ends_at: string | null }  (ISO 8601 timestamp, or null to clear)
// Rare exception path (US-221): lets an admin extend or clear a user's Pro
// trial window. Writes users.trial_ends_at directly and audit-logs before/after.
adminBillingRoutes.post("/users/:id/set-trial", requireScope("billing:write"), async (c) => {
  // US-399: extending entitlement for free is destructive — require step-up.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const targetUserId = c.req.param("id");

  let body: { trial_ends_at?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let trialEndsAt: string | null;
  if (body.trial_ends_at === null || body.trial_ends_at === undefined) {
    trialEndsAt = null;
  } else if (typeof body.trial_ends_at === "string") {
    const parsed = new Date(body.trial_ends_at);
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ error: "trial_ends_at must be a valid ISO timestamp or null" }, 400);
    }
    trialEndsAt = parsed.toISOString();
  } else {
    return c.json({ error: "trial_ends_at must be a string or null" }, 400);
  }

  const { data: targetUser, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, trial_ends_at")
    .eq("id", targetUserId)
    .single();

  if (userError || !targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const { error: updateError } = await supabaseAdmin
    .from("users")
    .update({ trial_ends_at: trialEndsAt })
    .eq("id", targetUserId);

  if (updateError) {
    console.error("[admin-billing] set-trial update failed:", updateError);
    return c.json({ error: "Failed to update trial" }, 500);
  }

  await auditLog(c, "admin.set_trial", "user", targetUserId, {
    from_trial_ends_at: targetUser.trial_ends_at,
    to_trial_ends_at: trialEndsAt,
  });
  await recordAdminEvent(targetUserId, adminId, null, null, {
    action: "set_trial",
    from_trial_ends_at: targetUser.trial_ends_at,
    to_trial_ends_at: trialEndsAt,
  });

  return c.json({ ok: true, trial_ends_at: trialEndsAt });
});

// ── POST /charges/:id/refund ─────────────────────────────────────
//
// Refunds a Stripe charge. If the charge was a credit pack, the
// charge.refunded webhook handler will write a ledger reversal.
adminBillingRoutes.post("/charges/:id/refund", requireScope("billing:write"), async (c) => {
  // US-270: manual refund is destructive — require a fresh MFA step-up.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const chargeId = c.req.param("id");

  let body: { reason?: unknown; amount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const refundReason = typeof body.reason === "string" ? body.reason.slice(0, 200) : null;

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  // US-2294: read the charge FIRST, so a partial refund can be bounded by what
  // is actually still refundable. Without this there was no ceiling at all — a
  // typo'd extra digit went straight to Stripe, and a charge already partly
  // refunded would fail only AFTER the audit-log entry was written.
  let remainingCents: number | null = null;
  try {
    const charge = await stripe.charges.retrieve(chargeId);
    remainingCents = (charge.amount ?? 0) - (charge.amount_refunded ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Could not read charge: ${msg}` }, 502);
  }

  // US-2294: `amount: 0` used to be FALSY, so the field was dropped and Stripe
  // read the request as a full refund — an admin typing 0 refunded the whole
  // charge. "Refund everything" is now an intent (omit the field), never
  // something inferred from a value being falsy.
  const parsed = normalizeRefundAmount(body.amount, remainingCents);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    const refund = await stripe.refunds.create(
      {
        charge: chargeId,
        ...(parsed.kind === "partial" ? { amount: parsed.amount } : {}),
        reason: "requested_by_customer",
        metadata: {
          admin_id: adminId,
          ...(refundReason ? { admin_reason: refundReason } : {}),
        },
      },
      // US-1641: idempotency so a double-click / retry can't issue a second
      // refund. Keyed on (charge, amount) — a distinct partial amount still goes
      // through, but an identical resubmit within Stripe's 24h window is replayed,
      // not re-charged. US-2294 moved the key next to the validator, because the
      // old spelling produced `:0` for an amount Stripe executed as a FULL
      // refund — a different key for the same effect, so the double-click guard
      // was bypassed by the exact input that caused the bug.
      { idempotencyKey: refundIdempotencyKey(chargeId, parsed) },
    );

    await auditLog(c, "admin.refund_charge", "charge", chargeId, {
      refund_id: refund.id,
      amount: refund.amount,
      reason: refundReason,
    });

    return c.json({
      ok: true,
      refund_id: refund.id,
      amount: refund.amount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin-billing] refund failed:", msg);
    return c.json({ error: `Refund failed: ${msg}` }, 500);
  }
});

// ── GET /coupons (US-223) ────────────────────────────────────────
//
// Listing of Stripe coupons + promotion codes with redemption counts. Creation
// (POST /coupons), name edits (POST /coupons/:id) and promo-code pause/resume
// (POST /promotion-codes/:id) are all available in-app to super_admins (US-586).
adminBillingRoutes.get("/coupons", requireScope("billing:write"), async (c) => {
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const [coupons, promoCodes] = await Promise.all([
      stripe.coupons.list({ limit: 50 }),
      // Include inactive codes so the admin can re-activate a paused one
      // (US-586 toggle). The UI badges active vs inactive.
      stripe.promotionCodes.list({ limit: 50 }),
    ]);

    return c.json({
      coupons: coupons.data.map((c: Stripe.Coupon) => ({
        id: c.id,
        name: c.name,
        percent_off: c.percent_off,
        amount_off: c.amount_off,
        currency: c.currency,
        duration: c.duration,
        duration_in_months: c.duration_in_months,
        max_redemptions: c.max_redemptions,
        times_redeemed: c.times_redeemed,
        redeem_by: c.redeem_by,
        valid: c.valid,
        created: c.created,
      })),
      promotion_codes: promoCodes.data.map((p: Stripe.PromotionCode) => ({
        id: p.id,
        code: p.code,
        coupon_id: typeof p.coupon === "string" ? p.coupon : p.coupon.id,
        max_redemptions: p.max_redemptions,
        times_redeemed: p.times_redeemed,
        expires_at: p.expires_at,
        active: p.active,
        created: p.created,
      })),
    });
  } catch (err) {
    console.error("[admin-billing] coupons list failed:", err);
    return c.json({ error: "Failed to load coupons" }, 500);
  }
});

// ── POST /coupons (US-630) ───────────────────────────────────────
//
// Create a Stripe coupon (+ optional promotion code) from the admin panel —
// closes the old read-only gap (coupons were "create them in the Stripe
// dashboard" only). super_admin + fresh MFA step-up; every create is audited.
//
// Body: { name?, percent_off?|amount_off?+currency, duration, duration_in_months?,
//         max_redemptions?, redeem_by?(unix sec), promo_code? }
adminBillingRoutes.post("/coupons", requireScope("billing:write"), async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required to create coupons." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const percentOff = body.percent_off != null ? Number(body.percent_off) : null;
  const amountOff = body.amount_off != null ? Number(body.amount_off) : null;
  const currency = typeof body.currency === "string" ? body.currency.toLowerCase() : null;
  const duration = body.duration === "forever" || body.duration === "repeating" ? body.duration : "once";
  const durationInMonths = body.duration_in_months != null ? Number(body.duration_in_months) : null;

  // Exactly one discount kind.
  if ((percentOff == null) === (amountOff == null)) {
    return c.json({ error: "Provide exactly one of percent_off or amount_off" }, 400);
  }
  if (percentOff != null && (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100)) {
    return c.json({ error: "percent_off must be 1-100" }, 400);
  }
  if (amountOff != null) {
    if (!Number.isFinite(amountOff) || amountOff <= 0) {
      return c.json({ error: "amount_off must be a positive integer (in cents)" }, 400);
    }
    if (!currency) return c.json({ error: "currency is required with amount_off" }, 400);
  }
  if (duration === "repeating" && (!Number.isFinite(Number(durationInMonths)) || Number(durationInMonths) < 1)) {
    return c.json({ error: "duration_in_months is required for a repeating coupon" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const params: Stripe.CouponCreateParams = { duration: duration as Stripe.CouponCreateParams.Duration };
    if (typeof body.name === "string" && body.name.trim()) params.name = body.name.trim().slice(0, 200);
    if (percentOff != null) params.percent_off = percentOff;
    if (amountOff != null) {
      params.amount_off = Math.round(amountOff);
      params.currency = currency!;
    }
    if (duration === "repeating") params.duration_in_months = Math.round(Number(durationInMonths));
    if (body.max_redemptions != null && Number.isFinite(Number(body.max_redemptions))) {
      params.max_redemptions = Math.round(Number(body.max_redemptions));
    }
    if (body.redeem_by != null && Number.isFinite(Number(body.redeem_by))) {
      params.redeem_by = Math.round(Number(body.redeem_by));
    }

    const coupon = await stripe.coupons.create(params);

    // Optional human-facing promotion code referencing the new coupon.
    let promoCode: Stripe.PromotionCode | null = null;
    const codeStr = typeof body.promo_code === "string" ? body.promo_code.trim().toUpperCase() : "";
    if (codeStr) {
      promoCode = await stripe.promotionCodes.create({ coupon: coupon.id, code: codeStr.slice(0, 40) });
    }

    await auditLog(c, "admin.coupon.create", "coupon", coupon.id, {
      percent_off: coupon.percent_off,
      amount_off: coupon.amount_off,
      currency: coupon.currency,
      duration: coupon.duration,
      duration_in_months: coupon.duration_in_months,
      max_redemptions: coupon.max_redemptions,
      promo_code: promoCode?.code ?? null,
    });

    return c.json({ ok: true, coupon_id: coupon.id, promo_code: promoCode?.code ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin-billing] coupon create failed:", msg);
    return c.json({ error: `Coupon create failed: ${msg}` }, 500);
  }
});

// ── POST /coupons/:id/archive (US-630) ───────────────────────────
//
// Delete a Stripe coupon. Existing subscriptions that already applied it keep
// it; new redemptions are blocked and any promo codes referencing it stop
// working. super_admin + step-up; audited.
adminBillingRoutes.post("/coupons/:id/archive", requireScope("billing:write"), async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const couponId = c.req.param("id");
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    await stripe.coupons.del(couponId);
    await auditLog(c, "admin.coupon.archive", "coupon", couponId, {});
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin-billing] coupon archive failed:", msg);
    return c.json({ error: `Archive failed: ${msg}` }, 500);
  }
});

// ── POST /coupons/:id (US-586) ───────────────────────────────────
//
// Edit an existing coupon. Stripe makes a coupon's discount immutable once
// created (percent_off/amount_off/duration can't change) — only `name` (and
// metadata) are mutable. So "edit" here updates the internal name; to change a
// discount you archive + recreate. super_admin + step-up; audited.
//
// Body: { name: string | null }
adminBillingRoutes.post("/coupons/:id", requireScope("billing:write"), async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required to edit coupons." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const couponId = c.req.param("id");

  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.name !== null && typeof body.name !== "string") {
    return c.json({ error: "name must be a string or null" }, 400);
  }
  // Stripe clears the name when an empty string is sent; pass through deliberately.
  const name = body.name === null ? "" : (body.name as string).trim().slice(0, 200);

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const coupon = await stripe.coupons.update(couponId, { name });
    await auditLog(c, "admin.coupon.update", "coupon", couponId, {
      name: coupon.name,
    });
    return c.json({ ok: true, coupon_id: coupon.id, name: coupon.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin-billing] coupon update failed:", msg);
    return c.json({ error: `Coupon update failed: ${msg}` }, 500);
  }
});

// ── POST /promotion-codes/:id (US-586) ───────────────────────────
//
// Edit a promotion code. Stripe only lets you toggle `active` (the code string,
// coupon and restrictions are fixed at creation). Pausing/resuming a code is the
// fast lever for a growth experiment — stop redemptions without nuking the
// underlying coupon or any subscriptions already carrying it. super_admin +
// step-up; audited.
//
// Body: { active: boolean }
adminBillingRoutes.post("/promotion-codes/:id", requireScope("billing:write"), async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required to edit promotion codes." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const promoId = c.req.param("id");

  let body: { active?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.active !== "boolean") {
    return c.json({ error: "active must be a boolean" }, 400);
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const promo = await stripe.promotionCodes.update(promoId, { active: body.active });
    await auditLog(c, "admin.promotion_code.update", "promotion_code", promoId, {
      code: promo.code,
      active: promo.active,
    });
    return c.json({ ok: true, promotion_code_id: promo.id, active: promo.active });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin-billing] promotion code update failed:", msg);
    return c.json({ error: `Promotion code update failed: ${msg}` }, 500);
  }
});

// ── GET /users/:id/payments ──────────────────────────────────────
//
// Lists the target user's recent Stripe charges + subscription state for
// the admin billing tab UI.
adminBillingRoutes.get("/users/:id/payments", requireScope("billing:write"), async (c) => {
  const targetUserId = c.req.param("id");

  const { data: targetUser, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, email, stripe_customer_id, flipdesk_subscription_id")
    .eq("id", targetUserId)
    .single();

  if (userError || !targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!targetUser.stripe_customer_id) {
    return c.json({ charges: [], subscription: null });
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const [charges, subscription] = await Promise.all([
      stripe.charges.list({ customer: targetUser.stripe_customer_id, limit: 20 }),
      targetUser.flipdesk_subscription_id
        ? stripe.subscriptions.retrieve(targetUser.flipdesk_subscription_id)
        : Promise.resolve(null),
    ]);

    return c.json({
      charges: charges.data.map((ch: Stripe.Charge) => ({
        id: ch.id,
        amount: ch.amount,
        currency: ch.currency,
        status: ch.status,
        refunded: ch.refunded,
        amount_refunded: ch.amount_refunded,
        description: ch.description,
        created: ch.created,
        metadata: ch.metadata,
        receipt_url: ch.receipt_url,
      })),
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            current_period_end: subscription.current_period_end,
            cancel_at_period_end: subscription.cancel_at_period_end,
            items: subscription.items.data.map((it: Stripe.SubscriptionItem) => ({
              price_id: it.price.id,
              unit_amount: it.price.unit_amount,
              interval: it.price.recurring?.interval,
              lookup_key: it.price.lookup_key,
            })),
          }
        : null,
    });
  } catch (err) {
    console.error("[admin-billing] payments query failed:", err);
    return c.json({ error: "Failed to load payments" }, 500);
  }
});

// ── Pending grade refunds (US-771) ───────────────────────────────
//
// Per-grade Stripe refunds the pipeline couldn't issue automatically (a Stripe
// error, or a paid_stripe submission with no stored PaymentIntent) land in
// public.pending_refunds. These endpoints let an operator see + complete them.

// GET /pending-refunds — open operator queue.
adminBillingRoutes.get("/pending-refunds", requireScope("billing:write"), async (c) => {
  const { data, error } = await supabaseAdmin
    .from("pending_refunds")
    .select(
      "id, submission_id, user_id, payment_intent_id, reason, last_error, created_at",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    console.error("[admin-billing] pending_refunds query failed:", error);
    return c.json({ error: "Failed to load pending refunds" }, 500);
  }

  const rows = (data ?? []) as Array<{ user_id: string }>;
  // Attach the customer email for context.
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const emailById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .in("id", userIds);
    for (const u of (users ?? []) as Array<{ id: string; email: string }>) {
      emailById.set(u.id, u.email);
    }
  }

  return c.json({
    data: (data ?? []).map((r) => ({
      ...(r as Record<string, unknown>),
      user_email: emailById.get((r as { user_id: string }).user_id) ?? null,
    })),
  });
});

// POST /pending-refunds/:id/resolve — issue the Stripe refund (idempotent on
// the submission) and close the row. Destructive → fresh MFA step-up required.
adminBillingRoutes.post("/pending-refunds/:id/resolve", requireScope("billing:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const id = c.req.param("id");

  const { data: row, error: loadErr } = await supabaseAdmin
    .from("pending_refunds")
    .select("id, submission_id, payment_intent_id, status")
    .eq("id", id)
    .maybeSingle();
  if (loadErr || !row) return c.json({ error: "Pending refund not found" }, 404);
  const refund = row as {
    submission_id: string;
    payment_intent_id: string | null;
    status: string;
  };
  if (refund.status !== "pending") {
    return c.json({ error: `Already ${refund.status}` }, 409);
  }
  if (!refund.payment_intent_id) {
    return c.json(
      {
        error:
          "No PaymentIntent on this row — locate the charge in Stripe and refund it via Charges, then this row can be canceled.",
      },
      422,
    );
  }

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const created = await stripe.refunds.create(
      {
        payment_intent: refund.payment_intent_id,
        reason: "requested_by_customer",
        metadata: { submission_id: refund.submission_id, admin_id: adminId },
      },
      // Same key the pipeline would have used → Stripe won't double-refund.
      { idempotencyKey: `grade-refund:${refund.submission_id}` },
    );

    await supabaseAdmin
      .from("pending_refunds")
      .update({
        status: "resolved",
        stripe_refund_id: created.id,
        resolved_at: new Date().toISOString(),
        resolved_by: adminId,
      })
      .eq("id", id);
    await supabaseAdmin
      .from("submissions")
      .update({ stripe_refund_id: created.id })
      .eq("id", refund.submission_id);

    await auditLog(c, "admin.grade_refund_resolved", "pending_refund", id, {
      submission_id: refund.submission_id,
      refund_id: created.id,
    });

    return c.json({ ok: true, refund_id: created.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin-billing] resolve pending refund failed:", msg);
    await supabaseAdmin
      .from("pending_refunds")
      .update({ last_error: msg.slice(0, 1000) })
      .eq("id", id);
    return c.json({ error: `Refund failed: ${msg}` }, 500);
  }
});

// ── Webhook dead letters (US-772) ────────────────────────────────
//
// Non-transient webhook handler drops (a code bug a provider retry can't fix)
// land in public.webhook_dead_letters with a redacted payload. These endpoints
// surface the queue and let an operator mark a row resolved after replaying it.
//
// Manual replay (no one-click reprocess by design — the failing handler is a bug
// that needs a code fix first): once the bug is fixed and deployed, an operator
// re-sends the event from the Stripe dashboard (Developers → Events → the evt_…
// id shown here → "Resend"). The new delivery is a fresh event id, so the
// idempotency claim won't dedupe it. After confirming it processed, resolve the
// row here. See vault/10-ops/incident-response.md → "3a. Dead-lettered webhook".

// GET /webhook-dead-letters — open (unresolved) queue, newest first.
adminBillingRoutes.get("/webhook-dead-letters", requireScope("billing:write"), async (c) => {
  const { data, error } = await supabaseAdmin
    .from("webhook_dead_letters")
    .select(
      "id, provider, event_id, event_type, error_message, payload, created_at",
    )
    .eq("status", "unresolved")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[admin-billing] webhook_dead_letters query failed:", error);
    return c.json({ error: "Failed to load webhook dead letters" }, 500);
  }

  return c.json({ data: data ?? [] });
});

// POST /webhook-dead-letters/:id/resolve — mark a dead letter resolved after the
// operator has replayed/handled it. Body: { note?: string }. This is an
// acknowledgement (no money moves here), so no step-up — just admin-gated +
// audited. The replay itself happens out of band (see the note above).
adminBillingRoutes.post("/webhook-dead-letters/:id/resolve", requireScope("billing:write"), async (c) => {
  const adminId = c.get("userId");
  const id = c.req.param("id");

  let body: { note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : null;

  const { data: updated, error } = await supabaseAdmin
    .from("webhook_dead_letters")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: adminId,
      resolution_note: note,
    })
    .eq("id", id)
    .eq("status", "unresolved")
    .select("id, provider, event_id")
    .maybeSingle();

  if (error) {
    console.error("[admin-billing] resolve webhook dead letter failed:", error);
    return c.json({ error: "Failed to resolve dead letter" }, 500);
  }
  if (!updated) {
    // Either it doesn't exist or it was already resolved by another operator.
    return c.json({ error: "Dead letter not found or already resolved" }, 404);
  }

  const row = updated as { provider: string; event_id: string };
  await auditLog(c, "admin.webhook_dead_letter_resolved", "webhook_dead_letter", id, {
    provider: row.provider,
    event_id: row.event_id,
    note,
  });

  return c.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// US-893: Stripe reconciliation & dunning console.
//
// Surfaces revenue leaks — past-due/paused accounts, recent failed invoices, and
// Stripe-vs-DB subscription divergences precomputed by the scheduled
// billing-reconciliation job — and the recovery actions: re-sync a user from live
// Stripe state, send a dunning nudge (reuses the US-582 transactional sender), or
// mark a divergence resolved. All paths are mounted under /api/admin (this router)
// so the AC paths are /billing/reconciliation*.
// ═══════════════════════════════════════════════════════════════════

interface PastDueRow {
  id: string;
  email: string;
  full_name: string | null;
  flipdesk_plan: string | null;
  subscription_status: string | null;
  past_due_since: string | null;
  flipdesk_period_end: string | null;
  flipdesk_subscription_id: string | null;
  stripe_customer_id: string | null;
}

// GET /billing/reconciliation — three operator panels (AC1). The past-due/paused
// account list is the primary server-side-paginated surface; recent failed
// invoices and precomputed divergences are bounded secondary panels.
adminBillingRoutes.get("/billing/reconciliation", requireScope("billing:write"), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 100);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  // (a) Past-due / paused accounts — paginated.
  const { data: pastDueData, error: pastDueErr, count: pastDueCount } = await supabaseAdmin
    .from("users")
    .select(
      "id, email, full_name, flipdesk_plan, subscription_status, past_due_since, flipdesk_period_end, flipdesk_subscription_id, stripe_customer_id",
      { count: "exact" },
    )
    .in("subscription_status", ["past_due", "paused"])
    .order("past_due_since", { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (pastDueErr) {
    console.error("[admin-billing] reconciliation past-due query failed:", pastDueErr.message);
    return c.json({ error: "Failed to load past-due accounts" }, 500);
  }
  const pastDue = (pastDueData ?? []) as PastDueRow[];

  // (b) Recent failed invoices (last 30 days), bounded. Emails resolved in a
  // second scoped query to keep the typed client simple.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: failedRaw } = await supabaseAdmin
    .from("flipdesk_subscription_events")
    .select("id, user_id, event_type, raw_payload, created_at")
    .eq("event_type", "invoice.payment_failed")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(25);
  const failedRows = (failedRaw ?? []) as Array<{
    id: string;
    user_id: string;
    raw_payload: Record<string, unknown> | null;
    created_at: string;
  }>;
  const emailById = new Map<string, string>();
  if (failedRows.length > 0) {
    const ids = [...new Set(failedRows.map((r) => r.user_id))];
    const { data: emailRows } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .in("id", ids);
    for (const u of (emailRows ?? []) as Array<{ id: string; email: string }>) {
      emailById.set(u.id, u.email);
    }
  }
  const failedInvoices = failedRows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    email: emailById.get(r.user_id) ?? null,
    created_at: r.created_at,
    detail: r.raw_payload ?? {},
  }));

  // (c) Precomputed divergences from the scheduled job (AC3) — bounded + counted.
  const { data: divData, count: divCount } = await supabaseAdmin
    .from("billing_reconciliation_flags")
    .select(
      "id, subject_user_id, kind, db_status, expected_status, db_plan, expected_plan, latest_event_type, detail, detected_at, last_seen_at",
      { count: "exact" },
    )
    .eq("status", "open")
    .order("detected_at", { ascending: false })
    .limit(100);

  // Last time the reconciliation job wrote anything, so the UI can show staleness.
  const { data: lastScan } = await supabaseAdmin
    .from("billing_reconciliation_flags")
    .select("last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return c.json({
    pastDue: { data: pastDue, total: pastDueCount ?? pastDue.length, limit, offset },
    failedInvoices,
    divergences: { data: divData ?? [], total: divCount ?? (divData?.length ?? 0) },
    lastScanAt: (lastScan as { last_seen_at: string } | null)?.last_seen_at ?? null,
  });
});

interface ResyncUserRow {
  id: string;
  email: string;
  full_name: string | null;
  flipdesk_plan: FlipdeskPlan | null;
  subscription_status: string | null;
  flipdesk_subscription_id: string | null;
  stripe_customer_id: string | null;
  trial_ends_at: string | null;
  past_due_since: string | null;
}

// Pick the most relevant subscription from a customer's list: a live one
// (active/trialing/past_due/paused) wins; otherwise the most recently created.
function pickRelevantSubscription(
  subs: Stripe.Subscription[],
): Stripe.Subscription | null {
  if (subs.length === 0) return null;
  const live = subs.find((s) =>
    ["active", "trialing", "past_due", "unpaid", "paused"].includes(s.status)
  );
  if (live) return live;
  return [...subs].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0] ?? null;
}

// POST /billing/reconciliation/users/:id/resync — pull live Stripe state and
// apply it (AC2). Idempotent: it sets the cached columns to whatever Stripe
// currently reports, so running it twice yields the same result, and it NEVER
// writes processed_webhook_events — a real future webhook (a new event.id) is
// unaffected, so this can't double-apply an event already processed (AC5).
adminBillingRoutes.post("/billing/reconciliation/users/:id/resync", requireScope("billing:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const targetUserId = c.req.param("id");

  const { data: userRaw, error: loadErr } = await supabaseAdmin
    .from("users")
    .select(
      "id, email, full_name, flipdesk_plan, subscription_status, flipdesk_subscription_id, stripe_customer_id, trial_ends_at, past_due_since",
    )
    .eq("id", targetUserId)
    .maybeSingle();
  if (loadErr) return failSafe(c, 500, "Couldn't load the user.", loadErr, "admin.billing.reconciliation.resync.load");
  const user = userRaw as ResyncUserRow | null;
  if (!user) return c.json({ error: "User not found" }, 404);

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Billing is not configured" }, 503);

  // Resolve the live subscription: prefer the stored id, fall back to the
  // customer's subscription list.
  let sub: Stripe.Subscription | null = null;
  try {
    if (user.flipdesk_subscription_id) {
      try {
        sub = await stripe.subscriptions.retrieve(user.flipdesk_subscription_id, {
          expand: ["items.data.price"],
        });
      } catch {
        sub = null; // deleted / not found → fall through to customer lookup
      }
    }
    if (!sub && user.stripe_customer_id) {
      const list = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: "all",
        limit: 10,
        expand: ["data.items.data.price"],
      });
      sub = pickRelevantSubscription(list.data);
    }
  } catch (err) {
    console.error("[admin-billing] resync Stripe lookup failed:", err);
    return c.json({ error: "Failed to read live subscription from Stripe" }, 502);
  }

  // Compute the cached state from live Stripe data (or no-subscription Free).
  let plan: FlipdeskPlan;
  let status: "none" | "trialing" | "active" | "past_due" | "paused" | "canceled";
  let interval: "monthly" | "yearly" | null = null;
  let periodEnd: string | null = null;
  let pauseUntil: string | null = null;
  let cancelAtPeriodEnd = false;
  let subscriptionId: string | null = null;

  if (sub) {
    plan = mapSubscriptionToFlipdeskPlan(sub) ?? "free";
    status = sub.pause_collection ? "paused" : mapSubscriptionStatus(sub.status);
    interval = mapSubscriptionInterval(sub);
    periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null;
    pauseUntil = sub.pause_collection?.resumes_at
      ? new Date(sub.pause_collection.resumes_at * 1000).toISOString()
      : null;
    cancelAtPeriodEnd = sub.cancel_at_period_end ?? false;
    subscriptionId = sub.id;
  } else {
    // No live subscription in Stripe. If the user previously had one, it's
    // canceled; otherwise they're simply on Free.
    plan = "free";
    status = user.flipdesk_subscription_id ? "canceled" : "none";
  }

  const { error: updErr } = await supabaseAdmin
    .from("users")
    .update({
      flipdesk_plan: plan,
      flipdesk_interval: interval,
      subscription_status: status,
      flipdesk_subscription_id: subscriptionId,
      flipdesk_period_end: periodEnd,
      flipdesk_pause_until: pauseUntil,
      flipdesk_cancel_at_period_end: cancelAtPeriodEnd,
      past_due_since: nextPastDueSince(
        user.subscription_status,
        user.past_due_since,
        status,
      ),
    })
    .eq("id", user.id);
  if (updErr) {
    console.error("[admin-billing] resync update failed:", updErr.message);
    return c.json({ error: "Failed to apply subscription state" }, 500);
  }

  // Mirror the action into the subscription event trail (stripe_event_id null —
  // NOT processed_webhook_events, preserving AC5 idempotency).
  await supabaseAdmin.from("flipdesk_subscription_events").insert({
    user_id: user.id,
    stripe_event_id: null,
    event_type: "admin_resync",
    from_plan: user.flipdesk_plan,
    to_plan: plan,
    raw_payload: {
      admin_id: adminId,
      source: "reconciliation",
      subscription_id: subscriptionId,
      stripe_status: sub?.status ?? null,
    },
  });

  // Any open divergence flag for this account is now reconciled.
  await supabaseAdmin
    .from("billing_reconciliation_flags")
    .update({
      status: "resolved",
      resolution: "resynced",
      resolved_at: new Date().toISOString(),
      resolved_by: adminId,
    })
    .eq("subject_user_id", user.id)
    .eq("status", "open");

  await auditLog(c, "admin.subscription_resync", "user", user.id, {
    from: { plan: user.flipdesk_plan, status: user.subscription_status },
    to: { plan, status, interval },
    subscription_id: subscriptionId,
    had_live_subscription: sub !== null,
  });

  return c.json({ ok: true, applied: { plan, status, interval }, subscriptionId });
});

// POST /billing/reconciliation/users/:id/dunning-email — send a dunning nudge
// (AC2). Reuses the US-582 transactional sender + in-app notification + audit.
adminBillingRoutes.post("/billing/reconciliation/users/:id/dunning-email", requireScope("billing:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const targetUserId = c.req.param("id");
  const { data: userRaw, error: loadErr } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, flipdesk_plan, subscription_status")
    .eq("id", targetUserId)
    .maybeSingle();
  if (loadErr) return failSafe(c, 500, "Couldn't load the user.", loadErr, "admin.billing.reconciliation.dunning.load");
  const user = userRaw as
    | { id: string; email: string; full_name: string | null; flipdesk_plan: string | null; subscription_status: string | null }
    | null;
  if (!user) return c.json({ error: "User not found" }, 404);

  const planLabel = user.flipdesk_plan
    ? user.flipdesk_plan.charAt(0).toUpperCase() + user.flipdesk_plan.slice(1)
    : "your";
  const subject = "Action needed: update your payment method";
  const body =
    `We weren't able to process the most recent payment for your FlipDesk ${planLabel} plan.\n\n` +
    "To avoid an interruption to your account, please update your payment method as soon as possible. " +
    "Once your card is updated we'll retry the charge automatically.\n\n" +
    "If you've already updated your billing details, you can disregard this message.";
  const ctaUrl = `${SITE_URL}/dashboard/billing`;

  const sent = await sendAdminMessageEmail(user.email, {
    userName: user.full_name || user.email,
    subject,
    body,
    ctaLabel: "Update payment method",
    ctaUrl,
  });

  // In-app copy so the nudge isn't email-only (mirrors admin-messages, US-582).
  const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
    user_id: user.id,
    type: "system",
    title: subject,
    message: body.length > 500 ? `${body.slice(0, 497)}…` : body,
    link: ctaUrl,
  });
  if (notifErr) {
    console.error("[admin-billing] dunning notification insert failed:", notifErr.message);
  }

  await auditLog(c, "admin.dunning_email", "user", user.id, {
    recipient_email: user.email,
    subscription_status: user.subscription_status,
    email_accepted: sent,
  });

  return c.json({ ok: true, delivered: sent }, sent ? 200 : 202);
});

// POST /billing/reconciliation/flags/:flagId/resolve — manually clear a
// divergence flag without re-syncing (AC2 "mark resolved").
adminBillingRoutes.post("/billing/reconciliation/flags/:flagId/resolve", requireScope("billing:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const adminId = c.get("userId");
  const flagId = c.req.param("flagId");

  const { data: updated, error } = await supabaseAdmin
    .from("billing_reconciliation_flags")
    .update({
      status: "resolved",
      resolution: "manual",
      resolved_at: new Date().toISOString(),
      resolved_by: adminId,
    })
    .eq("id", flagId)
    .eq("status", "open")
    .select("id, subject_user_id, kind")
    .maybeSingle();
  if (error) {
    console.error("[admin-billing] resolve reconciliation flag failed:", error.message);
    return c.json({ error: "Failed to resolve flag" }, 500);
  }
  if (!updated) {
    return c.json({ error: "Flag not found or already resolved" }, 404);
  }

  const row = updated as { subject_user_id: string; kind: string };
  await auditLog(c, "admin.reconciliation_flag_resolved", "billing_reconciliation_flag", flagId, {
    subject_user_id: row.subject_user_id,
    kind: row.kind,
  });

  return c.json({ ok: true });
});
