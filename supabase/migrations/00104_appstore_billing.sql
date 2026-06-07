-- iOS StoreKit 2 IAP: reconcile Apple in-app purchases into the SAME billing
-- columns the Stripe flow drives, so plan-gate and the rest of the app are
-- untouched. Additive only.
--
-- Subscriptions reuse processed_webhook_events for idempotency via
-- claimWebhookEvent('appstore', notificationUUID) — `provider` is free text, so
-- no DDL is needed for that. Consumable credit packs get a dedicated dedup table
-- + RPC so the claim + balance bump + ledger row are one atomic, race-free unit
-- (mirrors grant_grade_credits, migration 00092).

-- ── users: Apple billing identity + source ─────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS billing_source text;                       -- 'stripe' | 'appstore' | NULL
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS appstore_original_transaction_id text;     -- Apple subscription identity
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS appstore_product_id text;                  -- last-seen sub product (UI/debug)

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_billing_source_chk'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_billing_source_chk
      CHECK (billing_source IS NULL OR billing_source IN ('stripe', 'appstore'));
  END IF;
END $$;

-- One Apple subscription identity maps to exactly one user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_appstore_orig_txn
  ON public.users (appstore_original_transaction_id)
  WHERE appstore_original_transaction_id IS NOT NULL;

-- ── consumable dedup ledger ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.appstore_processed_transactions (
  transaction_id          text PRIMARY KEY,            -- Apple consumable transactionId
  original_transaction_id text NOT NULL,
  user_id                 uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  product_id              text NOT NULL,
  credits_granted         integer NOT NULL,
  processed_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appstore_txn_user
  ON public.appstore_processed_transactions(user_id);

-- Service-role only: enable RLS with no policies → deny-all to anon/auth
-- (the edge uses the service-role client, which bypasses RLS).
ALTER TABLE public.appstore_processed_transactions ENABLE ROW LEVEL SECURITY;

-- ── idempotent consumable credit grant ─────────────────────────────
-- Claim the transaction id, then (only on first claim) bump the balance + write
-- a unified ledger row (reason='pack_purchase', already in the CHECK set, so
-- /ledger and /billing-summary need no change). Idempotent: a duplicate
-- transaction_id no-ops and returns the current balance. Mirrors
-- grant_grade_credits (00092) but keyed on the Apple transaction id.
CREATE OR REPLACE FUNCTION public.grant_appstore_credits(
  p_user_id                 uuid,
  p_credits                 integer,
  p_transaction_id          text,
  p_original_transaction_id text,
  p_product_id              text,
  p_notes                   text DEFAULT NULL
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
    (transaction_id, original_transaction_id, user_id, product_id, credits_granted)
    VALUES (p_transaction_id, p_original_transaction_id, p_user_id, p_product_id, p_credits)
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
