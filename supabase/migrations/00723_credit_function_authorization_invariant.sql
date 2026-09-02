-- 00723_credit_function_authorization_invariant.sql
--
-- US-3094. The story asked for a REVOKE on eight credit functions. Do not add
-- one, and do not add one later either: the reason is below and it is an owner
-- decision, not a preference.
--
-- WHAT THE STORY EXPECTED, AND WHAT IS ACTUALLY TRUE. It read the prod census
-- as a DIVERGENCE -- "the revoke works locally and is not in effect on prod".
-- Measured on the throwaway stack 2026-09-02, the local ACL is IDENTICAL to the
-- prod one: anon holds EXECUTE on all eight and on neither of the two that
-- 00216 revoked. Nothing came back, because no revoke was ever written for
-- these eight anywhere. US-2282 shipped 00615, which put the authorization
-- check in the function BODY instead and says so at length; the 42501 recorded
-- in its closing note is that body raising, not an EXECUTE denial.
--
-- WHY A REVOKE IS THE WRONG FIX HERE. On this Postgres image a DENIED function
-- call from a role in supautils.hint_roles (anon, authenticated, service_role)
-- SEGFAULTS the backend and restarts the database while it builds the GRANT
-- hint (US-2403). anon is the key that ships in the browser bundle and
-- PostgREST exposes every one of these at /rpc/<name>, so a revoke would trade
-- a closed door for an unauthenticated restart button. That is why 00527 is
-- parked as .BLOCKED, why 00686 and 00720 each UNDID a revoke that shipped by
-- mistake, and why scripts/migrations-lint.mjs and
-- src/test/us2403-function-revoke-gate.test.ts both fail a new one.
--
-- SO THIS FREEZES THE POSTURE INSTEAD OF CHANGING IT. Every credit function is
-- either unreachable by anon or refuses anon in its own body. That invariant
-- holds today and nothing enforces it: CREATE OR REPLACE preserves an ACL but
-- DROP + CREATE resets it to the PUBLIC default, so one future migration that
-- re-creates one of these by dropping it re-opens the function and drops the
-- guard in the same breath, silently and green.
--
-- The assertion runs BEFORE the footer records the version, so under
-- ON_ERROR_STOP=1 a violation aborts the apply and records nothing.
--
-- Read-only and idempotent: it writes nothing but the footer.
-- The catalog gate that runs this same query in verify and CI is
-- scripts/check-credit-function-guards.mjs.

-- ---------------------------------------------------------------------------
-- REPAIR, ADDED 2026-09-02 AFTER THIS FILE FAILED ITS FIRST PROD APPLY.
--
-- The assertion below did exactly what it was built to do and refused the
-- apply, naming one offender:
--
--   grant_appstore_credits(uuid,integer,text,text,text,text,text)
--
-- That is PROD-ONLY DRIFT, and it is worth being precise about, because the
-- story this migration belongs to was filed on a wrong premise and this is the
-- one part of it that turned out to be real. Read from prod on 2026-09-02:
-- the function is SECURITY DEFINER, anon holds EXECUTE, prosrc is 1359 bytes
-- and contains NO auth.role() or gt_require_role check. The other seven
-- anon-reachable credit functions on prod all carry their guard, and the two
-- without one are not reachable by anon. So exactly one function on production
-- moves a money-like balance with no authorization check of any kind.
--
-- It is drift, not a missing migration. 00609 dropped the 6-argument form and
-- created the 7-argument one; 00615 then CREATE OR REPLACE'd that same
-- signature to add the guard. Both are recorded on prod IN THE RIGHT ORDER
-- (00609 2026-08-16 21:11 UTC, 00615 2026-08-17 16:39 UTC) and the parameter
-- NAMES match between them, so the replace could not have failed on a rename.
-- 00615 is recorded as applied and its effect on this one function is absent.
-- Whatever the cause, the database is the authority and it says the guard is
-- not there.
--
-- THE FIX IS A REPLACE, NEVER A DROP. CREATE OR REPLACE preserves the ACL, so
-- anon keeps EXECUTE and the US-2403 segfault stays disarmed. A DROP + CREATE
-- would reset the ACL to the PUBLIC default AND is the exact failure mode the
-- assertion below exists to catch.
--
-- The definition is copied byte-for-byte from 00615 (lines 288-347), with two
-- U+2014 em dashes in its comments replaced by hyphens so this file is pure
-- ASCII per CLAUDE.md. No executable line differs.
--
-- Idempotent: re-running replaces the function with the identical body. On any
-- database that already has the guard (every local stack built from the full
-- corpus does) this is a no-op that rewrites the same text.
-- ---------------------------------------------------------------------------

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
  -- authorization check of any kind - it relied on the grant, and the grant is
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
    RETURN v_balance; -- already granted for this transaction - no-op
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

DO $assert_00723$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO offenders
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.proname IN (
      'grant_grade_credits',
      'debit_grade_credits',
      'revoke_grade_credits',
      'admin_adjust_credits',
      'grant_appstore_credits',
      'grant_buyer_reward_credit',
      'issue_buyer_reward_credit',
      'redeem_buyer_reward_credit',
      'reserve_ai_action',
      'refund_ai_action'
    )
    -- Reachable with the public anon key ...
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    -- ... and carrying no authorization check of its own. Both shapes in use
    -- are accepted: the inline auth.role() test (00615, 00617) and the shared
    -- helper (00640). prosrc is the CATALOG body, so an overload that never got
    -- the guard is caught even when the migration text looks correct.
    AND p.prosrc NOT LIKE '%auth.role()%'
    AND p.prosrc NOT LIKE '%gt_require_role%';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'US-3094: credit function(s) reachable by anon with no authorization check in the body: %. Add the check to the BODY (see public.gt_require_role) -- do NOT take the EXECUTE grant away, which arms the US-2403 segfault.',
      offenders
      USING ERRCODE = 'check_violation';
  END IF;
END
$assert_00723$;

insert into public.applied_migrations (version) values ('00723') on conflict do nothing;
