-- US-2704: what GradeThread published, every time it published it.
--
-- A buyer opens an item-not-as-described case claiming the seller hid a flaw.
-- The seller's defence is the listing text and the item specifics that were
-- live at the time, and nothing recorded them: the description was written to
-- eBay and forgotten, and eBay's own GetMyeBaySelling does not return it.
--
-- ONE ROW PER PUBLISH AND PER REVISE. The columns are the claim and nothing
-- else: which listing, which channel, the description, the aspect map, the
-- price, and when.
--
-- THE CLAIM IS DELIBERATELY NARROW. This is what GradeThread PUBLISHED, never
-- what eBay DISPLAYED. A seller who edits in Seller Hub changes eBay's copy and
-- not ours, and we cannot always detect it, so nothing built on this table may
-- say "the listing read this at the time of sale" unless the live text was
-- independently confirmed to match. Claiming the second while knowing only the
-- first is manufacturing evidence, which is the thing this feature exists to be
-- better than.
--
-- last_confirmed_at is the collapse column. The credentials-refresh cron
-- re-pushes unchanged text often, and a duplicate row per re-push would bury
-- the real revisions. An unchanged push bumps this instead — which is also the
-- stronger statement: this exact text was live and confirmed from published_at
-- through last_confirmed_at.
--
-- Operator table: deny-all RLS, service-role writes only, registered in
-- SERVICE_ROLE_ONLY. Reads are tenant-scoped in the edge per US-268.

CREATE TABLE IF NOT EXISTS public.listing_publications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  owner_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel           text NOT NULL DEFAULT 'ebay',
  description       text,
  aspects           jsonb,
  price             numeric(10,2),
  published_at      timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now()
);

-- "What did this listing say, most recent first" — the evidence query, and the
-- one the collapse check runs on every write.
CREATE INDEX IF NOT EXISTS idx_listing_publications_listing
  ON public.listing_publications (listing_id, published_at DESC);

ALTER TABLE public.listing_publications ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.listing_publications
  FROM anon, authenticated;

insert into public.applied_migrations (version) values ('00643') on conflict do nothing;
