-- 00258_passport_claim_tokens.sql
--
-- US-1094: ownership handoff / claim flow (Layer 1 — title transfer). A seller
-- who sold a graded item can mint a single-use, time-bounded CLAIM TOKEN; the
-- buyer redeems it (no account required) to transfer the Garment Passport to a
-- new pseudonymous buyer node. This is the strongest, design-driven tracking
-- layer: the chain continues DETERMINISTICALLY because the parties opt in.
--
-- Security model (US-268): written only by the edge service-role client.
--   • Only the SHA-256 HASH of the token is stored (token_hash) — the raw token
--     is shown to the seller exactly once and is never recoverable from the row,
--     so a DB read can't redeem outstanding tokens.
--   • Single-use: claimed_at is set atomically on redemption (the edge claims
--     via UPDATE ... WHERE claimed_at IS NULL RETURNING, so a replay/double-claim
--     loses the race and is rejected).
--   • Time-bounded: expires_at gates redemption.
--   • created_by is the tenant key (the minting workspace owner). RLS: the owner
--     may READ their own tokens; all writes are service-role only.
--
-- Idempotent (IF NOT EXISTS / guarded). Applies cleanly on a fresh schema.

BEGIN;

CREATE TABLE IF NOT EXISTS public.passport_claim_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id         uuid NOT NULL REFERENCES public.garments(id) ON DELETE CASCADE,
  -- SHA-256 hex of the raw claim token. The raw token is never stored.
  token_hash         text NOT NULL UNIQUE,
  -- Tenant key: the workspace owner that minted the token.
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at         timestamptz NOT NULL,
  -- Set once, atomically, on redemption — the single-use gate.
  claimed_at         timestamptz,
  -- The pseudonymous buyer node the token minted on redemption.
  claimed_by_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.passport_claim_tokens IS
  'US-1094: single-use, time-bounded Garment Passport ownership-claim tokens. '
  'Only the SHA-256 hash is stored; raw token shown to the seller once. '
  'Service-role write only; owner reads own via created_by.';

-- Redemption looks up by token_hash and filters unclaimed/unexpired.
CREATE INDEX IF NOT EXISTS idx_passport_claim_tokens_garment
  ON public.passport_claim_tokens(garment_id);
-- Owner's "outstanding tokens" list.
CREATE INDEX IF NOT EXISTS idx_passport_claim_tokens_created_by
  ON public.passport_claim_tokens(created_by);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.passport_claim_tokens ENABLE ROW LEVEL SECURITY;

-- All writes are service-role only (no insert/update/delete policy).
REVOKE INSERT, UPDATE, DELETE ON public.passport_claim_tokens FROM anon, authenticated;
-- The minting owner may read their own tokens (status/expiry), never others'.
-- token_hash is a digest, so this exposes nothing redeemable.
CREATE POLICY passport_claim_tokens_select_own ON public.passport_claim_tokens
  FOR SELECT
  USING (created_by = auth.uid());

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00258')
ON CONFLICT (version) DO NOTHING;

COMMIT;
