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
import { captureException } from "./observability.ts";
import {
  AFFILIATE_PAYOUT_CONFIG_KEY,
  type AffiliatePayoutConfig,
  type AffiliatePayoutMode,
  type AffiliateProgram,
  DEFAULT_AFFILIATE_PAYOUT_CONFIG,
  isPayoutRetryable,
  normalizeAffiliateProgram,
  normalizeAffiliatePayoutConfig,
  planAccrual,
  planPayout,
  planSubscriptionAccrual,
} from "./affiliate-payout-math.ts";

const SWEEP_LOOKBACK_DAYS = 60;
const SWEEP_LIMIT = 500;

// Sum a set of ledger rows' amounts. Since US-1655 the affiliate ledger stores
// INTEGER CENTS, so the sum is exact integer cents (no float rounding needed);
// each row is coerced defensively — a null/garbage amount contributes 0.
function sumCents(rows: ReadonlyArray<{ amount: number | null }>): number {
  return rows.reduce(
    (acc, r) =>
      acc +
      (typeof r.amount === "number" && Number.isFinite(r.amount)
        ? Math.round(r.amount)
        : 0),
    0,
  );
}

export async function getAffiliatePayoutConfig(): Promise<
  AffiliatePayoutConfig
> {
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
  amount?: number; // integer cents (US-1655) when accrued
  reason?: string;
}

/**
 * US-9212: which programme an affiliate account is in.
 *
 * Fails CLOSED to "user", like every other gate on this path: no row, a read
 * error or an unrecognised value all mean no cash. An account only reads as a
 * creator when the column says so, and migration 00719 will not let it say so
 * without a recorded terms acceptance.
 */
export async function loadAffiliateProgram(userId: string): Promise<AffiliateProgram> {
  try {
    const { data, error } = await supabaseAdmin
      .from("affiliate_accounts")
      .select("program")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return "user";
    return normalizeAffiliateProgram((data as { program?: unknown } | null)?.program);
  } catch {
    return "user";
  }
}

// Accrue the affiliate commission for one converted referral. Idempotent + safe
// to call best-effort from the qualification hook (referrals.ts) and from the
// sweep backfill. Only affiliate-attributed conversions accrue.
export async function accrueAffiliateCommission(
  eventId: string,
): Promise<AccrueResult> {
  const config = await getAffiliatePayoutConfig();

  const { data: evRaw } = await supabaseAdmin
    .from("referral_events")
    .select("id, referrer_user_id, attribution_source")
    .eq("id", eventId)
    .maybeSingle();
  const ev = evRaw as
    | {
      id: string;
      referrer_user_id: string;
      attribution_source: string | null;
    }
    | null;
  if (!ev) return { accrued: false, reason: "not_found" };

  const plan = planAccrual({
    attributionSource: ev.attribution_source,
    mode: config.mode,
    rate: config.commission_per_conversion,
    alreadyAccrued: false,
    // US-9212: cash is creator-only. A user referral reaching this function
    // skips with "not_creator" and keeps earning grade credits in referrals.ts.
    program: await loadAffiliateProgram(ev.referrer_user_id),
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
    console.error(
      `[affiliate-payout] accrual insert failed for event ${eventId}:`,
      error.message,
    );
    return { accrued: false, reason: error.message };
  }
  return { accrued: true, amount: plan.amount };
}

// ── US-9212: subscription-percentage accrual ────────────────────────────────

export interface SubscriptionAccrualResult {
  accrued: boolean;
  amount?: number;
  reason?: string;
}

/**
 * Accrue a creator's share of ONE paid subscription invoice.
 *
 * Called best-effort from the Stripe invoice webhook. Everything that could
 * pay someone by accident is a refusal here: the payer must be a recorded
 * affiliate conversion, the affiliate must be in the creator programme, the
 * engine must be on, the model must be the percentage one, the invoice must
 * fall inside the window, and the per-account cap must have room. Any of those
 * missing returns a named reason and writes nothing.
 *
 * IDEMPOTENT ON THE INVOICE. The row carries stripe_invoice_id and migration
 * 00719 makes that unique, so a Stripe redelivery of the same invoice cannot
 * double-credit -- the insert comes back 23505 and this returns
 * "already_accrued".
 *
 * THE WINDOW ANCHORS ON THE FIRST COMMISSIONED INVOICE, not on the signup or
 * the referral click. A creator's referral may subscribe months later, and
 * "first-year subscription revenue" means the account's first year of paying,
 * which is the only date this ledger can actually observe.
 */
/**
 * The four reads and one write the accrual needs, injectable for tests.
 *
 * Same reason `fireTransfer` takes its IO: this decides money, and driving it
 * through the service-role client needs a database, which is how the whole
 * money path went untested in US-2345. The default is byte-for-byte what the
 * function did inline.
 */
export interface SubscriptionAccrualIO {
  /** The payout config, which is where `mode` lives. */
  loadConfig(): Promise<AffiliatePayoutConfig>;
  loadReferralEvent(referredUserId: string): Promise<
    { id: string; referrer_user_id: string; attribution_source: string | null } | null
  >;
  loadProgram(userId: string): Promise<AffiliateProgram>;
  loadPriorCommissions(
    affiliateUserId: string,
    referredUserId: string,
  ): Promise<Array<{ amount: number | null; created_at: string | null }>>;
  insertCommission(row: Record<string, unknown>): Promise<{ code?: string; message?: string } | null>;
}

const defaultAccrualIO: SubscriptionAccrualIO = {
  loadConfig() {
    return getAffiliatePayoutConfig();
  },
  async loadReferralEvent(referredUserId) {
    const { data } = await supabaseAdmin
      .from("referral_events")
      .select("id, referrer_user_id, attribution_source")
      .eq("referred_user_id", referredUserId)
      .maybeSingle();
    return (data as
      | { id: string; referrer_user_id: string; attribution_source: string | null }
      | null) ?? null;
  },
  loadProgram(userId) {
    return loadAffiliateProgram(userId);
  },
  async loadPriorCommissions(affiliateUserId, referredUserId) {
    const { data } = await supabaseAdmin
      .from("affiliate_commissions")
      .select("amount, created_at")
      .eq("affiliate_user_id", affiliateUserId)
      .eq("referred_user_id", referredUserId)
      .eq("commission_model", "subscription_pct")
      .neq("status", "void")
      .order("created_at", { ascending: true });
    return (data ?? []) as Array<{ amount: number | null; created_at: string | null }>;
  },
  async insertCommission(row) {
    const { error } = await supabaseAdmin.from("affiliate_commissions").insert(row);
    return error ? { code: (error as { code?: string }).code, message: error.message } : null;
  },
};

export async function accrueSubscriptionCommission(args: {
  referredUserId: string;
  invoiceId: string;
  invoiceAmountCents: number;
  paidAt?: string;
  io?: SubscriptionAccrualIO;
}): Promise<SubscriptionAccrualResult> {
  const io = args.io ?? defaultAccrualIO;
  const paidAt = args.paidAt ?? new Date().toISOString();
  if (!args.referredUserId || !args.invoiceId) {
    return { accrued: false, reason: "missing_args" };
  }

  const config = await io.loadConfig();

  const ev = await io.loadReferralEvent(args.referredUserId);
  if (!ev) return { accrued: false, reason: "not_referred" };

  const program = await io.loadProgram(ev.referrer_user_id);

  // Everything this creator has already earned from THIS account: the cap is
  // per referred account, and the earliest row is the window's anchor.
  const prior = await io.loadPriorCommissions(ev.referrer_user_id, args.referredUserId);
  const alreadyAccruedCents = sumCents(prior);
  const windowAnchor = prior[0]?.created_at ?? paidAt;

  const plan = planSubscriptionAccrual({
    attributionSource: ev.attribution_source,
    program,
    mode: config.mode,
    model: config.commission_model,
    pct: config.commission_pct,
    capUsd: config.commission_cap_usd,
    windowMonths: config.commission_window_months,
    subscriptionStartedAt: windowAnchor,
    invoicePaidAt: paidAt,
    invoiceAmountCents: args.invoiceAmountCents,
    alreadyAccruedCents,
  });
  if (plan.action === "skip") return { accrued: false, reason: plan.reason };

  const holdUntil = new Date(
    Date.now() + config.hold_days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const error = await io.insertCommission({
    affiliate_user_id: ev.referrer_user_id,
    referral_event_id: ev.id,
    referred_user_id: args.referredUserId,
    stripe_invoice_id: args.invoiceId,
    commission_model: "subscription_pct",
    amount: plan.amount,
    status: "accrued",
    hold_until: holdUntil,
  });
  if (error) {
    // 23505 = the partial UNIQUE on stripe_invoice_id fired: Stripe redelivered
    // the same invoice. Not a failure -- the row is already there.
    if (error.code === "23505") return { accrued: false, reason: "already_accrued" };
    console.error(
      `[affiliate-payout] subscription accrual failed for invoice ${args.invoiceId}:`,
      error.message,
    );
    return { accrued: false, reason: error.message ?? "insert_failed" };
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

/**
 * US-9212: is a certified tax profile on file for this creator?
 *
 * Fails CLOSED. A read error answers false, which queues the balance instead of
 * paying it — the ADR's gate is "no cash without the form", and a database blip
 * is not evidence the form exists.
 */
export async function hasCertifiedTaxProfile(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("affiliate_tax_profiles")
      .select("certified_at")
      .eq("owner_user_id", userId)
      .maybeSingle();
    if (error) return false;
    return Boolean((data as { certified_at?: string | null } | null)?.certified_at);
  } catch {
    return false;
  }
}

async function loadAccount(
  affiliateUserId: string,
): Promise<AffiliateAccount | null> {
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
  const balance = sumCents(rows); // integer cents (US-1655)

  const account = await loadAccount(affiliateUserId);
  const stripe = opts.stripe !== undefined ? opts.stripe : getStripe();
  const onboarded = Boolean(
    account?.stripe_connect_account_id && account?.payouts_enabled && stripe,
  );

  // US-9212 / ADR section 4.5: no cash moves without a certified tax profile.
  const plan = planPayout({
    eligibleBalanceCents: balance,
    minimum: config.minimum_payout,
    onboarded,
    taxProfileComplete: await hasCertifiedTaxProfile(affiliateUserId),
  });
  if (plan.action === "skip") {
    // A missing tax profile QUEUES rather than skips: the balance is real and
    // keeps accruing, and the creator gets paid the moment the form is on file.
    const queued = plan.reason === "not_onboarded" || plan.reason === "tax_profile_missing";
    return {
      outcome: queued ? "queued" : "skipped",
      affiliateUserId,
      reason: plan.reason,
    };
  }

  // Create the payout row (the idempotency unit), then claim the eligible
  // commissions into it. The claim is what actually moves money off 'accrued'.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("affiliate_payouts")
    .insert({
      affiliate_user_id: affiliateUserId,
      amount: balance,
      status: "pending",
      source: "auto",
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    console.error(
      `[affiliate-payout] payout insert failed for ${affiliateUserId}:`,
      insErr?.message,
    );
    return {
      outcome: "failed",
      affiliateUserId,
      reason: insErr?.message ?? "insert_failed",
    };
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
    await supabaseAdmin.from("affiliate_payouts").update({ status: "canceled" })
      .eq("id", payoutId);
    return {
      outcome: "skipped",
      affiliateUserId,
      payoutId,
      reason: "no_balance",
    };
  }
  const claimedSum = sumCents(claimed); // integer cents (US-1655)
  await supabaseAdmin.from("affiliate_payouts").update({ amount: claimedSum })
    .eq("id", payoutId);

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
    .select("id, affiliate_user_id, status, created_at")
    .eq("id", payoutId)
    .maybeSingle();
  const payout = payoutRaw as
    | {
      id: string;
      affiliate_user_id: string;
      status: string;
      created_at: string | null;
    }
    | null;
  if (!payout) {
    return {
      outcome: "skipped",
      affiliateUserId: "",
      reason: "payout_not_found",
    };
  }
  const affiliateUserId = payout.affiliate_user_id;
  if (!["pending", "failed"].includes(payout.status)) {
    return {
      outcome: "skipped",
      affiliateUserId,
      payoutId,
      reason: "already_settled",
    };
  }

  // Amount of record = the commissions still attached to this payout.
  const { data: linkedRaw } = await supabaseAdmin
    .from("affiliate_commissions")
    .select("amount")
    .eq("payout_id", payoutId);
  const linked = (linkedRaw ?? []) as Array<{ amount: number | null }>;
  const amount = sumCents(linked); // integer cents (US-1655)
  if (amount <= 0) {
    // Orphan/empty payout — cancel it; the accrued balance gets re-batched.
    await supabaseAdmin.from("affiliate_payouts").update({ status: "canceled" })
      .eq("id", payoutId);
    return {
      outcome: "skipped",
      affiliateUserId,
      payoutId,
      reason: "empty_payout",
    };
  }

  const account = await loadAccount(affiliateUserId);
  const onboarded = Boolean(
    account?.stripe_connect_account_id && account?.payouts_enabled && stripe,
  );
  if (!onboarded) {
    return {
      outcome: "queued",
      affiliateUserId,
      payoutId,
      reason: "not_onboarded",
    };
  }
  // US-9212: the same gate on the transfer path. A payout row created before
  // the form was required must not fire now that it is.
  if (!(await hasCertifiedTaxProfile(affiliateUserId))) {
    return {
      outcome: "queued",
      affiliateUserId,
      payoutId,
      reason: "tax_profile_missing",
    };
  }

  const accountId = account!.stripe_connect_account_id!;

  // Transfer-dedup (US-1653): Stripe's idempotency key only dedupes for ~24h, so
  // a payout that fails AFTER Stripe actually created the transfer (a network
  // blip on our side) and then gets retried >24h later would create a SECOND
  // transfer under a fresh idempotency scope — a real double-pay. Before
  // re-firing, ask Stripe whether a transfer for THIS payout already exists; if
  // so, reconcile the row as paid instead of transferring again. A lookup error
  // is treated as "unsafe to retry now" (skip) rather than blindly re-firing.
  const createdAtMs = payout.created_at ? Date.parse(payout.created_at) : NaN;
  const lookup = await findExistingTransfer(
    stripe!,
    accountId,
    payoutId,
    createdAtMs,
  );
  if (lookup.error) {
    return {
      outcome: "skipped",
      affiliateUserId,
      payoutId,
      reason: `transfer_lookup_failed: ${lookup.error}`,
    };
  }
  if (lookup.transfer) {
    await supabaseAdmin
      .from("affiliate_payouts")
      .update({
        amount,
        status: "paid",
        stripe_transfer_id: lookup.transfer.id,
        paid_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", payoutId)
      .eq("affiliate_user_id", affiliateUserId);
    return {
      outcome: "transferred",
      affiliateUserId,
      payoutId,
      amount,
      reason: "reconciled_existing",
    };
  }

  return await fireTransfer({
    payoutId,
    affiliateUserId,
    amount,
    accountId,
    stripe: stripe!,
  });
}

// Look up whether a Stripe transfer already exists for this payout, matching on
// metadata.payout_id (set by fireTransfer at create). Scans transfers to the
// affiliate's destination created at/after the payout row (a bounded window —
// the transfer can't predate the payout). Returns the transfer if found, or an
// `error` string on any Stripe failure so the caller can decline to re-fire
// rather than risk a double-pay on an unreadable state.
async function findExistingTransfer(
  stripe: Stripe,
  accountId: string,
  payoutId: string,
  createdAtMs: number,
): Promise<{ transfer: Stripe.Transfer | null; error?: string }> {
  // Bound the scan to transfers created no earlier than the payout row (minus a
  // small clock-skew cushion). Fall back to unbounded-by-time if created_at is
  // unreadable — correctness (finding the dup) outranks the query bound.
  const createdGte = Number.isFinite(createdAtMs)
    ? Math.floor((createdAtMs - 5 * 60 * 1000) / 1000)
    : undefined;
  // Explicit page walk (bounded) rather than the SDK async-iterator, so a
  // destination with a large transfer history can't spin the sweep. The target
  // transfer is created within seconds of the payout row, so with a time-bounded
  // newest-first list it lands on the first page in practice.
  const MAX_PAGES = 5;
  let startingAfter: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await stripe.transfers.list({
        destination: accountId,
        ...(createdGte !== undefined ? { created: { gte: createdGte } } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
        limit: 100,
      });
      for (const transfer of res.data) {
        if (transfer.metadata?.payout_id === payoutId) {
          return { transfer };
        }
      }
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { transfer: null };
  } catch (err) {
    return {
      transfer: null,
      error: err instanceof Error ? err.message : "list_failed",
    };
  }
}

// Fire (or retry) the Stripe transfer for a payout row. Idempotency key
// `affiliate_payout_<id>` ⇒ a retry of the SAME row never double-pays.
// `amount` is INTEGER CENTS (US-1655) — the same minor unit Stripe expects, so
// it's passed straight through (no *100). Math.round is a defensive coercion.
/**
 * US-2345 AC1: the two writes `fireTransfer` makes, injectable.
 *
 * This is the money path's failure branch, and it was untestable for the usual
 * reason — the writes went straight to the service-role client, so exercising
 * "the transfer threw" needed a database. The default implementations below are
 * exactly what the function did before; nothing about the live path changed.
 *
 * Both writes are scoped by payout id AND affiliate user id. That second
 * predicate is not redundant: it is what stops a mis-derived payout id marking
 * some other affiliate's payout as paid.
 */
export interface TransferIO {
  markPaid(args: {
    payoutId: string;
    affiliateUserId: string;
    amount: number;
    transferId: string;
  }): Promise<void>;
  markFailed(args: {
    payoutId: string;
    affiliateUserId: string;
    message: string;
  }): Promise<void>;
}

const defaultTransferIO: TransferIO = {
  async markPaid({ payoutId, affiliateUserId, amount, transferId }) {
    await supabaseAdmin
      .from("affiliate_payouts")
      .update({
        amount,
        status: "paid",
        stripe_transfer_id: transferId,
        paid_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", payoutId)
      .eq("affiliate_user_id", affiliateUserId);
  },
  async markFailed({ payoutId, affiliateUserId, message }) {
    await supabaseAdmin
      .from("affiliate_payouts")
      .update({ status: "failed", error: message })
      .eq("id", payoutId)
      .eq("affiliate_user_id", affiliateUserId);
  },
};

export async function fireTransfer(args: {
  payoutId: string;
  affiliateUserId: string;
  amount: number;
  accountId: string;
  stripe: Stripe;
  io?: TransferIO;
}): Promise<ProcessResult> {
  const { payoutId, affiliateUserId, amount, accountId, stripe } = args;
  const io = args.io ?? defaultTransferIO;
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: Math.round(amount),
        currency: "usd",
        destination: accountId,
        metadata: {
          affiliate_user_id: affiliateUserId,
          payout_id: payoutId,
          source: "auto",
        },
      },
      { idempotencyKey: `affiliate_payout_${payoutId}` },
    );
    await io.markPaid({
      payoutId,
      affiliateUserId,
      amount,
      transferId: transfer.id,
    });
    return { outcome: "transferred", affiliateUserId, payoutId, amount };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transfer failed";
    // Keep the commissions attached to this (now failed) payout — the sweep
    // retries the SAME row/key. Never release them to a new payout (would risk a
    // double-pay if the transfer actually went through on a network blip).
    await io.markFailed({ payoutId, affiliateUserId, message });
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
  // Open payouts too old to auto-retry (US-1653 retry cap) — surfaced, not
  // silently dropped, so an operator can settle them manually.
  stale: number;
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
    stale: 0,
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

  // (b) Retry open payouts (same idempotency key), but skip ones past the retry
  // cap (US-1653) so a permanently-failing payout can't be re-fired forever.
  // Stale ones are counted + logged, not silently dropped.
  const nowMs = Date.now();
  const { data: openRaw } = await supabaseAdmin
    .from("affiliate_payouts")
    .select("id, created_at")
    .in("status", ["pending", "failed"])
    // US-2345 AC4: OLDEST FIRST, and the order is the whole point rather than
    // tidiness. Without it Postgres returns an arbitrary set, and an arbitrary
    // set from a stable plan is the SAME 500 rows every run — so past the cap
    // an affiliate is not delayed, they are permanently starved, and nothing
    // anywhere reports it. Oldest-first also matches what a retry queue should
    // do: a payout that has been failing for a week outranks one that failed a
    // minute ago.
    .order("created_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  for (
    const p of (openRaw ?? []) as Array<
      { id: string; created_at: string | null }
    >
  ) {
    const createdAtMs = p.created_at ? Date.parse(p.created_at) : NaN;
    if (!isPayoutRetryable(createdAtMs, nowMs)) {
      summary.stale += 1;
      console.warn(
        `[affiliate-payout] payout ${p.id} past retry cap (created ${p.created_at}) — ` +
          `no longer auto-retried; settle manually`,
      );
      continue;
    }
    // US-2315: per-payout isolation. retryAffiliatePayout reaches Stripe, so
    // one network blip used to abort the sweep and leave every payout after it
    // unprocessed. Unlike the other two sites in this story, the SELECTION here
    // already has a terminal escape — isPayoutRetryable above drops a payout
    // once it ages past the retry cap — so a throwing row cannot starve the
    // queue forever. What it could do is waste every run until then.
    try {
      tally(await retryAffiliatePayout(p.id, stripe));
    } catch (err) {
      summary.scanned += 1;
      summary.failed += 1;
      captureException(err, {
        level: "warn",
        route: "affiliate-payout.retry",
        extra: { payoutId: p.id },
      });
    }
  }

  // (c) New payouts: affiliates with eligible (accrued, past-hold) commissions.
  const nowIso = new Date().toISOString();
  const { data: eligibleRaw } = await supabaseAdmin
    .from("affiliate_commissions")
    .select("affiliate_user_id")
    .eq("status", "accrued")
    .is("payout_id", null)
    .lte("hold_until", nowIso)
    // US-2345 AC4: longest-waiting first. Same reasoning as the retry phase
    // above — and it matters more here, because this phase has no age cap to
    // eventually flush a row. An affiliate past the unordered cap would wait
    // forever while the same 500 rows were re-read every sweep.
    .order("hold_until", { ascending: true })
    .limit(SWEEP_LIMIT);
  const affiliateIds = new Set<string>();
  for (const r of (eligibleRaw ?? []) as Array<{ affiliate_user_id: string }>) {
    affiliateIds.add(r.affiliate_user_id);
  }
  for (const id of affiliateIds) {
    // US-2315: same isolation for the create phase. This one has NO age cap —
    // an affiliate with eligible commissions stays eligible — so a permanently
    // throwing affiliate would have blocked every affiliate after it on every
    // run, indefinitely. Iteration order is Set insertion order over an
    // unordered query, so "after it" is stable enough to matter.
    try {
      tally(await processAffiliatePayout(id, { stripe }));
    } catch (err) {
      summary.scanned += 1;
      summary.failed += 1;
      captureException(err, {
        level: "warn",
        route: "affiliate-payout.create",
        extra: { affiliateUserId: id },
      });
    }
  }

  return summary;
}
