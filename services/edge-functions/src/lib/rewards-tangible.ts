// US-1848 (epic spine): the TANGIBLE reward rail.
//
// The cosmetic track (XP, levels, badges, streaks — rewards-engine.ts,
// rewards-badges.ts) is free and unlimited: it costs nothing to award status.
// This module is the other half the epic requires, and it is a different kind of
// thing entirely, because every grant here moves real value. Three rules hold it
// together:
//
//   1. XP IS NEVER SPENT. A milestone is a THRESHOLD crossed, not a purchase.
//      Crossing it claims a reward_tangible_grants row; the XP total is not
//      debited and only ever accrues. (Spendable currency remains the existing
//      grade-credit ledger.)
//   2. IDEMPOTENT BY CLAIM-BEFORE-PAY. The UNIQUE (user_id, milestone_key) index
//      is the guarantee: the row is inserted BEFORE any value moves, so two
//      concurrent grant paths cannot double-pay a milestone. A delivery failure
//      deletes the claim so a later pass can retry it. This mirrors
//      awardReferralMilestones (US-1071), which solved the same problem.
//   3. CAPPED AND KILL-SWITCHED, FAIL-CLOSED. The `rewards_tangible` flag is read
//      with defaultEnabled=false — unlike most flags here, a missing row or a DB
//      blip pays NOBODY rather than everybody. Spend is bounded by three ceilings
//      (global monthly, per-user monthly, per-user lifetime) evaluated against
//      the marginal cost recorded on each grant.
//
// ── Why the catalog only mints credits today ────────────────────────────────
// The table, the types and the budget rail all carry subscription_discount and
// per_grade_discount, because US-1853 adds them with the Stripe coupon and
// payment-precedence work they need. The CATALOG below deliberately ships only
// free_grade_credits, and grantTangibleRewards refuses any reward type with no
// registered fulfiller. A ledger row nothing honours is an inert promise to a
// user — worse than no reward at all — so the fulfiller registry, not a comment,
// is what keeps the two in step.

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser } from "./notify.ts";
import { getSetting } from "./system-settings.ts";
import { isFeatureEnabled } from "./feature-flags.ts";

export type TangibleRewardType =
  | "free_grade_credits"
  | "subscription_discount"
  | "per_grade_discount";

export interface MilestoneReward {
  /** Stable catalog key — also the idempotency key on the grant row. */
  key: string;
  /** XP total at or above which the milestone unlocks. */
  xpThreshold: number;
  rewardType: TangibleRewardType;
  /** Credits (a count) or a discount percent, per rewardType. */
  value: number;
  /** GradeThread's marginal cost of honouring it, in USD. */
  costUsd: number;
  label: string;
}

/**
 * The milestone ladder. Thresholds are spaced so the first reward lands after a
 * user has genuinely used the product (level 3 on the quadratic curve = 900 XP)
 * and later ones take sustained contribution — a farmed account hits the caps
 * long before it walks the ladder.
 *
 * costUsd is the AI + processing cost of a free grade, NOT its list price: the
 * budget protects the margin, so it must be denominated in what a grant actually
 * costs to honour.
 */
export const TANGIBLE_MILESTONES: readonly MilestoneReward[] = [
  { key: "xp_900_credits_1", xpThreshold: 900, rewardType: "free_grade_credits", value: 1, costUsd: 0.35, label: "1 free grade" },
  { key: "xp_2500_credits_3", xpThreshold: 2_500, rewardType: "free_grade_credits", value: 3, costUsd: 1.05, label: "3 free grades" },
  { key: "xp_6400_credits_5", xpThreshold: 6_400, rewardType: "free_grade_credits", value: 5, costUsd: 1.75, label: "5 free grades" },
  { key: "xp_14400_credits_10", xpThreshold: 14_400, rewardType: "free_grade_credits", value: 10, costUsd: 3.5, label: "10 free grades" },
  { key: "xp_25600_credits_20", xpThreshold: 25_600, rewardType: "free_grade_credits", value: 20, costUsd: 7, label: "20 free grades" },
];

/** Milestones an XP total has reached, lowest first. Pure. */
export function milestonesForXp(xpTotal: number): MilestoneReward[] {
  return TANGIBLE_MILESTONES
    .filter((m) => xpTotal >= m.xpThreshold)
    .sort((a, b) => a.xpThreshold - b.xpThreshold);
}

/** The next milestone above `xpTotal`, or null when the ladder is exhausted. */
export function nextMilestoneForXp(xpTotal: number): MilestoneReward | null {
  const ahead = TANGIBLE_MILESTONES
    .filter((m) => xpTotal < m.xpThreshold)
    .sort((a, b) => a.xpThreshold - b.xpThreshold);
  return ahead[0] ?? null;
}

// ─── Budget ─────────────────────────────────────────────────────────────────

export interface RewardBudget {
  monthlyUsdCap: number;
  perUserMonthlyUsdCap: number;
  perUserLifetimeUsdCap: number;
}

/** Matches the `rewards_tangible_budget` seed in migration 00538. */
export const DEFAULT_REWARD_BUDGET: RewardBudget = {
  monthlyUsdCap: 500,
  perUserMonthlyUsdCap: 15,
  perUserLifetimeUsdCap: 60,
};

export const REWARD_BUDGET_SETTING_KEY = "rewards_tangible_budget";

function positiveNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Coerce the operator-editable setting into a usable budget. Pure. */
export function normalizeRewardBudget(raw: unknown): RewardBudget {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    monthlyUsdCap: positiveNumber(o.monthly_usd_cap, DEFAULT_REWARD_BUDGET.monthlyUsdCap),
    perUserMonthlyUsdCap: positiveNumber(
      o.per_user_monthly_usd_cap,
      DEFAULT_REWARD_BUDGET.perUserMonthlyUsdCap,
    ),
    perUserLifetimeUsdCap: positiveNumber(
      o.per_user_lifetime_usd_cap,
      DEFAULT_REWARD_BUDGET.perUserLifetimeUsdCap,
    ),
  };
}

/** Tangible spend already committed, in USD of marginal cost. */
export interface RewardSpend {
  globalMonthUsd: number;
  userMonthUsd: number;
  userLifetimeUsd: number;
}

export type BudgetRefusal =
  | "global_monthly_cap"
  | "user_monthly_cap"
  | "user_lifetime_cap";

export interface BudgetDecision {
  allowed: boolean;
  refusal?: BudgetRefusal;
}

/**
 * Would granting `costUsd` breach a ceiling? Pure, so the whole policy is
 * testable without a DB. A grant that would breach ANY cap is refused outright
 * rather than partially honoured — a half-paid milestone is not a thing.
 */
export function budgetDecision(
  costUsd: number,
  spend: RewardSpend,
  budget: RewardBudget,
): BudgetDecision {
  if (spend.globalMonthUsd + costUsd > budget.monthlyUsdCap) {
    return { allowed: false, refusal: "global_monthly_cap" };
  }
  if (spend.userMonthUsd + costUsd > budget.perUserMonthlyUsdCap) {
    return { allowed: false, refusal: "user_monthly_cap" };
  }
  if (spend.userLifetimeUsd + costUsd > budget.perUserLifetimeUsdCap) {
    return { allowed: false, refusal: "user_lifetime_cap" };
  }
  return { allowed: true };
}

/** UTC first-of-month boundary for the monthly budget window. */
export function monthStartIso(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// ─── Fulfilment ─────────────────────────────────────────────────────────────

/**
 * How each reward type is actually honoured. A type with NO entry here can never
 * be granted (grantTangibleRewards skips it and logs), which is what stops the
 * ledger from filling with promises nothing redeems. US-1853 registers the two
 * discount fulfillers alongside its Stripe coupon work.
 */
const FULFILLERS: Partial<
  Record<TangibleRewardType, (userId: string, reward: MilestoneReward) => Promise<void>>
> = {
  free_grade_credits: async (userId, reward) => {
    const { error } = await supabaseAdmin.rpc("grant_grade_credits", {
      p_user_id: userId,
      p_credits: Math.round(reward.value),
      p_reason: "admin_grant",
      p_stripe_payment_intent: null,
      p_notes: `Rewards milestone: ${reward.label} (${reward.key})`,
    });
    if (error) throw new Error(error.message);
  },
};

/** True when a reward type has a registered fulfiller. Pure. */
export function isFulfillable(rewardType: TangibleRewardType): boolean {
  return typeof FULFILLERS[rewardType] === "function";
}

// ─── Engine (service-role; every query scoped by user_id — US-268) ──────────

async function loadSpend(userId: string, nowMs: number): Promise<RewardSpend | null> {
  const since = monthStartIso(nowMs);
  const globalQ = supabaseAdmin
    .from("reward_tangible_grants")
    .select("cost_usd")
    .eq("status", "granted")
    .gte("granted_at", since);
  const userQ = supabaseAdmin
    .from("reward_tangible_grants")
    .select("cost_usd, granted_at")
    .eq("user_id", userId)
    .eq("status", "granted");

  const [globalRes, userRes] = await Promise.all([globalQ, userQ]);
  if (globalRes.error || userRes.error) {
    console.error(
      "[rewards-tangible] spend load failed:",
      globalRes.error?.message ?? userRes.error?.message,
    );
    return null;
  }

  const sum = (rows: Array<{ cost_usd: number | string }>) =>
    rows.reduce((acc, r) => acc + (Number(r.cost_usd) || 0), 0);

  const userRows = (userRes.data ?? []) as Array<{
    cost_usd: number | string;
    granted_at: string | null;
  }>;
  return {
    globalMonthUsd: sum((globalRes.data ?? []) as Array<{ cost_usd: number | string }>),
    userLifetimeUsd: sum(userRows),
    userMonthUsd: sum(userRows.filter((r) => (r.granted_at ?? "") >= since)),
  };
}

/**
 * Grant every milestone `userId`'s XP has unlocked and not yet been paid.
 *
 * Best-effort by design: this runs off the back of a rewardable action, and a
 * reward-payout problem must never fail the action that earned it. Returns the
 * milestone keys delivered on THIS call (empty is the normal case).
 */
export async function grantTangibleRewards(
  userId: string,
  xpTotal: number,
  nowMs: number = Date.now(),
): Promise<string[]> {
  try {
    // Fail-CLOSED kill-switch: no flag row, or an unreadable one, pays nobody.
    const enabled = await isFeatureEnabled("rewards_tangible", {
      userId,
      defaultEnabled: false,
    });
    if (!enabled) return [];

    const eligible = milestonesForXp(xpTotal).filter((m) => isFulfillable(m.rewardType));
    if (eligible.length === 0) return [];

    // Which milestones already have a row? A 'claimed' row counts as taken — a
    // retry of THAT milestone is the claim-repair path below, not a second pay.
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("reward_tangible_grants")
      .select("milestone_key")
      .eq("user_id", userId);
    if (existingErr) {
      console.error("[rewards-tangible] claim load failed:", existingErr.message);
      return [];
    }
    const taken = new Set(
      ((existing ?? []) as Array<{ milestone_key: string }>).map((r) => r.milestone_key),
    );
    const pending = eligible.filter((m) => !taken.has(m.key));
    if (pending.length === 0) return [];

    const budget = normalizeRewardBudget(
      await getSetting<unknown>(REWARD_BUDGET_SETTING_KEY, DEFAULT_REWARD_BUDGET),
    );
    const spend = await loadSpend(userId, nowMs);
    if (!spend) return [];

    const delivered: string[] = [];
    for (const reward of pending) {
      const decision = budgetDecision(reward.costUsd, spend, budget);
      if (!decision.allowed) {
        // Refused, not deferred — but the milestone stays unclaimed, so a later
        // pass in a fresh budget window can still honour it.
        console.warn(
          `[rewards-tangible] ${reward.key} refused for ${userId}: ${decision.refusal}`,
        );
        break;
      }

      // CLAIM first (UNIQUE absorbs a concurrent claimer), then move value.
      const { error: claimErr } = await supabaseAdmin
        .from("reward_tangible_grants")
        .insert({
          user_id: userId,
          milestone_key: reward.key,
          reward_type: reward.rewardType,
          reward_value: reward.value,
          cost_usd: reward.costUsd,
          status: "claimed",
          metadata: { xp_total: xpTotal, xp_threshold: reward.xpThreshold },
        } as never);
      if (claimErr) {
        // 23505 = a concurrent pass already claimed it. Anything else is a real
        // failure; either way this milestone is not ours to pay.
        if ((claimErr as { code?: string }).code !== "23505") {
          console.error("[rewards-tangible] claim failed:", claimErr.message);
        }
        continue;
      }

      try {
        await FULFILLERS[reward.rewardType]!(userId, reward);
      } catch (err) {
        // Release the claim so a later pass can retry the milestone.
        console.error(
          `[rewards-tangible] fulfilment failed for ${reward.key}:`,
          err instanceof Error ? err.message : String(err),
        );
        await supabaseAdmin
          .from("reward_tangible_grants")
          .delete()
          .eq("user_id", userId)
          .eq("milestone_key", reward.key);
        continue;
      }

      await supabaseAdmin
        .from("reward_tangible_grants")
        .update({ status: "granted", granted_at: new Date(nowMs).toISOString() } as never)
        .eq("user_id", userId)
        .eq("milestone_key", reward.key);

      // Count it against the running budget so a multi-milestone catch-up in one
      // pass respects the same ceilings a series of single grants would.
      spend.globalMonthUsd += reward.costUsd;
      spend.userMonthUsd += reward.costUsd;
      spend.userLifetimeUsd += reward.costUsd;
      delivered.push(reward.key);

      await notifyUser(userId, {
        type: "billing",
        title: "Reward unlocked!",
        message: `You hit ${reward.xpThreshold.toLocaleString()} XP — ${reward.label} added to your account.`,
        link: "/dashboard/billing",
      }).catch(() => {});
    }

    return delivered;
  } catch (err) {
    console.error(
      "[rewards-tangible] grant pass threw:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
