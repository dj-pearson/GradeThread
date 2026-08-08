// US-1914: LOYALTY — tenure tiers, anniversaries, and standing that never decays.
//
// Everything else in the reward system is a measurement of ACTIVITY inside a
// window: a season is a quarter, a quest is a week, a nudge looks at a few days.
// That is correct for activity and wrong for loyalty, and conflating the two is
// the specific failure this module exists to prevent — decay mechanics punish
// the loyal-but-bursty reseller hardest, because a picker who sources for three
// weeks and lists forty items in a weekend looks "inactive" for most of a month
// while being one of the best customers on the platform.
//
// So three rules, and they are the whole module:
//
//   1. TENURE ONLY ASCENDS. The tier is derived from account age + lifetime paid
//      months, but the DERIVED value is never what is stored: `ascendOnly` takes
//      the max of the derived rank and the persisted peak, exactly like
//      user_reward_state.xp_peak (00542). The inputs can move — an operator
//      raises a threshold, the paid-months read fails, an erased ledger row
//      shrinks the count — and none of that may demote anybody.
//   2. THE MULTIPLIER SCALES COST TOO. A tenure multiplier that grew the reward
//      but not the `cost_usd` it is charged at would spend 1.35× the money
//      against a budget that thought it spent 1×, and the US-1858 ceilings would
//      quietly stop being ceilings. `applyTenureMultiplier` moves both together.
//   3. AN ANNIVERSARY IS A MILESTONE. It rides the US-1853 catalog rail rather
//      than a payout path of its own, so it inherits claim-before-pay, the USD
//      ceilings, the velocity limit and the fraud hold. The only new mechanic is
//      the per-year INSTANCE KEY (`anniversary_gift:y3`), which is what turns
//      UNIQUE (user_id, milestone_key) from "once ever" into "once per year".
//
// The pure half (tier resolution, ascent, month math, anniversary instancing,
// multiplier application) has no DB and no env, so the whole policy is testable
// without a database — see rewards-loyalty_test.ts.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";

// ─── Config ─────────────────────────────────────────────────────────────────

export const LOYALTY_CONFIG_KEY = "rewards_loyalty_config";

export interface LoyaltyConfig {
  enabled: boolean;
  multiplierEnabled: boolean;
  anniversaryEnabled: boolean;
  /** How long after the date a missed sweep may still deliver the gift. */
  anniversaryWindowDays: number;
  /** How long an account must have been quiet before a comeback nudge is true. */
  comebackQuietDays: number;
}

export const DEFAULT_LOYALTY_CONFIG: LoyaltyConfig = {
  enabled: true,
  multiplierEnabled: true,
  anniversaryEnabled: true,
  anniversaryWindowDays: 14,
  comebackQuietDays: 45,
};

function bounded(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

/** Coerce the operator-editable setting into a usable config. Never throws. */
export function normalizeLoyaltyConfig(raw: unknown): LoyaltyConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_LOYALTY_CONFIG;
  const r = raw as Record<string, unknown>;
  const flag = (v: unknown, fallback: boolean) => typeof v === "boolean" ? v : fallback;
  return {
    enabled: flag(r.enabled, DEFAULT_LOYALTY_CONFIG.enabled),
    multiplierEnabled: flag(r.multiplier_enabled, DEFAULT_LOYALTY_CONFIG.multiplierEnabled),
    anniversaryEnabled: flag(r.anniversary_enabled, DEFAULT_LOYALTY_CONFIG.anniversaryEnabled),
    anniversaryWindowDays: bounded(
      r.anniversary_window_days,
      DEFAULT_LOYALTY_CONFIG.anniversaryWindowDays,
      1,
      90,
    ),
    comebackQuietDays: bounded(
      r.comeback_quiet_days,
      DEFAULT_LOYALTY_CONFIG.comebackQuietDays,
      7,
      365,
    ),
  };
}

export async function loadLoyaltyConfig(): Promise<LoyaltyConfig> {
  return normalizeLoyaltyConfig(await getSetting<unknown>(LOYALTY_CONFIG_KEY, null));
}

// ─── The tenure ladder ──────────────────────────────────────────────────────

export interface TenureTier {
  key: string;
  label: string;
  blurb: string;
  /** Position on the ladder. Higher is longer-standing. */
  rank: number;
  minMonths: number;
  minPaidMonths: number;
  /** Multiplies milestone-granted CREDITS. Always ≥ 1 — see 00557's CHECK. */
  creditMultiplier: number;
}

/**
 * The FALLBACK ladder, used only when reward_tenure_tiers can't be read.
 *
 * Unlike the milestone catalog, an EMPTY read falls back here too. The reason is
 * the difference between the two things: a milestone moves money, so an operator
 * switching every rung off must mean "pay nobody". A tenure tier is a STATEMENT
 * ABOUT SOMEONE'S HISTORY, and an empty ladder would erase everybody's standing
 * rather than pause a payout — the one outcome this feature promises can't
 * happen. Rank 0 multiplies by 1.00, so an empty ladder still costs nothing.
 */
export const DEFAULT_TENURE_TIERS: readonly TenureTier[] = [
  {
    key: "newcomer",
    label: "Member",
    blurb: "Welcome aboard. Your standing starts here and only ever goes up.",
    rank: 0,
    minMonths: 0,
    minPaidMonths: 0,
    creditMultiplier: 1,
  },
  {
    key: "year_one",
    label: "One year in",
    blurb: "A year with GradeThread. Milestone credits come through 10% larger.",
    rank: 1,
    minMonths: 12,
    minPaidMonths: 3,
    creditMultiplier: 1.1,
  },
  {
    key: "year_two",
    label: "Two years in",
    blurb: "Two years and counting. Milestone credits come through 20% larger.",
    rank: 2,
    minMonths: 24,
    minPaidMonths: 9,
    creditMultiplier: 1.2,
  },
  {
    key: "veteran",
    label: "Veteran",
    blurb: "Three years of graded finds. Milestone credits come through 35% larger.",
    rank: 3,
    minMonths: 36,
    minPaidMonths: 18,
    creditMultiplier: 1.35,
  },
];

/** Whole calendar months between two instants, never negative. Pure. */
export function monthsSince(fromMs: number, nowMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs) || nowMs <= fromMs) return 0;
  const from = new Date(fromMs);
  const now = new Date(nowMs);
  let months = (now.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - from.getUTCMonth());
  // The month only counts once the day-of-month has come round again, so a
  // signup on the 28th is not "one month in" on the 1st.
  if (now.getUTCDate() < from.getUTCDate()) months--;
  return Math.max(0, months);
}

/** Completed account YEARS. Pure — the anniversary count, not a rounded age. */
export function completedYears(memberSinceMs: number, nowMs: number): number {
  return Math.floor(monthsSince(memberSinceMs, nowMs) / 12);
}

/**
 * The tier a user's history earns them RIGHT NOW, ignoring what they already
 * hold. Both thresholds must be met — long tenure on a free account is real
 * tenure but not paid engagement, and a ladder that ignored one of its own two
 * inputs would be a ladder with one rung. Pure.
 */
export function deriveTenureTier(
  months: number,
  paidMonths: number,
  tiers: readonly TenureTier[] = DEFAULT_TENURE_TIERS,
): TenureTier | null {
  let best: TenureTier | null = null;
  for (const t of tiers) {
    if (months < t.minMonths || paidMonths < t.minPaidMonths) continue;
    if (!best || t.rank > best.rank) best = t;
  }
  return best;
}

/**
 * The tier a user actually STANDS in: the higher of what they earn today and the
 * peak they have already reached. Pure, and the single place the never-decay
 * promise is implemented.
 *
 * A persisted peak that no longer matches any live tier still wins — the ladder
 * is resolved back by rank, and if even that fails the peak is reported as an
 * unnamed rank rather than dropped. Losing the NAME of somebody's standing is
 * recoverable; losing the standing is not.
 */
export function ascendOnly(
  derived: TenureTier | null,
  peakRank: number,
  tiers: readonly TenureTier[] = DEFAULT_TENURE_TIERS,
): TenureTier | null {
  const derivedRank = derived?.rank ?? -1;
  if (derivedRank >= peakRank) return derived;
  const held = tiers.filter((t) => t.rank <= peakRank).sort((a, b) => b.rank - a.rank)[0];
  return held ?? derived;
}

/** The next rung above `current`, or null at the top of the ladder. Pure. */
export function nextTenureTier(
  current: TenureTier | null,
  tiers: readonly TenureTier[] = DEFAULT_TENURE_TIERS,
): TenureTier | null {
  const rank = current?.rank ?? -1;
  return tiers
    .filter((t) => t.rank > rank)
    .sort((a, b) => a.rank - b.rank)[0] ?? null;
}

/** The multiplier a standing carries, with the operator switch applied. Pure. */
export function creditMultiplierFor(
  tier: TenureTier | null,
  config: LoyaltyConfig,
): number {
  if (!config.enabled || !config.multiplierEnabled) return 1;
  const m = tier?.creditMultiplier ?? 1;
  // The DB CHECK already floors this at 1.00; the floor is restated here because
  // the fallback ladder and a hand-built test tier do not pass through the DB.
  return Number.isFinite(m) && m > 1 ? Math.min(5, m) : 1;
}

// ─── Applying the multiplier to a milestone ─────────────────────────────────

/** The subset of a milestone the multiplier touches. Keeps this module free of
 *  a runtime import back into rewards-tangible.ts (which imports this one). */
export interface MultipliableMilestone {
  rewardType: string;
  value: number;
  costUsd: number;
}

/**
 * Grow a credit milestone by the tenure multiplier. Pure.
 *
 * Two things are deliberate. Only `free_grade_credits` is scaled: a discount is
 * a PERCENT, and 20% off × 1.35 is 27% off, which is a different offer rather
 * than a larger version of the same one — and it would silently walk past the
 * "a discount can't exceed 100%" band the catalog enforces. And the COST scales
 * with the value, so the US-1858 ceilings charge for what actually went out; a
 * multiplier that grew the gift but not the number the budget reads would make
 * every cap 35% larger than the operator set it to, invisibly.
 */
export function applyTenureMultiplier<T extends MultipliableMilestone>(
  m: T,
  multiplier: number,
): T {
  if (m.rewardType !== "free_grade_credits" || !(multiplier > 1)) return m;
  const value = Math.max(1, Math.round(m.value * multiplier));
  if (value === m.value) return m;
  // Cost is charged on the DELIVERED credit count, not on the raw multiplier, so
  // rounding the reward down never leaves the budget paying for a credit nobody
  // received.
  const costUsd = Math.round((m.costUsd / Math.max(1, m.value)) * value * 100) / 100;
  return { ...m, value, costUsd };
}

// ─── Anniversaries ──────────────────────────────────────────────────────────

/** The per-year grant key for an anniversary milestone. Pure. */
export function anniversaryInstanceKey(baseKey: string, year: number): string {
  return `${baseKey}:y${year}`;
}

/** The base catalog key behind an instance key (or the key itself). Pure. */
export function anniversaryBaseKey(instanceKey: string): string {
  const i = instanceKey.lastIndexOf(":y");
  return i > 0 ? instanceKey.slice(0, i) : instanceKey;
}

export interface AnniversaryDue {
  /** The completed account year being celebrated (1 = first anniversary). */
  year: number;
  /** ms epoch of the anniversary itself. */
  atMs: number;
}

/**
 * Is an anniversary gift owed right now, and for which year? Pure.
 *
 * Bounded by a WINDOW rather than by an exact date so a sweep that was down for
 * a day still delivers, and by `lastCelebratedYear` so it delivers ONCE. It
 * never back-pays: an account eight years old whose state says year 7 is owed
 * year 8 only, and only if today is inside year 8's window. Everything before
 * that is history nobody promised them, and paying it would empty the reward
 * budget on a deploy day.
 */
export function anniversaryDue(
  memberSinceMs: number,
  lastCelebratedYear: number,
  nowMs: number,
  config: LoyaltyConfig,
): AnniversaryDue | null {
  if (!config.enabled || !config.anniversaryEnabled) return null;
  const years = completedYears(memberSinceMs, nowMs);
  if (years < 1 || years <= lastCelebratedYear) return null;

  const at = new Date(memberSinceMs);
  at.setUTCFullYear(at.getUTCFullYear() + years);
  const atMs = at.getTime();
  if (nowMs < atMs) return null;
  if (nowMs - atMs > config.anniversaryWindowDays * 86_400_000) return null;
  return { year: years, atMs };
}

/** The instant the NEXT anniversary falls on, for the sweep's index. Pure. */
export function nextAnniversaryMs(memberSinceMs: number, nowMs: number): number {
  const years = completedYears(memberSinceMs, nowMs);
  const at = new Date(memberSinceMs);
  at.setUTCFullYear(at.getUTCFullYear() + years + 1);
  return at.getTime();
}

/** Ordinal copy for an anniversary year ("1st", "2nd", "13th"). Pure. */
export function ordinalYear(year: number): string {
  const n = Math.max(1, Math.floor(year));
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// ─── DB half (service-role; every per-user query scoped by user_id — US-268) ─

interface TenureTierRow {
  key: string;
  label: string;
  blurb: string;
  tier_rank: number;
  min_months: number;
  min_paid_months: number;
  credit_multiplier: number | string;
}

/** Map a config row onto the engine's shape. Pure. */
export function tenureTierFromRow(row: TenureTierRow): TenureTier {
  const m = Number(row.credit_multiplier);
  return {
    key: row.key,
    label: row.label,
    blurb: row.blurb ?? "",
    rank: Math.max(0, Math.floor(Number(row.tier_rank) || 0)),
    minMonths: Math.max(0, Math.floor(Number(row.min_months) || 0)),
    minPaidMonths: Math.max(0, Math.floor(Number(row.min_paid_months) || 0)),
    creditMultiplier: Number.isFinite(m) && m >= 1 ? Math.min(5, m) : 1,
  };
}

/** The live ladder. An error OR an empty read falls back — see DEFAULT_TENURE_TIERS. */
export async function loadTenureTiers(): Promise<TenureTier[]> {
  const { data, error } = await supabaseAdmin
    .from("reward_tenure_tiers")
    .select("key, label, blurb, tier_rank, min_months, min_paid_months, credit_multiplier")
    .eq("enabled", true)
    .order("tier_rank", { ascending: true });
  if (error) {
    console.error("[rewards-loyalty] tier load failed, using fallback:", error.message);
    return [...DEFAULT_TENURE_TIERS];
  }
  const rows = (data ?? []) as unknown as TenureTierRow[];
  if (rows.length === 0) return [...DEFAULT_TENURE_TIERS];
  return rows.map(tenureTierFromRow);
}

export interface LoyaltyStateRow {
  member_since: string;
  tier_rank_peak: number;
  tier_key_peak: string;
  tier_reached_at: string | null;
  last_anniversary_year: number;
  anniversary_due_at: string | null;
}

/**
 * The user's loyalty row, creating it if this account predates the trigger.
 *
 * Self-healing rather than assuming the backfill ran: the row is cheap, and a
 * missing one would otherwise mean a user with no tenure standing at all, which
 * is the one thing this feature promises cannot happen.
 */
export async function loadLoyaltyState(userId: string): Promise<LoyaltyStateRow | null> {
  const { data, error } = await supabaseAdmin
    .from("user_loyalty_state")
    .select(
      "member_since, tier_rank_peak, tier_key_peak, tier_reached_at, last_anniversary_year, anniversary_due_at",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[rewards-loyalty] state load failed:", error.message);
    return null;
  }
  if (data) return data as unknown as LoyaltyStateRow;

  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("created_at")
    .eq("id", userId)
    .maybeSingle();
  const createdAt = (userRow as { created_at?: string } | null)?.created_at;
  if (!createdAt) return null;

  const seeded = {
    user_id: userId,
    member_since: createdAt,
    anniversary_due_at: new Date(nextAnniversaryMs(Date.parse(createdAt), Date.now()))
      .toISOString(),
  };
  const { error: insErr } = await supabaseAdmin
    .from("user_loyalty_state")
    .insert(seeded as never);
  // 23505 = a concurrent seed won; either way the row now exists.
  if (insErr && (insErr as { code?: string }).code !== "23505") {
    console.error("[rewards-loyalty] state seed failed:", insErr.message);
  }
  return {
    member_since: createdAt,
    tier_rank_peak: 0,
    tier_key_peak: "newcomer",
    tier_reached_at: null,
    last_anniversary_year: 0,
    anniversary_due_at: seeded.anniversary_due_at,
  };
}

/**
 * Distinct calendar months in which this account received PAID credits.
 *
 * 'pack_purchase' is money spent directly; 'included_grant' is the monthly drop
 * a paid plan makes, so one of those per month IS a paid month. 'admin_grant',
 * 'refund' and the debits are excluded — a reward we gave someone is not
 * evidence that they paid us, and counting it would let the loyalty ladder be
 * climbed with the rewards the ladder itself hands out.
 */
export async function loadPaidMonths(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("grade_credit_transactions")
    .select("created_at, reason")
    .eq("user_id", userId)
    .in("reason", ["pack_purchase", "included_grant"])
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) {
    // Reads as ZERO paid months, which can only ever hold someone at the tier
    // they already stand in — ascendOnly makes a failed read unable to demote.
    console.error("[rewards-loyalty] paid-month load failed:", error.message);
    return 0;
  }
  const months = new Set<string>();
  for (const r of (data ?? []) as Array<{ created_at: string }>) {
    if (typeof r.created_at === "string" && r.created_at.length >= 7) {
      months.add(r.created_at.slice(0, 7));
    }
  }
  return months.size;
}

/** What the rewards screen and the grant pass both need to know. */
export interface LoyaltyStanding {
  /** ISO date the account was created — the "member since" flair. */
  memberSince: string;
  months: number;
  years: number;
  paidMonths: number;
  tier: TenureTier | null;
  nextTier: TenureTier | null;
  /** Whole months of tenure still needed for `nextTier`, or null at the top. */
  monthsToNext: number | null;
  /** Paid months still needed for `nextTier`, or null at the top. */
  paidMonthsToNext: number | null;
  creditMultiplier: number;
  config: LoyaltyConfig;
  /** The anniversary owed right now, if any. */
  due: AnniversaryDue | null;
  lastAnniversaryYear: number;
}

/**
 * Resolve (and persist) a user's loyalty standing.
 *
 * The write is a PROMOTION-ONLY update: it fires when the resolved rank exceeds
 * the stored peak and never otherwise, so there is no code path here that can
 * lower a rank. Best-effort throughout — this hangs off the rewards screen and
 * off the grant pass, and neither may fail because a tenure read did.
 */
export async function loadLoyaltyStanding(
  userId: string,
  nowMs: number = Date.now(),
): Promise<LoyaltyStanding | null> {
  try {
    const [config, tiers, state] = await Promise.all([
      loadLoyaltyConfig(),
      loadTenureTiers(),
      loadLoyaltyState(userId),
    ]);
    if (!state) return null;

    const memberSinceMs = Date.parse(state.member_since);
    if (!Number.isFinite(memberSinceMs)) return null;

    const months = monthsSince(memberSinceMs, nowMs);
    const paidMonths = await loadPaidMonths(userId);
    const derived = deriveTenureTier(months, paidMonths, tiers);
    const tier = ascendOnly(derived, state.tier_rank_peak ?? 0, tiers);

    if (tier && tier.rank > (state.tier_rank_peak ?? 0)) {
      const { error } = await supabaseAdmin
        .from("user_loyalty_state")
        .update({
          tier_rank_peak: tier.rank,
          tier_key_peak: tier.key,
          tier_reached_at: new Date(nowMs).toISOString(),
        } as never)
        .eq("user_id", userId)
        // Belt and braces: even a concurrent writer cannot make this a demotion.
        .lt("tier_rank_peak", tier.rank);
      if (error) console.error("[rewards-loyalty] tier promotion failed:", error.message);
    }

    const nextTier = nextTenureTier(tier, tiers);
    return {
      memberSince: state.member_since,
      months,
      years: Math.floor(months / 12),
      paidMonths,
      tier,
      nextTier,
      monthsToNext: nextTier ? Math.max(0, nextTier.minMonths - months) : null,
      paidMonthsToNext: nextTier ? Math.max(0, nextTier.minPaidMonths - paidMonths) : null,
      creditMultiplier: creditMultiplierFor(tier, config),
      config,
      due: anniversaryDue(memberSinceMs, state.last_anniversary_year ?? 0, nowMs, config),
      lastAnniversaryYear: state.last_anniversary_year ?? 0,
    };
  } catch (err) {
    console.error(
      "[rewards-loyalty] standing load threw:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Record that an anniversary has been delivered and point the sweep at the next.
 *
 * Guarded by `.lt("last_anniversary_year", year)` so a concurrent sweep cannot
 * roll the marker BACKWARDS and re-open a year that was already celebrated —
 * the same shape as the promotion guard above, for the same reason.
 */
export async function markAnniversaryDelivered(
  userId: string,
  memberSinceMs: number,
  year: number,
  nowMs: number = Date.now(),
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("user_loyalty_state")
    .update({
      last_anniversary_year: year,
      anniversary_due_at: new Date(nextAnniversaryMs(memberSinceMs, nowMs)).toISOString(),
    } as never)
    .eq("user_id", userId)
    .lt("last_anniversary_year", year);
  if (error) console.error("[rewards-loyalty] anniversary mark failed:", error.message);
}

/** Accounts whose anniversary is due, oldest-due first. Bounded by the index. */
export async function loadAnniversaryDueUsers(
  nowMs: number,
  limit = 400,
): Promise<Array<{ userId: string; memberSinceMs: number; lastYear: number }>> {
  const { data, error } = await supabaseAdmin
    .from("user_loyalty_state")
    .select("user_id, member_since, last_anniversary_year")
    .not("anniversary_due_at", "is", null)
    .lte("anniversary_due_at", new Date(nowMs).toISOString())
    .order("anniversary_due_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[rewards-loyalty] anniversary sweep load failed:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    user_id: string;
    member_since: string;
    last_anniversary_year: number;
  }>)
    .map((r) => ({
      userId: r.user_id,
      memberSinceMs: Date.parse(r.member_since),
      lastYear: r.last_anniversary_year ?? 0,
    }))
    .filter((r) => Number.isFinite(r.memberSinceMs));
}
