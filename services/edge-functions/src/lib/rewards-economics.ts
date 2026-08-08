// US-1858: the economics guardrails around the tangible reward rail.
//
// rewards-tangible.ts owns HOW a milestone is paid. This module owns WHETHER it
// may be, and it exists because the three flat USD ceilings 00538 shipped are
// necessary but not sufficient:
//
//   • A flat per-user cap cannot express a MARGIN. $15 of free grades is nothing
//     against a $99/mo Business subscriber and is the entire business case
//     against a free account. `marginHeadroomUsd` turns the 40% floor from
//     vault/50-business/subscription-unit-economics.md into a number, and the
//     effective per-user cap is the SMALLER of the flat cap and that headroom —
//     guardrails narrow a budget, they never widen one.
//   • UNIQUE (user_id, milestone_key) stops a rung paying twice, so it bounds
//     re-farming ONE milestone and says nothing about walking many rungs at once.
//     That is the shape a farmed account actually has, so it gets a daily
//     velocity limit on the shared rate_limit_counters store.
//   • A refusal with no memory is a refusal nobody can act on. Every ceiling that
//     bites records a `reward_budget_breaches` row (one OPEN row per scope +
//     subject, exactly like ai_budget_breaches) and the platform-wide one can
//     flip the kill-switch off.
//
// COSMETIC REWARDS ARE EXEMPT, and that is structural rather than a policy this
// file enforces: XP, levels, badges and streaks never reach this module at all.
// They cost nothing marginal, so metering them would buy no margin and would let
// a billing outage break the engagement loop.
//
// Everything above the "impure" divider is PURE and unit-tested without a DB.
// Contract: vault/20-domain/reward-ledger.md.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
// TYPE-only, deliberately: rewards-tangible.ts imports this module, and a
// runtime import back would close a module cycle at boot. Anything this module
// needs from the month window is passed in by the caller instead.
import type { RewardBudget } from "./rewards-tangible.ts";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface RewardGuardrails {
  /** Share of a subscriber's revenue that must survive their costs (0–1). */
  marginFloorPct: number;
  /** Monthly allowance for an account with no subscription revenue, USD. */
  freeTierMonthlyUsdCap: number;
  /** Tangible grants one account may receive in a UTC day. */
  perUserDailyGrantCap: number;
  /** Marginal cost one account may be granted in a UTC day, USD. */
  perUserDailyUsdCap: number;
  /** Flip the `rewards_tangible` kill-switch when the platform ceiling breaks. */
  autoKillOnGlobalBreach: boolean;
  /** Refuse grants to an account carrying an open high/critical abuse signal. */
  fraudHoldEnabled: boolean;
}

/** Matches the `rewards_economics_guardrails` seed in migration 00548. */
export const DEFAULT_REWARD_GUARDRAILS: RewardGuardrails = {
  marginFloorPct: 0.4,
  freeTierMonthlyUsdCap: 2,
  perUserDailyGrantCap: 3,
  perUserDailyUsdCap: 5,
  autoKillOnGlobalBreach: true,
  fraudHoldEnabled: true,
};

export const REWARD_GUARDRAILS_SETTING_KEY = "rewards_economics_guardrails";

function boundedNumber(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Coerce the operator-editable setting into a usable config. Pure.
 *
 * Every field is clamped rather than merely defaulted: this config NARROWS a
 * money ceiling, and a typo'd `margin_floor_pct: 40` (meaning 40%) would
 * otherwise read as 4000% and refuse every grant forever — or, the other way
 * round, a negative daily cap would refuse everything with no clue why.
 */
export function normalizeRewardGuardrails(raw: unknown): RewardGuardrails {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    marginFloorPct: boundedNumber(o.margin_floor_pct, DEFAULT_REWARD_GUARDRAILS.marginFloorPct, 0, 0.95),
    freeTierMonthlyUsdCap: boundedNumber(
      o.free_tier_monthly_usd_cap,
      DEFAULT_REWARD_GUARDRAILS.freeTierMonthlyUsdCap,
      0,
      1_000,
    ),
    perUserDailyGrantCap: Math.floor(
      boundedNumber(o.per_user_daily_grant_cap, DEFAULT_REWARD_GUARDRAILS.perUserDailyGrantCap, 0, 1_000),
    ),
    perUserDailyUsdCap: boundedNumber(
      o.per_user_daily_usd_cap,
      DEFAULT_REWARD_GUARDRAILS.perUserDailyUsdCap,
      0,
      10_000,
    ),
    autoKillOnGlobalBreach: boolOr(
      o.auto_kill_on_global_breach,
      DEFAULT_REWARD_GUARDRAILS.autoKillOnGlobalBreach,
    ),
    fraudHoldEnabled: boolOr(o.fraud_hold_enabled, DEFAULT_REWARD_GUARDRAILS.fraudHoldEnabled),
  };
}

/** Serialise back to the setting's snake_case shape. Pure. */
export function guardrailsToSetting(g: RewardGuardrails): Record<string, unknown> {
  return {
    margin_floor_pct: g.marginFloorPct,
    free_tier_monthly_usd_cap: g.freeTierMonthlyUsdCap,
    per_user_daily_grant_cap: g.perUserDailyGrantCap,
    per_user_daily_usd_cap: g.perUserDailyUsdCap,
    auto_kill_on_global_breach: g.autoKillOnGlobalBreach,
    fraud_hold_enabled: g.fraudHoldEnabled,
  };
}

// ─── Unit economics: the margin floor ───────────────────────────────────────

/**
 * Monthly subscription revenue by FlipDesk plan, USD. Mirrors the tier table in
 * vault/50-business/subscription-unit-economics.md.
 *
 * A LOOKUP, not a live Stripe read, on purpose: this runs off the back of every
 * rewardable action, and an unknown/absent plan must resolve to the free tier
 * (the conservative direction) rather than to an outage.
 */
export const PLAN_MONTHLY_USD: Record<string, number> = {
  free: 0,
  starter: 29,
  pro: 59,
  business: 99,
};

export function planMonthlyRevenueUsd(plan: string | null | undefined): number {
  if (typeof plan !== "string") return 0;
  return PLAN_MONTHLY_USD[plan.trim().toLowerCase()] ?? 0;
}

export interface UnitEconomics {
  /** Monthly revenue of the account's plan, USD. */
  planMonthlyUsd: number;
  /** AI + processing cost already attributed to the account this month, USD. */
  aiCostMonthUsd: number;
  /** Tangible reward cost already granted to the account this month, USD. */
  rewardCostMonthUsd: number;
}

/**
 * How much more tangible reward this account can be given this month while its
 * own unit economics still clear the margin floor. Pure.
 *
 * revenue − (AI cost + reward cost) ≥ revenue × floor
 *   ⇒ headroom = revenue × (1 − floor) − AI cost − reward cost
 *
 * A ZERO-REVENUE account has no margin to protect and would get a headroom of
 * exactly nothing, which would mean no free account is ever rewarded — and the
 * whole point of the ladder is to turn a free user into a paying one. So the
 * free tier falls back to its own flat allowance, which is a deliberate,
 * separately-budgeted acquisition cost rather than a margin calculation.
 */
export function marginHeadroomUsd(e: UnitEconomics, g: RewardGuardrails): number {
  if (e.planMonthlyUsd <= 0) {
    return Math.max(0, g.freeTierMonthlyUsdCap - e.rewardCostMonthUsd);
  }
  const spendable = e.planMonthlyUsd * (1 - g.marginFloorPct);
  return Math.max(0, spendable - e.aiCostMonthUsd - e.rewardCostMonthUsd);
}

/**
 * The per-user monthly ceiling actually in force: the flat budget cap narrowed
 * by whatever margin headroom the account has. Pure.
 *
 * Expressed as a cap on CUMULATIVE monthly spend (not on the next grant) so it
 * composes with `budgetDecision`, which compares `spend + cost` against a cap.
 */
export function effectivePerUserMonthlyCap(
  budget: RewardBudget,
  e: UnitEconomics,
  g: RewardGuardrails,
): number {
  const headroomCap = e.rewardCostMonthUsd + marginHeadroomUsd(e, g);
  return Math.min(budget.perUserMonthlyUsdCap, headroomCap);
}

// ─── Velocity ───────────────────────────────────────────────────────────────

export interface VelocityUsage {
  /** Tangible grants already delivered to this account today. */
  grantsToday: number;
  /** Marginal cost already granted to this account today, USD. */
  usdToday: number;
}

export type VelocityRefusal = "velocity_grant_cap" | "velocity_usd_cap";

/**
 * Would this grant break a daily velocity limit? Pure.
 *
 * A cap of 0 means "no velocity limit", not "grant nothing" — an operator who
 * wants nothing granted has the kill-switch, and reading a blank config field as
 * a total stop is the kind of guardrail that takes the product down at 3am.
 */
export function velocityDecision(
  costUsd: number,
  usage: VelocityUsage,
  g: RewardGuardrails,
): { allowed: boolean; refusal?: VelocityRefusal } {
  if (g.perUserDailyGrantCap > 0 && usage.grantsToday + 1 > g.perUserDailyGrantCap) {
    return { allowed: false, refusal: "velocity_grant_cap" };
  }
  if (g.perUserDailyUsdCap > 0 && usage.usdToday + costUsd > g.perUserDailyUsdCap) {
    return { allowed: false, refusal: "velocity_usd_cap" };
  }
  return { allowed: true };
}

// ─── Breach scopes ──────────────────────────────────────────────────────────

export type BreachScope =
  | "global_monthly"
  | "user_monthly"
  | "user_lifetime"
  | "margin_floor"
  | "velocity";

export const BREACH_SCOPES: readonly BreachScope[] = [
  "global_monthly",
  "user_monthly",
  "user_lifetime",
  "margin_floor",
  "velocity",
];

export function isBreachScope(v: unknown): v is BreachScope {
  return typeof v === "string" && (BREACH_SCOPES as readonly string[]).includes(v);
}

/** Plain-English label for a breach scope. Pure — the console renders it. */
export function breachScopeLabel(scope: BreachScope): string {
  switch (scope) {
    case "global_monthly":
      return "Platform monthly budget";
    case "user_monthly":
      return "Per-account monthly budget";
    case "user_lifetime":
      return "Per-account lifetime budget";
    case "margin_floor":
      return "Margin floor";
    case "velocity":
      return "Daily velocity limit";
  }
}

/** A platform-wide breach is the only one that can pause the whole rail. Pure. */
export function isPlatformScope(scope: BreachScope): boolean {
  return scope === "global_monthly";
}

// ─── ROI ────────────────────────────────────────────────────────────────────

export interface RoiInputs {
  /** Tangible reward spend in the window, USD of marginal cost. */
  rewardSpendUsd: number;
  /** Signups attributed to a referral in the window. */
  referralSignups: number;
  /** Signups attributed to a shared find in the window. */
  shareSignups: number;
}

export interface RoiSummary extends RoiInputs {
  attributedSignups: number;
  /** Reward spend per attributed signup, USD. Null when nothing was attributed. */
  costPerSignupUsd: number | null;
}

/**
 * Reward spend against the signups it can be credited with. Pure.
 *
 * `costPerSignupUsd` is NULL rather than 0 (or Infinity) when nothing converted:
 * "we spent $40 and acquired nobody" and "we spent nothing" are different
 * situations, and a 0 would read as the best possible result on a dashboard
 * sorted ascending.
 *
 * Share-driven signups are counted SEPARATELY from referral ones and then
 * summed, because a signup off a shared find is very often also a referral
 * signup — the summed figure is deliberately the optimistic bound, which is why
 * both components are reported beside it rather than folded away.
 */
export function summarizeRoi(input: RoiInputs): RoiSummary {
  const attributedSignups = Math.max(0, input.referralSignups) +
    Math.max(0, input.shareSignups);
  const spend = Math.max(0, input.rewardSpendUsd);
  return {
    ...input,
    attributedSignups,
    costPerSignupUsd: attributedSignups > 0
      ? Math.round((spend / attributedSignups) * 100) / 100
      : null,
  };
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/** A delivered grant, as the reconciler reads it. */
export interface GrantLedgerRow {
  id: string;
  user_id: string;
  milestone_key: string;
  reward_type: string;
  reward_value: number;
  cost_usd: number;
  granted_at: string | null;
  metadata: Record<string, unknown> | null;
}

/** A grade-credit ledger row that a reward grant should have produced. */
export interface CreditLedgerRow {
  user_id: string;
  delta: number;
  notes: string | null;
  created_at: string | null;
}

export type ReconcileIssue =
  | "missing_credit_ledger"
  | "credit_amount_mismatch"
  | "missing_coupon"
  | "coupon_not_found";

export interface ReconcileFinding {
  grantId: string;
  userId: string;
  milestoneKey: string;
  rewardType: string;
  issue: ReconcileIssue;
  expected: number | string;
  actual: number | string | null;
}

export interface ReconcileResult {
  checked: number;
  matched: number;
  findings: ReconcileFinding[];
}

/**
 * The credit-ledger note `grantTangibleRewards` writes. The reconciler matches
 * on it, so it lives here rather than being spelled twice.
 */
export function creditLedgerNote(label: string, milestoneKey: string): string {
  return `Rewards milestone: ${label} (${milestoneKey})`;
}

/** Does a ledger note belong to this milestone? Pure. */
export function noteMatchesMilestone(note: string | null, milestoneKey: string): boolean {
  return typeof note === "string" && note.includes(`(${milestoneKey})`);
}

/**
 * Compare delivered grants against what actually moved. Pure, so the whole
 * reconciliation policy is testable without a DB or a Stripe key.
 *
 * A `free_grade_credits` grant must have a grade_credit_transactions row for the
 * same user carrying the milestone key, and its delta must equal the granted
 * count. A discount grant must carry a `stripe_coupon_id` in its metadata, and —
 * when the caller supplies the live set — that coupon must still exist in Stripe.
 *
 * `liveCouponIds` is NULL when Stripe could not be reached. That is deliberately
 * not the same as "the coupon is gone": an unreachable Stripe reports no
 * `coupon_not_found` findings at all, because a network blip must not be shown
 * to an operator as a payout that never happened.
 */
export function reconcileGrants(
  grants: readonly GrantLedgerRow[],
  creditRows: readonly CreditLedgerRow[],
  liveCouponIds: ReadonlySet<string> | null,
): ReconcileResult {
  const findings: ReconcileFinding[] = [];
  let matched = 0;

  for (const g of grants) {
    const base = {
      grantId: g.id,
      userId: g.user_id,
      milestoneKey: g.milestone_key,
      rewardType: g.reward_type,
    };

    if (g.reward_type === "free_grade_credits") {
      const expected = Math.round(Number(g.reward_value) || 0);
      const row = creditRows.find(
        (r) => r.user_id === g.user_id && noteMatchesMilestone(r.notes, g.milestone_key),
      );
      if (!row) {
        findings.push({ ...base, issue: "missing_credit_ledger", expected, actual: null });
        continue;
      }
      if (Math.round(Number(row.delta) || 0) !== expected) {
        findings.push({
          ...base,
          issue: "credit_amount_mismatch",
          expected,
          actual: Math.round(Number(row.delta) || 0),
        });
        continue;
      }
      matched++;
      continue;
    }

    const couponId = typeof g.metadata?.stripe_coupon_id === "string"
      ? g.metadata.stripe_coupon_id
      : "";
    if (!couponId) {
      findings.push({ ...base, issue: "missing_coupon", expected: "stripe_coupon_id", actual: null });
      continue;
    }
    if (liveCouponIds && !liveCouponIds.has(couponId)) {
      findings.push({ ...base, issue: "coupon_not_found", expected: couponId, actual: null });
      continue;
    }
    matched++;
  }

  return { checked: grants.length, matched, findings };
}

// ══ impure ══════════════════════════════════════════════════════════════════
// Everything below touches the DB. Every query is either platform-wide operator
// data or scoped by the userId the caller already owns (US-268).

const DAY_MS = 86_400_000;

/** UTC day floor as an ISO string — the fixed window the velocity caps use. */
export function dayWindowStart(nowMs: number): string {
  return new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString();
}

/** The live guardrail config, falling back to the compiled defaults. */
export async function loadRewardGuardrails(): Promise<RewardGuardrails> {
  return normalizeRewardGuardrails(
    await getSetting<unknown>(REWARD_GUARDRAILS_SETTING_KEY, DEFAULT_REWARD_GUARDRAILS),
  );
}

/**
 * One account's unit economics for the current month. Best-effort: a read
 * failure resolves to the FREE tier with zero attributed cost, which is the
 * conservative direction — the account gets the small free-tier allowance rather
 * than a Business-sized one.
 */
export async function loadUnitEconomics(
  userId: string,
  rewardCostMonthUsd: number,
  /** UTC first-of-month boundary — `monthStartIso()` from rewards-tangible.ts. */
  since: string,
): Promise<UnitEconomics> {
  const [planRes, aiRes] = await Promise.all([
    supabaseAdmin.from("users").select("flipdesk_plan").eq("id", userId).maybeSingle(),
    supabaseAdmin
      .from("ai_usage_events")
      .select("cost_usd")
      .eq("user_id", userId)
      .gte("created_at", since),
  ]);

  const plan = (planRes.data as { flipdesk_plan?: string | null } | null)?.flipdesk_plan ?? null;
  const aiCostMonthUsd = ((aiRes.data ?? []) as Array<{ cost_usd: number | string }>)
    .reduce((acc, r) => acc + (Number(r.cost_usd) || 0), 0);

  return {
    planMonthlyUsd: planMonthlyRevenueUsd(plan),
    aiCostMonthUsd,
    rewardCostMonthUsd,
  };
}

/**
 * Today's grant velocity for one account, read from the grant ledger itself
 * rather than a counter.
 *
 * The counter store would be cheaper, but it is a fixed-window COUNTER — it
 * increments on every ATTEMPT, so a user whose grants were all refused for
 * unrelated reasons would still burn their velocity budget. The ledger says what
 * was actually delivered, which is the thing the limit is about. Best-effort: a
 * read failure reports zero usage, so the USD ceilings (which are read
 * separately and fail closed) remain the binding constraint.
 */
export async function loadVelocityUsage(
  userId: string,
  nowMs: number = Date.now(),
): Promise<VelocityUsage> {
  const { data, error } = await supabaseAdmin
    .from("reward_tangible_grants")
    .select("cost_usd")
    .eq("user_id", userId)
    .eq("status", "granted")
    .gte("granted_at", dayWindowStart(nowMs));
  if (error) {
    console.error("[rewards-economics] velocity read failed:", error.message);
    return { grantsToday: 0, usdToday: 0 };
  }
  const rows = (data ?? []) as Array<{ cost_usd: number | string }>;
  return {
    grantsToday: rows.length,
    usdToday: rows.reduce((acc, r) => acc + (Number(r.cost_usd) || 0), 0),
  };
}

/**
 * Is this account under a fraud hold — i.e. does it carry an untriaged
 * high/critical abuse signal?
 *
 * Fails OPEN (no hold) on a read error. A hold suspends value someone has
 * genuinely earned, and suspending it because the signals table was briefly
 * unreadable would be a worse failure than paying a farmer one more rung — the
 * USD ceilings still bound that.
 */
export async function isUnderFraudHold(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("abuse_signals")
    .select("id")
    .eq("subject_user_id", userId)
    .in("status", ["open", "reviewing"])
    .in("severity", ["high", "critical"])
    .limit(1);
  if (error) {
    console.error("[rewards-economics] fraud hold read failed:", error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

/** The dedupe key one account's reward-farming signal uses, per UTC day. */
export function rewardFarmingDedupeKey(userId: string, nowMs: number): string {
  return `reward_farming:${userId}:${dayWindowStart(nowMs).slice(0, 10)}`;
}

/**
 * Raise (or refresh) the reward-farming signal for an account whose velocity
 * limit just tripped, so it lands in the EXISTING triage console rather than in
 * a second queue nobody remembers to open. Best-effort.
 *
 * One signal per account per UTC day (the dedupe key): a farmed account trips
 * the limit repeatedly, and a row per trip would bury the console under one
 * account.
 */
export async function raiseRewardFarmingSignal(
  userId: string,
  detail: { refusal: string; milestoneKey: string; grantsToday: number; usdToday: number },
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const nowIso = new Date(nowMs).toISOString();
    const { error } = await supabaseAdmin
      .from("abuse_signals")
      .upsert(
        {
          signal_type: "reward_farming",
          severity: "medium",
          subject_user_id: userId,
          dedupe_key: rewardFarmingDedupeKey(userId, nowMs),
          // Ids + counts only — the same evidence discipline as abuse-signals.ts.
          evidence: {
            count: detail.grantsToday,
            window_hours: 24,
            since: dayWindowStart(nowMs),
          },
          last_seen_at: nowIso,
        } as never,
        { onConflict: "dedupe_key", ignoreDuplicates: false },
      );
    if (error) console.error("[rewards-economics] farming signal failed:", error.message);
  } catch (err) {
    console.error(
      "[rewards-economics] farming signal threw:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface BreachInput {
  scope: BreachScope;
  subjectUserId: string | null;
  limitUsd: number;
  spendUsd: number;
  milestoneKey: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Record a ceiling breach, ONCE, while it stays open.
 *
 * The insert races against the partial UNIQUE indexes in 00548, and a 23505
 * means an open breach for this (scope, subject) already exists — which is the
 * suppression working, not a failure. Returns the new row's id, or null when the
 * breach was suppressed or the write failed; the caller uses that to decide
 * whether to alert, so a suppressed breach is silent by construction.
 */
export async function recordBudgetBreach(input: BreachInput): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("reward_budget_breaches")
      .insert({
        scope: input.scope,
        subject_user_id: input.subjectUserId,
        limit_usd: Math.round(input.limitUsd * 100) / 100,
        spend_usd: Math.round(input.spendUsd * 100) / 100,
        milestone_key: input.milestoneKey,
        detail: input.detail ?? {},
      } as never)
      .select("id")
      .single();
    if (error) {
      if ((error as { code?: string }).code !== "23505") {
        console.error("[rewards-economics] breach insert failed:", error.message);
      }
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    console.error(
      "[rewards-economics] breach insert threw:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Flip the `rewards_tangible` kill-switch off after a platform-wide breach.
 * Returns true only when a row was actually flipped (an already-off flag is not
 * a kill). Best-effort.
 */
export async function killTangibleRewards(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("feature_flags")
      .update({ enabled: false } as never)
      .eq("key", "rewards_tangible")
      .eq("enabled", true)
      .select("key");
    if (error) {
      console.error("[rewards-economics] kill-switch flip failed:", error.message);
      return false;
    }
    const flipped = ((data ?? []) as Array<{ key: string }>).length > 0;
    if (flipped) {
      const { clearFeatureFlagCache } = await import("./feature-flags.ts");
      clearFeatureFlagCache();
    }
    return flipped;
  } catch (err) {
    console.error(
      "[rewards-economics] kill-switch threw:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
