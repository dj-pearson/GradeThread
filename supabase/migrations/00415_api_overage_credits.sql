-- US-1792: B2B API overage credit packs (prepaid, never expire).
--
-- Beyond the monthly included quota (US-1791 api_keys.monthly_quota), an API
-- partner can prepay overage credits ($10/$50/$100/$200 packs, volume discount).
-- When a key exceeds its monthly quota, each further call draws down the OWNER's
-- api_credit_balance (atomic) instead of 429ing. Credits never expire.
--
-- Wallet lives in its OWN table (service-role writes only) so it never touches
-- the users self-update guard — mirrors buyer_meter_usage (00413). Cloned from
-- the grade-credit wallet (00037): a FOR UPDATE debit + an append-only ledger.

CREATE TABLE IF NOT EXISTS public.api_credit_wallet (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance     integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only ledger (running-sum == balance_after, like grade_credit_transactions).
CREATE TABLE IF NOT EXISTS public.api_credit_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delta              integer NOT NULL,
  reason             text NOT NULL,
  balance_after      integer NOT NULL,
  stripe_session_id  text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_credit_tx_user_created
  ON public.api_credit_transactions (user_id, created_at DESC);
-- Idempotency: one grant per Stripe session (a replayed checkout.completed grants once).
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_credit_tx_session
  ON public.api_credit_transactions (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

ALTER TABLE public.api_credit_wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_credit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own api credit wallet" ON public.api_credit_wallet;
CREATE POLICY "Users read own api credit wallet"
  ON public.api_credit_wallet FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users read own api credit transactions" ON public.api_credit_transactions;
CREATE POLICY "Users read own api credit transactions"
  ON public.api_credit_transactions FOR SELECT USING (auth.uid() = user_id);

-- Grant credits (Stripe overage-pack purchase). Idempotent on stripe_session_id:
-- a duplicate session is a no-op returning the current balance. Returns the new
-- balance.
CREATE OR REPLACE FUNCTION public.grant_api_credits(
  p_user_id uuid, p_credits int, p_reason text, p_session_id text, p_notes text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  IF p_credits <= 0 THEN
    SELECT balance INTO v_balance FROM public.api_credit_wallet WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;
  -- Already granted for this session? (idempotency)
  IF p_session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.api_credit_transactions WHERE stripe_session_id = p_session_id
  ) THEN
    SELECT balance INTO v_balance FROM public.api_credit_wallet WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;

  INSERT INTO public.api_credit_wallet(user_id, balance) VALUES (p_user_id, p_credits)
    ON CONFLICT (user_id) DO UPDATE SET balance = public.api_credit_wallet.balance + p_credits,
                                        updated_at = now()
    RETURNING balance INTO v_balance;

  INSERT INTO public.api_credit_transactions(user_id, delta, reason, balance_after, stripe_session_id, notes)
    VALUES (p_user_id, p_credits, p_reason, v_balance, p_session_id, p_notes);
  RETURN v_balance;
END;
$$;

-- Atomically debit `p_credits` (default 1) if the balance covers it. Returns the
-- new balance, or -1 when insufficient (caller then 429s).
CREATE OR REPLACE FUNCTION public.debit_api_credits(
  p_user_id uuid, p_credits int, p_notes text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  SELECT balance INTO v_balance FROM public.api_credit_wallet WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_balance < p_credits THEN
    RETURN -1;
  END IF;
  UPDATE public.api_credit_wallet SET balance = balance - p_credits, updated_at = now()
    WHERE user_id = p_user_id RETURNING balance INTO v_balance;
  INSERT INTO public.api_credit_transactions(user_id, delta, reason, balance_after, notes)
    VALUES (p_user_id, -p_credits, 'api_overage_debit', v_balance, p_notes);
  RETURN v_balance;
END;
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00415')
ON CONFLICT (version) DO NOTHING;
