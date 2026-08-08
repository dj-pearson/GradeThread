// US-1848 / US-1853: the TANGIBLE reward rail.
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
//      grade-credit ledger.) This is why a level or a leaderboard rank can never
//      go backwards for redeeming — the redemption does not touch the number the
//      rank is computed from.
//   2. IDEMPOTENT BY CLAIM-BEFORE-PAY. The UNIQUE (user_id, milestone_key) index
//      is the guarantee: the row is inserted BEFORE any value moves, so two
//      concurrent grant paths cannot double-pay a milestone. A delivery failure
//      deletes the claim so a later pass can retry it. This mirrors
//      awardReferralMilestones (US-1071), which solved the same problem.
//   3. CAPPED AND KILL-SWITCHED, FAIL-CLOSED. The `rewards_tangible` flag is read
//      with defaultEnabled=false — unlike most flags here, a missing row or a DB
//      blip pays NOBODY rather than everybody. Spend is bounded by three USD
//      ceilings (global monthly, per-user monthly, per-user lifetime) and, per
//      milestone, by its own platform-wide monthly + lifetime issue caps.
//
// ── The catalog is data now (US-1853) ───────────────────────────────────────
// TANGIBLE_MILESTONES below is no longer the ladder — it is the FALLBACK ladder,
// used only when the reward_milestones table (00544) can't be read. The live
// catalog is operator-editable: reward type, trigger (XP threshold | badge |
// season goal), value, cost and caps. Keep the two in step in spirit, not by
// hand: the seed in 00544 is exactly this list.
//
// ── Every reward type now has a fulfiller ───────────────────────────────────
// US-1848 shipped credits only and refused the two discount types, because a
// ledger row nothing honours is an inert promise to a user — worse than no
// reward at all. US-1853 registers both: a subscription discount mints a Stripe
// coupon redeemed at the next subscription checkout (payments.ts), and a
// per-grade discount is a time-boxed entitlement read at the payment-precedence
// step (grade-billing.ts) and applied at per-grade checkout. The registry, not a
// comment, is still what keeps the catalog honest.

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser } from "./notify.ts";
import { getSetting } from "./system-settings.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import { getStripe } from "./stripe-client.ts";
import {
  creditLedgerNote,
  effectivePerUserMonthlyCap,
  isUnderFraudHold,
  killTangibleRewards,
  loadRewardGuardrails,
  loadUnitEconomics,
  loadVelocityUsage,
  raiseRewardFarmingSignal,
  recordBudgetBreach,
  velocityDecision,
} from "./rewards-economics.ts";
import type { BreachScope, RewardGuardrails } from "./rewards-economics.ts";
import {
  anniversaryBaseKey,
  anniversaryInstanceKey,
  applyTenureMultiplier,
  loadLoyaltyStanding,
  markAnniversaryDelivered,
  ordinalYear,
} from "./rewards-loyalty.ts";
import type { LoyaltyStanding } from "./rewards-loyalty.ts";

export type TangibleRewardType =
  | "free_grade_credits"
  | "subscription_discount"
  | "per_grade_discount";

/** What unlocks a milestone. Mirrors the `trigger_type` CHECK in 00544/00557. */
export type MilestoneTriggerType =
  | "xp_threshold"
  | "badge"
  | "season_goal"
  | "anniversary";

export interface MilestoneReward {
  /** Stable catalog key — also the idempotency key on the grant row. */
  key: string;
  /**
   * The CATALOG key behind `key`. Identical for every milestone except an
   * INSTANCED one (US-1914's anniversary, whose grant key carries the year), and
   * it exists because two things need the catalog identity rather than the grant
   * identity: the per-milestone issue caps, which would otherwise count each
   * year separately and never bind, and the label lookup on the owner's view.
   */
  baseKey: string;
  triggerType: MilestoneTriggerType;
  /** XP total at or above which the milestone unlocks (xp_threshold only). */
  xpThreshold: number;
  /** Badge key / season-goal key for the other two trigger types. */
  triggerKey: string | null;
  rewardType: TangibleRewardType;
  /** Credits (a count) or a discount percent, per rewardType. */
  value: number;
  /** GradeThread's marginal cost of honouring it, in USD. */
  costUsd: number;
  label: string;
  /** Months a subscription coupon repeats for (null = a single invoice). */
  discountDurationMonths: number | null;
  /** Days a per-grade discount stays live (null = DEFAULT_DISCOUNT_VALID_DAYS). */
  discountValidDays: number | null;
  /** Platform-wide issue caps for this milestone (null = uncapped). */
  monthlyGrantCap: number | null;
  lifetimeGrantCap: number | null;
}

/** A per-grade discount with no configured window lives this long. */
export const DEFAULT_DISCOUNT_VALID_DAYS = 90;

function xpMilestone(
  key: string,
  xpThreshold: number,
  value: number,
  costUsd: number,
  label: string,
): MilestoneReward {
  return {
    key,
    baseKey: key,
    triggerType: "xp_threshold",
    xpThreshold,
    triggerKey: null,
    rewardType: "free_grade_credits",
    value,
    costUsd,
    label,
    discountDurationMonths: null,
    discountValidDays: null,
    monthlyGrantCap: null,
    lifetimeGrantCap: null,
  };
}

/**
 * The FALLBACK milestone ladder — what the engine grants when the catalog table
 * can't be read. Thresholds are spaced so the first reward lands after a user has
 * genuinely used the product (level 3 on the quadratic curve = 900 XP) and later
 * ones take sustained contribution — a farmed account hits the caps long before
 * it walks the ladder.
 *
 * costUsd is the AI + processing cost of a free grade, NOT its list price: the
 * budget protects the margin, so it must be denominated in what a grant actually
 * costs to honour.
 */
export const TANGIBLE_MILESTONES: readonly MilestoneReward[] = [
  xpMilestone("xp_900_credits_1", 900, 1, 0.35, "1 free grade"),
  xpMilestone("xp_2500_credits_3", 2_500, 3, 1.05, "3 free grades"),
  xpMilestone("xp_6400_credits_5", 6_400, 5, 1.75, "5 free grades"),
  xpMilestone("xp_14400_credits_10", 14_400, 10, 3.5, "10 free grades"),
  xpMilestone("xp_25600_credits_20", 25_600, 20, 7, "20 free grades"),
];

/** XP milestones an XP total has reached, lowest first. Pure. */
export function milestonesForXp(
  xpTotal: number,
  catalog: readonly MilestoneReward[] = TANGIBLE_MILESTONES,
): MilestoneReward[] {
  return catalog
    .filter((m) => m.triggerType === "xp_threshold" && xpTotal >= m.xpThreshold)
    .sort((a, b) => a.xpThreshold - b.xpThreshold);
}

/** The next XP milestone above `xpTotal`, or null when the ladder is exhausted. */
export function nextMilestoneForXp(
  xpTotal: number,
  catalog: readonly MilestoneReward[] = TANGIBLE_MILESTONES,
): MilestoneReward | null {
  const ahead = catalog
    .filter((m) => m.triggerType === "xp_threshold" && xpTotal < m.xpThreshold)
    .sort((a, b) => a.xpThreshold - b.xpThreshold);
  return ahead[0] ?? null;
}

// ─── Triggers ───────────────────────────────────────────────────────────────

/**
 * Everything a milestone's trigger can be evaluated against. The two key sets
 * are loaded lazily — a catalog with no badge/season milestone never pays for
 * them (see loadTriggerContext).
 */
export interface MilestoneTriggerContext {
  xpTotal: number;
  badgeKeys: ReadonlySet<string>;
  seasonGoalKeys: ReadonlySet<string>;
  /**
   * US-1914: the account year owed a gift right now, or 0 for none. It is a
   * WINDOW rather than a date (see anniversaryDue) so a sweep that missed a day
   * still delivers, and it is 0 rather than "the account's age" so an eight-year
   * account never back-pays seven anniversaries at once.
   */
  anniversaryYear: number;
}

/** Has this milestone's trigger fired? Pure — the whole policy is testable. */
export function isMilestoneUnlocked(
  m: MilestoneReward,
  ctx: MilestoneTriggerContext,
): boolean {
  switch (m.triggerType) {
    case "xp_threshold":
      return ctx.xpTotal >= m.xpThreshold;
    case "badge":
      return !!m.triggerKey && ctx.badgeKeys.has(m.triggerKey);
    case "season_goal":
      return !!m.triggerKey && ctx.seasonGoalKeys.has(m.triggerKey);
    case "anniversary":
      // Loyalty, not activity: the ONLY input is how long they have been here.
      // The instance key already carries the year, so an entry that reaches this
      // branch is by construction the one for the year currently owed.
      return ctx.anniversaryYear >= 1;
  }
}

/** Every unlocked milestone, cheapest-cost first so a tight budget pays the
 *  small rungs rather than being eaten by one expensive one. Pure. */
export function unlockedMilestones(
  catalog: readonly MilestoneReward[],
  ctx: MilestoneTriggerContext,
): MilestoneReward[] {
  return catalog
    .filter((m) => isMilestoneUnlocked(m, ctx))
    .sort((a, b) => a.costUsd - b.costUsd || a.key.localeCompare(b.key));
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

/**
 * Which breach scope a budget refusal is recorded under (US-1858). The two
 * vocabularies are deliberately separate — a refusal is a decision, a scope is a
 * durable operator record — so the mapping is stated once here rather than by
 * string-munging the suffix off.
 */
export const BREACH_SCOPE_FOR_REFUSAL: Record<BudgetRefusal, BreachScope> = {
  global_monthly_cap: "global_monthly",
  user_monthly_cap: "user_monthly",
  user_lifetime_cap: "user_lifetime",
};

/** Grants of ONE milestone already issued platform-wide. */
export interface MilestoneIssueCounts {
  monthCount: number;
  lifetimeCount: number;
}

export type MilestoneCapRefusal = "milestone_monthly_cap" | "milestone_lifetime_cap";

/**
 * The per-milestone issue caps (00544). These narrow the USD budget, never widen
 * it: both are checked, and either one refusing is a refusal. Pure.
 *
 * They are PLATFORM-WIDE rather than per-user because UNIQUE (user_id,
 * milestone_key) already bounds a user to one grant of each milestone — the
 * number that actually needs a ceiling is how many of a given reward go out
 * before an operator looks at it again.
 */
export function milestoneCapDecision(
  m: MilestoneReward,
  counts: MilestoneIssueCounts,
): { allowed: boolean; refusal?: MilestoneCapRefusal } {
  if (m.lifetimeGrantCap !== null && counts.lifetimeCount + 1 > m.lifetimeGrantCap) {
    return { allowed: false, refusal: "milestone_lifetime_cap" };
  }
  if (m.monthlyGrantCap !== null && counts.monthCount + 1 > m.monthlyGrantCap) {
    return { allowed: false, refusal: "milestone_monthly_cap" };
  }
  return { allowed: true };
}

/** UTC first-of-month boundary for the monthly budget window. */
export function monthStartIso(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** When a grant stops applying, or null for one that never expires. Pure. */
export function grantExpiryIso(m: MilestoneReward, nowMs: number): string | null {
  if (m.rewardType !== "per_grade_discount") return null;
  const days = m.discountValidDays ?? DEFAULT_DISCOUNT_VALID_DAYS;
  return new Date(nowMs + days * 86_400_000).toISOString();
}

// ─── Discounts ──────────────────────────────────────────────────────────────

export interface CouponParams {
  percentOff: number;
  duration: "once" | "repeating";
  durationInMonths?: number;
  /** Single-user coupons are capped at one redemption. */
  maxRedemptions?: number;
  redeemByMs?: number;
}

/**
 * The Stripe coupon a discount milestone mints. Pure, so the shape of the offer
 * is testable without a Stripe key.
 *
 * A per-grade discount rides ONE-OFF payments, and Stripe only accepts a
 * `duration: 'once'` coupon on a `mode: 'payment'` session — the entitlement's
 * lifetime is carried by redeem_by (and by expires_at on the grant row), not by
 * the coupon duration, which for a one-off charge is meaningless.
 */
export function couponParamsFor(m: MilestoneReward, nowMs: number): CouponParams {
  const percentOff = Math.min(100, Math.max(1, Math.round(m.value)));
  if (m.rewardType === "subscription_discount") {
    const months = m.discountDurationMonths;
    return months && months > 1
      ? { percentOff, duration: "repeating", durationInMonths: months, maxRedemptions: 1 }
      : { percentOff, duration: "once", maxRedemptions: 1 };
  }
  const expiry = grantExpiryIso(m, nowMs);
  return {
    percentOff,
    duration: "once",
    ...(expiry ? { redeemByMs: Date.parse(expiry) } : {}),
  };
}

/** A live, unredeemed discount a checkout can apply. */
export interface ActiveDiscount {
  milestoneKey: string;
  percentOff: number;
  couponId: string;
}

interface GrantRow {
  milestone_key: string;
  reward_type: string;
  reward_value: number | string;
  expires_at: string | null;
  consumed_at: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Pick the discount a checkout should apply from a user's granted rows: the
 * BIGGEST live one. Stripe takes a single discount per session, so when someone
 * holds two the choice has to be deterministic, and giving them the smaller one
 * is the sort of quiet shortchanging nobody would ever notice. Pure.
 */
export function activeDiscount(
  rows: readonly GrantRow[],
  rewardType: TangibleRewardType,
  nowMs: number,
): ActiveDiscount | null {
  let best: ActiveDiscount | null = null;
  for (const r of rows) {
    if (r.reward_type !== rewardType) continue;
    if (r.consumed_at) continue;
    if (r.expires_at && Date.parse(r.expires_at) <= nowMs) continue;
    const couponId = typeof r.metadata?.stripe_coupon_id === "string"
      ? r.metadata.stripe_coupon_id
      : "";
    if (!couponId) continue;
    const percentOff = Math.round(Number(r.reward_value) || 0);
    if (percentOff <= 0) continue;
    if (!best || percentOff > best.percentOff) {
      best = { milestoneKey: r.milestone_key, percentOff, couponId };
    }
  }
  return best;
}

/** Apply a whole-percent discount to a price in cents, never below zero. Pure. */
export function discountedCents(priceCents: number, percentOff: number): number {
  if (!Number.isFinite(priceCents) || priceCents <= 0) return Math.max(0, priceCents | 0);
  const pct = Math.min(100, Math.max(0, Math.round(percentOff)));
  if (pct === 0) return priceCents;
  return Math.max(0, Math.round(priceCents * (100 - pct) / 100));
}

/**
 * The live discount of `rewardType` for one user, or null. Tenant-scoped by
 * user_id (US-268). Best-effort: a DB error reads as "no discount", which
 * charges full price — the safe direction for a read that gates money.
 */
export async function loadActiveDiscount(
  userId: string,
  rewardType: TangibleRewardType,
  nowMs: number = Date.now(),
): Promise<ActiveDiscount | null> {
  const { data, error } = await supabaseAdmin
    .from("reward_tangible_grants")
    .select("milestone_key, reward_type, reward_value, expires_at, consumed_at, metadata")
    .eq("user_id", userId)
    .eq("reward_type", rewardType)
    .eq("status", "granted")
    .is("consumed_at", null);
  if (error) {
    console.error("[rewards-tangible] discount load failed:", error.message);
    return null;
  }
  return activeDiscount((data ?? []) as unknown as GrantRow[], rewardType, nowMs);
}

/**
 * Mark a subscription discount redeemed. Called from the webhook that sees the
 * subscription created — the same place the referral/drip coupons are consumed —
 * so an abandoned checkout never burns the reward. Best-effort.
 */
export async function consumeSubscriptionDiscount(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("reward_tangible_grants")
    .update({ consumed_at: new Date().toISOString() } as never)
    .eq("user_id", userId)
    .eq("reward_type", "subscription_discount")
    .eq("status", "granted")
    .is("consumed_at", null);
  if (error) {
    console.error("[rewards-tangible] discount consume failed:", error.message);
  }
}

// ─── Fulfilment ─────────────────────────────────────────────────────────────

/** Extra metadata a fulfiller wants recorded on the grant row (a coupon id). */
type FulfilResult = Record<string, unknown> | void;

async function mintRewardCoupon(
  userId: string,
  reward: MilestoneReward,
  nowMs: number,
): Promise<string> {
  const stripe = getStripe();
  // No Stripe, no coupon, no honourable discount. Throwing releases the claim so
  // a later pass retries — far better than recording a grant nothing can redeem.
  if (!stripe) throw new Error("STRIPE_UNAVAILABLE");

  const params = couponParamsFor(reward, nowMs);
  const coupon = await stripe.coupons.create(
    {
      percent_off: params.percentOff,
      duration: params.duration,
      ...(params.durationInMonths ? { duration_in_months: params.durationInMonths } : {}),
      ...(params.maxRedemptions ? { max_redemptions: params.maxRedemptions } : {}),
      ...(params.redeemByMs ? { redeem_by: Math.floor(params.redeemByMs / 1000) } : {}),
      name: `Reward: ${reward.label}`.slice(0, 40),
      metadata: { user_id: userId, milestone_key: reward.key, source: "rewards_milestone" },
    },
    // One coupon per (user, milestone) even across retries: a released-and-retried
    // claim must not litter Stripe with duplicate live coupons.
    { idempotencyKey: `reward-coupon:${userId}:${reward.key}` },
  );
  return coupon.id;
}

/**
 * How each reward type is actually honoured. A type with NO entry here can never
 * be granted (grantTangibleRewards skips it and logs), which is what stops the
 * ledger from filling with promises nothing redeems.
 */
const FULFILLERS: Partial<
  Record<
    TangibleRewardType,
    (userId: string, reward: MilestoneReward, nowMs: number) => Promise<FulfilResult>
  >
> = {
  free_grade_credits: async (userId, reward) => {
    const { error } = await supabaseAdmin.rpc("grant_grade_credits", {
      p_user_id: userId,
      p_credits: Math.round(reward.value),
      p_reason: "admin_grant",
      p_stripe_payment_intent: null,
      // US-1858: the note is the reconciler's join key between this ledger and
      // the grant row, so it is built by the shared helper rather than spelled
      // twice — a reworded note here would silently orphan every grant.
      p_notes: creditLedgerNote(reward.label, reward.key),
    });
    if (error) throw new Error(error.message);
  },

  // US-1853: a coupon on the user's single Stripe customer, applied at their next
  // subscription checkout (payments.ts) and consumed by the webhook that sees the
  // subscription created.
  subscription_discount: async (userId, reward, nowMs) => ({
    stripe_coupon_id: await mintRewardCoupon(userId, reward, nowMs),
    percent_off: Math.round(reward.value),
    duration_months: reward.discountDurationMonths,
  }),

  // US-1853: a time-boxed entitlement. The grant row IS the discount — it is read
  // at the payment-precedence step so the quote is right, and the coupon is
  // applied at per-grade checkout so the charge matches the quote.
  per_grade_discount: async (userId, reward, nowMs) => ({
    stripe_coupon_id: await mintRewardCoupon(userId, reward, nowMs),
    percent_off: Math.round(reward.value),
  }),
};

/** True when a reward type has a registered fulfiller. Pure. */
export function isFulfillable(rewardType: TangibleRewardType): boolean {
  return typeof FULFILLERS[rewardType] === "function";
}

// ─── Catalog (service-role) ─────────────────────────────────────────────────

interface MilestoneRow {
  key: string;
  label: string;
  reward_type: string;
  trigger_type: string;
  xp_threshold: number | null;
  trigger_key: string | null;
  reward_value: number | string;
  cost_usd: number | string;
  discount_duration_months: number | null;
  discount_valid_days: number | null;
  monthly_grant_cap: number | null;
  lifetime_grant_cap: number | null;
}

const REWARD_TYPES = new Set<string>([
  "free_grade_credits",
  "subscription_discount",
  "per_grade_discount",
]);
const TRIGGER_TYPES = new Set<string>([
  "xp_threshold",
  "badge",
  "season_goal",
  "anniversary",
]);

/** Map a catalog row onto the engine's shape, or null if it is unusable. Pure. */
export function milestoneFromRow(row: MilestoneRow): MilestoneReward | null {
  if (!REWARD_TYPES.has(row.reward_type) || !TRIGGER_TYPES.has(row.trigger_type)) return null;
  const value = Number(row.reward_value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const triggerType = row.trigger_type as MilestoneTriggerType;
  if (triggerType === "xp_threshold" && row.xp_threshold === null) return null;
  if (triggerType !== "xp_threshold" && !row.trigger_key) return null;
  return {
    key: row.key,
    baseKey: row.key,
    label: row.label,
    triggerType,
    xpThreshold: row.xp_threshold ?? 0,
    triggerKey: row.trigger_key,
    rewardType: row.reward_type as TangibleRewardType,
    value,
    costUsd: Math.max(0, Number(row.cost_usd) || 0),
    discountDurationMonths: row.discount_duration_months,
    discountValidDays: row.discount_valid_days,
    monthlyGrantCap: row.monthly_grant_cap,
    lifetimeGrantCap: row.lifetime_grant_cap,
  };
}

/**
 * The live, enabled catalog.
 *
 * An ERROR falls back to the compiled ladder (a DB blip must not silently stop
 * paying rewards people have already earned). An EMPTY result does NOT — every
 * milestone being switched off is a decision an operator made, and overriding it
 * with the compiled list would make the disable switch a lie.
 */
export async function loadMilestoneCatalog(): Promise<MilestoneReward[]> {
  const { data, error } = await supabaseAdmin
    .from("reward_milestones")
    .select(
      "key, label, reward_type, trigger_type, xp_threshold, trigger_key, reward_value, cost_usd, discount_duration_months, discount_valid_days, monthly_grant_cap, lifetime_grant_cap",
    )
    .eq("enabled", true)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[rewards-tangible] catalog load failed, using fallback:", error.message);
    return [...TANGIBLE_MILESTONES];
  }
  const rows = (data ?? []) as unknown as MilestoneRow[];
  return rows.map(milestoneFromRow).filter((m): m is MilestoneReward => m !== null);
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

/** Platform-wide issue counts for one milestone. Null on a read failure, which
 *  the caller treats as "don't grant" — an uncounted cap is not a cap. */
async function loadMilestoneCounts(
  reward: MilestoneReward,
  nowMs: number,
): Promise<MilestoneIssueCounts | null> {
  const since = monthStartIso(nowMs);
  // An INSTANCED milestone stores one grant key per year, so its cap has to count
  // the FAMILY (`anniversary_gift:y%`) rather than this year's key — counting the
  // instance would reset the operator's lifetime ceiling every anniversary, which
  // is a cap that has never once bound anything.
  const instanced = reward.key !== reward.baseKey;
  const scoped = () => {
    const q = supabaseAdmin
      .from("reward_tangible_grants")
      .select("id", { count: "exact", head: true })
      .eq("status", "granted");
    return instanced ? q.like("milestone_key", `${reward.baseKey}:y%`) : q.eq("milestone_key", reward.key);
  };

  const [lifetime, month] = await Promise.all([
    scoped(),
    scoped().gte("granted_at", since),
  ]);
  if (lifetime.error || month.error) {
    console.error(
      "[rewards-tangible] milestone count failed:",
      lifetime.error?.message ?? month.error?.message,
    );
    return null;
  }
  return { lifetimeCount: lifetime.count ?? 0, monthCount: month.count ?? 0 };
}

/**
 * Build the trigger context, loading ONLY what the catalog actually asks for. A
 * catalog of pure XP milestones — the shipped default — costs zero extra queries,
 * which matters because this runs off the back of every rewardable action.
 */
async function loadTriggerContext(
  userId: string,
  xpTotal: number,
  catalog: readonly MilestoneReward[],
  nowMs: number,
  anniversaryYear: number,
): Promise<MilestoneTriggerContext> {
  const needsBadges = catalog.some((m) => m.triggerType === "badge");
  const needsSeason = catalog.some((m) => m.triggerType === "season_goal");
  const badgeKeys = new Set<string>();
  const seasonGoalKeys = new Set<string>();

  if (needsBadges) {
    const { data, error } = await supabaseAdmin
      .from("user_badges")
      .select("badge_key")
      .eq("user_id", userId);
    if (error) console.error("[rewards-tangible] badge load failed:", error.message);
    for (const r of (data ?? []) as Array<{ badge_key: string }>) badgeKeys.add(r.badge_key);
  }

  if (needsSeason) {
    try {
      // Imported lazily: rewards-seasons imports the engine that imports this
      // module, and a static edge would make the cycle load-bearing at boot.
      const { loadSeasonProgress, loadSeasonTimezone } = await import("./rewards-seasons.ts");
      const progress = await loadSeasonProgress(userId, await loadSeasonTimezone(), nowMs);
      for (const g of progress.goals) if (g.complete) seasonGoalKeys.add(g.key);
    } catch (err) {
      console.error(
        "[rewards-tangible] season progress load failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { xpTotal, badgeKeys, seasonGoalKeys, anniversaryYear };
}

/**
 * Expand the catalog for one user's loyalty standing (US-1914). Pure.
 *
 * Two transforms, and the order matters: INSTANCE the anniversary entries first
 * (so an entry that is not owed this year disappears rather than being scaled),
 * then apply the tenure multiplier to what survives — including the anniversary
 * gift itself, which is the point of a loyalty multiplier.
 *
 * An anniversary entry with NO year owed is dropped entirely. Leaving it in with
 * its bare catalog key would grant it once and never again, quietly turning an
 * annual gift into a one-off.
 */
export function applyLoyaltyToCatalog(
  catalog: readonly MilestoneReward[],
  anniversaryYear: number,
  creditMultiplier: number,
): MilestoneReward[] {
  const out: MilestoneReward[] = [];
  for (const m of catalog) {
    if (m.triggerType === "anniversary") {
      if (anniversaryYear < 1) continue;
      out.push(
        applyTenureMultiplier(
          {
            ...m,
            key: anniversaryInstanceKey(m.baseKey, anniversaryYear),
            label: `${m.label} — year ${anniversaryYear}`,
          },
          creditMultiplier,
        ),
      );
      continue;
    }
    out.push(applyTenureMultiplier(m, creditMultiplier));
  }
  return out;
}

/**
 * Record a ceiling breach and, for the PLATFORM-wide one, pause the whole rail.
 *
 * Best-effort and suppressed while the breach stays open (00548's partial UNIQUE
 * indexes), which matters more here than it does for the AI budget: this runs
 * off the back of every rewardable action, so an unsuppressed breach would alert
 * thousands of times an hour. Only the global scope can auto-kill — a single
 * account hitting its own ceiling is the system working, not an incident.
 */
async function noteBreach(
  scope: BreachScope,
  userId: string,
  reward: MilestoneReward,
  spend: RewardSpend,
  budget: RewardBudget,
  guardrails: RewardGuardrails,
): Promise<void> {
  const global = scope === "global_monthly";
  const limitUsd = global
    ? budget.monthlyUsdCap
    : scope === "user_lifetime"
    ? budget.perUserLifetimeUsdCap
    : budget.perUserMonthlyUsdCap;
  const spendUsd = global
    ? spend.globalMonthUsd
    : scope === "user_lifetime"
    ? spend.userLifetimeUsd
    : spend.userMonthUsd;

  const breachId = await recordBudgetBreach({
    scope,
    subjectUserId: global ? null : userId,
    limitUsd,
    spendUsd,
    milestoneKey: reward.key,
    detail: { cost_usd: reward.costUsd, reward_type: reward.rewardType },
  });
  // A suppressed breach (an open row already exists) returns null, so the kill
  // and the ops noise happen exactly once per incident.
  if (!breachId || !global || !guardrails.autoKillOnGlobalBreach) return;

  const killed = await killTangibleRewards();
  if (killed) {
    console.error(
      `[rewards-tangible] platform reward budget exhausted ($${spendUsd.toFixed(2)} of ` +
        `$${limitUsd.toFixed(2)}) — rewards_tangible switched off`,
    );
    await supabaseAdmin
      .from("reward_budget_breaches")
      .update({ killed: true } as never)
      .eq("id", breachId);
  }
}

/**
 * Grant every milestone `userId` has unlocked and not yet been paid.
 *
 * Best-effort by design: this runs off the back of a rewardable action, and a
 * reward-payout problem must never fail the action that earned it. Returns the
 * milestone keys delivered on THIS call (empty is the normal case).
 */
export async function grantTangibleRewards(
  userId: string,
  xpTotal: number,
  nowMs: number = Date.now(),
  /** US-1914: pass a standing the caller already loaded (the anniversary sweep
   *  has one) so a grant pass never resolves the same tenure twice. */
  loyalty?: LoyaltyStanding | null,
): Promise<string[]> {
  try {
    // Fail-CLOSED kill-switch: no flag row, or an unreadable one, pays nobody.
    const enabled = await isFeatureEnabled("rewards_tangible", {
      userId,
      defaultEnabled: false,
    });
    if (!enabled) return [];

    // US-1914: loyalty is resolved BEFORE the catalog is evaluated, because it
    // changes what the catalog contains (which anniversary year, if any, is owed)
    // as well as what each rung is worth. A null standing — a read failure, or an
    // account with no users row — degrades to "newcomer": no anniversary, no
    // multiplier. Loyalty may enlarge a reward; it may never be what stops one.
    const standing = loyalty ?? await loadLoyaltyStanding(userId, nowMs);
    const anniversaryYear = standing?.due?.year ?? 0;

    const catalog = applyLoyaltyToCatalog(
      (await loadMilestoneCatalog()).filter((m) => isFulfillable(m.rewardType)),
      anniversaryYear,
      standing?.creditMultiplier ?? 1,
    );
    if (catalog.length === 0) return [];

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

    // Evaluate triggers only against milestones this user could still be paid —
    // an already-claimed badge milestone is no reason to go load their badges.
    const unclaimed = catalog.filter((m) => !taken.has(m.key));
    if (unclaimed.length === 0) return [];

    const ctx = await loadTriggerContext(userId, xpTotal, unclaimed, nowMs, anniversaryYear);
    const pending = unlockedMilestones(unclaimed, ctx);
    if (pending.length === 0) return [];

    const budget = normalizeRewardBudget(
      await getSetting<unknown>(REWARD_BUDGET_SETTING_KEY, DEFAULT_REWARD_BUDGET),
    );
    const spend = await loadSpend(userId, nowMs);
    if (!spend) return [];

    // US-1858 guardrails. The fraud hold comes FIRST because it is the only one
    // that is about the account rather than the money: paying a rung to an
    // account under review and then reviewing it is the wrong order.
    const guardrails = await loadRewardGuardrails();
    if (guardrails.fraudHoldEnabled && (await isUnderFraudHold(userId))) {
      console.warn(`[rewards-tangible] grants held for ${userId}: open abuse signal`);
      return [];
    }

    // The flat per-user monthly cap, narrowed by this account's own margin
    // headroom. Guardrails narrow a budget; they never widen one, which is why
    // this composes as a min() rather than replacing the cap.
    const economics = await loadUnitEconomics(userId, spend.userMonthUsd, monthStartIso(nowMs));
    const effectiveBudget: RewardBudget = {
      ...budget,
      perUserMonthlyUsdCap: effectivePerUserMonthlyCap(budget, economics, guardrails),
    };
    const marginBound = effectiveBudget.perUserMonthlyUsdCap < budget.perUserMonthlyUsdCap;
    const velocity = await loadVelocityUsage(userId, nowMs);

    const delivered: string[] = [];
    for (const reward of pending) {
      const decision = budgetDecision(reward.costUsd, spend, effectiveBudget);
      if (!decision.allowed) {
        // Refused, not deferred — but the milestone stays unclaimed, so a later
        // pass in a fresh budget window can still honour it. The list is sorted
        // cheapest-first, so a refusal here means nothing further fits either.
        console.warn(
          `[rewards-tangible] ${reward.key} refused for ${userId}: ${decision.refusal}`,
        );
        // A per-user monthly refusal that only bites because the margin headroom
        // narrowed the cap is a MARGIN breach, not a budget one — reporting it as
        // "budget" would send an operator to raise a cap that was never the
        // binding constraint.
        const scope: BreachScope = decision.refusal === "user_monthly_cap" && marginBound
          ? "margin_floor"
          : BREACH_SCOPE_FOR_REFUSAL[decision.refusal!];
        await noteBreach(scope, userId, reward, spend, effectiveBudget, guardrails);
        break;
      }

      // Velocity: many rungs at once is the shape a farmed account has, and the
      // per-milestone UNIQUE index says nothing about it.
      const paced = velocityDecision(reward.costUsd, velocity, guardrails);
      if (!paced.allowed) {
        console.warn(
          `[rewards-tangible] ${reward.key} refused for ${userId}: ${paced.refusal}`,
        );
        await recordBudgetBreach({
          scope: "velocity",
          subjectUserId: userId,
          limitUsd: guardrails.perUserDailyUsdCap,
          spendUsd: velocity.usdToday,
          milestoneKey: reward.key,
          detail: { refusal: paced.refusal, grants_today: velocity.grantsToday },
        });
        await raiseRewardFarmingSignal(userId, {
          refusal: paced.refusal!,
          milestoneKey: reward.key,
          grantsToday: velocity.grantsToday,
          usdToday: velocity.usdToday,
        }, nowMs);
        break;
      }

      // Per-milestone issue caps (00544). A failed count refuses this milestone
      // and moves on: an uncounted cap is not a cap.
      if (reward.monthlyGrantCap !== null || reward.lifetimeGrantCap !== null) {
        const counts = await loadMilestoneCounts(reward, nowMs);
        if (!counts) continue;
        const capped = milestoneCapDecision(reward, counts);
        if (!capped.allowed) {
          console.warn(
            `[rewards-tangible] ${reward.key} refused for ${userId}: ${capped.refusal}`,
          );
          continue;
        }
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
          metadata: grantMetadata(reward, xpTotal, standing),
        } as never);
      if (claimErr) {
        // 23505 = a concurrent pass already claimed it. Anything else is a real
        // failure; either way this milestone is not ours to pay.
        if ((claimErr as { code?: string }).code !== "23505") {
          console.error("[rewards-tangible] claim failed:", claimErr.message);
        }
        continue;
      }

      let extra: FulfilResult;
      try {
        extra = await FULFILLERS[reward.rewardType]!(userId, reward, nowMs);
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
        .update({
          status: "granted",
          granted_at: new Date(nowMs).toISOString(),
          expires_at: grantExpiryIso(reward, nowMs),
          metadata: { ...grantMetadata(reward, xpTotal, standing), ...(extra ?? {}) },
        } as never)
        .eq("user_id", userId)
        .eq("milestone_key", reward.key);

      // Count it against the running budget so a multi-milestone catch-up in one
      // pass respects the same ceilings a series of single grants would.
      spend.globalMonthUsd += reward.costUsd;
      spend.userMonthUsd += reward.costUsd;
      spend.userLifetimeUsd += reward.costUsd;
      // Same reason, for the daily window: a multi-milestone catch-up in one
      // pass must respect the velocity limit a series of single grants would.
      velocity.grantsToday += 1;
      velocity.usdToday += reward.costUsd;
      delivered.push(reward.key);

      // US-1914: mark the year celebrated only AFTER the value actually moved.
      // Marking on claim would burn the anniversary on a fulfilment failure —
      // the claim is released for retry, but the year would already read as
      // spent, and the retry would find nothing owed.
      if (reward.triggerType === "anniversary" && standing) {
        await markAnniversaryDelivered(
          userId,
          Date.parse(standing.memberSince),
          anniversaryYear,
          nowMs,
        );
      }

      await notifyUser(userId, {
        type: "billing",
        title: reward.triggerType === "anniversary"
          ? `Happy ${ordinalYear(anniversaryYear)} GradeThread anniversary`
          : "Reward unlocked!",
        message: rewardNotificationMessage(reward, anniversaryYear),
        // An anniversary belongs beside the standing it celebrates, not in
        // billing: the gift is the smaller half of the moment.
        link: reward.triggerType === "anniversary"
          ? "/dashboard/rewards?celebrate=anniversary"
          : "/dashboard/billing",
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

// ─── The owner's view of the ladder (US-1857) ───────────────────────────────
//
// There is NO "claim" button here and there never will be, because there is
// nothing for a user to claim: crossing a milestone grants it (grantTangibleRewards
// runs off the back of the action that earned it), and XP is never debited. So
// this read is a RECEIPT plus a horizon — what has already landed, and what the
// next rung costs in XP. A button labelled "claim" beside an automatic grant
// would invent a step the user can fail to take.

/** One grant as its owner sees it. */
export interface MilestoneGrantView {
  milestone_key: string;
  label: string;
  reward_type: string;
  reward_value: number;
  status: string;
  granted_at: string | null;
  expires_at: string | null;
}

/** The next XP rung, with progress from the rung below it. */
export interface NextMilestoneView {
  key: string;
  label: string;
  reward_type: string;
  value: number;
  xp_threshold: number;
  /** The rung below (or 0), so the bar measures the CURRENT step, not lifetime. */
  xp_from: number;
  xp_remaining: number;
  percent: number;
}

export interface MilestoneProgressView {
  /** The kill-switch. False = the ladder is paused; past grants still stand. */
  enabled: boolean;
  granted: MilestoneGrantView[];
  next: NextMilestoneView | null;
}

/**
 * Pure: where an XP total sits on the XP-threshold ladder.
 *
 * The bar spans the CURRENT step (previous rung → next rung), not 0 → next: a
 * user at 6,000 of 6,400 XP has all but arrived, and a lifetime-anchored bar
 * would show them at 94% forever as the ladder stretches. Non-XP milestones
 * (badge / season-goal triggers) have no numeric distance and are deliberately
 * absent — a progress bar toward "earn a specific badge" would be a lie.
 */
export function xpLadderProgress(
  xpTotal: number,
  catalog: readonly MilestoneReward[],
): NextMilestoneView | null {
  const rungs = catalog
    .filter((m) => m.triggerType === "xp_threshold")
    .sort((a, b) => a.xpThreshold - b.xpThreshold);
  const next = rungs.find((m) => xpTotal < m.xpThreshold);
  if (!next) return null;

  const below = rungs.filter((m) => m.xpThreshold <= xpTotal);
  const from = below.length > 0 ? below[below.length - 1]!.xpThreshold : 0;
  const span = Math.max(1, next.xpThreshold - from);
  const percent = Math.min(100, Math.max(0, Math.round(((xpTotal - from) / span) * 100)));

  return {
    key: next.key,
    label: next.label,
    reward_type: next.rewardType,
    value: next.value,
    xp_threshold: next.xpThreshold,
    xp_from: from,
    xp_remaining: Math.max(0, next.xpThreshold - xpTotal),
    percent,
  };
}

/**
 * The caller's grants + their next rung. Tenant-scoped by userId; best-effort,
 * because this hangs off the rewards screen and a ladder problem must not take
 * the level card down with it.
 */
export async function loadMilestoneProgress(
  userId: string,
  xpTotal: number,
): Promise<MilestoneProgressView> {
  const empty: MilestoneProgressView = { enabled: false, granted: [], next: null };
  try {
    const [enabled, catalog, grantsRes] = await Promise.all([
      isFeatureEnabled("rewards_tangible", { userId, defaultEnabled: false }),
      loadMilestoneCatalog(),
      supabaseAdmin
        .from("reward_tangible_grants")
        .select("milestone_key, reward_type, reward_value, status, granted_at, expires_at")
        .eq("user_id", userId)
        .order("granted_at", { ascending: false }),
    ]);

    if (grantsRes.error) {
      console.error("[rewards-tangible] grant view load failed:", grantsRes.error.message);
      return { ...empty, enabled };
    }

    const labels = new Map(catalog.map((m) => [m.key, m.label]));
    const rows = (grantsRes.data ?? []) as Array<{
      milestone_key: string;
      reward_type: string;
      reward_value: number | string;
      status: string;
      granted_at: string | null;
      expires_at: string | null;
    }>;

    // 'claimed' is an internal reservation, not a delivered reward — showing it
    // would promise value that has not moved (and may yet be released on a
    // fulfilment failure). Only 'granted' rows are the user's to see.
    const granted: MilestoneGrantView[] = rows
      .filter((r) => r.status === "granted")
      .map((r) => ({
        milestone_key: r.milestone_key,
        // An instanced key (`anniversary_gift:y3`) is not in the catalog under
        // its own name, so the fallback would print the raw key at the user.
        label: labels.get(r.milestone_key) ??
          labels.get(anniversaryBaseKey(r.milestone_key)) ??
          r.milestone_key,
        reward_type: r.reward_type,
        reward_value: Number(r.reward_value) || 0,
        status: r.status,
        granted_at: r.granted_at,
        expires_at: r.expires_at,
      }));

    // A milestone with a row of ANY status is spoken for, so the horizon skips
    // it — pointing someone at a rung they are already standing on.
    const taken = new Set(rows.map((r) => r.milestone_key));
    const ahead = catalog.filter((m) => !taken.has(m.key) && isFulfillable(m.rewardType));

    return { enabled, granted, next: xpLadderProgress(xpTotal, ahead) };
  } catch (err) {
    console.error(
      "[rewards-tangible] milestone progress threw:",
      err instanceof Error ? err.message : String(err),
    );
    return empty;
  }
}

/** What the unlock notification says. Pure — the copy has to match the trigger,
 *  or a badge reward reads as an XP one. */
export function rewardNotificationMessage(
  reward: MilestoneReward,
  anniversaryYear = 0,
): string {
  // An anniversary is a thank-you, not an achievement. "You hit a milestone" for
  // simply still being here reads as a score for something they did not do, and
  // it is the sentence a returning user is most likely to receive.
  if (reward.triggerType === "anniversary") {
    const years = anniversaryYear === 1 ? "a year" : `${anniversaryYear} years`;
    return `Thanks for ${years} with GradeThread — ${reward.label} is on us. ` +
      `Your level, badges and standing are all exactly where you left them.`;
  }
  const earned = reward.triggerType === "xp_threshold"
    ? `You hit ${reward.xpThreshold.toLocaleString()} XP`
    : "You hit a rewards milestone";
  const perk = reward.rewardType === "free_grade_credits"
    ? `${reward.label} added to your account.`
    : `${reward.label} is ready to use.`;
  return `${earned} — ${perk}`;
}

/**
 * What a grant row records about WHY it was issued. Pure.
 *
 * The tenure fields are stamped even when the multiplier was 1: a grant that
 * says nothing about the standing at the time is one an operator reconciling the
 * budget cannot explain, and "no multiplier" and "we didn't look" are different
 * facts that would otherwise look identical.
 */
export function grantMetadata(
  reward: MilestoneReward,
  xpTotal: number,
  standing: LoyaltyStanding | null,
): Record<string, unknown> {
  return {
    trigger_type: reward.triggerType,
    trigger_key: reward.triggerKey,
    xp_total: xpTotal,
    xp_threshold: reward.xpThreshold,
    milestone_base_key: reward.baseKey,
    tenure_tier: standing?.tier?.key ?? null,
    tenure_multiplier: standing?.creditMultiplier ?? 1,
  };
}
