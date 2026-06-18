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
}

export const REFERRAL_REWARD_CONFIG_SETTING_KEY = "referral.reward_config";

// Out-of-box economics: the historical 5/3 split, no window, no cap.
export const DEFAULT_REFERRAL_REWARD_CONFIG: ReferralRewardConfig = {
  referrer_credits: REFERRER_REWARD_CREDITS,
  referred_credits: REFERRED_REWARD_CREDITS,
  qualification_window_days: 0,
  per_referrer_cap: 0,
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
  };
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
  display_name: string;
  referrals: number;
  credits_earned: number;
}

// Pure ranking for the public top-referrers leaderboard (US-864). Takes the
// opted-in users (alias only — no PII) and a map of referrer-id → granted
// referral count, and returns the board: rows with at least one rewarded
// referral, ranked by count desc, capped. Unit-tested.
export function rankReferrers(
  users: Array<{ id: string; display_name: string }>,
  grantedCounts: Map<string, number>,
  limit = 100,
): ReferrerLeaderboardRow[] {
  return users
    .map((u) => {
      const referrals = grantedCounts.get(u.id) ?? 0;
      return {
        display_name: u.display_name,
        referrals,
        credits_earned: referrals * REFERRER_REWARD_CREDITS,
      };
    })
    .filter((r) => r.referrals > 0)
    .sort((a, b) => b.referrals - a.referrals)
    .slice(0, limit);
}
