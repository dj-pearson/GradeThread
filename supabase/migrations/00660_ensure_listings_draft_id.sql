-- 00660: ensure listings.draft_id exists, so a repaired production can prove it.
--
-- US-2832. The column comes from 00134, which is pre-footer-era: applied_migrations
-- only records 00254 and up, so the boot guard never checked it. Production turned
-- out to have 00134's trigger and policies but NOT this column, and every extension
-- cross-listing writeback failed with PGRST204 (US-2726).
--
-- 00134 cannot simply be re-run: its CREATE TRIGGER and three CREATE POLICY
-- statements carry no guards, so it raises 42710 on the trigger. That error is
-- itself the proof the rest of 00134 applied. The missing half was therefore
-- pasted by hand out of PENDING_MIGRATIONS.md, which left the repair with no
-- durable record anywhere in the database.
--
-- This migration is that record. On a repaired production it changes nothing and
-- the applied_migrations row is the entire point: a restored backup, a staging
-- stack or a future schema audit can now tell a repaired database from one that
-- still has the gap. Both statements are verbatim from 00134, and both are
-- IF NOT EXISTS forms, so this is a no-op wherever the column already exists.
--
-- The rest of 00134 is deliberately NOT reproduced here. Re-asserting a trigger
-- and three policies would turn a zero-risk statement into a real one, and the
-- 42710 already proved they are present.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES public.listings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_listings_draft_id
  ON public.listings (draft_id)
  WHERE draft_id IS NOT NULL;

insert into public.applied_migrations (version) values ('00660') on conflict do nothing;
