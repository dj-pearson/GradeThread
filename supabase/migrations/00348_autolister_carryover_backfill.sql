-- 00348: AutoLister → Inventory carry-over backfill (US-1567).
--
-- Generation historically parked the extracted Brand/Size/Color/Type/etc.
-- ONLY in the eBay aspect stores (inventory_items.ebay_aspects +
-- listings.item_specifics_override), so AI-processed drafts showed blank
-- Brand/Size/Color columns on the item page and inventory grid. The edge fix
-- (aspectCarryOver in ai-listing.ts) covers every FUTURE generation; this
-- backfill repairs the EXISTING AI-generated items.
--
-- STRICTLY FILL-ONLY and idempotent: a value the seller typed is never
-- overwritten, and re-running the file changes nothing (every SET is gated
-- on the target still being blank / a placeholder).

-- 1. Item columns from the canonical aspect store. Only items that went
--    through generation (ai_generated_aspects_at stamped) are touched.
update public.inventory_items i
set
  size = coalesce(
    nullif(btrim(i.size), ''),
    nullif(btrim(i.ebay_aspects->'Size'->>0), ''),
    nullif(btrim(i.ebay_aspects->'US Shoe Size'->>0), ''),
    nullif(btrim(i.ebay_aspects->'Shoe Size'->>0), ''),
    nullif(btrim(i.ebay_aspects->'Waist Size'->>0), '')
  ),
  color = coalesce(
    nullif(btrim(i.color), ''),
    nullif(btrim(i.ebay_aspects->'Color'->>0), ''),
    nullif(btrim(i.ebay_aspects->'Colour'->>0), '')
  ),
  material = coalesce(
    nullif(btrim(i.material), ''),
    nullif(btrim(i.ebay_aspects->'Material'->>0), ''),
    nullif(btrim(i.ebay_aspects->'Fabric Type'->>0), ''),
    nullif(btrim(i.ebay_aspects->'Upper Material'->>0), '')
  ),
  style = coalesce(
    nullif(btrim(i.style), ''),
    nullif(btrim(i.ebay_aspects->'Style'->>0), ''),
    nullif(btrim(i.ebay_aspects->'Type'->>0), '')
  )
where i.ai_generated_aspects_at is not null
  and i.ebay_aspects is not null
  and (
    coalesce(btrim(i.size), '') = ''
    or coalesce(btrim(i.color), '') = ''
    or coalesce(btrim(i.material), '') = ''
    or coalesce(btrim(i.style), '') = ''
  );

-- 2. attributes jsonb keys (the item canvas "Details / eBay attributes"
--    section) — fill-only merge: jsonb_strip_nulls drops the keys whose CASE
--    yielded NULL (already set), so existing values survive the ||.
update public.inventory_items i
set attributes = coalesce(i.attributes, '{}'::jsonb) || jsonb_strip_nulls(
  jsonb_build_object(
    'department', case when coalesce(btrim(i.attributes->>'department'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Department'->>0), '') end,
    'size_type', case when coalesce(btrim(i.attributes->>'size_type'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Size Type'->>0), '') end,
    'sleeve_length', case when coalesce(btrim(i.attributes->>'sleeve_length'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Sleeve Length'->>0), '') end,
    'neckline', case when coalesce(btrim(i.attributes->>'neckline'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Neckline'->>0), '') end,
    'pattern', case when coalesce(btrim(i.attributes->>'pattern'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Pattern'->>0), '') end,
    'fit', case when coalesce(btrim(i.attributes->>'fit'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Fit'->>0), '') end,
    'closure', case when coalesce(btrim(i.attributes->>'closure'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Closure'->>0), '') end,
    'garment_care', case when coalesce(btrim(i.attributes->>'garment_care'), '') = ''
      then coalesce(
        nullif(btrim(i.ebay_aspects->'Garment Care'->>0), ''),
        nullif(btrim(i.ebay_aspects->'Care Instructions'->>0), '')
      ) end,
    'country_of_manufacture', case when coalesce(btrim(i.attributes->>'country_of_manufacture'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Country/Region of Manufacture'->>0), '') end,
    'theme', case when coalesce(btrim(i.attributes->>'theme'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Theme'->>0), '') end,
    'mpn', case when coalesce(btrim(i.attributes->>'mpn'), '') = ''
      then nullif(btrim(i.ebay_aspects->'MPN'->>0), '') end,
    'style_code', case when coalesce(btrim(i.attributes->>'style_code'), '') = ''
      then nullif(btrim(i.ebay_aspects->'Style Code'->>0), '') end,
    'features', case when coalesce(btrim(i.attributes->>'features'), '') = ''
      then (
        select nullif(string_agg(btrim(v.val), ', '), '')
        from jsonb_array_elements_text(
          case when jsonb_typeof(i.ebay_aspects->'Features') = 'array'
            then i.ebay_aspects->'Features' else '[]'::jsonb end
        ) as v(val)
        where btrim(v.val) <> ''
      ) end
  )
)
where i.ai_generated_aspects_at is not null
  and i.ebay_aspects is not null;

-- 3. Title + description from the newest AutoLister draft listing. The title
--    condition mirrors shouldAdoptGeneratedTitle (placeholder-guarded); the
--    description fills only when the seller wrote none.
with drafts as (
  select distinct on (l.inventory_item_id)
    l.inventory_item_id,
    l.listing_title,
    l.listing_description
  from public.listings l
  where l.batch_id is not null
  order by l.inventory_item_id, l.created_at desc
)
update public.inventory_items i
set
  title = case
    when (
      coalesce(btrim(i.title), '') = ''
      or i.title ~* '^item\s+[0-9]+$'
      or i.title ~* '^untitled'
    ) and coalesce(btrim(d.listing_title), '') <> ''
    then d.listing_title
    else i.title
  end,
  description = case
    when coalesce(btrim(i.description), '') = ''
      and coalesce(btrim(d.listing_description), '') <> ''
    then d.listing_description
    else i.description
  end
from drafts d
where d.inventory_item_id = i.id
  and (
    (
      (
        coalesce(btrim(i.title), '') = ''
        or i.title ~* '^item\s+[0-9]+$'
        or i.title ~* '^untitled'
      ) and coalesce(btrim(d.listing_title), '') <> ''
    )
    or (
      coalesce(btrim(i.description), '') = ''
      and coalesce(btrim(d.listing_description), '') <> ''
    )
  );

insert into public.applied_migrations (version) values ('00348') on conflict do nothing;
