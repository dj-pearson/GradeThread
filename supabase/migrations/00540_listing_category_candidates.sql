-- US-2424: record WHICH eBay leaf categories AutoLister considered, and why it
-- picked the one it did.
--
-- Generation used to take eBay's first Taxonomy suggestion unchecked. Now it
-- scores the top few by how many of each leaf's REQUIRED item specifics the
-- item can already fill, and keeps the whole ranked list here so the composer
-- can offer a one-click switch to the runner-up without a fresh AI run.
--
-- Shape (array, best-first — the chosen leaf is element 0):
--   [{ "categoryId": "57988", "categoryPath": "Clothing…", "rank": 1,
--      "requiredFilled": 5, "requiredTotal": 6, "requiredMissing": ["Size Type"] }]
-- `rank` is eBay's own suggestion position, kept so a re-rank is explainable.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS category_candidates jsonb;

COMMENT ON COLUMN public.listings.category_candidates IS
  'US-2424: ranked eBay leaf candidates considered at generation time, best-first; element 0 is the chosen category. Null when the item already had a category.';

insert into public.applied_migrations (version) values ('00540') on conflict do nothing;
