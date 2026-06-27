-- 00321_google_play_billing.sql
--
-- Android backend dep (ANDROID_CONVERSION_PLAN.md): Google Play Billing
-- verification, the Android counterpart to the App Store verifier. The native
-- Android client reports a Play purchase; POST /api/payments/google/verify
-- validates the purchase token against the Google Play Developer API and flips
-- the SAME server-side plan/credit state the App Store + Stripe flows drive.
--
-- Two pieces of state:
--   1. google_processed_purchases — a one-row-per-consumable-purchase ledger
--      (purchase_token UNIQUE) so a replayed credit-pack purchase grants credits
--      exactly once (the Android analogue of appstore_processed_transactions).
--   2. users.google_purchase_token / google_product_id — the active Play
--      subscription's identifiers, so a later Real-time Developer Notification
--      (RTDN) webhook can reconcile renewals/cancellations to the right user.
--      billing_source already carries 'stripe'/'appstore'; Play sets 'googleplay'.
--
-- SECURITY: this ledger is written ONLY by the service-role edge (the verify
-- endpoint). Like appstore_processed_transactions, RLS is enabled with NO
-- policies (deny-all to anon/authenticated). Added to rls-guard's
-- SERVICE_ROLE_ONLY allowlist in the same change.
--
-- Idempotent (US-1108): IF NOT EXISTS everywhere + self-record footer.

CREATE TABLE IF NOT EXISTS public.google_processed_purchases (
  -- The Play purchase token — the idempotency key (one grant per purchase).
  purchase_token  text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  product_id      text NOT NULL,
  -- Credits granted for a consumable purchase (0 for a subscription row, though
  -- subscriptions don't write here — they update the users row instead).
  credits         integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  -- Google's order id, for support/reconciliation.
  order_id        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_processed_purchases_user
  ON public.google_processed_purchases (user_id);

COMMENT ON TABLE public.google_processed_purchases IS
  'Google Play consumable-purchase dedup ledger. One row per purchase_token so a '
  'replayed credit-pack purchase grants exactly once. Service-role only (RLS on, '
  'no policies) — the Android analogue of appstore_processed_transactions.';

ALTER TABLE public.google_processed_purchases ENABLE ROW LEVEL SECURITY;

-- Track the active Play subscription on the user (for RTDN renewal reconciliation).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS google_purchase_token text,
  ADD COLUMN IF NOT EXISTS google_product_id text;

COMMENT ON COLUMN public.users.google_purchase_token IS
  'Active Google Play subscription purchase token (billing_source=googleplay).';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00321') ON CONFLICT DO NOTHING;
