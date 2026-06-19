-- 00262_owner_nodes_linkage.sql
--
-- US-1100: eBay sale → pseudonymous sold-to node (Garment Passport Layer 4).
-- When an item sells, we record WHO it sold to as a pseudonymous buyer node
-- WITHOUT storing buyer PII: the node carries a SALTED SHA-256 of the buyer
-- identifier (minimizeLinkageRef, US-1090) — never a name/email/address. The
-- same hash reappearing later (e.g. that buyer becomes a seller) lets us LINK
-- nodes to detect resale, with zero retained PII.
--
-- This adds a nullable linkage_hash column to owner_nodes + a partial index so
-- the resale-detection lookup (find other nodes sharing a hash) is cheap. The
-- raw identifier is never stored, and the digest is irreversible, so this is
-- limited-PII by construction. Service-role write only (owner_nodes is already
-- deny-all to anon/authenticated — 00256).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Fresh-schema safe.

BEGIN;

ALTER TABLE public.owner_nodes
  ADD COLUMN IF NOT EXISTS linkage_hash text;

COMMENT ON COLUMN public.owner_nodes.linkage_hash IS
  'US-1100: salted SHA-256 (hex) of the buyer/seller identifier behind this '
  'pseudonymous node. NOT PII — the raw value is never stored and is not '
  'recoverable. Lets the same party be re-identified across chains to detect '
  'resale, while the public passport still shows only the ordinal label.';

-- Resale detection scans nodes sharing a linkage_hash; index only hashed rows.
CREATE INDEX IF NOT EXISTS idx_owner_nodes_linkage_hash
  ON public.owner_nodes(linkage_hash) WHERE linkage_hash IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00262')
ON CONFLICT (version) DO NOTHING;

COMMIT;
