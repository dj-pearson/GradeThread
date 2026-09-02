// US-1295: pure affiliate payout math + accrual/payout decision logic.
//
// Dependency-free (no supabase / Stripe / env) so it unit-tests without the env
// dance and the impure engine (lib/affiliate-payout.ts) shares one source of
// truth for the arithmetic and the accrue/pay/skip policy — mirrors the
// consignor split in consignor-payout-math.ts.

import { roundCents } from "./consignor-payout-math.ts";

export { roundCents };

// ── Money units (US-1655) ────────────────────────────────────────────────────
//
// The affiliate LEDGER (affiliate_commissions.amount, affiliate_payouts.amount)
// stores INTEGER CENTS so money can never drift by binary-float rounding. The
// CONFIG (commission_per_conversion, minimum_payout, tax_threshold_usd) stays in
// USD dollars in system_settings — it's human-edited. Convert config dollars →
// cents at the decision boundary (planAccrual/planPayout/crossesTaxThreshold),
// and convert ledger cents → dollars only at the client/JSON boundary
// (routes/affiliate.ts, the finance-agent feed). Everything in between is
// integer cents.

// USD dollars → integer cents. Rounds through cents first (half-up, killing
// 0.1+0.2 float drift) then to a whole cent. Non-finite → 0.
export function dollarsToCents(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(roundCents(usd) * 100);
}

// Integer cents → USD dollars (for display / the API contract). Non-finite → 0.
export function centsToDollars(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

// 'off'    → the engine is disabled (no accrual, no payout).
// 'batched'→ the affiliate-payouts cron accrues conversions + pays eligible
//            balances over Stripe Connect.
export type AffiliatePayoutMode = "off" | "batched";

export const AFFILIATE_PAYOUT_CONFIG_KEY = "affiliate_payout_config";

/**
 * US-9212: which commission model the programme pays on.
 *
 * `flat` is what US-1295 shipped: one fixed USD bounty per converted referral.
 * `subscription_pct` is what the founder decided on 2026-09-01
 * (vault/60-decisions/adr-referral-cash-payout.md section 6) for the CREATOR
 * programme: a percentage of the referred account's first-year subscription
 * revenue, capped per account. Both are kept because the ledger already holds
 * rows accrued under the flat model, and a model switch must not restate what
 * was already earned.
 */
export type AffiliateCommissionModel = "flat" | "subscription_pct";

/**
 * US-9212: which programme an affiliate account is in.
 *
 * `user` is the referral everyone gets by sharing a link: it earns GRADE
 * CREDITS and never cash. `creator` is the cash programme the founder decided
 * on 2026-09-01, entered by accepting its own terms
 * (vault/50-business/creator-affiliate-terms.md) and being admitted by an
 * operator. The split is the whole point of the ADR: one ledger paying both
 * would turn every link-sharing seller into a 1099 recipient.
 */
export type AffiliateProgram = "user" | "creator";

/** Anything that is not exactly "creator" is a user account. Unknown = user. */
export function normalizeAffiliateProgram(v: unknown): AffiliateProgram {
  return v === "creator" ? "creator" : "user";
}

export interface AffiliatePayoutConfig {
  mode: AffiliatePayoutMode;
  /** US-9212: which of the two models above is in force. */
  commission_model: AffiliateCommissionModel;
  // The "rate": flat USD commission earned per converted affiliate referral.
  commission_per_conversion: number;
  /**
   * US-9212: percent of first-year subscription revenue, for
   * `subscription_pct`. The founder set a 20-30 band; a value outside it is
   * clamped rather than honoured, because the band IS the decision.
   */
  commission_pct: number;
  /** Most one referred account can ever earn a creator, in USD. */
  commission_cap_usd: number;
  /** How many months of a referred account's subscription revenue count. */
  commission_window_months: number;
  // The balance (USD) an affiliate must accrue before a payout fires.
  minimum_payout: number;
  // Days a commission is held (refund/clawback window) before it's payable.
  hold_days: number;
  // 1099 reporting flag threshold (IRS default $600).
  tax_threshold_usd: number;
}

// Ships disabled — an admin enables it after onboarding the Connect flow.
export const CREATOR_COMMISSION_MIN_PCT = 20;
export const CREATOR_COMMISSION_MAX_PCT = 30;

export const DEFAULT_AFFILIATE_PAYOUT_CONFIG: AffiliatePayoutConfig = {
  mode: "off",
  // US-9212: the creator programme's model. The flat bounty stays reachable by
  // configuration for anything accrued under it.
  commission_model: "subscription_pct",
  commission_per_conversion: 5,
  // 25% is the midpoint of the 20-30 band in the ADR; $250 covers Starter and
  // Pro for a full year and caps Business, whose first year at 25% would
  // otherwise be $297. Mirrored in src/lib/constants.ts and pricing.md.
  commission_pct: 25,
  commission_cap_usd: 250,
  commission_window_months: 12,
  minimum_payout: 25,
  hold_days: 30,
  tax_threshold_usd: 600,
};

/**
 * US-9212: keep an override inside the band the founder actually set. A value
 * outside 20-30 is clamped, never refused and never honoured — a config typo
 * must not pay a creator 300% and must not silently pay them nothing.
 */
export function clampCommissionPct(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const whole = Math.round(n);
  if (whole < CREATOR_COMMISSION_MIN_PCT) return CREATOR_COMMISSION_MIN_PCT;
  if (whole > CREATOR_COMMISSION_MAX_PCT) return CREATOR_COMMISSION_MAX_PCT;
  return whole;
}

function nonNegNum(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Coerce an untrusted jsonb blob into a safe config (never throws).
export function normalizeAffiliatePayoutConfig(raw: unknown): AffiliatePayoutConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AFFILIATE_PAYOUT_CONFIG;
  return {
    mode: o.mode === "batched" ? "batched" : "off",
    commission_model: o.commission_model === "flat" ? "flat" : d.commission_model,
    commission_pct: clampCommissionPct(o.commission_pct, d.commission_pct),
    commission_cap_usd: roundCents(nonNegNum(o.commission_cap_usd, d.commission_cap_usd)),
    commission_window_months: Math.max(
      1,
      Math.floor(nonNegNum(o.commission_window_months, d.commission_window_months)),
    ),
    commission_per_conversion: roundCents(
      nonNegNum(o.commission_per_conversion, d.commission_per_conversion),
    ),
    minimum_payout: roundCents(nonNegNum(o.minimum_payout, d.minimum_payout)),
    hold_days: Math.floor(nonNegNum(o.hold_days, d.hold_days)),
    tax_threshold_usd: roundCents(nonNegNum(o.tax_threshold_usd, d.tax_threshold_usd)),
  };
}

// ── Accrual decision (pure) ─────────────────────────────────────────────────

export type AccrualPlan =
  | {
    action: "skip";
    reason:
      | "not_affiliate"
      | "not_creator"
      | "disabled"
      | "zero_rate"
      | "already_accrued";
  }
  // amount is INTEGER CENTS (the ledger unit) — the config USD rate converted.
  | { action: "accrue"; amount: number };

// Decide whether a converted referral earns an affiliate commission. Only
// referrals attributed to the affiliate channel accrue; a $0 rate or a disabled
// engine accrues nothing; an already-accrued conversion is a no-op (idempotent).
// `rate` is the config commission in USD dollars; the returned amount is the
// equivalent integer cents (US-1655).
export function planAccrual(args: {
  attributionSource: string | null | undefined;
  mode: AffiliatePayoutMode;
  rate: number;
  alreadyAccrued: boolean;
  /**
   * US-9212: the affiliate's programme. CASH IS CREATOR-ONLY, so this defaults
   * to refusal exactly like the tax gate in planPayout: a caller that does not
   * say accrues nothing rather than quietly paying a user who only ever shared
   * a referral link. User referrals keep earning grade credits through
   * referrals.ts, which this function has never touched.
   */
  program?: AffiliateProgram;
}): AccrualPlan {
  const { attributionSource, mode, rate, alreadyAccrued } = args;
  if (alreadyAccrued) return { action: "skip", reason: "already_accrued" };
  if (attributionSource !== "affiliate") return { action: "skip", reason: "not_affiliate" };
  if (args.program !== "creator") return { action: "skip", reason: "not_creator" };
  if (mode === "off") return { action: "skip", reason: "disabled" };
  const amount = dollarsToCents(rate);
  if (amount <= 0) return { action: "skip", reason: "zero_rate" };
  return { action: "accrue", amount };
}

// ── US-9212: subscription-percentage accrual (pure) ─────────────────────────

export interface SubscriptionCommissionInput {
  /** The referred account's PAID invoice, in integer cents. */
  invoiceAmountCents: number;
  /** Percent of it the creator earns; clamped into the 20-30 band. */
  pct: number;
  /** Everything this referred account has already earned, in integer cents. */
  alreadyAccruedCents: number;
  /** Per-referred-account cap, in USD dollars (config unit). */
  capUsd: number;
}

/**
 * What ONE paid invoice earns a creator, in integer cents, after the cap.
 *
 * Rounded DOWN. A half-cent in the creator's favour on every invoice is a
 * ledger that drifts from the money that moved, and the direction that costs
 * us is the one that overpays.
 */
export function commissionForSubscriptionInvoice(
  input: SubscriptionCommissionInput,
): number {
  const amount = Math.floor(input.invoiceAmountCents);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const pct = clampCommissionPct(input.pct, DEFAULT_AFFILIATE_PAYOUT_CONFIG.commission_pct);
  const capCents = dollarsToCents(input.capUsd);
  const accrued = Math.max(0, Math.floor(input.alreadyAccruedCents));
  const room = capCents - accrued;
  if (room <= 0) return 0;
  return Math.max(0, Math.min(Math.floor((amount * pct) / 100), room));
}

/** Is this invoice inside the referred account's commission window? */
export function isWithinCommissionWindow(
  subscriptionStartedAt: string | Date,
  invoicePaidAt: string | Date,
  months: number,
): boolean {
  const startMs = new Date(subscriptionStartedAt).getTime();
  const paidMs = new Date(invoicePaidAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(paidMs)) return false;
  if (paidMs < startMs) return false;
  const end = new Date(startMs);
  end.setUTCMonth(end.getUTCMonth() + Math.max(1, Math.floor(months)));
  return paidMs < end.getTime();
}

/**
 * US-9212: the whole decision for ONE paid invoice, in one pure function.
 *
 * The engine reads rows; this says what they mean. Every refusal is named so
 * the webhook can log why a creator earned nothing on an invoice that really
 * was paid -- "nothing happened" is the failure mode that made the flat model
 * hard to trust.
 */
export type SubscriptionAccrualPlan =
  | {
    action: "skip";
    reason:
      | "not_affiliate"
      | "not_creator"
      | "disabled"
      | "wrong_model"
      | "outside_window"
      | "cap_reached"
      | "zero_amount";
  }
  | { action: "accrue"; amount: number };

export function planSubscriptionAccrual(args: {
  attributionSource: string | null | undefined;
  program: AffiliateProgram;
  mode: AffiliatePayoutMode;
  model: AffiliateCommissionModel;
  pct: number;
  capUsd: number;
  windowMonths: number;
  /** When the referred account's paid relationship started (the conversion). */
  subscriptionStartedAt: string | Date;
  invoicePaidAt: string | Date;
  invoiceAmountCents: number;
  /** Everything this affiliate has already earned FROM THIS ACCOUNT, in cents. */
  alreadyAccruedCents: number;
}): SubscriptionAccrualPlan {
  if (args.attributionSource !== "affiliate") return { action: "skip", reason: "not_affiliate" };
  if (args.program !== "creator") return { action: "skip", reason: "not_creator" };
  if (args.mode === "off") return { action: "skip", reason: "disabled" };
  if (args.model !== "subscription_pct") return { action: "skip", reason: "wrong_model" };
  if (!Number.isFinite(args.invoiceAmountCents) || args.invoiceAmountCents <= 0) {
    return { action: "skip", reason: "zero_amount" };
  }
  if (
    !isWithinCommissionWindow(args.subscriptionStartedAt, args.invoicePaidAt, args.windowMonths)
  ) {
    return { action: "skip", reason: "outside_window" };
  }
  const amount = commissionForSubscriptionInvoice({
    invoiceAmountCents: args.invoiceAmountCents,
    pct: args.pct,
    alreadyAccruedCents: args.alreadyAccruedCents,
    capUsd: args.capUsd,
  });
  if (amount <= 0) return { action: "skip", reason: "cap_reached" };
  return { action: "accrue", amount };
}

// ── Payout decision (pure) ──────────────────────────────────────────────────

export type PayoutPlan =
  | {
    action: "skip";
    reason: "no_balance" | "below_minimum" | "not_onboarded" | "tax_profile_missing";
  }
  // amount is INTEGER CENTS (the eligible balance to transfer).
  | { action: "pay"; amount: number };

// Decide whether to pay out an affiliate's eligible (accrued, past-hold) balance.
// Order matters: nothing to pay → skip; below the minimum threshold → hold;
// not yet onboarded to Stripe Connect → hold (the balance keeps accruing). Only
// an onboarded affiliate whose balance clears the minimum is paid.
// `eligibleBalanceCents` is the ledger sum in integer cents; `minimum` is the
// config threshold in USD dollars (converted to cents for the compare) (US-1655).
export function planPayout(args: {
  eligibleBalanceCents: number;
  minimum: number;
  onboarded: boolean;
  /**
   * US-9212 / ADR section 4.5: a certified tax profile (the W-9 equivalent) is
   * on file. Cash may not move without one, so this defaults to FALSE when the
   * caller does not say — a caller that forgets the gate queues the balance
   * rather than paying it.
   */
  taxProfileComplete?: boolean;
}): PayoutPlan {
  const balance = Math.round(args.eligibleBalanceCents);
  if (balance <= 0) return { action: "skip", reason: "no_balance" };
  if (balance < dollarsToCents(args.minimum)) return { action: "skip", reason: "below_minimum" };
  if (!args.onboarded) return { action: "skip", reason: "not_onboarded" };
  // Last, deliberately: the balance is real and the account is onboarded, so
  // the only thing standing between the creator and their money is the form.
  if (args.taxProfileComplete !== true) {
    return { action: "skip", reason: "tax_profile_missing" };
  }
  return { action: "pay", amount: balance };
}

// A commission becomes payable once its hold window has elapsed.
export function isPastHold(holdUntilMs: number | null | undefined, nowMs: number): boolean {
  if (typeof holdUntilMs !== "number" || !Number.isFinite(holdUntilMs)) return true;
  return holdUntilMs <= nowMs;
}

// ── Retry cap (pure) ────────────────────────────────────────────────────────
//
// A payout whose transfer keeps failing (bad Connect account, permanent Stripe
// rejection) would otherwise be re-fired by every sweep forever. Cap the retry
// window by age: once a payout is older than MAX_PAYOUT_RETRY_AGE_MS it's
// considered permanently stuck and the sweep stops auto-retrying it (surfacing
// it as a stale count rather than silently dropping it, so an operator can
// investigate/settle it manually). 14 days comfortably covers transient Stripe
// outages and Connect-onboarding lag while bounding the runaway-retry blast.
export const MAX_PAYOUT_RETRY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Should an open (pending/failed) payout still be auto-retried? False once it's
// older than the cap. A missing/garbage created_at is treated as retryable
// (fail-open: a readable age is required to declare something stale).
export function isPayoutRetryable(
  createdAtMs: number | null | undefined,
  nowMs: number,
  maxAgeMs: number = MAX_PAYOUT_RETRY_AGE_MS,
): boolean {
  if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return true;
  return nowMs - createdAtMs <= maxAgeMs;
}

// 1099 reporting flag: has the affiliate been paid at/over the threshold this
// (calendar) year. `paidYtdCents` is the ledger sum in integer cents; `thresholdUsd`
// is the config threshold in USD dollars. A 0/negative threshold disables the flag.
export function crossesTaxThreshold(paidYtdCents: number, thresholdUsd: number): boolean {
  const threshold = dollarsToCents(thresholdUsd);
  return threshold > 0 && Math.round(paidYtdCents) >= threshold;
}

// ── US-9212: the creator dashboard's arithmetic (pure) ──────────────────────

export interface CreatorCommissionRow {
  /** Integer cents, as the ledger stores it. */
  amount: number | null;
  status: string;
  hold_until: string | null;
  created_at: string | null;
  referred_user_id: string | null;
}

export interface CreatorAccountSummary {
  /** An opaque handle for one referred account. NEVER that account's identity. */
  ref: string;
  earnedCents: number;
  /** What is left of this account's cap, in cents. Zero once it is spent. */
  capRemainingCents: number;
  /** The first commissioned invoice; the window runs from here. */
  firstEarnedAt: string | null;
  windowEndsAt: string | null;
}

export interface CreatorEarnings {
  paidCents: number;
  /** Accrued and past its hold: this is what the next sweep would pay. */
  payableCents: number;
  /** Accrued but still inside the hold window. */
  heldCents: number;
  accounts: CreatorAccountSummary[];
}

/**
 * Fold a creator's own commission rows into the four numbers their dashboard
 * shows, plus one row per referred account.
 *
 * THE ACCOUNT ROWS CARRY NO IDENTITY. A creator has a real interest in knowing
 * which referral is still earning and when its window closes; they have no
 * interest in the referred seller's name, email or plan, and this is our data
 * about a third party. `ref` is the last six characters of the account's id --
 * enough to tell two rows apart across a page refresh, useless as a lookup.
 *
 * Voided rows count for nothing anywhere, including against the cap: a
 * commission we reversed is revenue that never happened.
 */
export function summarizeCreatorEarnings(
  rows: ReadonlyArray<CreatorCommissionRow>,
  opts: { capUsd: number; windowMonths: number; nowMs: number },
): CreatorEarnings {
  const capCents = dollarsToCents(opts.capUsd);
  const months = Math.max(1, Math.floor(opts.windowMonths));
  let paidCents = 0;
  let payableCents = 0;
  let heldCents = 0;
  const byAccount = new Map<string, { earned: number; first: string | null }>();

  for (const row of rows) {
    if (row.status === "void") continue;
    const amount = typeof row.amount === "number" && Number.isFinite(row.amount)
      ? Math.round(row.amount)
      : 0;
    if (row.status === "paid") {
      paidCents += amount;
    } else if (row.status === "accrued") {
      const holdMs = row.hold_until ? Date.parse(row.hold_until) : null;
      if (isPastHold(Number.isFinite(holdMs as number) ? holdMs : null, opts.nowMs)) {
        payableCents += amount;
      } else {
        heldCents += amount;
      }
    }

    if (!row.referred_user_id) continue;
    const seen = byAccount.get(row.referred_user_id) ?? { earned: 0, first: null };
    seen.earned += amount;
    if (row.created_at && (!seen.first || row.created_at < seen.first)) {
      seen.first = row.created_at;
    }
    byAccount.set(row.referred_user_id, seen);
  }

  const accounts: CreatorAccountSummary[] = [...byAccount.entries()]
    .map(([id, v]) => {
      let windowEndsAt: string | null = null;
      if (v.first) {
        const end = new Date(v.first);
        if (Number.isFinite(end.getTime())) {
          end.setUTCMonth(end.getUTCMonth() + months);
          windowEndsAt = end.toISOString();
        }
      }
      return {
        ref: id.slice(-6),
        earnedCents: v.earned,
        capRemainingCents: Math.max(0, capCents - v.earned),
        firstEarnedAt: v.first,
        windowEndsAt,
      };
    })
    .sort((a, b) => b.earnedCents - a.earnedCents);

  return { paidCents, payableCents, heldCents, accounts };
}
