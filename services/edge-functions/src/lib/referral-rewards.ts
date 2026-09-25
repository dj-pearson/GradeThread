// US-629 / US-864: referral reward sizes (grade credits).
//
// Kept in a tiny leaf module so every importer — the grant path
// (lib/referrals.ts), the admin route, the user-facing /referrals/me endpoint,
// and the public leaderboard feed (content-public.ts) — can read the same
// numbers WITHOUT pulling in the notify/email graph that lib/referrals.ts needs
// for the actual grant.

// Credits granted to the referrer when one of their referrals is rewarded.
// US-1069: these are now the OUT-OF-BOX DEFAULTS only — the live values are
// admin-tunable in system_settings (see ReferralRewardConfig below) and read at
// grant time. They remain exported as the published defaults the config falls
// back to, and so back-compat importers keep compiling.
export const REFERRER_REWARD_CREDITS = 5;
// Credits granted to the referred (new) user on the same event.
export const REFERRED_REWARD_CREDITS = 3;

// US-1069: admin-configurable referral reward economics. The per-referral credit
// sizes (formerly the hardcoded constants above), plus a qualification window and
// a per-referrer cap, now live in `system_settings` under
// REFERRAL_REWARD_CONFIG_SETTING_KEY so the operator tunes referral payout
// without a deploy. Kept in this leaf module (no supabase import) so the
// normalize/validate logic is unit-testable and shared by the grant path
// (lib/referrals.ts), the user-facing /referrals/me endpoint, and the admin
// Incentives surface.
export interface ReferralRewardConfig {
  // Grade credits granted to the referrer per granted referral.
  referrer_credits: number;
  // Grade credits granted to the referred (new) user per granted referral.
  referred_credits: number;
  // The referred user must reach their first paid action (qualify) within this
  // many days of redeeming the ?ref= link, else the reward is forfeit. 0 = no
  // window (qualify any time).
  qualification_window_days: number;
  // Max number of granted referrals a single referrer earns rewards for; once
  // hit, further referrals qualify but pay no reward. 0 = unlimited.
  per_referrer_cap: number;
  // A referral code can only be redeemed by an account younger than this many
  // days. Stops an established account from claiming the signup incentive by
  // typing a friend's code months later. 0 = no limit.
  redeem_window_days: number;
}

export const REFERRAL_REWARD_CONFIG_SETTING_KEY = "referral.reward_config";

// Out-of-box economics: the historical 5/3 split, no window, no cap.
export const DEFAULT_REFERRAL_REWARD_CONFIG: ReferralRewardConfig = {
  referrer_credits: REFERRER_REWARD_CREDITS,
  referred_credits: REFERRED_REWARD_CREDITS,
  qualification_window_days: 0,
  per_referrer_cap: 0,
  redeem_window_days: 14,
};

// Coerce one untrusted non-negative-integer field: an ABSENT field falls back to
// the default; a PRESENT-but-invalid field (non-number/NaN/string) becomes 0;
// negatives/fractions are clamped to a whole, non-negative count.
function coerceNonNegInt(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 0;
}

// Coerce an untrusted stored/admin value (jsonb from system_settings, possibly
// partial/wrongly-typed/absent) into a safe, fully-populated config. Pure —
// unit-tested and shared by the grant path. Never throws.
export function normalizeReferralRewardConfig(raw: unknown): ReferralRewardConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    referrer_credits: coerceNonNegInt(
      r.referrer_credits,
      DEFAULT_REFERRAL_REWARD_CONFIG.referrer_credits,
    ),
    referred_credits: coerceNonNegInt(
      r.referred_credits,
      DEFAULT_REFERRAL_REWARD_CONFIG.referred_credits,
    ),
    qualification_window_days: coerceNonNegInt(
      r.qualification_window_days,
      DEFAULT_REFERRAL_REWARD_CONFIG.qualification_window_days,
    ),
    per_referrer_cap: coerceNonNegInt(
      r.per_referrer_cap,
      DEFAULT_REFERRAL_REWARD_CONFIG.per_referrer_cap,
    ),
    redeem_window_days: coerceNonNegInt(
      r.redeem_window_days,
      DEFAULT_REFERRAL_REWARD_CONFIG.redeem_window_days,
    ),
  };
}

export type RedeemRefusal = "account_too_old" | "already_paid" | "circular_referral";

/**
 * Why a referral code may not be redeemed by this caller, or null when it may.
 * Pure. The route reads the facts; this decides.
 *
 * - account_too_old: the account is older than redeem_window_days. A referral
 *   is for a NEW account; an old one typing a code is buying the signup bonus.
 * - already_paid: the caller has already bought credits, so the referral did
 *   not bring them in.
 * - circular_referral: the code's owner was referred by the caller. A-refers-B
 *   then B-refers-A pays both sides twice for one pair of accounts.
 */
export function redeemRefusal(args: {
  accountCreatedAt: string | null | undefined;
  nowMs: number;
  windowDays: number;
  hasPaidPurchase: boolean;
  circular: boolean;
}): RedeemRefusal | null {
  if (args.windowDays > 0 && args.accountCreatedAt) {
    const created = Date.parse(args.accountCreatedAt);
    if (Number.isFinite(created) && args.nowMs - created > args.windowDays * 86_400_000) {
      return "account_too_old";
    }
  }
  if (args.hasPaidPurchase) return "already_paid";
  if (args.circular) return "circular_referral";
  return null;
}

// US-1071: tiered/milestone rewards. A referrer earns these one-time BONUS
// credits (on top of the per-referral reward) when their granted-referral count
// crosses a threshold — a viral incentive to keep sharing. Kept here so the
// grant path (lib/referrals.ts), the user-facing /me endpoint, and the admin
// surface read the same tiers. Must stay sorted ascending by `threshold`.
export interface ReferralMilestone {
  threshold: number; // granted-referral count that unlocks the bonus
  bonus: number; // one-time bonus grade credits
}

export const REFERRAL_MILESTONES: ReferralMilestone[] = [
  { threshold: 5, bonus: 10 },
  { threshold: 10, bonus: 25 },
  { threshold: 25, bonus: 75 },
  { threshold: 50, bonus: 200 },
];

// Every milestone reached at `grantedCount` granted referrals (threshold ≤ count).
// Pure — unit-tested and reused by the idempotent grant path.
export function milestonesReached(grantedCount: number): ReferralMilestone[] {
  return REFERRAL_MILESTONES.filter((m) => grantedCount >= m.threshold);
}

// The next milestone a referrer is working toward, or null once all are earned.
// Drives the "X more referrals to your next bonus" progress UI.
export function nextMilestone(grantedCount: number): ReferralMilestone | null {
  return REFERRAL_MILESTONES.find((m) => grantedCount < m.threshold) ?? null;
}

// US-1070: referred-user SIGNUP incentive — the tangible welcome a referred new
// user gets the moment they redeem a ?ref= link, BEFORE any paid action. This is
// additive to (and distinct from) the qualification reward both parties get when
// the referral later qualifies (REFERRED_REWARD_CREDITS). It exists so the share
// is actually compelling at the point of signup.
//
// Admin-configurable without a deploy: the value is stored in `system_settings`
// under REFERRED_SIGNUP_INCENTIVE_SETTING_KEY (US-1069 layers a richer admin
// surface on top later). The shape is kept here in the leaf module — alongside
// the reward sizes — so the normalize/validate logic is unit-testable with no
// supabase import, and so the grant path + the (future) admin surface share one
// definition. `null` coupon = credits-only; a coupon id is a Stripe coupon
// (e.g. one created via admin-billing.ts) applied at the next subscription
// checkout for the "free month" incentive.
export interface ReferredSignupIncentive {
  enabled: boolean;
  bonus_credits: number; // grade credits granted immediately on redeem
  free_month_coupon_id: string | null; // Stripe coupon applied at next checkout
}

export const REFERRED_SIGNUP_INCENTIVE_SETTING_KEY = "referral.referred_signup_incentive";

// Out-of-box: a small welcome-credit bonus, no coupon. Operators tune it (or wire
// a free-month coupon) via system_settings; set bonus_credits=0 + coupon=null (or
// enabled=false) to turn the signup incentive off entirely.
export const DEFAULT_REFERRED_SIGNUP_INCENTIVE: ReferredSignupIncentive = {
  enabled: true,
  bonus_credits: 3,
  free_month_coupon_id: null,
};

// Coerce an untrusted stored/admin value (the jsonb from system_settings, which
// may be partial, wrongly-typed, or absent) into a safe, fully-populated config.
// Pure — unit-tested and shared by the grant path. An ABSENT field falls back to
// the default; a PRESENT-but-invalid field is coerced defensively (bad/negative
// credits → 0, a blank/non-string coupon → null) rather than silently restoring
// the default. Never throws.
export function normalizeReferredSignupIncentive(raw: unknown): ReferredSignupIncentive {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const enabled = typeof r.enabled === "boolean"
    ? r.enabled
    : DEFAULT_REFERRED_SIGNUP_INCENTIVE.enabled;

  let bonus_credits: number;
  if (r.bonus_credits === undefined) {
    bonus_credits = DEFAULT_REFERRED_SIGNUP_INCENTIVE.bonus_credits;
  } else if (typeof r.bonus_credits === "number" && Number.isFinite(r.bonus_credits)) {
    bonus_credits = Math.max(0, Math.floor(r.bonus_credits));
  } else {
    bonus_credits = 0;
  }

  let free_month_coupon_id: string | null;
  if (r.free_month_coupon_id === undefined) {
    free_month_coupon_id = DEFAULT_REFERRED_SIGNUP_INCENTIVE.free_month_coupon_id;
  } else if (typeof r.free_month_coupon_id === "string") {
    const trimmed = r.free_month_coupon_id.trim();
    free_month_coupon_id = trimmed.length > 0 ? trimmed : null;
  } else {
    free_month_coupon_id = null;
  }

  return { enabled, bonus_credits, free_month_coupon_id };
}

export interface ReferrerLeaderboardRow {
  /** Standard competition rank: tied sellers share it and the next one skips. */
  rank: number;
  /** True when another listed seller holds the same rank. */
  tied: boolean;
  display_name: string;
  referrals: number;
  credits_earned: number;
  // US-1784: a public /verified handle when this referrer is a verified seller
  // who has opted into the directory — the row links to their profile. Absent
  // for referrers who aren't publicly verified (privacy: alias-only stays alias).
  verified_handle?: string | null;
}

/** One referrer's rewarded referrals and the credits those actually paid. */
export interface ReferrerTotals {
  referrals: number;
  credits: number;
}

interface RankedReferrer extends ReferrerLeaderboardRow {
  userId: string;
}

// The full ranked set, user ids still attached. Internal: the public board
// strips the id, and /me uses it to find the caller's own rank.
function rankAllReferrers(
  users: Array<{ id: string; display_name: string; verified_handle?: string | null }>,
  totals: Map<string, ReferrerTotals>,
): RankedReferrer[] {
  const sorted = users
    .map((u) => {
      const t = totals.get(u.id);
      return {
        userId: u.id,
        display_name: u.display_name,
        referrals: t?.referrals ?? 0,
        credits_earned: t?.credits ?? 0,
        verified_handle: u.verified_handle ?? null,
      };
    })
    .filter((r) => r.referrals > 0)
    .sort((a, b) =>
      b.referrals - a.referrals ||
      b.credits_earned - a.credits_earned ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
    );

  const out: RankedReferrer[] = [];
  let rank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const prev = sorted[i - 1];
    if (!prev || prev.referrals !== r.referrals || prev.credits_earned !== r.credits_earned) {
      rank = i + 1;
    }
    const { verified_handle, ...rest } = r;
    out.push({
      ...rest,
      rank,
      tied: false,
      ...(verified_handle ? { verified_handle } : {}),
    });
  }
  const perRank = new Map<number, number>();
  for (const r of out) perRank.set(r.rank, (perRank.get(r.rank) ?? 0) + 1);
  for (const r of out) r.tied = (perRank.get(r.rank) ?? 0) > 1;
  return out;
}

// Pure ranking for the public top-referrers leaderboard (US-864). Takes the
// opted-in users (alias only — no PII) and each referrer's rewarded referrals
// plus the credits those grants really paid, and returns the board: rows with
// at least one rewarded referral, ranked by referrals, then credits, then user
// id (so two reads never disagree), with shared ranks for true ties, capped.
export function rankReferrers(
  users: Array<{ id: string; display_name: string; verified_handle?: string | null }>,
  totals: Map<string, ReferrerTotals>,
  limit = 100,
): ReferrerLeaderboardRow[] {
  return rankAllReferrers(users, totals)
    .slice(0, limit)
    .map(({ userId: _id, ...row }) => row);
}

/** The caller's rank over the FULL board, or null when they are not on it. */
export function referrerRank(
  users: Array<{ id: string; display_name: string }>,
  totals: Map<string, ReferrerTotals>,
  viewerId: string,
): { rank: number; tied: boolean } | null {
  const me = rankAllReferrers(users, totals).find((r) => r.userId === viewerId);
  return me ? { rank: me.rank, tied: me.tied } : null;
}

/** Sum rewarded referrals and their stored credits per referrer. Pure. */
export function referrerTotals(
  rows: ReadonlyArray<{ referrer_user_id: string; referrer_reward_credits: number | null }>,
): Map<string, ReferrerTotals> {
  const out = new Map<string, ReferrerTotals>();
  for (const r of rows) {
    const t = out.get(r.referrer_user_id) ?? { referrals: 0, credits: 0 };
    t.referrals += 1;
    const c = r.referrer_reward_credits;
    t.credits += typeof c === "number" && Number.isFinite(c) ? Math.max(0, c) : REFERRER_REWARD_CREDITS;
    out.set(r.referrer_user_id, t);
  }
  return out;
}

// ── What a referrer's rows actually mean ────────────────────────────────────

export interface ReferralLedgerRow {
  reward_status: string;
  referrer_reward_credits: number | null;
  created_at: string;
  qualified_at: string | null;
}

export type ReferralRowStatus = "rewarded" | "waiting" | "forfeit";
export type ReferralForfeitReason = "expired" | "over_cap";

export interface ClassifiedReferralRow {
  status: ReferralRowStatus;
  reason: ReferralForfeitReason | null;
  /** Credits this referral paid the referrer (0 unless rewarded). */
  credits: number;
  /** Last moment the friend can qualify, or null with no window. */
  qualify_by: string | null;
}

export interface ReferralSummary {
  granted: number;
  waiting: number;
  forfeit: number;
  /** Credits actually paid: each grant's stored amount, plus milestone bonuses. */
  earned: number;
  /** Credits the waiting referrals will pay at today's rate. */
  pending_credits: number;
}

/**
 * Classify ONE referral row. Pure.
 *
 * rewarded: granted. It pays what was stored at grant time, not today's rate,
 *   so a config change never restates what a seller already earned. A legacy
 *   row with no stored amount paid the historical REFERRER_REWARD_CREDITS.
 * forfeit: it can never pay. Pending or qualified past the qualification
 *   window ("expired"), or qualified once the referrer's granted count has
 *   reached the per-referrer cap ("over_cap").
 * waiting: everything else. Still inside the window and under the cap.
 */
export function classifyReferralRow(
  row: ReferralLedgerRow,
  config: ReferralRewardConfig,
  grantedCount: number,
  nowMs: number,
): ClassifiedReferralRow {
  const createdMs = Date.parse(row.created_at);
  const windowMs = config.qualification_window_days * 86_400_000;
  const qualifyBy = config.qualification_window_days > 0 && Number.isFinite(createdMs)
    ? new Date(createdMs + windowMs).toISOString()
    : null;

  if (row.reward_status === "granted") {
    const stored = row.referrer_reward_credits;
    const credits = typeof stored === "number" && Number.isFinite(stored)
      ? Math.max(0, stored)
      : REFERRER_REWARD_CREDITS;
    return { status: "rewarded", reason: null, credits, qualify_by: qualifyBy };
  }

  if (qualifyBy) {
    const qualifiedMs = row.qualified_at ? Date.parse(row.qualified_at) : NaN;
    // A qualified row is judged on WHEN it qualified; a pending one on now.
    const reachedMs = row.reward_status === "qualified" && Number.isFinite(qualifiedMs)
      ? qualifiedMs
      : nowMs;
    if (reachedMs - createdMs > windowMs) {
      return { status: "forfeit", reason: "expired", credits: 0, qualify_by: qualifyBy };
    }
  }

  if (
    row.reward_status === "qualified" &&
    config.per_referrer_cap > 0 &&
    grantedCount >= config.per_referrer_cap
  ) {
    return { status: "forfeit", reason: "over_cap", credits: 0, qualify_by: qualifyBy };
  }

  return { status: "waiting", reason: null, credits: 0, qualify_by: qualifyBy };
}

/** Fold a referrer's rows into the numbers the Share tab shows. Pure. */
export function classifyReferralRows(
  rows: ReadonlyArray<ReferralLedgerRow>,
  config: ReferralRewardConfig,
  nowMs: number,
  earnedBonusCredits = 0,
): ReferralSummary {
  const grantedCount = rows.filter((r) => r.reward_status === "granted").length;
  const out: ReferralSummary = { granted: 0, waiting: 0, forfeit: 0, earned: 0, pending_credits: 0 };
  for (const row of rows) {
    const c = classifyReferralRow(row, config, grantedCount, nowMs);
    if (c.status === "rewarded") {
      out.granted += 1;
      out.earned += c.credits;
    } else if (c.status === "forfeit") {
      out.forfeit += 1;
    } else {
      out.waiting += 1;
    }
  }
  out.earned += Math.max(0, earnedBonusCredits);
  out.pending_credits = out.waiting * config.referrer_credits;
  return out;
}
