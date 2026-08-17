-- US-2282: nine credit functions have NO authorization check at all.
--
-- This is the story's headline finding — "mint yourself unlimited grade
-- credits" — and it is the one that was DEMONSTRATED rather than reasoned:
-- an anonymous caller holding only the public anon key called
-- grant_grade_credits and moved a real balance 0 -> 999, then debit_grade_credits
-- took it to 998.
--
-- ── WHY THESE ARE DIFFERENT FROM 00611's SIX ────────────────────────────────
--
-- 00611 fixed functions whose guard was WRONG (it tested auth.uid(), which is
-- null for anon, so the check passed everyone through). These nine have no
-- guard whatsoever. They rely entirely on the GRANT — and the grant is the
-- CREATE FUNCTION default to PUBLIC, which every role is a member of. So the
-- protection was never there to be wrong.
--
--   grant_grade_credits         mints grading credits
--   debit_grade_credits         spends them
--   grant_api_credits           mints API credits
--   debit_api_credits           spends them
--   grant_appstore_credits      mints from an App Store purchase
--   grant_buyer_reward_credit   mints a buyer reward
--   issue_buyer_reward_credit   issues one
--   redeem_buyer_reward_credit  redeems one
--   refund_buyer_reward_credit  refunds one
--
-- ── EVERY CALLER IS THE SERVICE ROLE, CHECKED ONE BY ONE ────────────────────
--
--   grant_grade_credits         lib/referrals.ts                supabaseAdmin
--   debit_grade_credits         lib/grade-billing.ts:272        supabaseAdmin
--   grant_api_credits           routes/webhooks.ts              supabaseAdmin
--   debit_api_credits           middleware/api-key-auth.ts      supabaseAdmin
--   grant_appstore_credits      routes/appstore.ts              supabaseAdmin
--   grant_buyer_reward_credit   lib/buyer-guarantee-claim.ts    supabaseAdmin
--   issue_buyer_reward_credit   lib/buyer-rewards.ts            supabaseAdmin
--   redeem_buyer_reward_credit  lib/buyer-rewards.ts            supabaseAdmin
--   refund_buyer_reward_credit  lib/buyer-rewards.ts            supabaseAdmin
--
-- And NOTHING in the browser bundle calls any of them: a search of src/ for an
-- rpc() on any credit function returns nothing. So `service_role or admin` is
-- the true caller set, not a guess at it.
--
-- ── NOT INCLUDED, DELIBERATELY ──────────────────────────────────────────────
--
-- credit_ledger_reconciliation is the tenth credit function with no body guard
-- and is left alone: it is genuinely REVOKED from PUBLIC already (unlike these
-- nine, which rely on the default), and no caller could be found for it. Adding
-- a guard there would be risk without benefit.
--
-- admin_adjust_credits and revoke_grade_credits are also absent for the same
-- reason — 00216:143-144 revokes them `FROM PUBLIC, anon, authenticated`, which
-- is the form that actually works.
--
-- ── WHY AN ALLOWLIST AND NOT A REVOKE, ONCE MORE ────────────────────────────
--
-- A DENIED call from anon or authenticated SEGFAULTS this Postgres image
-- (US-2403), which is why 00527 is a permanent DO NOT APPLY — an owner
-- decision. And per US-2666 a `REVOKE … FROM anon` would be a no-op regardless,
-- because the PUBLIC grant survives it. A body check raises an ordinary error,
-- so it arms neither problem. Proven on production by 00610 and extended by
-- 00611.
--
-- Everything below is the live definition of each function with ONLY the guard
-- inserted after its own BEGIN. CREATE OR REPLACE, signatures untouched.

-- ── grant_grade_credits ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grant_grade_credits(p_user_id uuid, p_credits integer, p_reason text, p_stripe_payment_intent text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance integer;
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'grant_grade_credits: service role required' USING ERRCODE = '42501';
  END IF;

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
$function$;

-- ── debit_grade_credits ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.debit_grade_credits(p_user_id uuid, p_credits integer, p_submission_id uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance integer;
  v_existing integer;
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'debit_grade_credits: service role required' USING ERRCODE = '42501';
  END IF;

  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT: must be positive (got %)', p_credits;
  END IF;

  -- The row lock is what makes the check-then-act below safe: it serialises
  -- every debit for this user, so a concurrent retry waits here rather than
  -- racing past the duplicate check.
  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  -- US-2289: a replay of a charge that already happened is a NO-OP that
  -- reports success. Returning the current balance rather than raising is
  -- deliberate — the caller's intent ("this submission is paid for") is
  -- already satisfied, and an error here would make a harmless retry look
  -- like a billing failure and push the caller into a checkout it does not
  -- need.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT balance_after INTO v_existing
      FROM public.grade_credit_transactions
      WHERE idempotency_key = p_idempotency_key
      LIMIT 1;
    IF FOUND THEN
      RETURN v_balance;
    END IF;
  END IF;

  IF v_balance < p_credits THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: balance % < requested %', v_balance, p_credits;
  END IF;

  v_balance := v_balance - p_credits;

  UPDATE public.users
    SET grade_credit_balance = v_balance,
        updated_at = now()
    WHERE id = p_user_id;

  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, submission_id, notes, idempotency_key)
    VALUES (p_user_id, -p_credits, 'grade_debit', v_balance, p_submission_id, p_notes,
            p_idempotency_key);

  RETURN v_balance;
END;
$function$;

-- ── grant_api_credits ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grant_api_credits(p_user_id uuid, p_credits integer, p_reason text, p_session_id text, p_notes text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance int;
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'grant_api_credits: service role required' USING ERRCODE = '42501';
  END IF;

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
$function$;

-- ── debit_api_credits ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.debit_api_credits(p_user_id uuid, p_credits integer, p_notes text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance int;
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'debit_api_credits: service role required' USING ERRCODE = '42501';
  END IF;

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
$function$;

-- ── grant_appstore_credits ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grant_appstore_credits(p_user_id uuid, p_credits integer, p_transaction_id text, p_original_transaction_id text, p_product_id text, p_notes text DEFAULT NULL::text, p_environment text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance integer;
  v_claimed integer;
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'grant_appstore_credits: service role required' USING ERRCODE = '42501';
  END IF;

  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT: must be positive (got %)', p_credits;
  END IF;

  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  -- Claim the transaction id under the row lock; a duplicate delivery no-ops.
  INSERT INTO public.appstore_processed_transactions
    (transaction_id, original_transaction_id, user_id, product_id, credits_granted, environment)
    VALUES (p_transaction_id, p_original_transaction_id, p_user_id, p_product_id, p_credits, p_environment)
    ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN v_balance; -- already granted for this transaction — no-op
  END IF;

  v_balance := v_balance + p_credits;

  UPDATE public.users
    SET grade_credit_balance = v_balance,
        updated_at = now()
    WHERE id = p_user_id;

  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, notes)
    VALUES (p_user_id, p_credits, 'pack_purchase', v_balance,
            COALESCE(p_notes, 'App Store pack ' || p_transaction_id));

  RETURN v_balance;
END;
$function$;

-- ── grant_buyer_reward_credit ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grant_buyer_reward_credit(p_user_id uuid, p_reference_id text, p_credits integer, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'grant_buyer_reward_credit: service role required' USING ERRCODE = '42501';
  END IF;

  IF p_credits <= 0 THEN RETURN 0; END IF;

  INSERT INTO public.buyer_reward_credits(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.buyer_reward_credits WHERE user_id = p_user_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.buyer_reward_ledger
    WHERE user_id = p_user_id AND entry_type = 'earn' AND reference_id = p_reference_id
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, reference_id)
    VALUES (p_user_id, 'earn', p_credits, p_reason, p_reference_id);
  UPDATE public.buyer_reward_credits
    SET balance = balance + p_credits,
        lifetime_earned = lifetime_earned + p_credits,
        updated_at = now()
    WHERE user_id = p_user_id;
  RETURN p_credits;
END;
$function$;

-- ── issue_buyer_reward_credit ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_buyer_reward_credit(p_user_id uuid, p_reference_id text, p_credits integer, p_daily_cap integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today int;
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'issue_buyer_reward_credit: service role required' USING ERRCODE = '42501';
  END IF;

  IF p_credits <= 0 THEN RETURN 0; END IF;

  INSERT INTO public.buyer_reward_credits(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.buyer_reward_credits WHERE user_id = p_user_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.buyer_reward_ledger
    WHERE user_id = p_user_id AND entry_type = 'earn' AND reference_id = p_reference_id
  ) THEN
    RETURN 0;
  END IF;

  IF p_daily_cap > 0 THEN
    SELECT count(*) INTO v_today FROM public.buyer_reward_ledger
      WHERE user_id = p_user_id AND entry_type = 'earn'
        AND reason = 'grade_confirmation'
        AND created_at >= date_trunc('day', now());
    IF v_today >= p_daily_cap THEN RETURN 0; END IF;
  END IF;

  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, reference_id)
    VALUES (p_user_id, 'earn', p_credits, 'grade_confirmation', p_reference_id);
  UPDATE public.buyer_reward_credits
    SET balance = balance + p_credits,
        lifetime_earned = lifetime_earned + p_credits,
        updated_at = now()
    WHERE user_id = p_user_id;
  RETURN p_credits;
END;
$function$;

-- ── redeem_buyer_reward_credit ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_buyer_reward_credit(p_user_id uuid, p_meter text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance int;
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'redeem_buyer_reward_credit: service role required' USING ERRCODE = '42501';
  END IF;

  SELECT balance INTO v_balance FROM public.buyer_reward_credits
    WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_balance <= 0 THEN RETURN false; END IF;

  UPDATE public.buyer_reward_credits
    SET balance = balance - 1,
        lifetime_redeemed = lifetime_redeemed + 1,
        updated_at = now()
    WHERE user_id = p_user_id;
  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, meter, reference_id)
    VALUES (p_user_id, 'redeem', 1, 'meter_redemption', p_meter, gen_random_uuid()::text);
  RETURN true;
END;
$function$;

-- ── refund_buyer_reward_credit ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_buyer_reward_credit(p_user_id uuid, p_meter text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- US-2282: SERVER-ONLY. This function moves a money-like balance and had no
  -- authorization check of any kind — it relied on the grant, and the grant is
  -- the CREATE FUNCTION default to PUBLIC, which every role belongs to. An
  -- anonymous caller holding the public anon key could call it directly.
  --
  -- Allowlist, not a revoke: a DENIED call segfaults this Postgres image
  -- (US-2403), and a REVOKE naming only anon is a no-op anyway (US-2666).
  -- Every caller of this function is the edge's service-role client.
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'refund_buyer_reward_credit: service role required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.buyer_reward_credits(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.buyer_reward_credits
    SET balance = balance + 1,
        lifetime_redeemed = GREATEST(0, lifetime_redeemed - 1),
        updated_at = now()
    WHERE user_id = p_user_id;
  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, meter, reference_id)
    VALUES (p_user_id, 'reversal', 1, 'meter_refund', p_meter, gen_random_uuid()::text);
END;
$function$;

insert into public.applied_migrations (version) values ('00612') on conflict do nothing;
