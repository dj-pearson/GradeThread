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

export interface AffiliatePayoutConfig {
  mode: AffiliatePayoutMode;
  // The "rate": flat USD commission earned per converted affiliate referral.
  commission_per_conversion: number;
  // The balance (USD) an affiliate must accrue before a payout fires.
  minimum_payout: number;
  // Days a commission is held (refund/clawback window) before it's payable.
  hold_days: number;
  // 1099 reporting flag threshold (IRS default $600).
  tax_threshold_usd: number;
}

// Ships disabled — an admin enables it after onboarding the Connect flow.
export const DEFAULT_AFFILIATE_PAYOUT_CONFIG: AffiliatePayoutConfig = {
  mode: "off",
  commission_per_conversion: 5,
  minimum_payout: 25,
  hold_days: 30,
  tax_threshold_usd: 600,
};

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
    reason: "not_affiliate" | "disabled" | "zero_rate" | "already_accrued";
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
}): AccrualPlan {
  const { attributionSource, mode, rate, alreadyAccrued } = args;
  if (alreadyAccrued) return { action: "skip", reason: "already_accrued" };
  if (attributionSource !== "affiliate") return { action: "skip", reason: "not_affiliate" };
  if (mode === "off") return { action: "skip", reason: "disabled" };
  const amount = dollarsToCents(rate);
  if (amount <= 0) return { action: "skip", reason: "zero_rate" };
  return { action: "accrue", amount };
}

// ── Payout decision (pure) ──────────────────────────────────────────────────

export type PayoutPlan =
  | { action: "skip"; reason: "no_balance" | "below_minimum" | "not_onboarded" }
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
}): PayoutPlan {
  const balance = Math.round(args.eligibleBalanceCents);
  if (balance <= 0) return { action: "skip", reason: "no_balance" };
  if (balance < dollarsToCents(args.minimum)) return { action: "skip", reason: "below_minimum" };
  if (!args.onboarded) return { action: "skip", reason: "not_onboarded" };
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
