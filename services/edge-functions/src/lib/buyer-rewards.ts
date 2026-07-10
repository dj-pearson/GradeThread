// US-1813: buyer reward ledger — config, issuance (anti-abuse gated), redemption.
//
// A verified grade confirmation (US-1812) earns reward CREDITS that redeem on
// metered buyer actions once the monthly allowance is spent (the US-1800 debit
// precedence's middle leg). The pure config normalize + the issue-gate decision
// are unit-tested with no DB; the DB helpers are thin wrappers over the atomic
// SECURITY DEFINER RPCs (00422). Every query is scoped by user_id (US-268).

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";

// ── admin-tunable economics (referral-reward-config pattern) ────────────────

export interface BuyerRewardConfig {
  /** Reward credits earned per verified grade confirmation. */
  credits_per_confirmation: number;
  /** Max rewarded confirmations per account/day (0 = unlimited). Anti-abuse. */
  daily_confirmation_cap: number;
  /** Only reward confirmations backed by ≥1 arrival photo. Anti-abuse. */
  require_arrival_evidence: boolean;
}

export const BUYER_REWARD_CONFIG_SETTING_KEY = "buyer.reward_config";

export const DEFAULT_BUYER_REWARD_CONFIG: BuyerRewardConfig = {
  credits_per_confirmation: 1,
  daily_confirmation_cap: 5,
  require_arrival_evidence: true,
};

function coerceNonNegInt(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 0;
}

/**
 * Coerce the untrusted stored/admin jsonb into a safe, fully-populated config.
 * Pure, never throws. An ABSENT field falls back to the default; a present but
 * invalid field is clamped (bad/negative → 0, non-boolean evidence → default).
 */
export function normalizeBuyerRewardConfig(raw: unknown): BuyerRewardConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    credits_per_confirmation: coerceNonNegInt(
      r.credits_per_confirmation,
      DEFAULT_BUYER_REWARD_CONFIG.credits_per_confirmation,
    ),
    daily_confirmation_cap: coerceNonNegInt(
      r.daily_confirmation_cap,
      DEFAULT_BUYER_REWARD_CONFIG.daily_confirmation_cap,
    ),
    require_arrival_evidence: typeof r.require_arrival_evidence === "boolean"
      ? r.require_arrival_evidence
      : DEFAULT_BUYER_REWARD_CONFIG.require_arrival_evidence,
  };
}

// ── issue-gate decision (pure) ──────────────────────────────────────────────

export type RewardGate =
  | { issue: true; credits: number }
  | { issue: false; reason: "disabled" | "no_evidence" };

/**
 * Decide whether a confirmation should attempt a reward issue, BEFORE the atomic
 * (idempotency + daily-cap) RPC. Pure. The day-cap and double-issue guards live
 * in the RPC (they need a consistent read); this covers the evidence gate and a
 * zero-config off switch.
 */
export function decideRewardIssue(
  config: BuyerRewardConfig,
  hasArrivalEvidence: boolean,
): RewardGate {
  if (config.credits_per_confirmation <= 0) return { issue: false, reason: "disabled" };
  if (config.require_arrival_evidence && !hasArrivalEvidence) {
    return { issue: false, reason: "no_evidence" };
  }
  return { issue: true, credits: config.credits_per_confirmation };
}

// ── DB helpers (service-role) ───────────────────────────────────────────────

/**
 * Issue the reward for a verified confirmation. Best-effort: reads config, runs
 * the evidence gate, then the atomic issue RPC (idempotent on reference_id +
 * day-capped). Returns the credits actually issued (0 when gated, duplicate, or
 * capped). Never throws — a reward failure must not block the confirmation.
 */
export async function issueConfirmationReward(
  userId: string,
  purchaseId: string,
): Promise<number> {
  try {
    const config = normalizeBuyerRewardConfig(
      await getSetting<unknown>(BUYER_REWARD_CONFIG_SETTING_KEY, DEFAULT_BUYER_REWARD_CONFIG),
    );

    let hasEvidence = true;
    if (config.require_arrival_evidence) {
      const { count } = await supabaseAdmin
        .from("purchase_arrival_captures")
        .select("id", { count: "exact", head: true })
        .eq("purchase_id", purchaseId)
        .eq("user_id", userId);
      hasEvidence = (count ?? 0) > 0;
    }

    const gate = decideRewardIssue(config, hasEvidence);
    if (!gate.issue) return 0;

    const { data, error } = await supabaseAdmin.rpc("issue_buyer_reward_credit", {
      p_user_id: userId,
      p_reference_id: purchaseId,
      p_credits: gate.credits,
      p_daily_cap: config.daily_confirmation_cap,
    });
    if (error) {
      console.error("[buyer-rewards] issue rpc failed:", error.message);
      return 0;
    }
    return typeof data === "number" ? data : 0;
  } catch (err) {
    console.error(
      "[buyer-rewards] issueConfirmationReward failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/**
 * Redeem one reward credit against a meter. Fail-closed: an rpc error reads as
 * "no credit redeemed" so a broken ledger never hands out a free action.
 */
export async function redeemRewardCredit(userId: string, meter: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc("redeem_buyer_reward_credit", {
      p_user_id: userId,
      p_meter: meter,
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (err) {
    console.error(
      "[buyer-rewards] redeemRewardCredit failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Return a redeemed reward credit when the paid work failed. */
export async function refundRewardCredit(userId: string, meter: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("refund_buyer_reward_credit", {
    p_user_id: userId,
    p_meter: meter,
  });
  if (error) console.error("[buyer-rewards] refundRewardCredit failed:", error.message);
}
