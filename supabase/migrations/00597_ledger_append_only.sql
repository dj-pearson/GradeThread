-- US-2565: enforce append-only on the credit ledger in the database.
--
-- grade_credit_transactions has been append-only by CONVENTION since 00037.
-- Every writer only ever INSERTs — debit_grade_credits (00516),
-- grant_grade_credits (00092), revoke_grade_credits (00083), refund_grade
-- (00093) — and a sweep of every migration and every edge module found no
-- UPDATE and no DELETE against the table. Convention is exactly the right
-- amount of protection right up until the first admin route that "just fixes"
-- a row, and then it is none at all.
--
-- RLS IS NOT THE CONTROL HERE AND CANNOT BE. The table's only policy grants
-- users SELECT on their own rows, which reads like protection. But every route
-- in the edge service runs on the service-role client, and service_role bypasses
-- RLS entirely — so the whole application is already past that policy before it
-- touches a row. A trigger is not bypassed. It fires for service_role, for a
-- psql session, and for anything else that ever holds the connection.
--
-- ⚠ APPLY ORDER: this migration REQUIRES 00595. Until the cascading foreign key
-- on user_id is gone, account deletion deletes ledger rows, and a DELETE-blocking
-- trigger would abort every account deletion in the product. Files apply in
-- NNNNN order, so running the directory is safe; running this one alone is not.
--
-- Corrections stay possible; they just stop being invisible. A wrong debit is
-- reversed by INSERTing a compensating row (reason 'refund' or 'admin_grant'),
-- which is already what lib/credit-ledger.ts findLedgerInvariantViolation()
-- assumes when it walks the running sum of deltas against balance_after.

CREATE OR REPLACE FUNCTION public.reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'grade_credit_transactions is append-only: % is not permitted on row %. '
    'Reverse a transaction by INSERTing a compensating row (reason ''refund'' '
    'or ''admin_grant'') so the ledger keeps its history.',
    TG_OP, COALESCE(OLD.id::text, '?')
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION public.reject_ledger_mutation() IS
  'US-2565: append-only guard for the credit ledger. Raises on UPDATE and '
  'DELETE for every role, service_role included. Depends on 00595 having '
  'removed the cascading FK that used to delete these rows on account erasure.';

DROP TRIGGER IF EXISTS grade_credit_transactions_append_only
  ON public.grade_credit_transactions;
CREATE TRIGGER grade_credit_transactions_append_only
  BEFORE UPDATE OR DELETE ON public.grade_credit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.reject_ledger_mutation();

-- ── Proof, not just intent ────────────────────────────────────────────────
--
-- A guard nobody can see the state of gets quietly dropped during some future
-- incident and never restored. This reports whether the trigger is live, so the
-- admin ledger view and the ops health check can both assert it rather than
-- assume it.
CREATE OR REPLACE FUNCTION public.ledger_append_only_enforced()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM pg_trigger tg
      JOIN pg_class rel ON rel.oid = tg.tgrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'grade_credit_transactions'
       AND tg.tgname = 'grade_credit_transactions_append_only'
       AND NOT tg.tgisinternal
       AND tg.tgenabled <> 'D'
  );
$$;

GRANT EXECUTE ON FUNCTION public.ledger_append_only_enforced() TO service_role;

COMMENT ON FUNCTION public.ledger_append_only_enforced() IS
  'US-2565: true when the append-only trigger is present AND enabled. Read by '
  'the ops health check so "the ledger is immutable" is a measurement rather '
  'than a belief.';

-- US-1108: self-record so the edge schema-version boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00597') ON CONFLICT DO NOTHING;
