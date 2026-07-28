-- One-off: reset the Super Admin comp account that a stale test-mode Stripe
-- customer flipped to `starter`.
--
-- What this does, for DPearson@infomaxoffice.com ONLY:
--   • Nulls the stale test-mode Stripe linkage (cus_UbJBHJwrgkWYPB was a sandbox
--     customer that does not exist under the live keys — the source of the
--     "No such customer" billing-summary noise).
--   • Restores the comped `business` plan with no Stripe subscription behind it.
--   • Clears any pending plan change so it can't re-apply later.
--
-- billing_source is set NULL on purpose: this is a manual grant, not a Stripe/
-- App Store/Play purchase, so no processor "owns" it and the UI won't show a
-- "managed in the app" banner.
--
-- Run against PROD (self-hosted). Idempotent: safe to re-run.

BEGIN;

UPDATE public.users
SET
  stripe_customer_id            = NULL,
  flipdesk_subscription_id      = NULL,
  flipdesk_plan                 = 'business',
  flipdesk_interval             = NULL,
  subscription_status           = 'active',
  billing_source                = NULL,
  flipdesk_period_end           = NULL,
  flipdesk_pause_until          = NULL,
  flipdesk_cancel_at_period_end = FALSE,
  pending_flipdesk_plan         = NULL,
  pending_flipdesk_interval     = NULL,
  pending_effective_at          = NULL
WHERE lower(email) = 'dpearson@infomaxoffice.com';

-- Verify one row changed before committing.
COMMIT;
