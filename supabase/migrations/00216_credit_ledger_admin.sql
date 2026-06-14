-- US-892: Credit ledger & refund/adjustment console.
--
-- Adds the DB primitives an operator needs to inspect any user's append-only
-- grade-credit ledger and issue an audited manual credit / debit / refund that
-- keeps users.grade_credit_balance consistent and NEVER mutates historical
-- rows. Two pieces:
--
--   1. A new 'correction' reason (signed admin adjustment that is neither a
--      pack purchase, an organic grade debit, nor a refund) + an idempotency_key
--      column so a retried money-moving operation can't double-apply.
--   2. admin_adjust_credits(): a row-locked, append-only, idempotent RPC that
--      applies an arbitrary SIGNED delta with reason in
--      (admin_grant | refund | correction), updating the wallet atomically.
--   3. revoke_grade_credits() gains an optional idempotency key so the
--      admin-initiated Stripe pack-refund flow and the charge.refunded webhook
--      converge on EXACTLY ONE ledger reversal (whichever runs first wins; the
--      other is a no-op). A NULL key preserves the legacy behaviour, so the
--      existing webhook + integration tests are unaffected.

-- ── (1) New reason + idempotency key ─────────────────────────────
ALTER TABLE public.grade_credit_transactions
  DROP CONSTRAINT IF EXISTS grade_credit_transactions_reason_check;
ALTER TABLE public.grade_credit_transactions
  ADD CONSTRAINT grade_credit_transactions_reason_check CHECK (reason IN (
    'pack_purchase',
    'grade_debit',
    'included_grant',
    'admin_grant',
    'refund',
    'expiration',
    'correction'
  ));

ALTER TABLE public.grade_credit_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Global uniqueness (across users) so a retry of a money-moving op can't write a
-- second row. Partial: the vast majority of rows carry no key (multiple NULLs
-- are always permitted by a partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS grade_credit_transactions_idempotency_key_key
  ON public.grade_credit_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.grade_credit_transactions.idempotency_key IS
  'US-892: optional dedupe key for money-moving operations (admin adjust, '
  'pack refund). A UNIQUE partial index guarantees at most one ledger row per '
  'key so a retry cannot double-apply. NULL for organic rows.';

-- ── (2) admin_adjust_credits: signed, atomic, append-only, idempotent ─
--
-- Applies p_delta (positive = credit, negative = debit) under a FOR UPDATE row
-- lock so it serialises with grant/debit/revoke for the same user. Rejects an
-- adjustment that would drive the balance negative (the balance CHECK forbids it
-- anyway). Writes exactly one new ledger row — never UPDATEs a historical row —
-- with a balance_after computed atomically inside the lock. Returns the new row
-- id + balance so the caller can audit-log the before/after.
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_user_id          uuid,
  p_delta            integer,
  p_reason           text,
  p_actor_id         uuid,
  p_notes            text DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance     integer;
  v_new_balance integer;
  v_existing    public.grade_credit_transactions%ROWTYPE;
  v_tx_id       uuid;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'INVALID_ADJUSTMENT: delta must be non-zero';
  END IF;

  IF p_reason NOT IN ('admin_grant', 'refund', 'correction') THEN
    RAISE EXCEPTION 'INVALID_ADJUST_REASON: % (allowed: admin_grant, refund, correction)', p_reason;
  END IF;

  -- Row lock so a concurrent debit/grant/revoke can't race this adjustment.
  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  -- Idempotency: a prior row already claimed this key → return it unchanged.
  -- Safe under the row lock (a key is tied to a single user) + the global UNIQUE
  -- index (cross-user safety / belt-and-suspenders).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM public.grade_credit_transactions
      WHERE idempotency_key = p_idempotency_key
      LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'idempotent_replay', true,
        'transaction_id', v_existing.id,
        'delta', v_existing.delta,
        'balance_after', COALESCE(v_existing.balance_after, v_balance)
      );
    END IF;
  END IF;

  v_new_balance := v_balance + p_delta;
  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: balance % cannot absorb delta %', v_balance, p_delta;
  END IF;

  UPDATE public.users
    SET grade_credit_balance = v_new_balance,
        updated_at = now()
    WHERE id = p_user_id;

  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, notes, idempotency_key)
    VALUES (
      p_user_id,
      p_delta,
      p_reason,
      v_new_balance,
      COALESCE(NULLIF(btrim(p_notes), ''), 'admin adjustment') ||
        format(' [admin %s]', p_actor_id::text),
      p_idempotency_key
    )
    RETURNING id INTO v_tx_id;

  RETURN jsonb_build_object(
    'idempotent_replay', false,
    'transaction_id', v_tx_id,
    'delta', p_delta,
    'balance_after', v_new_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, integer, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.admin_adjust_credits(uuid, integer, text, uuid, text, text) IS
  'US-892: row-locked, append-only, idempotent admin credit adjustment. Applies '
  'a signed delta (reason admin_grant|refund|correction), rejects a debit that '
  'would go negative, and records the acting admin id in the ledger notes. '
  'Never mutates historical rows.';

-- ── (3) revoke_grade_credits gains an optional idempotency key ───
--
-- Drop the 4-arg version and recreate with a 5th (defaulted) p_idempotency_key.
-- Callers that pass only the original 4 args resolve to this function with the
-- key defaulted to NULL → identical legacy behaviour. When a key IS supplied and
-- a row already carries it, the reversal is a no-op so the admin-initiated pack
-- refund and the charge.refunded webhook can't double-claw the wallet.
DROP FUNCTION IF EXISTS public.revoke_grade_credits(uuid, integer, text, text);

CREATE OR REPLACE FUNCTION public.revoke_grade_credits(
  p_user_id                uuid,
  p_credits                integer,
  p_stripe_payment_intent  text DEFAULT NULL,
  p_notes                  text DEFAULT NULL,
  p_idempotency_key        text DEFAULT NULL
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
  v_existing    public.grade_credit_transactions%ROWTYPE;
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

  -- US-892: idempotent reversal. If this key already wrote a row, return it
  -- unchanged (no second claw-back). The row lock serialises same-user callers;
  -- the UNIQUE index is the cross-user guard.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM public.grade_credit_transactions
      WHERE idempotency_key = p_idempotency_key
      LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'revoked', GREATEST(-v_existing.delta, 0),
        'shortfall', 0,
        'balance_after', COALESCE(v_existing.balance_after, v_balance),
        'idempotent_replay', true
      );
    END IF;
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
  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, stripe_payment_intent_id, notes, idempotency_key)
    VALUES (
      p_user_id,
      -v_revoked,
      'refund',
      v_new_balance,
      p_stripe_payment_intent,
      COALESCE(p_notes, 'Refund reversal') ||
        CASE WHEN v_shortfall > 0
             THEN format(' [reconcile: %s credit(s) already spent, not recovered]', v_shortfall)
             ELSE '' END,
      p_idempotency_key
    );

  RETURN jsonb_build_object(
    'revoked', v_revoked,
    'shortfall', v_shortfall,
    'balance_after', v_new_balance,
    'idempotent_replay', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_grade_credits(uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.revoke_grade_credits(uuid, integer, text, text, text) IS
  'US-384/US-892: row-locked credit-pack refund reversal. Debits the wallet '
  '(clamped at 0), writes a balance-consistent ledger row, and returns '
  '{revoked, shortfall, balance_after, idempotent_replay}. An optional '
  'idempotency key makes the admin pack-refund flow and the charge.refunded '
  'webhook converge on a single reversal.';
