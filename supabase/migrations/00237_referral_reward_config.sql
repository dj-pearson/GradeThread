-- US-1069: admin-configurable referral reward economics.
--
-- The per-referral credit sizes were hardcoded in code
-- (REFERRER_REWARD_CREDITS=5 / REFERRED_REWARD_CREDITS=3). This moves them — plus
-- a qualification window and a per-referrer reward cap — into the system_settings
-- registry so the operator tunes referral payout WITHOUT a deploy. The grant path
-- (lib/referrals.ts, grantReferralReward) reads this at grant time; the admin
-- Incentives surface edits it through the existing settings registry (super_admin
-- + MFA step-up + audit log).
--
-- The richer "free month / % off / welcome credits" levers already live in
-- 'referral.referred_signup_incentive' (migration 00236); the Incentives surface
-- presents both together.
--
-- Additive + idempotent (ON CONFLICT DO NOTHING) — safe to re-run; a manual
-- override set before a re-run is preserved.

BEGIN;

INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'referral.reward_config',
  jsonb_build_object(
    'referrer_credits', 5,
    'referred_credits', 3,
    'qualification_window_days', 0,
    'per_referrer_cap', 0
  ),
  'json',
  jsonb_build_object(
    'referrer_credits', 5,
    'referred_credits', 3,
    'qualification_window_days', 0,
    'per_referrer_cap', 0
  ),
  'referrals',
  'Referral reward economics, read at grant time. referrer_credits / referred_credits = '
  'grade credits each party earns per granted referral; qualification_window_days = the '
  'referred user must reach a first paid action within this many days of redeeming (0 = no '
  'window); per_referrer_cap = max granted referrals one referrer earns rewards for (0 = '
  'unlimited). Negative/invalid values are clamped to 0.'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
