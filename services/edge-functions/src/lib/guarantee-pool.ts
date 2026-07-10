// US-1822: buyer guarantee claims-pool accounting, caps & circuit-breaker.
//
// The pool (guarantee_pool_ledger, 00425) is a period-bucketed ledger of
// ACCRUALS (subscription-revenue slices) and DRAWDOWNS (paid remedies). The pure
// half — config normalize, the payout gate, and the stats roll-up — is
// unit-tested with no DB; the impure half is thin idempotent ledger writes/reads.
// All admin/service-role (US-268: this is pool-level financial data).

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";

// ── admin-tunable economics ─────────────────────────────────────────────────

export interface GuaranteePoolConfig {
  /** Max drawdown per period (0 = unlimited). */
  period_budget_cents: number;
  /** Max remedy one buyer can draw per period (0 = unlimited). */
  per_account_period_cap_cents: number;
  /** Circuit-breaker: auto-payout throttles above this drawn/accrued ratio. */
  loss_ratio_throttle: number;
  /** Accrued per active buyer subscription per period. */
  accrual_per_active_sub_cents: number;
}

export const GUARANTEE_POOL_SETTING_KEY = "buyer.guarantee_pool";

export const DEFAULT_GUARANTEE_POOL_CONFIG: GuaranteePoolConfig = {
  period_budget_cents: 500000,
  per_account_period_cap_cents: 20000,
  loss_ratio_throttle: 0.85,
  accrual_per_active_sub_cents: 100,
};

function coerceNonNegInt(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 0;
}

export function normalizeGuaranteePoolConfig(raw: unknown): GuaranteePoolConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_GUARANTEE_POOL_CONFIG;
  const ratio = typeof r.loss_ratio_throttle === "number" && Number.isFinite(r.loss_ratio_throttle)
    ? Math.max(0, r.loss_ratio_throttle)
    : d.loss_ratio_throttle;
  return {
    period_budget_cents: coerceNonNegInt(r.period_budget_cents, d.period_budget_cents),
    per_account_period_cap_cents: coerceNonNegInt(r.per_account_period_cap_cents, d.per_account_period_cap_cents),
    loss_ratio_throttle: ratio,
    accrual_per_active_sub_cents: coerceNonNegInt(r.accrual_per_active_sub_cents, d.accrual_per_active_sub_cents),
  };
}

// ── pure payout gate (per-account cap, period budget, circuit-breaker) ──────

export interface PoolPeriodState {
  periodAccruedCents: number;
  periodDrawnCents: number;
  /** This buyer's drawdowns this period. */
  accountDrawnCents: number;
}

export type PoolGate =
  | { allowAuto: true }
  | { allowAuto: false; reason: "account_cap" | "period_budget" | "loss_ratio" };

/**
 * Decide whether a `remedyCents` auto-payout may proceed against the pool. PURE.
 * Three gates, checked in order — a breach routes the claim to MANUAL REVIEW
 * (never a silent auto-pay past a cap):
 *   1. per-account period cap,
 *   2. per-period budget,
 *   3. loss-ratio circuit-breaker (only once the period has any accrual — an
 *      un-accrued period is governed by the absolute budget, not an ∞ ratio).
 */
export function evaluatePoolGate(
  remedyCents: number,
  state: PoolPeriodState,
  config: GuaranteePoolConfig,
): PoolGate {
  if (
    config.per_account_period_cap_cents > 0 &&
    state.accountDrawnCents + remedyCents > config.per_account_period_cap_cents
  ) {
    return { allowAuto: false, reason: "account_cap" };
  }
  if (
    config.period_budget_cents > 0 &&
    state.periodDrawnCents + remedyCents > config.period_budget_cents
  ) {
    return { allowAuto: false, reason: "period_budget" };
  }
  if (state.periodAccruedCents > 0) {
    const ratio = (state.periodDrawnCents + remedyCents) / state.periodAccruedCents;
    if (ratio > config.loss_ratio_throttle) {
      return { allowAuto: false, reason: "loss_ratio" };
    }
  }
  return { allowAuto: true };
}

// ── pure stats roll-up (admin dashboard) ────────────────────────────────────

export interface PoolLedgerEntry {
  entry_type: "accrual" | "drawdown";
  amount_cents: number;
  period: string;
}

export interface PoolPeriodStats {
  period: string;
  accruedCents: number;
  drawnCents: number;
  /** accrued − drawn (can be negative if the pool is over-drawn). */
  exposureCents: number;
  /** drawn / accrued, or null when nothing has accrued. */
  lossRatio: number | null;
  drawdownCount: number;
}

/** Roll a period's ledger rows up into the dashboard stats. PURE. */
export function computePoolPeriodStats(entries: PoolLedgerEntry[], period: string): PoolPeriodStats {
  let accrued = 0;
  let drawn = 0;
  let drawdownCount = 0;
  for (const e of entries) {
    if (e.period !== period) continue;
    if (e.entry_type === "accrual") accrued += e.amount_cents;
    else {
      drawn += e.amount_cents;
      drawdownCount++;
    }
  }
  return {
    period,
    accruedCents: accrued,
    drawnCents: drawn,
    exposureCents: accrued - drawn,
    lossRatio: accrued > 0 ? drawn / accrued : null,
    drawdownCount,
  };
}

/** UTC 'YYYY-MM' period key for a timestamp. */
export function periodKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── impure ledger ops (service-role) ────────────────────────────────────────

export async function getGuaranteePoolConfig(): Promise<GuaranteePoolConfig> {
  return normalizeGuaranteePoolConfig(
    await getSetting<unknown>(GUARANTEE_POOL_SETTING_KEY, DEFAULT_GUARANTEE_POOL_CONFIG),
  );
}

/** Sum a period's accruals/drawdowns (+ one buyer's drawdowns) for the gate. */
export async function getPoolPeriodState(period: string, accountUserId: string): Promise<PoolPeriodState> {
  const { data, error } = await supabaseAdmin
    .from("guarantee_pool_ledger")
    .select("entry_type, amount_cents, account_user_id")
    .eq("period", period);
  if (error) {
    // Fail-CLOSED for the gate: pretend the period is fully drawn so a broken
    // read can't wave through an over-cap auto-payout.
    console.error("[guarantee-pool] period state load failed:", error.message);
    return { periodAccruedCents: 0, periodDrawnCents: Number.MAX_SAFE_INTEGER, accountDrawnCents: Number.MAX_SAFE_INTEGER };
  }
  let accrued = 0;
  let drawn = 0;
  let accountDrawn = 0;
  for (const r of data ?? []) {
    const row = r as { entry_type: string; amount_cents: number; account_user_id: string | null };
    if (row.entry_type === "accrual") accrued += row.amount_cents;
    else {
      drawn += row.amount_cents;
      if (row.account_user_id === accountUserId) accountDrawn += row.amount_cents;
    }
  }
  return { periodAccruedCents: accrued, periodDrawnCents: drawn, accountDrawnCents: accountDrawn };
}

/** Record a remedy drawdown, idempotent on the claim id. Returns true if new. */
export async function recordPoolDrawdown(
  claimId: string,
  accountUserId: string,
  amountCents: number,
  period: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("guarantee_pool_ledger")
    .upsert(
      {
        entry_type: "drawdown",
        amount_cents: amountCents,
        period,
        account_user_id: accountUserId,
        reference_id: claimId,
        reason: "guarantee_remedy",
      } as never,
      { onConflict: "entry_type,reference_id", ignoreDuplicates: true },
    );
  if (error) {
    console.error("[guarantee-pool] drawdown record failed:", error.message);
    return false;
  }
  return true;
}

/** Record a period accrual, idempotent per period (reference_id 'accrual:<period>'). */
export async function recordPoolAccrual(period: string, amountCents: number, reason: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("guarantee_pool_ledger")
    .upsert(
      {
        entry_type: "accrual",
        amount_cents: amountCents,
        period,
        reference_id: `accrual:${period}`,
        reason,
      } as never,
      { onConflict: "entry_type,reference_id", ignoreDuplicates: true },
    );
  if (error) {
    console.error("[guarantee-pool] accrual record failed:", error.message);
    return false;
  }
  return true;
}
