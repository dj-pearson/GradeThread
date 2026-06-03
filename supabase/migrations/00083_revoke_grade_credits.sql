-- US-384: Fix credit-pack refund to actually debit the wallet.
--
-- Bug: webhooks.ts handleChargeRefunded inserted a ledger row (delta=-credits,
-- balance_after:0) but NEVER touched users.grade_credit_balance — so a refunded
-- customer kept every credit, and the ledger's balance_after was a lie (0).
--
-- Fix: a row-locked SECURITY DEFINER RPC that mirrors debit/grant_grade_credits.
-- It claws back as many credits as the wallet still holds, clamps at zero (the
-- balance CHECK forbids negative), and records the shortfall — credits already
-- spent before the refund — for ops reconciliation instead of silently
-- succeeding or silently failing.

CREATE OR REPLACE FUNCTION public.revoke_grade_credits(
  p_user_id                uuid,
  p_credits                integer,
  p_stripe_payment_intent  text DEFAULT NULL,
  p_notes                  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance     integer;
  v_revoked     integer;
  v_shortfall   integer;
  v_new_balance integer;
BEGIN
  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT: must be positive (got %)', p_credits;
  END IF;

  -- Row lock so a concurrent debit/grant can't race the reversal.
  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  -- Recover only what's left; the rest was already spent and can't be clawed
  -- back without pushing the balance negative (blocked by the CHECK anyway).
  v_revoked     := LEAST(v_balance, p_credits);
  v_shortfall   := p_credits - v_revoked;
  v_new_balance := v_balance - v_revoked;

  UPDATE public.users
    SET grade_credit_balance = v_new_balance,
        updated_at = now()
    WHERE id = p_user_id;

  -- Always write a ledger row (even when v_revoked = 0) so a fully-spent pack's
  -- refund leaves an auditable trail with the shortfall, not a silent no-op.
  -- delta = credits actually clawed back, keeping the running ledger balance
  -- (balance_after) consistent with users.grade_credit_balance.
  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, stripe_payment_intent_id, notes)
    VALUES (
      p_user_id,
      -v_revoked,
      'refund',
      v_new_balance,
      p_stripe_payment_intent,
      COALESCE(p_notes, 'Refund reversal') ||
        CASE WHEN v_shortfall > 0
             THEN format(' [reconcile: %s credit(s) already spent, not recovered]', v_shortfall)
             ELSE '' END
    );

  RETURN jsonb_build_object(
    'revoked', v_revoked,
    'shortfall', v_shortfall,
    'balance_after', v_new_balance
  );
END;
$$;

COMMENT ON FUNCTION public.revoke_grade_credits(uuid, integer, text, text) IS
  'US-384: row-locked credit-pack refund reversal. Debits the wallet (clamped '
  'at 0), writes a balance-consistent ledger row, and returns '
  '{revoked, shortfall, balance_after} so the caller can flag spent-credit '
  'shortfalls for reconciliation.';
