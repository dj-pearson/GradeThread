-- US-1070: referral-triggered SIGNUP incentive (free month / welcome credits).
--
-- A referred new user should get something tangible the MOMENT they redeem a
-- ?ref= link — not only at their first paid action — so the share is actually
-- compelling. This adds the persistence the redeem path (lib/referrals.ts,
-- applyReferredSignupIncentive) and the checkout path (payments.ts) need:
--
--   1. referral_events.signup_incentive_*  — an idempotent record of what welcome
--      incentive was applied to a redemption (credits + optional Stripe coupon),
--      stamped under a CLAIM so a retry can't double-grant.
--   2. users.pending_referral_coupon       — a free-month Stripe coupon stashed at
--      redeem time and consumed at the user's next subscription checkout (cleared
--      by the customer.subscription.created webhook).
--   3. system_settings 'referral.referred_signup_incentive' — the admin-tunable
--      incentive config (enabled / bonus_credits / free_month_coupon_id), edited
--      via the existing settings registry with no deploy (US-1069 layers a richer
--      Incentives surface on top later).
--
-- Additive + idempotent (IF NOT EXISTS / on conflict do nothing) — safe to re-run.

BEGIN;

-- ── 1. Per-redemption incentive record (idempotent claim) ──────────────────
ALTER TABLE public.referral_events
  ADD COLUMN IF NOT EXISTS signup_incentive_credits    integer,
  ADD COLUMN IF NOT EXISTS signup_incentive_coupon     text,
  ADD COLUMN IF NOT EXISTS signup_incentive_applied_at timestamptz;

COMMENT ON COLUMN public.referral_events.signup_incentive_applied_at IS
  'US-1070: set (non-null) once the referred-user signup incentive has been '
  'applied for this redemption; the apply path claims on this being null so a '
  'retry never double-grants.';

-- ── 2. Pending free-month coupon for the referred user''s next checkout ─────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pending_referral_coupon text;

COMMENT ON COLUMN public.users.pending_referral_coupon IS
  'US-1070: Stripe coupon id from a referral signup incentive, applied as a '
  'discount at the next subscription checkout and cleared by the '
  'customer.subscription.created webhook (one-time free-month offer).';

-- ── 3. Admin-configurable signup-incentive economics ───────────────────────
-- on conflict do nothing so a manual override set before a re-run is preserved.
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'referral.referred_signup_incentive',
  jsonb_build_object('enabled', true, 'bonus_credits', 3, 'free_month_coupon_id', null),
  'json',
  jsonb_build_object('enabled', true, 'bonus_credits', 3, 'free_month_coupon_id', null),
  'referrals',
  'Welcome incentive applied to a referred new user the moment they redeem a ?ref= '
  'link. enabled toggles it; bonus_credits = grade credits granted immediately; '
  'free_month_coupon_id = optional Stripe coupon applied at their next subscription '
  'checkout for a free month. Set bonus_credits=0 + coupon=null (or enabled=false) to disable.'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
