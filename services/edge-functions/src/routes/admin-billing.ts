import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";

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

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    console.error("[admin-billing] STRIPE_SECRET_KEY not configured");
    return null;
  }
  return new Stripe(key, { apiVersion: "2024-04-10" });
}

async function auditLog(
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin.from("admin_audit_log").insert({
    admin_user_id: adminUserId,
    action,
    target_type: targetType,
    target_id: targetId,
    details,
  });
  if (error) {
    console.error("[admin-billing] audit log insert failed:", error);
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
adminBillingRoutes.post("/users/:id/change-plan", async (c) => {
  const adminId = c.get("userId");
  const targetUserId = c.req.param("id");

  let body: { plan?: unknown; interval?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const plan = body.plan as string | undefined;
  const interval = (body.interval as string | undefined) ?? "monthly";

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

    try {
      // Cancel immediately (no prorated refund — admin should issue separately if needed).
      await stripe.subscriptions.cancel(targetUser.flipdesk_subscription_id);
    } catch (err) {
      console.error("[admin-billing] cancel failed:", err);
      return c.json({ error: "Stripe cancel failed" }, 500);
    }

    // Webhook will set flipdesk_plan='free' and subscription_status='canceled'.
    await auditLog(adminId, "admin.change_plan", "user", targetUserId, {
      from_plan: fromPlan,
      to_plan: "free",
      method: "stripe_cancel_immediate",
    });
    return c.json({ ok: true, method: "stripe_cancel_immediate" });
  }

  // ─ Case 3: paid → paid (swap subscription price) ─
  if (plan !== "free" && targetUser.flipdesk_subscription_id) {
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
    await auditLog(adminId, "admin.change_plan", "user", targetUserId, {
      from_plan: fromPlan,
      to_plan: plan,
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
adminBillingRoutes.post("/users/:id/comp-credits", async (c) => {
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

  await auditLog(adminId, "admin.comp_credits", "user", targetUserId, {
    credits,
    reason,
    previous_balance: targetUser.grade_credit_balance,
    new_balance: newBalance,
  });

  return c.json({ ok: true, newBalance });
});

// ── POST /charges/:id/refund ─────────────────────────────────────
//
// Refunds a Stripe charge. If the charge was a credit pack, the
// charge.refunded webhook handler will write a ledger reversal.
adminBillingRoutes.post("/charges/:id/refund", async (c) => {
  const adminId = c.get("userId");
  const chargeId = c.req.param("id");

  let body: { reason?: unknown; amount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const refundReason = typeof body.reason === "string" ? body.reason.slice(0, 200) : null;
  const amount = typeof body.amount === "number" ? body.amount : undefined;

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const refund = await stripe.refunds.create({
      charge: chargeId,
      ...(amount ? { amount } : {}),
      reason: "requested_by_customer",
      metadata: {
        admin_id: adminId,
        ...(refundReason ? { admin_reason: refundReason } : {}),
      },
    });

    await auditLog(adminId, "admin.refund_charge", "charge", chargeId, {
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
// Read-only listing of Stripe coupons + promotion codes. Admins create
// coupons via the Stripe dashboard for the first pass; this endpoint just
// makes them visible + shows redemption counts for tracking.
adminBillingRoutes.get("/coupons", async (c) => {
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payment service unavailable" }, 503);

  try {
    const [coupons, promoCodes] = await Promise.all([
      stripe.coupons.list({ limit: 50 }),
      stripe.promotionCodes.list({ limit: 50, active: true }),
    ]);

    return c.json({
      coupons: coupons.data.map((c) => ({
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
      promotion_codes: promoCodes.data.map((p) => ({
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

// ── GET /users/:id/payments ──────────────────────────────────────
//
// Lists the target user's recent Stripe charges + subscription state for
// the admin billing tab UI.
adminBillingRoutes.get("/users/:id/payments", async (c) => {
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
      charges: charges.data.map((ch) => ({
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
            items: subscription.items.data.map((it) => ({
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
