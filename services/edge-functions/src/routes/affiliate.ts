// US-603: affiliate / earned-link channel.
//
//   POST /api/affiliate/click   PUBLIC (unauthenticated) — log a click on a
//                               "Graded by GradeThread" badge / earned link.
//                               No PII, no auth; the code is the only join key.
//   GET  /api/affiliate/me      AUTHED — the caller's earned-link code + click
//                               and conversion stats for their own code.
//
// Rewards/payouts are NOT here — affiliate conversions ride the existing
// referral_events ledger (see referrals.ts redeem + admin-growth.ts grant).
// The /me endpoint is mounted behind authMiddleware in main.ts; /click is left
// public (rate-limited per-IP, fail-closed). Every read is scoped to the
// caller's own code.

import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { ensureCode } from "./referrals.ts";
import {
  centsToDollars,
  crossesTaxThreshold,
  isPastHold,
} from "../lib/affiliate-payout-math.ts";
import { getAffiliatePayoutConfig } from "../lib/affiliate-payout.ts";

type Env = { Variables: { userId?: string } };

export const affiliateRoutes = new Hono<Env>();

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2024-04-10", timeout: 20_000, maxNetworkRetries: 2 });
}

function siteUrl(): string {
  return Deno.env.get("SITE_URL") || "https://gradethread.com";
}

const VALID_SOURCES = new Set(["badge", "link", "certificate"]);

// Trim to keep the row small and avoid storing oversized attacker-controlled
// strings. Paths/hosts are diagnostics only.
function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// PUBLIC — anonymous visitor landed via an earned link. Log the click so the
// code's owner can see their funnel. Unknown codes are silently accepted-as-noop
// (return ok) so we never leak which codes exist to an unauthenticated caller.
affiliateRoutes.post("/click", async (c) => {
  let body: { code?: unknown; source?: unknown; path?: unknown; referrer?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code || code.length > 32) return c.json({ error: "code is required" }, 400);

  const source = VALID_SOURCES.has(String(body.source)) ? String(body.source) : "link";

  // Only log clicks for codes that actually exist — keeps the table from being
  // a free-write sink. Done silently either way (don't reveal existence).
  const { data: owner } = await supabaseAdmin
    .from("referral_codes")
    .select("user_id")
    .eq("code", code)
    .maybeSingle();
  if (!owner) return c.json({ ok: true });

  await supabaseAdmin.from("affiliate_clicks").insert({
    code,
    source,
    landing_path: clip(body.path, 512),
    referrer_host: clip(body.referrer, 255),
  });

  return c.json({ ok: true });
});

// AUTHED — the caller's earned-link code + funnel. Strictly scoped to the
// caller: clicks are joined by THEIR code, conversions are referral_events where
// they are the referrer and the channel is 'affiliate'.
affiliateRoutes.get("/me", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const code = await ensureCode(userId);

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const clicksTotalQ = supabaseAdmin
    .from("affiliate_clicks")
    .select("id", { count: "exact", head: true })
    .eq("code", code);
  const clicks30Q = supabaseAdmin
    .from("affiliate_clicks")
    .select("id", { count: "exact", head: true })
    .eq("code", code)
    .gte("created_at", since30);
  const convertedQ = supabaseAdmin
    .from("affiliate_clicks")
    .select("id", { count: "exact", head: true })
    .eq("code", code)
    .not("converted_user_id", "is", null);
  // Channel conversions in the reward ledger (independent of click linkage).
  const eventsQ = supabaseAdmin
    .from("referral_events")
    .select("id", { count: "exact", head: true })
    .eq("referrer_user_id", userId)
    .eq("attribution_source", "affiliate");

  const [clicksTotal, clicks30, converted, events] = await Promise.all([
    clicksTotalQ,
    clicks30Q,
    convertedQ,
    eventsQ,
  ]);

  return c.json({
    code,
    clicks: {
      total: clicksTotal.count ?? 0,
      last30: clicks30.count ?? 0,
      converted: converted.count ?? 0,
    },
    conversions: events.count ?? 0,
  });
});

// ── Payouts (US-1295) ────────────────────────────────────────────────────────
// AUTHED. The affiliate's commission ledger pays out over Stripe Connect (the
// same rails as consignment). Every read/write is scoped to the caller's userId.

// POST /connect — create (or reuse) a Stripe Connect Express account and return
// an onboarding link the affiliate completes. Mirrors the consignor flow.
affiliateRoutes.post("/connect", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

  const { data: existingRaw } = await supabaseAdmin
    .from("affiliate_accounts")
    .select("stripe_connect_account_id")
    .eq("user_id", userId)
    .maybeSingle();
  let accountId = (existingRaw as { stripe_connect_account_id: string | null } | null)
    ?.stripe_connect_account_id ?? null;

  if (!accountId) {
    const { data: userRaw } = await supabaseAdmin
      .from("users")
      .select("email")
      .eq("id", userId)
      .maybeSingle();
    const email = (userRaw as { email: string | null } | null)?.email ?? undefined;
    const account = await stripe.accounts.create({
      type: "express",
      email,
      capabilities: { transfers: { requested: true } },
      metadata: { affiliate_user_id: userId },
    });
    accountId = account.id;
    // Upsert so a re-connect for an affiliate without a row still records it.
    await supabaseAdmin
      .from("affiliate_accounts")
      .upsert(
        { user_id: userId, stripe_connect_account_id: accountId },
        { onConflict: "user_id" },
      );
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${siteUrl()}/dashboard/referrals?connect=refresh`,
    return_url: `${siteUrl()}/dashboard/referrals?connect=done`,
    type: "account_onboarding",
  });

  return c.json({ url: link.url });
});

// GET /connect/status — refresh payouts_enabled from Stripe.
affiliateRoutes.get("/connect/status", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const { data: existingRaw } = await supabaseAdmin
    .from("affiliate_accounts")
    .select("stripe_connect_account_id, payouts_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  const existing = existingRaw as
    | { stripe_connect_account_id: string | null; payouts_enabled: boolean | null }
    | null;
  const accountId = existing?.stripe_connect_account_id ?? null;
  if (!accountId) return c.json({ connected: false, payouts_enabled: false });

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

  const account = await stripe.accounts.retrieve(accountId);
  const enabled = Boolean(account.payouts_enabled && account.charges_enabled);
  if (enabled !== Boolean(existing?.payouts_enabled)) {
    await supabaseAdmin
      .from("affiliate_accounts")
      .update({ payouts_enabled: enabled })
      .eq("user_id", userId);
  }

  return c.json({
    connected: true,
    payouts_enabled: enabled,
    details_submitted: Boolean(account.details_submitted),
  });
});

// GET /payouts — the affiliate's earnings: accrued (held + payable) vs paid,
// recent payout ledger, Stripe onboarding state, and the 1099-threshold flag.
affiliateRoutes.get("/payouts", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const config = await getAffiliatePayoutConfig();
  const nowMs = Date.now();
  const yearStart = new Date(new Date().getUTCFullYear(), 0, 1).toISOString();

  const [{ data: commRaw }, { data: payoutsRaw }, { data: acctRaw }] = await Promise.all([
    supabaseAdmin
      .from("affiliate_commissions")
      .select("amount, status, hold_until")
      .eq("affiliate_user_id", userId),
    supabaseAdmin
      .from("affiliate_payouts")
      .select("id, amount, status, stripe_transfer_id, paid_at, created_at")
      .eq("affiliate_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("affiliate_accounts")
      .select("stripe_connect_account_id, payouts_enabled")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const commissions = (commRaw ?? []) as Array<{
    amount: number | null;
    status: string;
    hold_until: string | null;
  }>;
  // amount is INTEGER CENTS since US-1655 — sum in cents, convert at the JSON edge.
  let accruedPayableCents = 0;
  let accruedHeldCents = 0;
  let paidCents = 0;
  for (const row of commissions) {
    const amt = typeof row.amount === "number" && Number.isFinite(row.amount)
      ? Math.round(row.amount)
      : 0;
    if (row.status === "paid") {
      paidCents += amt;
    } else if (row.status === "accrued") {
      const holdMs = row.hold_until ? Date.parse(row.hold_until) : null;
      if (isPastHold(Number.isFinite(holdMs as number) ? (holdMs as number) : null, nowMs)) {
        accruedPayableCents += amt;
      } else {
        accruedHeldCents += amt;
      }
    }
  }

  const payouts = (payoutsRaw ?? []) as Array<{
    amount: number | null;
    status: string;
    paid_at: string | null;
  }>;
  // 1099 reporting flag = actually paid out this calendar year (integer cents).
  const paidThisYearCents = payouts
    .filter((p) => p.status === "paid" && p.paid_at && p.paid_at >= yearStart)
    .reduce(
      (acc, p) => acc + (typeof p.amount === "number" && Number.isFinite(p.amount) ? Math.round(p.amount) : 0),
      0,
    );

  const acct = acctRaw as
    | { stripe_connect_account_id: string | null; payouts_enabled: boolean | null }
    | null;

  return c.json({
    enabled: config.mode !== "off",
    rate: config.commission_per_conversion,
    minimum_payout: config.minimum_payout,
    hold_days: config.hold_days,
    onboarding: {
      connected: Boolean(acct?.stripe_connect_account_id),
      payouts_enabled: Boolean(acct?.payouts_enabled),
    },
    balance: {
      accrued_payable: centsToDollars(accruedPayableCents),
      accrued_held: centsToDollars(accruedHeldCents),
      paid: centsToDollars(paidCents),
    },
    tax: {
      threshold: config.tax_threshold_usd,
      paid_this_year: centsToDollars(paidThisYearCents),
      reaches_1099_threshold: crossesTaxThreshold(paidThisYearCents, config.tax_threshold_usd),
    },
    // amount is stored in integer cents (US-1655); convert to USD dollars for the
    // client contract (referrals.tsx renders payouts[].amount as currency).
    payouts: ((payoutsRaw ?? []) as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      amount: centsToDollars(typeof p.amount === "number" ? p.amount : 0),
    })),
  });
});
