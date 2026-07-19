-- US-2144: make the guarantee pool gate a transactional RESERVE.
--
-- The gate read pool state, decided, and only recorded the drawdown after the
-- claim insert. Two concurrent claims therefore evaluated against the same
-- pre-drawdown state and could both pass the same budget — the period budget and
-- the per-account cap were advisory under concurrency, which is precisely the
-- correlated-batch case they exist to bound.
--
-- This function checks and inserts under one advisory lock keyed on the period,
-- so the decision and the reservation cannot be separated. Idempotent per claim:
-- a retry finds its own drawdown and reports allowed, never double-reserving.
--
-- Rationale for the parked authenticity guarantee that motivated this:
-- vault/60-decisions/adr-authenticity-guarantee.md.

CREATE OR REPLACE FUNCTION public.reserve_guarantee_pool_drawdown(
  p_claim_id          text,
  p_account_user_id   uuid,
  p_amount_cents      integer,
  p_period            text,
  p_account_cap_cents integer,
  p_period_budget_cents integer,
  p_loss_ratio        numeric
)
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_drawn integer;
  v_period_drawn  integer;
  v_period_accrued integer;
  v_existing      integer;
BEGIN
  -- Serialize every reserve for this period. Without it the SELECTs below race
  -- exactly as the application code did.
  PERFORM pg_advisory_xact_lock(hashtext('guarantee_pool:' || p_period));

  -- Already reserved for this claim → allowed, no second row. Makes a retry
  -- after a timeout safe.
  SELECT count(*) INTO v_existing
  FROM public.guarantee_pool_ledger
  WHERE entry_type = 'drawdown' AND reference_id = p_claim_id;
  IF v_existing > 0 THEN
    RETURN QUERY SELECT true, 'already_reserved'::text;
    RETURN;
  END IF;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_account_drawn
  FROM public.guarantee_pool_ledger
  WHERE entry_type = 'drawdown' AND period = p_period
    AND account_user_id = p_account_user_id;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_period_drawn
  FROM public.guarantee_pool_ledger
  WHERE entry_type = 'drawdown' AND period = p_period;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_period_accrued
  FROM public.guarantee_pool_ledger
  WHERE entry_type = 'accrual' AND period = p_period;

  IF p_account_cap_cents > 0
     AND v_account_drawn + p_amount_cents > p_account_cap_cents THEN
    RETURN QUERY SELECT false, 'account_cap'::text;
    RETURN;
  END IF;

  IF p_period_budget_cents > 0
     AND v_period_drawn + p_amount_cents > p_period_budget_cents THEN
    RETURN QUERY SELECT false, 'period_budget'::text;
    RETURN;
  END IF;

  IF v_period_accrued > 0
     AND (v_period_drawn + p_amount_cents)::numeric / v_period_accrued > p_loss_ratio THEN
    RETURN QUERY SELECT false, 'loss_ratio'::text;
    RETURN;
  END IF;

  INSERT INTO public.guarantee_pool_ledger
    (entry_type, amount_cents, period, account_user_id, reference_id, reason)
  VALUES
    ('drawdown', p_amount_cents, p_period, p_account_user_id, p_claim_id, 'guarantee_remedy')
  ON CONFLICT (entry_type, reference_id) DO NOTHING;

  RETURN QUERY SELECT true, 'reserved'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_guarantee_pool_drawdown(
  text, uuid, integer, text, integer, integer, numeric) FROM public, anon, authenticated;

COMMENT ON FUNCTION public.reserve_guarantee_pool_drawdown(
  text, uuid, integer, text, integer, integer, numeric) IS
  'US-2144: atomically evaluate the guarantee pool caps AND record the drawdown '
  'under an advisory lock, so concurrent claims cannot both pass the same '
  'budget. Idempotent per claim id.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00490') on conflict do nothing;
