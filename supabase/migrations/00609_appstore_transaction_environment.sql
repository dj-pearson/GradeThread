-- US-2286: stamp the store environment on each consumable credit grant.
--
-- 00559 marked the USER (users.billing_environment) and the Play purchase
-- table, and left appstore_processed_transactions unmarked because that table
-- is written ONLY through the SECURITY DEFINER RPC below — stamping it needs a
-- signature change, which is its own migration rather than a line in that one.
--
-- WHY IT MATTERS SEPARATELY FROM THE USER MARKER. The user column says what the
-- account's LAST purchase was. This table is the per-transaction record the AC5
-- audit reads: "which grants came from sandbox". Without the column every row
-- is unattributable, and that unattributable set grows with every sandbox
-- purchase until this lands.
--
-- NULL = pre-marker, exactly as 00559 chose, so nothing is backfilled and no
-- historical row is claimed to be something it is not. Same CHECK shape too.
--
-- DROP AND *THEN* CREATE OR REPLACE. Both halves are load-bearing and they
-- answer different questions.
--
-- The DROP is why this is not a bare CREATE OR REPLACE. Postgres identifies a
-- function by its argument list, so "replacing" it with an extra parameter
-- would leave BOTH versions and make an existing 5-argument call ambiguous.
-- Dropping the old 6-argument signature first is what stops that. The drop and
-- the create are in one migration, therefore one transaction, so there is no
-- window where the function is missing.
--
-- The OR REPLACE is why this file can be run twice (US-2837). On a second run
-- the DROP matches nothing, because the 6-argument signature is already gone,
-- and a bare CREATE then hits "function grant_appstore_credits already exists
-- with same argument types" and aborts the whole run. This was the only
-- CREATE FUNCTION in 658 migrations without OR REPLACE, and US-1108 rule 1
-- requires every migration to be safe to run twice. Measured, not reasoned:
-- applied twice in a row against the local stack, exit 0 both times.
--
-- Note the two are not in tension. The DROP removes a signature that no longer
-- exists after the first run; the OR REPLACE handles the one that does.
--
-- DEPLOY ORDER IS SAFE IN THE DOCUMENTED DIRECTION (migration, then edge). The
-- new parameter is defaulted, so the CURRENT edge — which passes five named
-- arguments — keeps resolving after this applies. The reverse order would fail,
-- which is the order the standing rule already forbids.

ALTER TABLE public.appstore_processed_transactions
  ADD COLUMN IF NOT EXISTS environment text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appstore_txn_environment_chk'
  ) THEN
    ALTER TABLE public.appstore_processed_transactions
      ADD CONSTRAINT appstore_txn_environment_chk
      CHECK (environment IS NULL
             OR environment IN ('production', 'sandbox'));
  END IF;
END $$;

COMMENT ON COLUMN public.appstore_processed_transactions.environment IS
  'US-2286: which App Store environment verified this transaction. NULL means '
  'the row predates the marker and CANNOT be classified from the database — see '
  'the story before reading a NULL as production.';

DROP FUNCTION IF EXISTS public.grant_appstore_credits(uuid, integer, text, text, text, text);

CREATE OR REPLACE FUNCTION public.grant_appstore_credits(
  p_user_id                 uuid,
  p_credits                 integer,
  p_transaction_id          text,
  p_original_transaction_id text,
  p_product_id              text,
  p_notes                   text DEFAULT NULL,
  p_environment             text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_claimed integer;
BEGIN
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
$$;

-- ⚠ DELIBERATELY NO REVOKE HERE, and that is not an oversight.
--
-- 00104 granted nothing explicitly, so this function has always carried the
-- default EXECUTE to PUBLIC. Tightening it looks obviously right and is
-- currently UNSAFE: US-2403 found that on this Postgres image a DENIED function
-- call from anon or authenticated SEGFAULTS the backend and restarts the whole
-- database, because supautils appends a GRANT hint to the error. That is why
-- 00527 — the bulk revoke across the schema — is parked as .BLOCKED.
--
-- Adding a revoke here would create exactly that crash surface on a route
-- reachable with the public anon key. The permission question belongs to
-- US-2282/US-2403 and lands with them, not smuggled into a column addition.

insert into public.applied_migrations (version) values ('00609') on conflict do nothing;
