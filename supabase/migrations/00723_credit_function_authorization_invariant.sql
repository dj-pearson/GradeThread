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
