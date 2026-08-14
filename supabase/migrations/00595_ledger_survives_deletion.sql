-- US-2562: the credit ledger stops being collateral damage of account deletion.
--
-- THE DEFECT. `grade_credit_transactions.user_id` and
-- `flipdesk_subscription_events.user_id` are both `ON DELETE CASCADE` to
-- public.users (00037), and public.users cascades from auth.users. So
-- POST /api/account/delete -> auth.admin.deleteUser erases the entire financial
-- ledger for that account. The compliance row that survives
-- (public.account_deletion_log, 00064) records BOOLEANS — had_stripe_customer,
-- stripe_deleted, storage_purged — and no amounts, no payment intents, nothing
-- that could represent a charge.
--
-- WHY THAT MATTERS AT $2-3 PER GRADE. A card network dispute window runs to 120
-- days. A deletion inside that window leaves nothing to represent the charge
-- with, and "grade fifty items, delete the account, dispute the charges" is the
-- cheapest abuse path in the product. It is also the ordinary case: a customer
-- who leaves and then queries a charge is not attacking anything, and today we
-- cannot answer them either.
--
-- THE FIX IS TO STOP MOVING THE ROWS, NOT TO COPY THEM. A ledger that gets
-- archived elsewhere on deletion is two sources of truth that drift; a ledger
-- that simply is not deleted is one. Dropping the cascading foreign key leaves
-- every row exactly where it is, with its own primary key, its delta, its
-- balance_after, its idempotency_key and its stripe_payment_intent_id intact.
-- The append-only invariant that lib/credit-ledger.ts walks (a running SUM of
-- delta must equal balance_after on every row that records one) keeps holding,
-- because nothing about the rows changes.
--
-- submission_id gets the same treatment for the same reason: it is
-- `ON DELETE SET NULL` today, and submissions DO cascade with the user, so a
-- surviving charge row would lose the record of what it paid for at the exact
-- moment that record became the only thing worth having.
--
-- RETENTION BASIS. These rows carry no PII. user_id is a UUID that no longer
-- resolves to a person through any system we operate once auth.users is gone;
-- `notes` is generated text of the form "standard grade - 1 credit". They are
-- financial records kept under the legal-obligation carve-out to erasure, which
-- is the same basis account_deletion_log has stood on since 00064.
--
-- IDEMPOTENT: the FK drops are name-discovered rather than name-guessed, so
-- re-running finds nothing to drop and does nothing.

-- ── grade_credit_transactions: release both cascading links ───────────────
--
-- Discovered by COLUMN rather than by constraint name. The constraints were
-- created inline in 00037, so their names are Postgres defaults today
-- (grade_credit_transactions_user_id_fkey), but a hand-applied prod fix or a
-- future rename would make a hardcoded DROP silently no-op — which is the worst
-- outcome available here, since it would report success and leave the cascade in
-- place.
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'grade_credit_transactions'
       AND con.contype = 'f'
       AND con.conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = rel.oid AND attname = 'user_id')
           ]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.grade_credit_transactions DROP CONSTRAINT %I', v_name
    );
  END LOOP;
END $$;

DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'grade_credit_transactions'
       AND con.contype = 'f'
       AND con.conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = rel.oid AND attname = 'submission_id')
           ]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.grade_credit_transactions DROP CONSTRAINT %I', v_name
    );
  END LOOP;
END $$;

COMMENT ON COLUMN public.grade_credit_transactions.user_id IS
  'US-2562: the account this transaction belongs to. NOT a foreign key, '
  'deliberately — the ledger is a financial record and must survive the '
  'account deletion cascade. A user_id with no matching public.users row means '
  'the account was erased, not that the row is corrupt.';

COMMENT ON COLUMN public.grade_credit_transactions.submission_id IS
  'US-2562: the grade this transaction paid for. NOT a foreign key — see the '
  'note on user_id. Submissions cascade with the account; the record of what '
  'was charged must not.';

-- The user_id index used to come free with the FK's own lookups; with the
-- constraint gone, the admin ledger read (routes/admin-billing.ts) and the
-- invariant walk need one of their own. The composite from 00037 already covers
-- (user_id, created_at DESC), so this is belt-and-braces for the equality-only
-- path and is skipped if that index is chosen by the planner anyway.
CREATE INDEX IF NOT EXISTS idx_grade_credit_transactions_user_id
  ON public.grade_credit_transactions(user_id);

-- ── flipdesk_subscription_events: same release ────────────────────────────
--
-- The subscription audit trail answers "what plan were they on when they were
-- charged", which is the other half of a representment packet.
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'flipdesk_subscription_events'
       AND con.contype = 'f'
       AND con.conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = rel.oid AND attname = 'user_id')
           ]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.flipdesk_subscription_events DROP CONSTRAINT %I', v_name
    );
  END LOOP;
END $$;

COMMENT ON COLUMN public.flipdesk_subscription_events.user_id IS
  'US-2562: NOT a foreign key. The subscription audit trail survives account '
  'deletion for the same reason the credit ledger does.';

CREATE INDEX IF NOT EXISTS idx_flipdesk_subscription_events_user_id
  ON public.flipdesk_subscription_events(user_id);

-- ⚠ raw_payload ON THIS TABLE DOES CARRY PII. It is the verbatim Stripe object,
-- which includes customer email and billing address. Erasure must therefore
-- REDACT it rather than rely on the cascade that no longer exists. The edge
-- deletion path does that explicitly (US-2562), and this function is the single
-- implementation both the self-serve and admin paths call, so the two cannot
-- drift.
CREATE OR REPLACE FUNCTION public.redact_subscription_event_pii(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'redact_subscription_event_pii is service-role only';
  END IF;

  -- The AUDIT fields (event_type, from_plan, to_plan, stripe_event_id,
  -- created_at) stay. Only the verbatim payload goes, replaced with a marker
  -- so a reader can tell "redacted on erasure" from "never captured".
  UPDATE public.flipdesk_subscription_events
     SET raw_payload = jsonb_build_object(
           'redacted', true,
           'redacted_at', now(),
           'reason', 'account_erasure'
         )
   WHERE user_id = p_user_id
     AND raw_payload IS NOT NULL
     AND COALESCE(raw_payload->>'redacted', 'false') <> 'true';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.redact_subscription_event_pii(uuid) FROM public;
REVOKE ALL ON FUNCTION public.redact_subscription_event_pii(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.redact_subscription_event_pii(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.redact_subscription_event_pii(uuid) TO service_role;

COMMENT ON FUNCTION public.redact_subscription_event_pii(uuid) IS
  'US-2562: strip the verbatim Stripe payload from a user''s subscription '
  'events while keeping the audit fields. Called by the account-deletion path '
  'now that the cascade no longer removes these rows. Idempotent.';

-- ── account_deletion_log: make the retention PROVABLE ─────────────────────
--
-- "The ledger survived" is a claim until the deletion record carries the count
-- it survived with. had_stripe_customer was already a boolean standing in for
-- the id an auditor actually needs; now that the ledger persists, keeping the
-- customer id costs nothing extra in PII terms (it is an opaque Stripe handle,
-- not a person) and is the join key a representment starts from.
ALTER TABLE public.account_deletion_log
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS ledger_rows_retained integer,
  ADD COLUMN IF NOT EXISTS subscription_events_redacted integer;

COMMENT ON COLUMN public.account_deletion_log.stripe_customer_id IS
  'US-2562: the erased account''s Stripe customer id, kept as the join key for '
  'a dispute filed after deletion. An opaque handle, not PII.';
COMMENT ON COLUMN public.account_deletion_log.ledger_rows_retained IS
  'US-2562: how many grade_credit_transactions rows survived this deletion. '
  'NULL on rows written before 00595, when the answer was always zero.';
COMMENT ON COLUMN public.account_deletion_log.subscription_events_redacted IS
  'US-2562: how many flipdesk_subscription_events had raw_payload redacted.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00595') ON CONFLICT DO NOTHING;
