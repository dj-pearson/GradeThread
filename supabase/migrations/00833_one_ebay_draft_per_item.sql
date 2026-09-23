-- One eBay draft per inventory item.
--
-- generateListing (lib/ai-listing.ts) wrote the AutoLister draft as
-- select-then-insert on (inventory_item_id, platform='ebay',
-- listing_status='draft') with nothing in the schema behind it. A generation
-- that outlived its batch timeout and a retry of the same job could both see
-- no draft and both insert one, leaving the composer two drafts to choose
-- between. This index makes the second insert fail with 23505; the edge code
-- catches that and updates the surviving draft instead.
--
-- Scoped to platform='ebay' on purpose. The extension channels (relist,
-- cross-push siblings, extension writeback) have their own draft rules and
-- were never part of this race.
--
-- Existing duplicates are DEMOTED, not deleted. A delete would cascade into
-- repricing, publication and queue rows and null out job and sale links, and
-- nobody can inspect prod from here. Per item, the keeper is the draft most
-- likely to be the real one: linked to an eBay listing, then an eBay offer,
-- then scheduled to publish, then the most recently updated. Every other eBay
-- draft for that item becomes 'ended' (the is_active trigger turns it off),
-- loses its publish schedule so the publish-due tick cannot pick it up, and is
-- stamped platform_fields.dedupe_00833 = {kept_listing_id, demoted_at} so the
-- owner can find, restore or delete exactly these rows later.
--
-- Idempotent: on a second run there are no duplicates left, the UPDATE matches
-- nothing, and the index already exists.

WITH ranked AS (
  SELECT
    l.id,
    first_value(l.id) OVER w AS keeper_id,
    row_number() OVER w AS rn
  FROM public.listings l
  WHERE l.platform = 'ebay'
    AND l.listing_status = 'draft'
  WINDOW w AS (
    PARTITION BY l.inventory_item_id
    ORDER BY
      (l.platform_listing_id IS NOT NULL) DESC,
      (l.platform_offer_id IS NOT NULL) DESC,
      (l.scheduled_publish_at IS NOT NULL) DESC,
      l.updated_at DESC,
      l.created_at DESC,
      l.id DESC
  )
)
UPDATE public.listings t
SET
  listing_status = 'ended',
  scheduled_publish_at = NULL,
  platform_fields = coalesce(t.platform_fields, '{}'::jsonb)
    || jsonb_build_object(
      'dedupe_00833',
      jsonb_build_object('kept_listing_id', r.keeper_id, 'demoted_at', now())
    )
FROM ranked r
WHERE t.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_listings_one_ebay_draft_per_item
  ON public.listings (inventory_item_id)
  WHERE platform = 'ebay' AND listing_status = 'draft';

COMMENT ON INDEX public.uq_listings_one_ebay_draft_per_item IS
  'At most one eBay draft per inventory item. generateListing relies on the 23505 to turn a racing insert into an update (00833).';

insert into public.applied_migrations (version) values ('00833') on conflict do nothing;
