-- US-1126: opt-in to embed verified-seller credentials in listing descriptions.
--
-- A verified seller's accumulated, independently-certified grades are the trust
-- signal that differentiates them from a plain marketplace seller. This per-seller
-- toggle lets that signal (total graded, average grade, a link to the public
-- /verified/<handle> profile) be embedded automatically into the listing /
-- cross-listing description the AutoLister builds — but only when the seller is
-- actually publicly verified AND deliberately opts in.
--
-- Like verified_enabled, it defaults OFF so embedding the credential block is a
-- deliberate choice. The column lives on the locked-down users table and stays
-- readable only by the owner (existing "Users can view own profile" policy) and
-- the service role (no new public RLS); the listing embed is built server-side by
-- the RLS-bypassing edge client.
--
-- Idempotent (US-1108): IF NOT EXISTS column + self-record footer.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS verified_embed_in_listings boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.verified_embed_in_listings IS
  'US-1126: when true (and verified_enabled with a handle), the seller''s verified '
  'credentials (total graded, average grade, profile link) are embedded into the '
  'listing/cross-listing descriptions AutoLister builds. Defaults off (opt-in).';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00305')
ON CONFLICT (version) DO NOTHING;
