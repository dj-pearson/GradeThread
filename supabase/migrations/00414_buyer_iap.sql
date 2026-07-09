-- US-1804: buyer subscription via mobile IAP (App Store + Google Play).
--
-- A buyer can subscribe to Guard/Connoisseur through the native store. The
-- verification path (appstore.ts / google-play.ts) writes the SAME buyer_*
-- columns (00402) as the Stripe webhook, so entitlement resolution treats an
-- IAP-backed buyer sub identically (US-1800/1887). These columns add the
-- processor tag + store identifiers for the buyer product (mirroring the seller
-- billing_source / appstore_original_transaction_id / google_purchase_token),
-- so a renewal/expiry notification can reconcile by the store id and the buyer
-- Stripe checkout can refuse to double-bill an active store sub.
--
-- No IAP *mapping* table is needed — the product catalog is code
-- (lib/appstore/products.ts BUYER catalog + lib/google-play buyer catalog).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS buyer_billing_source text
    CHECK (buyer_billing_source IS NULL OR buyer_billing_source IN ('stripe', 'appstore', 'googleplay')),
  ADD COLUMN IF NOT EXISTS buyer_appstore_original_transaction_id text,
  ADD COLUMN IF NOT EXISTS buyer_appstore_product_id text,
  ADD COLUMN IF NOT EXISTS buyer_google_purchase_token text,
  ADD COLUMN IF NOT EXISTS buyer_google_product_id text;

-- Reconcile a store renewal/expiry notification back to the buyer by its store id.
CREATE INDEX IF NOT EXISTS idx_users_buyer_appstore_orig_txn
  ON public.users (buyer_appstore_original_transaction_id)
  WHERE buyer_appstore_original_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_buyer_google_token
  ON public.users (buyer_google_purchase_token)
  WHERE buyer_google_purchase_token IS NOT NULL;

COMMENT ON COLUMN public.users.buyer_billing_source IS
  'US-1804: which processor owns the buyer subscription (stripe/appstore/googleplay). Separate from the seller billing_source; both can differ.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00414')
ON CONFLICT (version) DO NOTHING;
