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

-- US-3396: this line used to read "Verify one row changed before committing."
-- and the next line was a bare COMMIT. An instruction to a human, in a file a
-- human pastes into psql in one go, is not a check - the transaction committed
-- whether the UPDATE touched one row, zero rows, or the wrong row.
--
-- The verification is now the statement it was asking for. If the account is
-- not in the expected state the RAISE aborts the transaction, so the COMMIT
-- below can only commit a change that landed. Re-running still finds exactly
-- one row, so the file stays idempotent.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.users
  WHERE lower(email) = 'dpearson@infomaxoffice.com'
    AND flipdesk_plan = 'business'
    AND subscription_status = 'active'
    AND stripe_customer_id IS NULL
    AND flipdesk_subscription_id IS NULL
    AND pending_flipdesk_plan IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'reset-superadmin-comp-business: expected exactly 1 account in the reset state, found %. Rolling back.', n;
  END IF;
END
$$;

COMMIT;
