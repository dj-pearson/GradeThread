-- US-398: make all credit-ledger writes balance-consistent.
--
-- Two ledger writes snapshotted balance_after from a NON-atomic read of
-- grade_credit_balance: the zero-delta 'included_grant' row in
-- runPaymentPrecedence() and the zero-delta 'refund' row in refund_grade()'s
-- included branch. A concurrent debit/grant between the read and the insert
-- made that snapshot a lie, so balance_after could drift from the real balance.
--
-- These rows are ZERO-DELTA audit rows — they don't change the balance — so the
-- correct fix (per the AC) is to make balance_after NULLABLE and write NULL for
-- them, rather than persist a possibly-stale number. Every balance-CHANGING
-- write already goes through a row-locking RPC (grant/debit/revoke_grade_credits
-- and refund_grade's credits branch) that computes balance_after under FOR
-- UPDATE, so the running balance_after stays truthful on the rows that matter.

ALTER TABLE public.grade_credit_transactions
  ALTER COLUMN balance_after DROP NOT NULL;
-- The existing CHECK (balance_after >= 0) is satisfied by NULL (a NULL CHECK is
-- treated as not-violated), so it continues to bound the non-null rows.

COMMENT ON COLUMN public.grade_credit_transactions.balance_after IS
  'US-398: balance immediately AFTER this transaction, computed atomically by '
  'the row-locking RPC that wrote it. NULL for zero-delta audit rows '
  '(included_grant / included refund), which do not change the balance.';

-- refund_grade: identical to 00048 except the included-refund branch now writes
-- balance_after = NULL (zero-delta audit row) instead of snapshotting a
-- non-atomic grade_credit_balance read.
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

    -- US-398: zero-delta audit row → balance_after NULL (balance unchanged;
    -- never snapshot a non-atomic read).
    INSERT INTO public.grade_credit_transactions
      (user_id, delta, reason, balance_after, submission_id, notes)
      VALUES (v_user_id, 0, 'refund', NULL, p_submission_id,
              'Included grade returned to monthly bundle (grading failed)');

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

-- US-398 reconciliation: prove SUM(delta) == grade_credit_balance for every
-- user. Returns ONLY the rows that drift (empty result = ledger is consistent),
-- so it doubles as a monitoring query. balance_after is excluded on purpose —
-- the invariant is over the deltas, which is what actually moves the balance.
CREATE OR REPLACE FUNCTION public.credit_ledger_reconciliation()
RETURNS TABLE (user_id uuid, ledger_sum bigint, balance integer, drift bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id,
         COALESCE(t.ledger_sum, 0) AS ledger_sum,
         u.grade_credit_balance     AS balance,
         COALESCE(t.ledger_sum, 0) - u.grade_credit_balance AS drift
    FROM public.users u
    LEFT JOIN (
      SELECT user_id, SUM(delta)::bigint AS ledger_sum
        FROM public.grade_credit_transactions
        GROUP BY user_id
    ) t ON t.user_id = u.id
   WHERE COALESCE(t.ledger_sum, 0) <> u.grade_credit_balance;
$$;

REVOKE ALL ON FUNCTION public.credit_ledger_reconciliation() FROM PUBLIC, anon, authenticated;
