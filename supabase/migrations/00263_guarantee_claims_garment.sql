-- 00263_guarantee_claims_garment.sql
--
-- US-1101: tie the buyer trust-guarantee to the Garment Passport CHAIN, not just
-- a one-off certificate. A guarantee claim (US-867) is filed against a public
-- certificate; that certificate's grade_report already carries a garment_id
-- (00257), so we denormalize the garment_id onto the claim. This makes the
-- guarantee travel WITH the passport — the incentive that makes buyers claim the
-- chain and resellers carry it forward.
--
-- Nullable + ON DELETE SET NULL: pre-passport certificates have no garment, and
-- a deleted garment must never cascade-delete a buyer's claim. Service-role
-- write only (guarantee_claims is already RLS-deny-all to clients — 00197).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Fresh-schema safe.

BEGIN;

ALTER TABLE public.guarantee_claims
  ADD COLUMN IF NOT EXISTS garment_id uuid
    REFERENCES public.garments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.guarantee_claims.garment_id IS
  'US-1101: the Garment Passport this claim is tied to (resolved server-side '
  'from the certificate''s grade_report, never the request). Nullable for '
  'pre-passport certificates. Lets a claim be anchored to the chain.';

CREATE INDEX IF NOT EXISTS idx_guarantee_claims_garment_id
  ON public.guarantee_claims (garment_id) WHERE garment_id IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00263')
ON CONFLICT (version) DO NOTHING;

COMMIT;
