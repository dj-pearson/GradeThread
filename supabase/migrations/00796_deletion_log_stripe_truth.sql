-- US-3404: make account_deletion_log.stripe_deleted mean something.
--
-- The admin erasure branch computed the result of the Stripe customer delete,
-- discarded it with `void stripeDeleted;`, and wrote the literal `false` into
-- this column. So the FORMAL erasure record -- the one a written request goes
-- through -- reported that the customer survived whether it survived or not.
--
-- The direction is the only thing that made it less bad than 00795's. That one
-- lied optimistically. This one lied pessimistically, so nobody was falsely
-- reassured, and a regulator asking "was my payment record removed" got a no
-- that means nothing.
--
-- A bare boolean also cannot say WHICH false: no customer existed, Stripe was
-- not configured in the container so nothing was attempted, or the call ran and
-- failed. Hence a status column with five values, of which `unverified` is the
-- default and the honest reading of every row that already exists.

ALTER TABLE public.account_deletion_log
  ADD COLUMN IF NOT EXISTS stripe_delete_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS stripe_delete_error text;

-- Validated on add (one row per erased account, so the scan is nothing) and
-- name-guarded so a re-run finds it and does nothing. There is no
-- ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'account_deletion_log_stripe_delete_status_check'
  ) THEN
    ALTER TABLE public.account_deletion_log
      ADD CONSTRAINT account_deletion_log_stripe_delete_status_check
      CHECK (stripe_delete_status IN ('no_customer', 'not_attempted', 'deleted', 'failed', 'unverified'));
  END IF;
END $$;

-- Find the rows whose Stripe claim was never checked:
--   select requested_at::date, source from public.account_deletion_log
--    where stripe_delete_status = 'unverified' order by requested_at;
CREATE INDEX IF NOT EXISTS idx_account_deletion_log_stripe_delete_status
  ON public.account_deletion_log(stripe_delete_status);

-- ── The historical rows, said where a reader of the table lands ──────────────
--
-- There is no backfill because there is nothing to backfill from. The answer
-- for every existing row is "nobody recorded it", and that is what the default
-- says. The column comment carries the part a status value cannot: that the
-- admin rows are not merely unrecorded, they are actively wrong.

COMMENT ON COLUMN public.account_deletion_log.stripe_deleted IS
  'US-3404: true ONLY when a Stripe customers.del call returned without '
  'throwing. READ THIS BEFORE CITING THE COLUMN ON AN OLDER ROW. Rows with '
  'source = ''admin'' written on or after 2026-08-16 all say false and the '
  'value is meaningless: routes/admin-compliance.ts computed the result, '
  'discarded it with a void, and inserted the literal false, so a customer '
  'that really was deleted is recorded here as surviving. Before that date the '
  'admin branch attempted no deletion at all, so false was correct by '
  'construction -- which is how the literal survived the review that added the '
  'delete. Rows with source = ''self_serve'' have always carried the computed '
  'value, but could not say WHY a false was false. Every row written before '
  '00796 is exactly the set with stripe_delete_status = ''unverified''.';

COMMENT ON COLUMN public.account_deletion_log.stripe_delete_status IS
  'US-3404: which of four things happened. deleted = the call succeeded. '
  'failed = the call was made and threw; stripe_delete_error says what it '
  'said. not_attempted = no STRIPE_SECRET_KEY in the container, so the '
  'customer was left standing at the processor. no_customer = the account '
  'never had one, which agrees with had_stripe_customer on the same row. '
  'unverified = nobody checked: a row written before 00796, or one whose '
  'writer omitted the column.';

COMMENT ON COLUMN public.account_deletion_log.stripe_delete_error IS
  'US-3404: NULL unless the teardown failed or was not attempted. Vendor text, '
  'capped at 300 characters, with anything email-shaped replaced by '
  '[redacted-email] before it is written -- 00064 promises this table holds no '
  'email, name or address, and that promise is ours to keep rather than '
  'Stripe''s. The customer id is not redacted: it is already its own column '
  '(00595) and is an opaque handle, not a person.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00796') ON CONFLICT DO NOTHING;
