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
 * ⚠ SUPERSEDED ON THE LIVE PATH — this is no longer what gates a payout.
 *
 * US-2144 moved the decision into `reserve_guarantee_pool_drawdown` (migration
 * 00490), because evaluating the caps in TS and recording the drawdown
 * afterwards let two concurrent claims pass the same budget. The SQL version
 * decides AND records under one advisory lock, and `reservePoolDrawdown` below
 * is what `buyer-guarantee-claim.ts` actually calls.
 *
 * Verified 2026-07-19: all three gates and all three reason strings
 * (`account_cap`, `period_budget`, `loss_ratio`) exist in 00490, including the
 * "only once the period has accrued" condition — so nothing was dropped in the
 * move.
 *
 * KEPT because it is the readable statement of the policy and its tests pin the
 * intent. But the two are a LOCKSTEP MIRROR WITH ONLY THE SQL SIDE LIVE, which
 * is the shape that has bitten this repo repeatedly (see US-1995). If you change
 * a cap rule here, you have changed nothing in production — change 00490's
 * successor migration too, or the policy and the behaviour diverge silently.
 *
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

// US-2363: `getPoolPeriodState` was deleted here, and the pure `evaluatePoolGate`
// above was deliberately KEPT. The difference is the point.
//
// The gate is a pure, tested statement of the policy, and its own header already
// warns that only the SQL side is live. This was the other half — an unlocked
// read of the ledger, whose only purpose was to feed that gate the state it
// needs. Together they ARE the read-then-decide sequence US-2144 deleted: two
// concurrent claims read the same pre-drawdown totals and both pass one budget.
//
// So the policy statement is worth keeping and the loader is not. Nothing called
// it; leaving it there left the removed sequence reassemblable from two imports.
// The live path reads and decides inside one advisory lock —
// `reservePoolDrawdown` below.

/** Record a remedy drawdown, idempotent on the claim id. Returns true if new. */
export interface PoolReserveResult {
  allowed: boolean;
  reason: string;
}

/**
 * US-2144: atomically evaluate the caps AND record the drawdown.
 *
 * Replaces the read-then-decide-then-write sequence, which let two concurrent
 * claims evaluate against the same pre-drawdown state and both pass the same
 * budget. The reservation happens inside the same advisory lock as the check, so
 * the decision and the money moving cannot be separated.
 *
 * Fails CLOSED: an unreachable or erroring reserve returns allowed=false, which
 * downgrades the claim to manual review rather than auto-paying against an
 * unknown budget.
 */
/**
 * The ledger reference id for a claim's pool drawdown.
 *
 * US-2291: ONE derivation, because there used to be two. `reservePoolDrawdown`
 * was called with `purchase:<purchaseId>` and `recordPoolDrawdown` with the
 * claim id, and the ledger's idempotency is `ON CONFLICT (entry_type,
 * reference_id)` — so two different keys meant two rows, and every
 * auto-approved claim drew the guarantee pool down TWICE. A $5,000 period
 * budget was exhausted after $2,500 of real payouts, and the shortfall showed
 * up as buyers being told the pool was spent.
 *
 * Keyed on the PURCHASE, not the claim, for the reason the reserve already
 * needed: the reserve happens at decision time, before the claim row exists,
 * and the claim is itself idempotent on purchase_id. So the purchase is the
 * only identifier both sides can agree on.
 */
export function poolDrawdownRef(purchaseId: string): string {
  return `purchase:${purchaseId}`;
}

export async function reservePoolDrawdown(
  claimId: string,
  accountUserId: string,
  amountCents: number,
  period: string,
  config: GuaranteePoolConfig,
): Promise<PoolReserveResult> {
  const { data, error } = await supabaseAdmin.rpc("reserve_guarantee_pool_drawdown", {
    p_claim_id: claimId,
    p_account_user_id: accountUserId,
    p_amount_cents: amountCents,
    p_period: period,
    p_account_cap_cents: config.per_account_period_cap_cents,
    p_period_budget_cents: config.period_budget_cents,
    p_loss_ratio: config.loss_ratio_throttle,
  });
  if (error) {
    console.error("[guarantee-pool] reserve failed:", error.message);
    return { allowed: false, reason: "reserve_error" };
  }
  const row = Array.isArray(data) ? data[0] : data;
  const r = row as { allowed?: boolean; reason?: string } | null;
  return { allowed: r?.allowed === true, reason: r?.reason ?? "unknown" };
}

/**
 * Record a drawdown that was NOT reserved at decision time — i.e. a claim a
 * human approved after it was routed to manual review.
 *
 * The auto-approved path must NOT call this: `reservePoolDrawdown` already
 * writes the ledger row atomically, and calling both is what US-2291 fixed.
 * Pass the same {@link poolDrawdownRef} a reserve would have used, so if the
 * claim WAS reserved this is an exact no-op instead of a second drawdown.
 *
 * US-2396: the first parameter is `referenceId`, not `claimId`, and the rename
 * IS the fix rather than tidying. The doc above has always said "pass
 * poolDrawdownRef"; the parameter said "claimId", and the only caller believed
 * the parameter. A signature that contradicts its own documentation is read as
 * the documentation being aspirational, and the value lands in `reference_id`
 * unexamined either way — so the mismatch is invisible at the call site and
 * only shows up as a second ledger row much later.
 */
export async function recordPoolDrawdown(
  referenceId: string,
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
        reference_id: referenceId,
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
