-- Refund a grade when the AI pipeline fails after payment (US-268 follow-up).
--
-- runPaymentPrecedence() (grade.ts) and the FlipDesk grading path charge the
-- customer BEFORE the Claude Vision pipeline runs: an included grade bumps
-- grades_used_this_month, a credit grade debits grade_credit_balance, a
-- one-time purchase sets payment_status='paid_stripe'. When the pipeline then
-- throws (Anthropic outage, parse failure, etc.) the old code only set
-- status='failed' — the customer lost money/credits with no compensating
-- transaction. This RPC reverses the charge atomically and idempotently.
--
-- Idempotency: submissions.refunded_at is set under a row lock; a second call
-- returns 'already_refunded' without touching the balance.

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

COMMENT ON COLUMN public.submissions.refunded_at IS
  'Set by refund_grade() when a paid grade was reversed because the AI '
  'pipeline failed. Guards against double-refunds.';

CREATE OR REPLACE FUNCTION public.refund_grade(p_submission_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id         uuid;
  v_payment_status  public.submission_payment_status;
  v_already         boolean;
  v_credits         integer;
  v_balance         integer;
BEGIN
  -- Claim under a row lock so concurrent callers can't double-refund.
  SELECT user_id, payment_status, (refunded_at IS NOT NULL)
    INTO v_user_id, v_payment_status, v_already
    FROM public.submissions
    WHERE id = p_submission_id
    FOR UPDATE;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'SUBMISSION_NOT_FOUND: %', p_submission_id;
  END IF;

  IF v_already THEN
    RETURN 'already_refunded';
  END IF;

  IF v_payment_status = 'included' THEN
    -- Return the grade to the monthly bundle.
    UPDATE public.users
      SET grades_used_this_month = GREATEST(grades_used_this_month - 1, 0),
          updated_at = now()
      WHERE id = v_user_id;

    INSERT INTO public.grade_credit_transactions
      (user_id, delta, reason, balance_after, submission_id, notes)
      SELECT v_user_id, 0, 'refund', grade_credit_balance, p_submission_id,
             'Included grade returned to monthly bundle (grading failed)'
        FROM public.users WHERE id = v_user_id;

  ELSIF v_payment_status = 'credits' THEN
    -- Refund exactly what was debited for this submission.
    SELECT -delta INTO v_credits
      FROM public.grade_credit_transactions
      WHERE submission_id = p_submission_id AND reason = 'grade_debit'
      ORDER BY created_at DESC
      LIMIT 1;

    IF v_credits IS NOT NULL AND v_credits > 0 THEN
      SELECT grade_credit_balance INTO v_balance
        FROM public.users WHERE id = v_user_id FOR UPDATE;

      v_balance := v_balance + v_credits;

      UPDATE public.users
        SET grade_credit_balance = v_balance, updated_at = now()
        WHERE id = v_user_id;

      INSERT INTO public.grade_credit_transactions
        (user_id, delta, reason, balance_after, submission_id, notes)
        VALUES (v_user_id, v_credits, 'refund', v_balance, p_submission_id,
                v_credits || ' credit(s) refunded (grading failed)');
    END IF;

  ELSE
    -- 'unpaid' (nothing charged) or 'paid_stripe' (real money — must be
    -- refunded through Stripe, not by minting credits). Caller logs the
    -- paid_stripe case so an admin can issue the Stripe refund manually.
    RETURN 'no_refund_' || v_payment_status::text;
  END IF;

  UPDATE public.submissions
    SET refunded_at = now()
    WHERE id = p_submission_id;

  RETURN 'refunded_' || v_payment_status::text;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_grade(uuid) FROM PUBLIC, anon, authenticated;
