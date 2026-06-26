// US-1295: pure affiliate payout math + accrual/payout decision logic.
//
// Dependency-free (no supabase / Stripe / env) so it unit-tests without the env
// dance and the impure engine (lib/affiliate-payout.ts) shares one source of
// truth for the arithmetic and the accrue/pay/skip policy — mirrors the
// consignor split in consignor-payout-math.ts.

import { roundCents } from "./consignor-payout-math.ts";

export { roundCents };

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
  | { action: "accrue"; amount: number };

// Decide whether a converted referral earns an affiliate commission. Only
// referrals attributed to the affiliate channel accrue; a $0 rate or a disabled
// engine accrues nothing; an already-accrued conversion is a no-op (idempotent).
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
  const amount = roundCents(rate);
  if (amount <= 0) return { action: "skip", reason: "zero_rate" };
  return { action: "accrue", amount };
}

// ── Payout decision (pure) ──────────────────────────────────────────────────

export type PayoutPlan =
  | { action: "skip"; reason: "no_balance" | "below_minimum" | "not_onboarded" }
  | { action: "pay"; amount: number };

// Decide whether to pay out an affiliate's eligible (accrued, past-hold) balance.
// Order matters: nothing to pay → skip; below the minimum threshold → hold;
// not yet onboarded to Stripe Connect → hold (the balance keeps accruing). Only
// an onboarded affiliate whose balance clears the minimum is paid.
export function planPayout(args: {
  eligibleBalance: number;
  minimum: number;
  onboarded: boolean;
}): PayoutPlan {
  const balance = roundCents(args.eligibleBalance);
  if (balance <= 0) return { action: "skip", reason: "no_balance" };
  if (balance < roundCents(args.minimum)) return { action: "skip", reason: "below_minimum" };
  if (!args.onboarded) return { action: "skip", reason: "not_onboarded" };
  return { action: "pay", amount: balance };
}

// A commission becomes payable once its hold window has elapsed.
export function isPastHold(holdUntilMs: number | null | undefined, nowMs: number): boolean {
  if (typeof holdUntilMs !== "number" || !Number.isFinite(holdUntilMs)) return true;
  return holdUntilMs <= nowMs;
}

// 1099 reporting flag: has the affiliate been paid at/over the threshold this
// (calendar) year. A 0/negative threshold disables the flag.
export function crossesTaxThreshold(paidYtd: number, threshold: number): boolean {
  return threshold > 0 && roundCents(paidYtd) >= roundCents(threshold);
}
