-- US-3015: EasyPost as the second shipping-label provider.
--
-- Two concerns.
--
-- easypost_accounts maps a seller to their EasyPost REFERRAL CUSTOMER. The
-- seller's own card is on file at EasyPost and EasyPost charges them for
-- postage, so this table holds a pointer and a key, never money and never a
-- balance. The key is AES-256-GCM ciphertext bound to the owner (lib/crypto-aes
-- v2, AAD = owner id), the same treatment marketplace tokens have had since
-- US-352. Deny-all RLS: only the edge's service-role client touches it, and a
-- readable row is a usable postage-spending credential.
--
-- sales.label_provider + sales.easypost_shipment_id record WHICH provider
-- bought a label and its id there. Existing eBay purchases keep using
-- sales.ebay_shipment_id (00509) untouched; label_provider is backfilled for
-- them so a reprint years from now knows which API to call rather than guessing
-- from which id column is populated. As on the eBay side the label URL is
-- deliberately NOT stored -- EasyPost's label URLs expire, so a reprint
-- re-reads the shipment.
--
-- The label price still lands in the EXISTING sales.shipping_cost (00008), so
-- Finances and the per-item P&L need no change and carry no provider branch.

CREATE TABLE IF NOT EXISTS public.easypost_accounts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  easypost_user_id            text NOT NULL,
  api_key_encrypted           text,
  payment_method_verified_at  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id)
);

COMMENT ON TABLE public.easypost_accounts IS
  'US-3015: one EasyPost referral customer per seller. Holds a pointer and an encrypted API key only -- no balance, no postage float; EasyPost charges the seller directly.';
COMMENT ON COLUMN public.easypost_accounts.api_key_encrypted IS
  'US-3015: the referral customer''s production API key, AES-256-GCM v2 with the owner id as AAD. Returned by EasyPost once at creation and never shown to a client.';
COMMENT ON COLUMN public.easypost_accounts.payment_method_verified_at IS
  'US-3015: when EasyPost last confirmed a payment method on this account. Null means onboarding is unfinished, which renders as a prompt rather than a failed purchase.';

CREATE INDEX IF NOT EXISTS idx_easypost_accounts_easypost_user_id
  ON public.easypost_accounts (easypost_user_id);

ALTER TABLE public.easypost_accounts ENABLE ROW LEVEL SECURITY;
-- Deny-all in both directions, and NO policy in either -- the same shape as
-- 00808. A readable row is a credential that spends postage; a writable one
-- lets a caller point a seller's labels at an account they control. The seller
-- reaches their own status through an owner-scoped edge route that returns a
-- boolean and never the ciphertext, so a policy here would only add a second
-- path to the same rows with its own drift. Registered in SERVICE_ROLE_ONLY in
-- rls-guard_test.ts, and the owner column is named `owner_user_id` per that
-- guard's discovery convention.

-- US-3355: RLS is not the only layer, and a deny-all table with a wide-open
-- grant is one `create policy` away from being readable.
REVOKE ALL ON public.easypost_accounts FROM anon, authenticated;

DROP TRIGGER IF EXISTS set_easypost_accounts_updated_at ON public.easypost_accounts;
CREATE TRIGGER set_easypost_accounts_updated_at
  BEFORE UPDATE ON public.easypost_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS label_provider        text,
  ADD COLUMN IF NOT EXISTS easypost_shipment_id  text;

COMMENT ON COLUMN public.sales.label_provider IS
  'US-3015: which provider bought the label -- ebay or easypost. Null means no label was bought in FlipDesk.';
COMMENT ON COLUMN public.sales.easypost_shipment_id IS
  'US-3015: EasyPost shipment id (shp_...) for a label bought here. Used to reprint (label URLs expire, so re-fetch rather than store) and to refund.';

-- Idempotent and self-correcting: it only fills rows that have a label but no
-- provider, so a second run matches nothing. Every such row predates EasyPost.
UPDATE public.sales
   SET label_provider = 'ebay'
 WHERE label_provider IS NULL
   AND ebay_shipment_id IS NOT NULL;

ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_label_provider_chk;
ALTER TABLE public.sales
  ADD CONSTRAINT sales_label_provider_chk
  CHECK (label_provider IS NULL OR label_provider IN ('ebay', 'easypost'));

CREATE INDEX IF NOT EXISTS idx_sales_easypost_shipment_id
  ON public.sales (easypost_shipment_id)
  WHERE easypost_shipment_id IS NOT NULL;

insert into public.applied_migrations (version) values ('00816') on conflict do nothing;
