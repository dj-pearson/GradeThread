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
  type CreatorCommissionRow,
  crossesTaxThreshold,
  isPastHold,
  summarizeCreatorEarnings,
} from "../lib/affiliate-payout-math.ts";
import { getAffiliatePayoutConfig } from "../lib/affiliate-payout.ts";
import { encryptToken } from "../lib/crypto-aes.ts";

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

// ── US-9212: the creator programme (cash), separate from user referral ──────
//
// A user who shares a referral link earns GRADE CREDITS and can never be paid
// cash. A creator earns a percentage of subscription revenue, and gets there by
// two deliberate steps: accept the programme's own terms
// (vault/50-business/creator-affiliate-terms.md), then be admitted by an
// operator (POST /api/admin/growth/affiliate/creators/:id/approve). Acceptance
// alone is an APPLICATION -- self-serve cash is not what the ADR decided.
//
// Migration 00719 enforces the consent half in the database: program='creator'
// is refused without a recorded terms version and acceptance timestamp.

const CREATOR_TERMS_VERSION = "2026-09-01";

// GET /creator — where this caller stands: the current terms version, what
// they accepted, whether they have been admitted, and whether the tax form is
// on file. Never returns anything about another account.
affiliateRoutes.get("/creator", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  // The dashboard AC6 asks for: clicks, signups, paid and owed. Clicks and
  // signups come from the same two counts /me reports; the money comes from
  // this creator's own commission rows, folded by a pure function.
  const code = await ensureCode(userId);
  const config = await getAffiliatePayoutConfig();

  const [
    { data: acctRaw },
    { data: taxRaw },
    clicks,
    signups,
    { data: commissionRaw },
  ] = await Promise.all([
    supabaseAdmin
      .from("affiliate_accounts")
      .select("program, creator_terms_version, creator_terms_accepted_at, creator_approved_at")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("affiliate_tax_profiles")
      .select("legal_name, entity_type, tin_last4, certified_at")
      .eq("owner_user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("affiliate_clicks")
      .select("id", { count: "exact", head: true })
      .eq("code", code),
    supabaseAdmin
      .from("referral_events")
      .select("id", { count: "exact", head: true })
      .eq("referrer_user_id", userId)
      .eq("attribution_source", "affiliate"),
    supabaseAdmin
      .from("affiliate_commissions")
      .select("amount, status, hold_until, created_at, referred_user_id")
      .eq("affiliate_user_id", userId)
      .eq("commission_model", "subscription_pct")
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  const acct = acctRaw as
    | {
      program: string | null;
      creator_terms_version: string | null;
      creator_terms_accepted_at: string | null;
      creator_approved_at: string | null;
    }
    | null;
  const tax = taxRaw as
    | {
      legal_name: string | null;
      entity_type: string | null;
      tin_last4: string | null;
      certified_at: string | null;
    }
    | null;

  const earnings = summarizeCreatorEarnings(
    (commissionRaw ?? []) as CreatorCommissionRow[],
    {
      capUsd: config.commission_cap_usd,
      windowMonths: config.commission_window_months,
      nowMs: Date.now(),
    },
  );

  return c.json({
    program: acct?.program === "creator" ? "creator" : "user",
    code,
    commission_pct: config.commission_pct,
    earnings: {
      clicks: clicks.count ?? 0,
      signups: signups.count ?? 0,
      // Dollars at the JSON edge, cents everywhere behind it (US-1655).
      owed: centsToDollars(earnings.payableCents + earnings.heldCents),
      payable: centsToDollars(earnings.payableCents),
      held: centsToDollars(earnings.heldCents),
      paid: centsToDollars(earnings.paidCents),
      accounts: earnings.accounts.map((a) => ({
        ref: a.ref,
        earned: centsToDollars(a.earnedCents),
        cap_remaining: centsToDollars(a.capRemainingCents),
        first_earned_at: a.firstEarnedAt,
        window_ends_at: a.windowEndsAt,
      })),
    },
    terms_version: CREATOR_TERMS_VERSION,
    accepted_version: acct?.creator_terms_version ?? null,
    accepted_at: acct?.creator_terms_accepted_at ?? null,
    // Accepted the CURRENT text, not merely some earlier version of it.
    terms_current: acct?.creator_terms_version === CREATOR_TERMS_VERSION,
    approved_at: acct?.creator_approved_at ?? null,
    tax_profile: {
      // The ciphertext is never in this response. Four digits is enough for a
      // creator to recognise which number is on file and useless on its own.
      certified: Boolean(tax?.certified_at),
      certified_at: tax?.certified_at ?? null,
      legal_name: tax?.legal_name ?? null,
      entity_type: tax?.entity_type ?? null,
      last4: tax?.tin_last4 ?? null,
    },
  });
});

// POST /creator/terms — record acceptance of the creator terms.
//
// The version must be the CURRENT one: a client sending an old string is
// agreeing to text it may have been shown before a revision, and recording that
// as consent to the live terms is the failure this check exists to prevent.
// Admission still belongs to an operator; this only unlocks it.
affiliateRoutes.post("/creator/terms", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  let body: { version?: unknown; accept?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (body.accept !== true) {
    return c.json({ error: "You have to accept the terms to join." }, 400);
  }
  if (typeof body.version !== "string" || body.version !== CREATOR_TERMS_VERSION) {
    return c.json(
      { error: "These terms have changed. Reload the page and read the current version." },
      409,
    );
  }

  const acceptedAt = new Date().toISOString();
  const { data: existingRaw } = await supabaseAdmin
    .from("affiliate_accounts")
    .select("creator_approved_at")
    .eq("user_id", userId)
    .maybeSingle();
  const approvedAt =
    (existingRaw as { creator_approved_at: string | null } | null)?.creator_approved_at ?? null;

  const { error } = await supabaseAdmin
    .from("affiliate_accounts")
    .upsert(
      {
        user_id: userId,
        creator_terms_version: CREATOR_TERMS_VERSION,
        creator_terms_accepted_at: acceptedAt,
        // An already-admitted creator who re-accepts a new version stays a
        // creator; everyone else stays a user until an operator says otherwise.
        program: approvedAt ? "creator" : "user",
      },
      { onConflict: "user_id" },
    );
  if (error) {
    console.error("[affiliate] creator terms acceptance failed:", error.message);
    return c.json({ error: "Couldn't record that. Try again." }, 500);
  }

  return c.json({
    ok: true,
    accepted_version: CREATOR_TERMS_VERSION,
    accepted_at: acceptedAt,
    program: approvedAt ? "creator" : "user",
    // Said plainly so nobody reads acceptance as admission.
    pending_approval: !approvedAt,
  });
});

const TAX_ENTITY_TYPES = new Set([
  "individual",
  "sole_proprietor",
  "single_member_llc",
  "c_corp",
  "s_corp",
  "partnership",
  "trust",
  "other",
]);

// POST /tax-profile — the W-9 equivalent (ADR section 4.5).
//
// The TIN is encrypted with the edge's own key before it touches the database
// and only the last four digits are stored in plaintext. The table is deny-all,
// so nothing but the service role can read either. Submitting the form IS the
// certification: the row is stamped certified_at, which is what unlocks cash in
// planPayout.
affiliateRoutes.post("/tax-profile", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const legalName = clip(body.legal_name, 200);
  if (!legalName) return c.json({ error: "Legal name is required." }, 400);

  const entityType = typeof body.entity_type === "string" ? body.entity_type : "";
  if (!TAX_ENTITY_TYPES.has(entityType)) {
    return c.json({ error: "Pick how you file: individual, LLC, corporation and so on." }, 400);
  }

  // Nine digits, however the sender punctuated them. An SSN and an EIN are both
  // nine, and the form does not need to know which.
  const tinDigits = (typeof body.tin === "string" ? body.tin : "").replace(/\D/g, "");
  if (tinDigits.length !== 9) {
    return c.json({ error: "A US tax ID is nine digits (SSN or EIN)." }, 400);
  }

  const country = clip(body.country, 2)?.toUpperCase() || "US";
  if (country !== "US") {
    // Honest refusal rather than a row nobody can report on: the 1099 path is
    // the only one built, and a W-8BEN is a different form with different rules.
    return c.json(
      { error: "Only US tax profiles are supported today. Email support and we will sort it out." },
      400,
    );
  }

  let tinEncrypted: string;
  try {
    // AAD binds the ciphertext to this user: a row copied to another account
    // cannot be decrypted there.
    tinEncrypted = await encryptToken(tinDigits, { aad: `affiliate_tin:${userId}` });
  } catch (err) {
    console.error("[affiliate] TIN encryption failed:", err);
    return c.json({ error: "Couldn't save that securely. Try again." }, 503);
  }

  const { error } = await supabaseAdmin
    .from("affiliate_tax_profiles")
    .upsert(
      {
        owner_user_id: userId,
        legal_name: legalName,
        entity_type: entityType,
        tin_encrypted: tinEncrypted,
        tin_last4: tinDigits.slice(-4),
        address_line1: clip(body.address_line1, 200),
        address_line2: clip(body.address_line2, 200),
        city: clip(body.city, 100),
        region: clip(body.region, 100),
        postal_code: clip(body.postal_code, 20),
        country,
        certified_at: new Date().toISOString(),
      },
      { onConflict: "owner_user_id" },
    );
  if (error) {
    console.error("[affiliate] tax profile save failed:", error.message);
    return c.json({ error: "Couldn't save your tax details. Try again." }, 500);
  }

  return c.json({ ok: true, certified: true, last4: tinDigits.slice(-4) });
});
