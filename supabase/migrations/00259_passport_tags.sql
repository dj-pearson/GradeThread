-- 00259_passport_tags.sql
--
-- US-1096: physical Garment Passport tags (Layer 2). A seller of a higher-value
-- item can attach a printable QR + human-readable short code bound to the
-- garment's passport. Scanning the tag opens the public passport and offers a
-- deterministic scan-to-claim handoff (Layer 1, US-1094).
--
-- The short_code is NOT a secret — it is printed on a physical tag and embedded
-- in the QR. Security is by (a) opt-in issuance, (b) server-side validation +
-- rate-limiting of the public scan/claim endpoints, and (c) revocation: a lost
-- tag can be revoked and a fresh one (re)issued. We therefore store the code in
-- the clear (unlike claim TOKENS, which are secret and hash-only).
--
-- Security model (US-268): written only by the edge service-role client. Owner
-- reads their own tags via created_by; the public resolve/claim path is served
-- by the edge from a non-PII projection, never anon PostgREST.
--
-- Idempotent; applies cleanly on a fresh schema.

BEGIN;

CREATE TABLE IF NOT EXISTS public.passport_tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id  uuid NOT NULL REFERENCES public.garments(id) ON DELETE CASCADE,
  -- Human-readable, QR-embedded handle (Crockford base32, no ambiguous chars).
  -- Public, not a secret.
  short_code  text NOT NULL UNIQUE,
  -- Tenant key: the workspace owner that issued the tag.
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Soft revocation: a revoked tag resolves to nothing (lost/reissued).
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.passport_tags IS
  'US-1096: physical Garment Passport tags (QR + short code) bound to a garment. '
  'short_code is public (printed on the tag). Service-role write; owner reads own.';

-- Public scan resolves by short_code; owner lists by garment / created_by.
CREATE INDEX IF NOT EXISTS idx_passport_tags_garment
  ON public.passport_tags(garment_id);
CREATE INDEX IF NOT EXISTS idx_passport_tags_created_by
  ON public.passport_tags(created_by);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.passport_tags ENABLE ROW LEVEL SECURITY;

-- All writes are service-role only (no insert/update/delete policy).
REVOKE INSERT, UPDATE, DELETE ON public.passport_tags FROM anon, authenticated;
-- The issuing owner may read their own tags (status/code for reprint).
CREATE POLICY passport_tags_select_own ON public.passport_tags
  FOR SELECT
  USING (created_by = auth.uid());

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00259')
ON CONFLICT (version) DO NOTHING;

COMMIT;
