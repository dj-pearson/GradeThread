-- US-1655: store affiliate money as INTEGER CENTS (float→cents migration).
--
-- affiliate_commissions.amount and affiliate_payouts.amount were numeric(10,2)
-- (dollars). roundCents() already mitigated binary-float drift at runtime, but
-- carrying the ledger as integer cents end-to-end makes drift structurally
-- impossible — cents are the same minor unit Stripe transfers.create expects,
-- so the engine (lib/affiliate-payout.ts) now carries cents straight through and
-- drops the *100 at the Stripe boundary.
--
-- This migration converts BOTH columns to integer and backfills every existing
-- row by *100 (round(amount * 100)). The CHECK (amount >= 0) and DEFAULT 0 carry
-- over unchanged (both valid for integer).
--
-- ⚠️ MONEY-TRANSFORMING + IDEMPOTENCY: a naive re-run of `USING round(amount*100)`
-- against an already-converted (integer) column would multiply by 100 AGAIN. The
-- conversion is therefore guarded on data_type='numeric' — once the column is
-- 'integer' the block is a no-op, so re-running the whole migrations directory
-- (scripts/apply-prod-migrations.sh does exactly that) is safe.
--
-- Client contract unchanged: the API still speaks USD dollars. routes/affiliate.ts
-- converts cents→dollars at the JSON boundary (referrals.tsx renders currency),
-- and the finance-agent feed (lib/agent-tools.ts) converts cents→dollars so its
-- dollar math stays consistent with consignor_payouts (still numeric dollars).
--
-- Idempotent (US-1108). Depends on 00310 (the affiliate tables).

BEGIN;

-- affiliate_commissions.amount: numeric(10,2) dollars → integer cents.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'affiliate_commissions'
      AND column_name = 'amount'
      AND data_type = 'numeric'
  ) THEN
    ALTER TABLE public.affiliate_commissions
      ALTER COLUMN amount DROP DEFAULT,
      ALTER COLUMN amount TYPE integer USING round(amount * 100)::integer,
      ALTER COLUMN amount SET DEFAULT 0;
  END IF;
END $$;

-- affiliate_payouts.amount: numeric(10,2) dollars → integer cents.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'affiliate_payouts'
      AND column_name = 'amount'
      AND data_type = 'numeric'
  ) THEN
    ALTER TABLE public.affiliate_payouts
      ALTER COLUMN amount DROP DEFAULT,
      ALTER COLUMN amount TYPE integer USING round(amount * 100)::integer,
      ALTER COLUMN amount SET DEFAULT 0;
  END IF;
END $$;

COMMENT ON COLUMN public.affiliate_commissions.amount IS
  'US-1655: commission amount in INTEGER CENTS (was numeric(10,2) dollars).';
COMMENT ON COLUMN public.affiliate_payouts.amount IS
  'US-1655: payout amount in INTEGER CENTS (was numeric(10,2) dollars); the minor unit Stripe transfers.create expects.';

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00375')
ON CONFLICT (version) DO NOTHING;
