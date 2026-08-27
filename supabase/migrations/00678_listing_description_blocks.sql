-- US-2956: the listing description stops being one opaque string.
--
-- Today a fact can sit in the AI prose, in the marker-delimited measurements
-- block and in the facts block at once, and only the last two can be updated.
-- Editing a measurement leaves the prose advertising the old number, and the
-- only way to clear it is a full AI rewrite that discards every other edit.
--
-- description_blocks is the ordered list of named blocks the description is
-- rendered FROM. listing_description survives as the render output, because
-- full-text search (00016), fuzzy search history (00248) and return attribution
-- (00655) all read that column.
--
-- Design: docs/superpowers/specs/2026-08-27-modular-listing-descriptions-design.md

-- NULL means "this listing predates blocks" — the signal to parse the legacy
-- string on open. No default, so no existing row is touched by this migration.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS description_blocks jsonb;

COMMENT ON COLUMN public.listings.description_blocks IS
  'US-2956: ordered description blocks. NULL = legacy string, parse on open. listing_description is rendered from this.';

-- The seller's standing lines, saved once and referenced by id from a listing
-- block, so fixing a shipping line fixes every listing that points at it.
CREATE TABLE IF NOT EXISTS public.listing_snippets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  body        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listing_snippets_user_sort_idx
  ON public.listing_snippets (user_id, sort_order);

DROP TRIGGER IF EXISTS set_listing_snippets_updated_at ON public.listing_snippets;
CREATE TRIGGER set_listing_snippets_updated_at
  BEFORE UPDATE ON public.listing_snippets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.listing_snippets ENABLE ROW LEVEL SECURITY;

-- The frontend reads/writes the caller's own rows directly from the settings
-- page; the edge service reads them via the service-role client when it renders
-- a description that carries a snippet block.
--
-- `(select auth.uid())`, not bare `auth.uid()` (US-1927). The two are
-- semantically identical because auth.uid() is STABLE, but the bare form is
-- re-evaluated PER ROW while the subselect hoists to a single InitPlan. Copying
-- the policy shape from an older migration such as 00134 reintroduces the bare
-- form; rls-guard_test.ts is what catches it.
DROP POLICY IF EXISTS "Users can view own listing snippets" ON public.listing_snippets;
CREATE POLICY "Users can view own listing snippets"
  ON public.listing_snippets FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own listing snippets" ON public.listing_snippets;
CREATE POLICY "Users can insert own listing snippets"
  ON public.listing_snippets FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own listing snippets" ON public.listing_snippets;
CREATE POLICY "Users can update own listing snippets"
  ON public.listing_snippets FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own listing snippets" ON public.listing_snippets;
CREATE POLICY "Users can delete own listing snippets"
  ON public.listing_snippets FOR DELETE
  USING ((select auth.uid()) = user_id);

-- US-1108: record this version here so the edge service boot guard (US-778)
-- stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00678')
ON CONFLICT (version) DO NOTHING;
