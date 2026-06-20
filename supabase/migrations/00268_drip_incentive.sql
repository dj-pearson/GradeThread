-- US-942: Conversion incentive / promo integration for the trial-conversion
-- drip win-back.
--
-- When the autonomous drip engine (00267 / routes/drip.ts) sends an eligible
-- win-back step with the campaign incentive ON, it stashes a time-boxed Stripe
-- coupon on the recipient so their next subscription checkout pre-applies it
-- (one-click conversion, payments.ts). These two columns hold that pending
-- offer; the Stripe webhook clears them once the subscription is created
-- (one-time offer, mirrors `pending_referral_coupon` from 00236).
--
-- The incentive DEFINITION (enabled flag, coupon id, promo code, max-discount
-- guardrail, expiry window) lives on drip_campaigns.graph.incentive (jsonb, no
-- schema change — validated in drip-graph.ts) and is edited from the admin
-- builder. Redemption/ROI is tracked via the existing
-- drip_enrollments.incentive_enabled flag + drip_attributions (00253) — the
-- engine flips the flag when it surfaces the offer, so the incentive-lift
-- analytics already pick it up.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No RLS change — `users` already has its
-- policies; these columns are written by the service-role engine + webhook and
-- read by the checkout handler.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pending_drip_coupon text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pending_drip_coupon_expires_at timestamptz;

COMMENT ON COLUMN public.users.pending_drip_coupon IS
  'US-942: Stripe coupon id from a win-back drip incentive, pre-applied at the '
  'next subscription checkout. Cleared by the webhook on subscription.created.';
COMMENT ON COLUMN public.users.pending_drip_coupon_expires_at IS
  'US-942: time-box for pending_drip_coupon; checkout ignores it once expired.';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00268')
ON CONFLICT (version) DO NOTHING;
