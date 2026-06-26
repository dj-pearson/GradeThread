// US-1295: affiliate commission accrual + automatic Stripe Connect payout engine.
//
// When a referral attributed to the affiliate channel converts (referral_events
// .attribution_source='affiliate' qualifies), accrue a commission row. The
// affiliate-payouts cron then sweeps eligible (accrued, past-hold) balances and,
// once an affiliate has completed Stripe Connect onboarding and cleared the
// minimum-payout threshold, fires a single Stripe transfer over the SAME rails
// the consignor engine uses (lib/consignor-payout.ts). A not-yet-onboarded or
// below-threshold balance simply keeps accruing until it qualifies.
//
// IDEMPOTENCY:
//   * Accrual — UNIQUE(referral_event_id) on affiliate_commissions; a re-run of
//     the accrual hook for the same conversion loses on the 23505 and is a no-op.
//   * Payout — the affiliate_payouts row is the idempotency unit. Eligible
//     commissions are CLAIMED into it (stamping payout_id + status='paid') before
//     the transfer, and the transfer uses idempotencyKey `affiliate_payout_<id>`,
//     so a retry on the SAME row can never double-pay. A failed transfer keeps
//     the commissions attached to that (failed) payout and the sweep retries the
//     transfer with the same key — it never re-batches them into a fresh payout.
//
// SECURITY (US-268): the service-role client bypasses RLS — every query is
// explicitly scoped by affiliate_user_id.

import Stripe from "stripe";
import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { roundCents } from "./consignor-payout-math.ts";
import {
  AFFILIATE_PAYOUT_CONFIG_KEY,
  type AffiliatePayoutConfig,
  type AffiliatePayoutMode,
  DEFAULT_AFFILIATE_PAYOUT_CONFIG,
  normalizeAffiliatePayoutConfig,
  planAccrual,
  planPayout,
} from "./affiliate-payout-math.ts";

const SWEEP_LOOKBACK_DAYS = 60;
const SWEEP_LIMIT = 500;

export async function getAffiliatePayoutConfig(): Promise<AffiliatePayoutConfig> {
  const raw = await getSetting<unknown>(
    AFFILIATE_PAYOUT_CONFIG_KEY,
    DEFAULT_AFFILIATE_PAYOUT_CONFIG,
  );
  return normalizeAffiliatePayoutConfig(raw);
}

export async function getAffiliatePayoutMode(): Promise<AffiliatePayoutMode> {
  return (await getAffiliatePayoutConfig()).mode;
}

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  return new Stripe(key, {
    apiVersion: "2024-04-10",
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
}

// ── Accrual ─────────────────────────────────────────────────────────────────

export interface AccrueResult {
  accrued: boolean;
  amount?: number;
  reason?: string;
}

// Accrue the affiliate commission for one converted referral. Idempotent + safe
// to call best-effort from the qualification hook (referrals.ts) and from the
// sweep backfill. Only affiliate-attributed conversions accrue.
export async function accrueAffiliateCommission(eventId: string): Promise<AccrueResult> {
  const config = await getAffiliatePayoutConfig();

  const { data: evRaw } = await supabaseAdmin
    .from("referral_events")
    .select("id, referrer_user_id, attribution_source")
    .eq("id", eventId)
    .maybeSingle();
  const ev = evRaw as
    | { id: string; referrer_user_id: string; attribution_source: string | null }
    | null;
  if (!ev) return { accrued: false, reason: "not_found" };

  const plan = planAccrual({
    attributionSource: ev.attribution_source,
    mode: config.mode,
    rate: config.commission_per_conversion,
    alreadyAccrued: false,
  });
  if (plan.action === "skip") return { accrued: false, reason: plan.reason };

  const holdUntil = new Date(
    Date.now() + config.hold_days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { error } = await supabaseAdmin.from("affiliate_commissions").insert({
    affiliate_user_id: ev.referrer_user_id,
    referral_event_id: ev.id,
    amount: plan.amount,
    status: "accrued",
    hold_until: holdUntil,
  });
  if (error) {
    // 23505 = the UNIQUE(referral_event_id) fired — already accrued. No-op.
    if ((error as { code?: string }).code === "23505") {
      return { accrued: false, reason: "already_accrued" };
    }
    console.error(`[affiliate-payout] accrual insert failed for event ${eventId}:`, error.message);
    return { accrued: false, reason: error.message };
  }
  return { accrued: true, amount: plan.amount };
}

// ── Payout ──────────────────────────────────────────────────────────────────

export type ProcessOutcome =
  | "transferred" // a payout was created/retried and the Stripe transfer sent
  | "queued" // eligible balance held (affiliate not yet onboarded)
  | "skipped" // nothing to do (no balance / below minimum / already settled)
  | "failed"; // transfer attempted and errored (payout row marked failed)

export interface ProcessResult {
  outcome: ProcessOutcome;
  affiliateUserId: string;
  payoutId?: string;
  amount?: number;
  reason?: string;
}

interface AffiliateAccount {
  stripe_connect_account_id: string | null;
  payouts_enabled: boolean | null;
}

async function loadAccount(affiliateUserId: string): Promise<AffiliateAccount | null> {
  const { data } = await supabaseAdmin
    .from("affiliate_accounts")
    .select("stripe_connect_account_id, payouts_enabled")
    .eq("user_id", affiliateUserId)
    .maybeSingle();
  return (data as AffiliateAccount | null) ?? null;
}

// Create a new payout for an affiliate's eligible balance: claim the eligible
// commissions atomically, then fire the transfer. Onboarded + above-minimum
// only; otherwise the balance is left to keep accruing.
export async function processAffiliatePayout(
  affiliateUserId: string,
  opts: { stripe?: Stripe | null } = {},
): Promise<ProcessResult> {
  const config = await getAffiliatePayoutConfig();
  const nowIso = new Date().toISOString();

  // Eligible = accrued, past its hold window, not already claimed into a payout.
  const { data: rowsRaw } = await supabaseAdmin
    .from("affiliate_commissions")
    .select("amount")
    .eq("affiliate_user_id", affiliateUserId)
    .eq("status", "accrued")
    .is("payout_id", null)
    .lte("hold_until", nowIso);
  const rows = (rowsRaw ?? []) as Array<{ amount: number | null }>;
  const balance = roundCents(
    rows.reduce((acc, r) => acc + (typeof r.amount === "number" ? r.amount : 0), 0),
  );

  const account = await loadAccount(affiliateUserId);
  const stripe = opts.stripe !== undefined ? opts.stripe : getStripe();
  const onboarded = Boolean(
    account?.stripe_connect_account_id && account?.payouts_enabled && stripe,
  );

  const plan = planPayout({ eligibleBalance: balance, minimum: config.minimum_payout, onboarded });
  if (plan.action === "skip") {
    return {
      outcome: plan.reason === "not_onboarded" ? "queued" : "skipped",
      affiliateUserId,
      reason: plan.reason,
    };
  }

  // Create the payout row (the idempotency unit), then claim the eligible
  // commissions into it. The claim is what actually moves money off 'accrued'.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("affiliate_payouts")
    .insert({ affiliate_user_id: affiliateUserId, amount: balance, status: "pending", source: "auto" })
    .select("id")
    .single();
  if (insErr || !inserted) {
    console.error(`[affiliate-payout] payout insert failed for ${affiliateUserId}:`, insErr?.message);
    return { outcome: "failed", affiliateUserId, reason: insErr?.message ?? "insert_failed" };
  }
  const payoutId = (inserted as { id: string }).id;

  const { data: claimedRaw } = await supabaseAdmin
    .from("affiliate_commissions")
    .update({ status: "paid", payout_id: payoutId })
    .eq("affiliate_user_id", affiliateUserId)
    .eq("status", "accrued")
    .is("payout_id", null)
    .lte("hold_until", nowIso)
    .select("amount");
  const claimed = (claimedRaw ?? []) as Array<{ amount: number | null }>;
  if (claimed.length === 0) {
    // A concurrent run claimed everything first — discard the empty payout.
    await supabaseAdmin.from("affiliate_payouts").update({ status: "canceled" }).eq("id", payoutId);
    return { outcome: "skipped", affiliateUserId, payoutId, reason: "no_balance" };
  }
  const claimedSum = roundCents(
    claimed.reduce((acc, r) => acc + (typeof r.amount === "number" ? r.amount : 0), 0),
  );
  await supabaseAdmin.from("affiliate_payouts").update({ amount: claimedSum }).eq("id", payoutId);

  return await fireTransfer({
    payoutId,
    affiliateUserId,
    amount: claimedSum,
    accountId: account!.stripe_connect_account_id!,
    stripe: stripe!,
  });
}

// Retry an existing open (pending/failed) payout. Re-derives the amount from the
// commissions still attached, fires the transfer with the SAME idempotency key,
// and cancels an orphaned/empty payout (a crash between create and claim leaves
// a pending row with no commissions — its accrued balance is recovered for a
// fresh payout).
async function retryAffiliatePayout(
  payoutId: string,
  stripe: Stripe | null,
): Promise<ProcessResult> {
  const { data: payoutRaw } = await supabaseAdmin
    .from("affiliate_payouts")
    .select("id, affiliate_user_id, status")
    .eq("id", payoutId)
    .maybeSingle();
  const payout = payoutRaw as
    | { id: string; affiliate_user_id: string; status: string }
    | null;
  if (!payout) return { outcome: "skipped", affiliateUserId: "", reason: "payout_not_found" };
  const affiliateUserId = payout.affiliate_user_id;
  if (!["pending", "failed"].includes(payout.status)) {
    return { outcome: "skipped", affiliateUserId, payoutId, reason: "already_settled" };
  }

  // Amount of record = the commissions still attached to this payout.
  const { data: linkedRaw } = await supabaseAdmin
    .from("affiliate_commissions")
    .select("amount")
    .eq("payout_id", payoutId);
  const linked = (linkedRaw ?? []) as Array<{ amount: number | null }>;
  const amount = roundCents(
    linked.reduce((acc, r) => acc + (typeof r.amount === "number" ? r.amount : 0), 0),
  );
  if (amount <= 0) {
    // Orphan/empty payout — cancel it; the accrued balance gets re-batched.
    await supabaseAdmin.from("affiliate_payouts").update({ status: "canceled" }).eq("id", payoutId);
    return { outcome: "skipped", affiliateUserId, payoutId, reason: "empty_payout" };
  }

  const account = await loadAccount(affiliateUserId);
  const onboarded = Boolean(
    account?.stripe_connect_account_id && account?.payouts_enabled && stripe,
  );
  if (!onboarded) return { outcome: "queued", affiliateUserId, payoutId, reason: "not_onboarded" };

  return await fireTransfer({
    payoutId,
    affiliateUserId,
    amount,
    accountId: account!.stripe_connect_account_id!,
    stripe: stripe!,
  });
}

// Fire (or retry) the Stripe transfer for a payout row. Idempotency key
// `affiliate_payout_<id>` ⇒ a retry of the SAME row never double-pays.
async function fireTransfer(args: {
  payoutId: string;
  affiliateUserId: string;
  amount: number;
  accountId: string;
  stripe: Stripe;
}): Promise<ProcessResult> {
  const { payoutId, affiliateUserId, amount, accountId, stripe } = args;
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: Math.round(amount * 100),
        currency: "usd",
        destination: accountId,
        metadata: { affiliate_user_id: affiliateUserId, payout_id: payoutId, source: "auto" },
      },
      { idempotencyKey: `affiliate_payout_${payoutId}` },
    );
    await supabaseAdmin
      .from("affiliate_payouts")
      .update({
        amount,
        status: "paid",
        stripe_transfer_id: transfer.id,
        paid_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", payoutId)
      .eq("affiliate_user_id", affiliateUserId);
    return { outcome: "transferred", affiliateUserId, payoutId, amount };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transfer failed";
    // Keep the commissions attached to this (now failed) payout — the sweep
    // retries the SAME row/key. Never release them to a new payout (would risk a
    // double-pay if the transfer actually went through on a network blip).
    await supabaseAdmin
      .from("affiliate_payouts")
      .update({ status: "failed", error: message })
      .eq("id", payoutId)
      .eq("affiliate_user_id", affiliateUserId);
    return { outcome: "failed", affiliateUserId, payoutId, reason: message };
  }
}

export interface SweepSummary {
  accrued: number;
  scanned: number;
  transferred: number;
  queued: number;
  skipped: number;
  failed: number;
}

// The affiliate-payouts cron. Three phases, all idempotent:
//   (a) backfill accrual for recent affiliate conversions missing a commission;
//   (b) retry any open (pending/failed) payout with the same idempotency key;
//   (c) create new payouts for affiliates whose eligible balance now qualifies.
export async function sweepAffiliatePayouts(): Promise<SweepSummary> {
  const stripe = getStripe();
  const summary: SweepSummary = {
    accrued: 0,
    scanned: 0,
    transferred: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
  };

  // (a) Backfill: recent affiliate conversions that have no commission row yet.
  const sinceIso = new Date(
    Date.now() - SWEEP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: convRaw } = await supabaseAdmin
    .from("referral_events")
    .select("id, reward_status, created_at")
    .eq("attribution_source", "affiliate")
    .in("reward_status", ["qualified", "granted"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(SWEEP_LIMIT);
  for (const ev of (convRaw ?? []) as Array<{ id: string }>) {
    const res = await accrueAffiliateCommission(ev.id);
    if (res.accrued) summary.accrued += 1;
  }

  const tally = (res: ProcessResult) => {
    summary.scanned += 1;
    if (res.outcome === "transferred") summary.transferred += 1;
    else if (res.outcome === "queued") summary.queued += 1;
    else if (res.outcome === "failed") summary.failed += 1;
    else summary.skipped += 1;
  };

  // (b) Retry open payouts (same idempotency key).
  const { data: openRaw } = await supabaseAdmin
    .from("affiliate_payouts")
    .select("id")
    .in("status", ["pending", "failed"])
    .limit(SWEEP_LIMIT);
  for (const p of (openRaw ?? []) as Array<{ id: string }>) {
    tally(await retryAffiliatePayout(p.id, stripe));
  }

  // (c) New payouts: affiliates with eligible (accrued, past-hold) commissions.
  const nowIso = new Date().toISOString();
  const { data: eligibleRaw } = await supabaseAdmin
    .from("affiliate_commissions")
    .select("affiliate_user_id")
    .eq("status", "accrued")
    .is("payout_id", null)
    .lte("hold_until", nowIso)
    .limit(SWEEP_LIMIT);
  const affiliateIds = new Set<string>();
  for (const r of (eligibleRaw ?? []) as Array<{ affiliate_user_id: string }>) {
    affiliateIds.add(r.affiliate_user_id);
  }
  for (const id of affiliateIds) {
    tally(await processAffiliatePayout(id, { stripe }));
  }

  return summary;
}
