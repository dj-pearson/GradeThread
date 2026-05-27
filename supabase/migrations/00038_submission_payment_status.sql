-- Submission payment status (US-207).
--
-- The grading pipeline must not run until a submission is paid for, but the
-- current schema has no way to track that — the webhook handler in 00037
-- references submissions.payment_status as if it existed. This adds it.
--
-- 'unpaid'         — created via /submit but no payment satisfied yet
-- 'included'       — covered by the FlipDesk tier's monthly bundle
-- 'credits'        — debited from grade_credit_balance
-- 'paid_stripe'    — one-time Stripe Checkout completed
--
-- All three "satisfied" states allow the grading pipeline to run. We keep
-- them distinct so the admin/billing views can show how a grade was paid for
-- (and to feed lifetime-value analytics).
--
-- Idempotent.

DO $$ BEGIN
  CREATE TYPE public.submission_payment_status AS ENUM (
    'unpaid', 'included', 'credits', 'paid_stripe'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS payment_status public.submission_payment_status
    NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

COMMENT ON COLUMN public.submissions.payment_status IS
  'How this submission was paid for. Set by /submit (included/credits) or the '
  'checkout.session.completed webhook (paid_stripe). Pipeline only runs when '
  'status is one of: included, credits, paid_stripe.';

-- Existing webhook handler stores the literal string 'paid'. Translate that
-- to 'paid_stripe' for backwards compatibility — once US-206's new webhook
-- code is deployed, the string 'paid' will no longer be written, but any
-- in-flight rows still need to be cleaned up.
UPDATE public.submissions
  SET payment_status = 'paid_stripe'
  WHERE payment_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_payment_status
  ON public.submissions(payment_status)
  WHERE payment_status = 'unpaid';
