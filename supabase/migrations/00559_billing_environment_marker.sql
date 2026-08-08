-- US-2286: mark WHICH store environment produced an in-app-purchase grant.
--
-- Apple's verifier falls back Production -> Sandbox and that fallback is
-- correct and stays: App Review always exercises IAP in the sandbox, even
-- against a Production build, so refusing Sandbox JWS fails review. The defect
-- is that the resulting grant carried no marker, so a sandbox-granted plan was
-- byte-identical on the users row to one somebody paid for -- indistinguishable
-- in revenue reporting, plan-distribution metrics, the expiry sweeps, and any
-- manual "why is this account on Pro" investigation. Google has the same gap
-- via licence-tester purchases (subscriptionsv2 testPurchase, products
-- purchaseType=0), which both response parsers were dropping at parse time.
--
-- NULLABLE WITH NO DEFAULT AND NO BACKFILL, deliberately. Three states, not
-- two: 'production', 'sandbox', and NULL meaning "granted before the marker
-- existed". Defaulting the past to 'production' would assert something no one
-- verified; defaulting it to 'sandbox' would zero out historical MRR the first
-- time a revenue query used it. lib/billing-environment.ts countsAsRevenue()
-- treats NULL as revenue (the overwhelming majority of historical grants are
-- real), and the sandbox grants hiding in that history are found by the AC5
-- prod audit rather than guessed at here.
--
-- Text + CHECK rather than a boolean is_sandbox, matching the in-repo
-- precedent at 00375 (push_device_tokens.environment), so a third value stays
-- addable without a column rename.

-- ── users: the seller and buyer entitlement families ────────────────
-- Two columns because they are two independent entitlements: a user can hold a
-- paid seller plan and a sandbox buyer plan at once, and one shared column
-- could not describe that.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS billing_environment text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS buyer_billing_environment text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_billing_environment_chk'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_billing_environment_chk
      CHECK (billing_environment IS NULL
             OR billing_environment IN ('production', 'sandbox'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_buyer_billing_environment_chk'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_buyer_billing_environment_chk
      CHECK (buyer_billing_environment IS NULL
             OR buyer_billing_environment IN ('production', 'sandbox'));
  END IF;
END $$;

COMMENT ON COLUMN public.users.billing_environment IS
  'US-2286: store environment that produced the seller entitlement '
  '(production/sandbox). NULL = granted before the marker existed; treated as '
  'revenue by countsAsRevenue(). Sandbox grants must be excluded from MRR/ARPU '
  'and plan-distribution reporting.';

COMMENT ON COLUMN public.users.buyer_billing_environment IS
  'US-2286: as billing_environment, for the buyer_* entitlement family.';

-- Partial indexes: every consumer of these columns is looking for the rare
-- sandbox rows (revenue exclusion, the AC5 audit), never for the common
-- production ones, so indexing only the sandbox side keeps them small.
CREATE INDEX IF NOT EXISTS idx_users_billing_environment_sandbox
  ON public.users (billing_environment)
  WHERE billing_environment = 'sandbox';

CREATE INDEX IF NOT EXISTS idx_users_buyer_billing_environment_sandbox
  ON public.users (buyer_billing_environment)
  WHERE buyer_billing_environment = 'sandbox';

-- ── google_processed_purchases: the consumable ledger ───────────────
-- Credits bought by a licence tester are as unreal as a tester's subscription.
-- This ledger is written directly over PostREST (routes/google-play.ts), so a
-- plain column is all it takes. The Apple analogue
-- (appstore_processed_transactions) is written only through the SECURITY
-- DEFINER RPC grant_appstore_credits, so stamping it needs a signature change
-- and is deliberately NOT bundled here -- see the story notes.
ALTER TABLE public.google_processed_purchases
  ADD COLUMN IF NOT EXISTS environment text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'google_processed_purchases_environment_chk'
  ) THEN
    ALTER TABLE public.google_processed_purchases
      ADD CONSTRAINT google_processed_purchases_environment_chk
      CHECK (environment IS NULL OR environment IN ('production', 'sandbox'));
  END IF;
END $$;

COMMENT ON COLUMN public.google_processed_purchases.environment IS
  'US-2286: production/sandbox, from the Play response purchaseType/testPurchase. '
  'NULL = recorded before the marker existed.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00559')
ON CONFLICT (version) DO NOTHING;
