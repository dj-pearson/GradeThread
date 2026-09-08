-- US-3138: behavioral proof for migration 00763 (Action Credits).
--
-- Runs entirely inside a transaction that ROLLS BACK, so it is safe against any
-- database the schema is on, including prod. It creates one throwaway auth user
-- and exercises every branch of the reserve/refund/grant/debit/clawback path.
--
-- Run it against the local stack:
--   docker exec -i supabase_db_gradethread psql -U postgres -d postgres --     -v ON_ERROR_STOP=1 < scripts/prove-action-credits.sql
--
-- Expected, in order: allowance/allowance/exhausted; a funded wallet turns the
-- third into 'credits'; the refund goes back to the WALLET while credit-paid
-- actions remain and to the COUNTER afterwards; p_allow_credits=false and
-- limit=-1 both leave the wallet untouched; the legacy 2-arg call still returns
-- a boolean; grant and clawback are idempotent; clawback clamps at zero; the
-- ledger running sum matches balance_after on every row; and a month rollover
-- zeroes both counters.

BEGIN;
\set QUIET on
\set u '\'11111111-1111-1111-1111-111111111111\''
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
  VALUES (:u::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated','authenticated',
          'ac-test@example.com','x', now(), now());
-- public.users is auto-created by the handle_new_user() trigger.
UPDATE public.users SET ai_actions_used_this_month = 0, ai_actions_credit_paid_this_month = 0,
       ai_actions_reset_at = now(), flipdesk_plan = 'starter' WHERE id = :u::uuid;
\set QUIET off

\echo '--- 1. allowance first: limit 2 gives allowance,allowance then exhausted (empty wallet)'
SELECT public.reserve_ai_action_v2(:u::uuid, 2) AS r1,
       public.reserve_ai_action_v2(:u::uuid, 2) AS r2,
       public.reserve_ai_action_v2(:u::uuid, 2) AS r3;

\echo '--- 2. fund the wallet with 3, then the same call pays with credits'
SELECT public.grant_action_credits(:u::uuid, 3, 'purchase','stripe','cs_test_1','pack 50') AS balance;
SELECT public.reserve_ai_action_v2(:u::uuid, 2) AS r4;
SELECT balance FROM public.action_credit_wallet WHERE user_id = :u::uuid;
SELECT ai_actions_used_this_month AS used, ai_actions_credit_paid_this_month AS credit_paid
  FROM public.users WHERE id = :u::uuid;

\echo '--- 3. refund routes BACK TO THE WALLET, not the counter'
SELECT public.refund_ai_action(:u::uuid);
SELECT (SELECT balance FROM public.action_credit_wallet WHERE user_id=:u::uuid) AS wallet,
       ai_actions_used_this_month AS used, ai_actions_credit_paid_this_month AS credit_paid
  FROM public.users WHERE id = :u::uuid;

\echo '--- 4. with no credit-paid actions left, refund goes to the counter'
SELECT public.refund_ai_action(:u::uuid);
SELECT (SELECT balance FROM public.action_credit_wallet WHERE user_id=:u::uuid) AS wallet,
       ai_actions_used_this_month AS used FROM public.users WHERE id = :u::uuid;

\echo '--- 5. p_allow_credits=false refuses WITHOUT touching the funded wallet'
UPDATE public.users SET ai_actions_used_this_month = 2 WHERE id = :u::uuid;
SELECT public.reserve_ai_action_v2(:u::uuid, 2, false) AS r5;
SELECT balance AS wallet_untouched FROM public.action_credit_wallet WHERE user_id = :u::uuid;

\echo '--- 6. limit -1 (unlimited) never touches the wallet'
SELECT public.reserve_ai_action_v2(:u::uuid, -1) AS r6;
SELECT balance AS wallet_untouched FROM public.action_credit_wallet WHERE user_id = :u::uuid;

\echo '--- 7. the 2-arg legacy signature still returns boolean'
UPDATE public.users SET ai_actions_used_this_month = 0 WHERE id = :u::uuid;
SELECT public.reserve_ai_action(:u::uuid, 5) AS legacy_true;

\echo '--- 8. grant is idempotent on (source, external_id)'
SELECT public.grant_action_credits(:u::uuid, 50, 'purchase','stripe','cs_test_1','replay') AS replayed_balance;

\echo '--- 9. clawback clamps at zero and is idempotent'
SELECT public.clawback_action_credits(:u::uuid, 999, 'stripe','cs_test_1','refunded') AS after_clawback;
SELECT public.clawback_action_credits(:u::uuid, 999, 'stripe','cs_test_1','replay') AS clawback_replayed;

\echo '--- 10. ledger invariant: running SUM(delta) == balance_after on every row'
SELECT bool_and(running = balance_after) AS ledger_consistent, count(*) AS rows
FROM (SELECT balance_after, sum(delta) OVER (ORDER BY seq) AS running
      FROM public.action_credit_transactions WHERE user_id = :u::uuid) t;

\echo '--- 11. month rollover zeroes BOTH counters'
UPDATE public.users SET ai_actions_used_this_month = 9, ai_actions_credit_paid_this_month = 4,
       ai_actions_reset_at = now() - interval '2 months' WHERE id = :u::uuid;
SELECT public.reserve_ai_action_v2(:u::uuid, 2) AS r11;
SELECT ai_actions_used_this_month AS used, ai_actions_credit_paid_this_month AS credit_paid
  FROM public.users WHERE id = :u::uuid;
ROLLBACK;
