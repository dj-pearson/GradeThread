-- 00265_owner_nodes_identity_reveal.sql
--
-- US-1105: opt-in identity reveal for the Garment Passport. By default every
-- participant on a passport is fully PSEUDONYMOUS (US-1090) — `owner_nodes` carry
-- only an ordinal label ("Seller A", "Buyer B") and, when the actor happened to
-- be signed in during a claim, a `linked_user_id` uuid that is NEVER exposed
-- publicly. This story lets a user who WANTS public credit explicitly, per-hop,
-- reveal their *already-public* GradeThread Verified handle on the chain.
--
-- Two columns on owner_nodes drive it:
--   • identity_revealed    — the per-hop consent flag. OFF by default. A reveal
--                            is only ever EFFECTIVE when this is true AND the
--                            node is linked AND that user has a PUBLIC verified
--                            profile (verified_enabled + handle). So the reveal
--                            ANDs with the existing opt-in verified profile —
--                            disabling either instantly re-pseudonymizes the hop.
--   • identity_revealed_at — when consent was granted (audit + reversibility).
--
-- PRIVACY: no PII is added here. The only thing a reveal ever surfaces is the
-- user's own public verified handle/display name (the same fields US-1101
-- already exposes for the origin seller) — never an id, email, or address. The
-- raw account linkage (`linked_user_id`) stays service-role-only and unexposed.
-- Reveals are honored across export/delete: account deletion's ON DELETE SET NULL
-- on linked_user_id severs the link, and /api/account/delete additionally
-- unreveals the user's nodes (defense-in-depth) so nothing can resolve after.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Fresh-schema safe.
-- owner_nodes is already deny-all to anon/authenticated (00256) — service-role
-- writes only; the public passport reads a PII-free projection via the edge.

BEGIN;

ALTER TABLE public.owner_nodes
  ADD COLUMN IF NOT EXISTS identity_revealed boolean NOT NULL DEFAULT false;

ALTER TABLE public.owner_nodes
  ADD COLUMN IF NOT EXISTS identity_revealed_at timestamptz;

COMMENT ON COLUMN public.owner_nodes.identity_revealed IS
  'US-1105: per-hop opt-in consent to show this node owner''s PUBLIC GradeThread '
  'Verified handle on the passport. OFF by default; only effective when '
  'linked_user_id is set AND that user has a public verified profile. Reversible.';

COMMENT ON COLUMN public.owner_nodes.identity_revealed_at IS
  'US-1105: when identity_revealed was last set true (audit / reversibility). '
  'NULL while pseudonymous.';

-- The reveal projection / management list both filter by linked_user_id (already
-- indexed, 00256). A small partial index over the revealed rows keeps the public
-- passport''s "is this actor revealed" resolution cheap without bloating writes.
CREATE INDEX IF NOT EXISTS idx_owner_nodes_revealed
  ON public.owner_nodes(linked_user_id)
  WHERE identity_revealed AND linked_user_id IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00265')
ON CONFLICT (version) DO NOTHING;

COMMIT;
