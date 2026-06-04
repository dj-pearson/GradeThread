-- US-390: make the credit-pack grant idempotent on the Stripe object id.
--
-- grant_grade_credits previously ALWAYS inserted a ledger row + bumped the
-- balance, so a duplicate checkout.session.completed delivery (or any retry that
-- slipped past the idempotency claim) double-granted credits. The webhook claim
-- (processed_webhook_events) is now the authoritative, fail-closed dedup, but
-- the money side effect must ALSO be idempotent on the payment_intent as defense
-- in depth (US-390 AC).
--
-- Fix: under the existing FOR UPDATE row lock (which serializes concurrent
-- grants for the same user), short-circuit to the current balance if a
-- pack_purchase ledger row already exists for this payment_intent. The lock
-- guarantees the check-then-insert is race-free for a given user, and a
-- payment_intent maps to exactly one user. admin_grant / refund grants (which
-- may carry no payment_intent, or a non-pack one) are unaffected.

CREATE OR REPLACE FUNCTION public.grant_grade_credits(
  p_user_id                uuid,
  p_credits                integer,
  p_reason                 text,
  p_stripe_payment_intent  text DEFAULT NULL,
  p_notes                  text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
BEGIN
  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT: must be positive (got %)', p_credits;
  END IF;

  IF p_reason NOT IN ('pack_purchase', 'admin_grant', 'refund') THEN
    RAISE EXCEPTION 'INVALID_GRANT_REASON: %', p_reason;
  END IF;

  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  -- US-390: idempotency on the Stripe payment_intent for pack purchases. The
  -- FOR UPDATE lock above serializes same-user grants, so this check-then-insert
  -- can't race. A duplicate delivery returns the current balance unchanged.
  IF p_reason = 'pack_purchase' AND p_stripe_payment_intent IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.grade_credit_transactions
        WHERE stripe_payment_intent_id = p_stripe_payment_intent
          AND reason = 'pack_purchase'
    ) THEN
      RETURN v_balance; -- already granted for this payment — no-op
    END IF;
  END IF;

  v_balance := v_balance + p_credits;

  UPDATE public.users
    SET grade_credit_balance = v_balance,
        updated_at = now()
    WHERE id = p_user_id;

  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, stripe_payment_intent_id, notes)
    VALUES (p_user_id, p_credits, p_reason, v_balance, p_stripe_payment_intent, p_notes);

  RETURN v_balance;
END;
$$;
