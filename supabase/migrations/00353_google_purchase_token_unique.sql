-- 00353_google_purchase_token_unique.sql
--
-- US-1614 (C1) — bind a Google Play subscription purchase token to exactly ONE
-- account. Before this, users.google_purchase_token had no uniqueness guarantee,
-- so a single Play subscription's purchaseToken could be shared and re-verified
-- to entitle N accounts (each getting Business, re-verifiable monthly).
--
-- The edge verify path (lib/google-play/verify.ts) now (a) requires the
-- purchase's obfuscatedExternalAccountId to match the caller's userId when the
-- client set it, and (b) refuses a token already bound to another user's row.
-- This partial unique index is the DB backstop for (b): even under a race, two
-- users can never hold the same subscription token.
--
-- Partial (WHERE ... IS NOT NULL) so the many free/never-subscribed-via-Play
-- users (google_purchase_token IS NULL) are exempt — NULLs don't collide anyway,
-- but the partial form keeps the index small and the intent explicit.
--
-- Idempotent (US-1108): CREATE UNIQUE INDEX IF NOT EXISTS + self-record footer.
-- NOTE: if prod already contains duplicate google_purchase_token values (i.e.
-- the exploit was used before this shipped), this index creation will fail —
-- that is the correct signal to investigate and de-dupe before applying. Google
-- Play billing is pre-launch, so no legitimate duplicates are expected.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_purchase_token
  ON public.users (google_purchase_token)
  WHERE google_purchase_token IS NOT NULL;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00353') ON CONFLICT DO NOTHING;
