-- US-3125: give every brand colorway an eBay colour bucket, and a shade.
--
-- THE PROBLEM THIS SOLVES, in the owner's words: "Optical White" belongs in the
-- TITLE and the DESCRIPTION, because it is what the brand calls the colour and
-- what a buyer searches. eBay's Color item specific will not accept it. That
-- field wants "White".
--
-- So a colorway now carries both:
--
--   color_name   the brand's own name          -> title, description
--   base_color   the eBay Color bucket         -> item specifics
--   shade        Dark / Medium / Light         -> disambiguation, description
--
-- The listing writer uses the first for prose and the second for the aspect, and
-- stops having to choose between being searchable and being valid.
--
-- -- WHERE THE BUCKETS COME FROM ---------------------------------------------
--
-- NOT a new vocabulary. services/edge-functions/src/lib/aspect-normalize.ts
-- already carries COLOR_FAMILY (117 entries) and BASE_COLORS
-- (18), which is the table the aspect normaliser has always used to
-- narrow a descriptive colour onto eBay's list. This resolves each colorway
-- through that same table, so the KB and the normaliser cannot disagree.
--
-- The rule is aspect-normalize's own: read the tokens RIGHT TO LEFT and take
-- the last colour-bearing one. "Sage Green" is Green, not Sage.
--
-- -- WHAT IS DELIBERATELY LEFT NULL, AND WHY IT MATTERS ----------------------
--
-- 1013 of 2294 colorways resolve to NOTHING and are left NULL.
-- A guessed bucket is worse than a missing one: NULL makes the listing writer
-- fall back to reading the garment, while a wrong "Brown" is a confident error
-- that ships.
--
-- ⚠ AND THE BIGGEST GROUP IS NOT A GAP IN THE TABLE -- IT IS DENIM. 7 For All
-- Mankind's "colours" are WASH NAMES: Arizona, Belton, Cisco, Franklin, Kansas,
-- Hilo, Halona, Midtown, Milkyway. A wash name carries no colour information at
-- all, by design; it names a finish. No colour table will ever resolve them, and
-- adding them one by one is a per-brand research job (a 7FAM "Coffee Bean" is
-- brown, "Coldspring" is a blue wash) rather than a missing entry.
--
-- FRAME (163 unresolved), Cotopaxi (104) and Outdoor Research (59) are the same
-- shape for the same reason: house names rather than descriptions.

alter table public.brand_colorways
  add column if not exists base_color text,
  add column if not exists shade text;

comment on column public.brand_colorways.base_color is
  'The eBay Color item-specific value this brand colour narrows to (US-3125). NULL means unresolved, never "no colour" - the listing writer must fall back rather than assume.';
comment on column public.brand_colorways.shade is
  'Dark / Medium / Light where the brand name says so, for describing a colour when several share a base_color.';

do $$
begin
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = '7forallmankind' and color_name = 'Army';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = '7forallmankind' and color_name = 'Beige';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = '7forallmankind' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = '7forallmankind' and color_name = 'Blue Core';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = '7forallmankind' and color_name = 'Brown';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = '7forallmankind' and color_name = 'Chocolate';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = '7forallmankind' and color_name = 'Cognac';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = '7forallmankind' and color_name = 'Dark Blue';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = '7forallmankind' and color_name = 'Dark Olive';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = '7forallmankind' and color_name = 'Deep Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = '7forallmankind' and color_name = 'Dusty Blue';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = '7forallmankind' and color_name = 'Ecru';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = '7forallmankind' and color_name = 'Espresso';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = '7forallmankind' and color_name = 'Ice White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = '7forallmankind' and color_name = 'Indigo Bloom';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = '7forallmankind' and color_name = 'Ivory';
  update public.brand_colorways set base_color = null, shade = 'Medium'
   where brand_key = '7forallmankind' and color_name = 'Medium Melrose';
  update public.brand_colorways set base_color = 'Blue', shade = 'Medium'
   where brand_key = '7forallmankind' and color_name = 'Mid Blue';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = '7forallmankind' and color_name = 'Midnight';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = '7forallmankind' and color_name = 'Midnight Fade';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = '7forallmankind' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = '7forallmankind' and color_name = 'Optical White';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = '7forallmankind' and color_name = 'Rinsed Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = '7forallmankind' and color_name = 'Rinsed Indigo';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = '7forallmankind' and color_name = 'Rose';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = '7forallmankind' and color_name = 'Sand Storm';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = '7forallmankind' and color_name = 'Silver Mink';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = '7forallmankind' and color_name = 'Sky Blue';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = '7forallmankind' and color_name = 'Slate';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = '7forallmankind' and color_name = 'Soho Light';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = '7forallmankind' and color_name = 'White';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'agjeans' and color_name = 'CHAMPAGNE';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'agjeans' and color_name = 'DEEP NAVY';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'agjeans' and color_name = 'DEEP TRENCHES';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'agjeans' and color_name = 'GALLERY WHITE';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'agjeans' and color_name = 'HEATHER GREY';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'agjeans' and color_name = 'SULFUR ANTIQUE BLACK';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'agjeans' and color_name = 'SUPER BLACK';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'agjeans' and color_name = 'TRUE BLACK';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'agjeans' and color_name = 'WHITE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'agjeans' and color_name = 'WOOD BROWN';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'aloyoga' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'aloyoga' and color_name = 'Bone';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'aloyoga' and color_name = 'Dark Grey Heather';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'aloyoga' and color_name = 'Espresso';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'andie' and color_name = 'BLACK';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'andie' and color_name = 'BLACK DOT';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'andie' and color_name = 'BLUE NIGHTS';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'andie' and color_name = 'BONE';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'andie' and color_name = 'CHERRY RED';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'andie' and color_name = 'HEATHER GREY';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'andie' and color_name = 'KHAKI';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'andie' and color_name = 'Natural';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'andie' and color_name = 'NAVY';
  update public.brand_colorways set base_color = 'Multicolor', shade = null
   where brand_key = 'andie' and color_name = 'RAINBOW WIDE STRIPE';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'andie' and color_name = 'SAGE LEAF';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'andie' and color_name = 'VINTAGE INDIGO';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'andie' and color_name = 'WARM GREY';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'andie' and color_name = 'WHITE';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'arcteryx' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'arcteryx' and color_name = 'Black Sapphire';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'athleta' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'athleta' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'barbour' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'barbour' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'barbour' and color_name = 'Olive';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'barbour' and color_name = 'Sage';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'beyondyoga' and color_name = 'Black Heather';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'beyondyoga' and color_name = 'Cream Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'beyondyoga' and color_name = 'Nocturnal Navy';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'birkenstock' and color_name = 'Mocha';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'birkenstock' and color_name = 'Stone';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'birkenstock' and color_name = 'Taupe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'brahmin' and color_name = 'Aura Blue Melbourne';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'brahmin' and color_name = 'Black Melbourne';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'brahmin' and color_name = 'Black Seagate';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'brahmin' and color_name = 'Blush Adrift';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'brahmin' and color_name = 'Candy Pink Melbourne';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'brahmin' and color_name = 'Chocolate Alden Road';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'brahmin' and color_name = 'Chocolate Grassland';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'brahmin' and color_name = 'Chocolate Melbourne';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'brahmin' and color_name = 'Electric Fuchsia Melbourne';
  update public.brand_colorways set base_color = 'Multicolor', shade = null
   where brand_key = 'brahmin' and color_name = 'Fossilized Ombre Melbourne';
  update public.brand_colorways set base_color = 'Multicolor', shade = null
   where brand_key = 'brahmin' and color_name = 'Ginger Ombre Melbourne';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'brahmin' and color_name = 'Ivory Helm';
  update public.brand_colorways set base_color = 'Gold', shade = 'Light'
   where brand_key = 'brahmin' and color_name = 'Light Gold Charms';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'brahmin' and color_name = 'Navy Windswept';
  update public.brand_colorways set base_color = 'Multicolor', shade = null
   where brand_key = 'brahmin' and color_name = 'Olive Ombre Melbourne';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'brahmin' and color_name = 'Tan Grassland';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'brahmin' and color_name = 'Vintage Indigo Melbourne';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'brahmin' and color_name = 'Vivid Yellow Sunshadow';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'brahmin' and color_name = 'Volcanic Red Melbourne';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Airstream Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Atlantic Teal';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Atlantic Teal Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Atlantic Teal / Spring Frost';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'burton' and color_name = 'Azalea Pink';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'burton' and color_name = 'Bear Hug Brown';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'burton' and color_name = 'Bear Hug Brown Heather';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'burton' and color_name = 'Black / White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Blue Teal';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'burton' and color_name = 'Chestnut Brown';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'burton' and color_name = 'Chinchilla Gray';
  update public.brand_colorways set base_color = 'Red', shade = 'Dark'
   where brand_key = 'burton' and color_name = 'Deep Cherry';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'burton' and color_name = 'Deep Emerald';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Dried Moss';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Dried Moss Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Dusty Blue';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'burton' and color_name = 'Fiesta Red';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'burton' and color_name = 'Flame Scarlet';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Forest City Streets';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Forest Moss';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'burton' and color_name = 'Geranium Red';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Glow Yellow Green';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'burton' and color_name = 'Goldfish Orange';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'burton' and color_name = 'Gotham Gray';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Graffiti Camo / Forest Moss';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'burton' and color_name = 'Gray Cloud';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'burton' and color_name = 'Gray Heather';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Green Voltage';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'burton' and color_name = 'Hyper Lilac';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'burton' and color_name = 'Imperial Purple';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Jake Blue';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'burton' and color_name = 'Light Teal';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'Matty Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Mineral Blue';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'burton' and color_name = 'Moondust Purple';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'burton' and color_name = 'Nightshade Purple';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Pacific Teal';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'burton' and color_name = 'Peach Echo';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Cloudy Pink (53% / S1)';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Sunny Bronze (17% / S3)';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Sunny Onyx (6% / S4)';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Sunny Polarized Onyx (12% / S3)';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Sun Red (14% / S3)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Variable Blue (21% / S2)';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Variable Green (22% / S2)';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'burton' and color_name = 'Perceive Variable Violet (34% / S2)';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'burton' and color_name = 'Purple Voltage';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'burton' and color_name = 'Sage Green';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Selvedge Blue';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'burton' and color_name = 'Shockwave Pink';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'burton' and color_name = 'Silver Sconce';
  update public.brand_colorways set base_color = 'Green', shade = 'Light'
   where brand_key = 'burton' and color_name = 'Soft Sage';
  update public.brand_colorways set base_color = 'Green', shade = 'Light'
   where brand_key = 'burton' and color_name = 'Soft Sage Heather';
  update public.brand_colorways set base_color = 'Black', shade = 'Light'
   where brand_key = 'burton' and color_name = 'Soft Sage / True Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Spiced Chai / Atlantic Teal';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'burton' and color_name = 'Stout White';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'burton' and color_name = 'Summit Taupe';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'burton' and color_name = 'Summit Taupe Heather';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'Summit Taupe / True Black';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'burton' and color_name = 'Sunrise Coral';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'burton' and color_name = 'Terracotta';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'Translucent Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'True Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'burton' and color_name = 'True Black Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'burton' and color_name = 'Twilight Blue';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'burton' and color_name = 'Washed Lavender';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'burton' and color_name = 'White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'canadagoose' and color_name = 'Atlantic Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'canadagoose' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'champion' and color_name = 'Oxford Grey';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Brown';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Burgundy';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Chocolate';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'citizensofhumanity' and color_name = 'Chocolate Dark Brown';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Cream';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'citizensofhumanity' and color_name = 'Dark Olive';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Ecru';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Espresso';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Heather Grey';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Mahogany';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Optic White';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'citizensofhumanity' and color_name = 'Pale Stone';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Quartz Grey';
  update public.brand_colorways set base_color = 'White', shade = 'Light'
   where brand_key = 'citizensofhumanity' and color_name = 'Soft White';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Tan';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'True Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Vintage Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'Washed Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'citizensofhumanity' and color_name = 'White';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'clarks' and color_name = 'Sand Suede';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'colehaan' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'colehaan' and color_name = 'Black-British Tan-Ivory';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'colehaan' and color_name = 'Black-Ivory';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'colehaan' and color_name = 'Black-White';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'colehaan' and color_name = 'British Tan';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'colehaan' and color_name = 'British Tan-Dark Chocolate';
  update public.brand_colorways set base_color = 'Ivory', shade = 'Dark'
   where brand_key = 'colehaan' and color_name = 'British Tan-Dark Natural';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'colehaan' and color_name = 'British Tan-Ivory';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'colehaan' and color_name = 'Brown';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'colehaan' and color_name = 'Dark Chocolate';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'colehaan' and color_name = 'Deep Olive';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'colehaan' and color_name = 'Green';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'colehaan' and color_name = 'Light Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'colehaan' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'colehaan' and color_name = 'Navy Blazer';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'colehaan' and color_name = 'Navy Blazer-British Tan-Ivory';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'colehaan' and color_name = 'Navy Blazer-New British Tan';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'colehaan' and color_name = 'Olive';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'colehaan' and color_name = 'Optic White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'colehaan' and color_name = 'Provincial Blue';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'colehaan' and color_name = 'Silver Lining';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'colehaan' and color_name = 'Tan';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'colehaan' and color_name = 'Tuscan Sand';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'colehaan' and color_name = 'White';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'columbia' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'columbia' and color_name = 'Collegiate Navy';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Amber';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Amber Stripes';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Amber/Wheat';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Apricot';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Black Violet';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Blue Smoke';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Blue Spruce';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Blue Spruce/Abyss';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Bone';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Bronze';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Burgundy';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Burgundy Stripes';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Chestnut';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Cotopaxi Black';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Cream';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Crimson';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'cotopaxi' and color_name = 'Deep Ocean';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'cotopaxi' and color_name = 'Deep Sea';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'cotopaxi' and color_name = 'Deep Sea/Fjord';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'cotopaxi' and color_name = 'Deep Sea Stripes';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'cotopaxi' and color_name = 'Del Día Dark';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Dusty Rose';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Faded Brick';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Forest';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Graphite';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Green Tea';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Heather Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Indigo';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'cotopaxi' and color_name = 'Juniper/Deep Ocean';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Khaki';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Maritime/Amber';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Moss';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Oatmeal';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Rose';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Rust';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Sand';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Silver Leaf';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Slate';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Smoke';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Smoke/Cinder';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Steel Blue';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Stone';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'cotopaxi' and color_name = 'White';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Wine';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Wine/Amethyst';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Wine/Blue Violet';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'cotopaxi' and color_name = 'Wine Stripes';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'dickies' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'dickies' and color_name = 'Black (BK)';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'dickies' and color_name = 'Black (BKX)';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'dickies' and color_name = 'Black (BLK)';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dickies' and color_name = 'Brown (BR)';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dickies' and color_name = 'Brown Duck';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'Caribbean Blue (CRB)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'Ceil Blue (CBL)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'CLASSIC BLUE (CLB)';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'dickies' and color_name = 'Dark Indigo (0DD)';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'dickies' and color_name = 'Dark Navy (0DN)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'Galaxy Blue (GBL)';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'dickies' and color_name = 'Gray-Tan';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dickies' and color_name = 'Hunter Green (GH)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'NAVY (0NV)';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dickies' and color_name = 'OLIVE (OL9)';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dickies' and color_name = 'Pewter Gray (PEW)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'Retro Indigo (RI2)';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'dickies' and color_name = 'Rinsed Black (RBK)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'Rinsed Indigo Blue (RNB)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dickies' and color_name = 'Teal Blue (TLB)';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'dickies' and color_name = 'White';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'dickies' and color_name = 'White (0WH)';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'dickies' and color_name = 'White (DWH)';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dickies' and color_name = 'Wine (WIN)';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'diesel' and color_name = 'Dark Rinse';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Amber';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Aqua';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Ash';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Beige';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Black Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Blue';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Blush';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Bone';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Brown';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Brown Tmoro';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Brown Tmoro Red';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Burgundy';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Burnt Orange';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Camel';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Caramel';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Caribbean Blue';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Cherry';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Chestnut';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Chocolate';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Cobalt';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Cognac';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Coral';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Cream';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Crimson';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'dooneybourke' and color_name = 'Dark Brown';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'dooneybourke' and color_name = 'Dark Grey';
  update public.brand_colorways set base_color = 'Beige', shade = 'Dark'
   where brand_key = 'dooneybourke' and color_name = 'Dark Taupe';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'dooneybourke' and color_name = 'Deep Teal';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Denim';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Dusty Blue';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Ecru';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Emerald';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Espresso';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Espresso Tan';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Forest';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'French Blue';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'dooneybourke' and color_name = 'French Caramel';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Fuchsia';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Glacier Blue';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Gold';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Graphite';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Green';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Grey';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Hot Pink';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Hunter';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Ice Blue';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Jade';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Kelly Green';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Khaki';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Lavender';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Lemon';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'dooneybourke' and color_name = 'Light Blue';
  update public.brand_colorways set base_color = 'Green', shade = 'Light'
   where brand_key = 'dooneybourke' and color_name = 'Light Green';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'dooneybourke' and color_name = 'Light Grey';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'dooneybourke' and color_name = 'Light Pink';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'dooneybourke' and color_name = 'Light Taupe';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Lilac';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Mauve';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Mediterranean Blue';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'dooneybourke' and color_name = 'Midnight Blue';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Mint';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Moss';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Mustard';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Natural';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Natural Bone';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Neon Green';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Neon Yellow';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Off White';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Olive';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Orange';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'dooneybourke' and color_name = 'Pale Blue';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'dooneybourke' and color_name = 'Pale Pink';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Periwinkle';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Pink';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Pink Green';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Plum Wine';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Pumpkin';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Pure White';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Purple';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Red';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Rose';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Royal Blue';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Saddle Tan';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Salmon';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Sand';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Sea Foam';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Sky';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Sky Blue';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Sky Blue White';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Slate';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Smoke';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Smoke Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Steel Blue';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Stone';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Tan';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Tangerine';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Taupe';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Taupe Tan';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Teal';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Terracotta';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Turquoise';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Violet';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'dooneybourke' and color_name = 'White';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'dooneybourke' and color_name = 'White Multi';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Wine';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'dooneybourke' and color_name = 'Yellow';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'drmartens' and color_name = 'Cherry Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'faherty' and color_name = 'Abyss Navy';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'faherty' and color_name = 'Agona Green';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'faherty' and color_name = 'Antique Ivory Heather';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'faherty' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'faherty' and color_name = 'Blue Nights';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'faherty' and color_name = 'Coastal Sage';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'faherty' and color_name = 'Dune Navy';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'faherty' and color_name = 'Forest Grove';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'faherty' and color_name = 'Graphite';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'faherty' and color_name = 'Island Brown';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'faherty' and color_name = 'Light Grey Heather';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'faherty' and color_name = 'Natural';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'faherty' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'faherty' and color_name = 'Olive';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'faherty' and color_name = 'Poppy Red';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'faherty' and color_name = 'Pure White';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'faherty' and color_name = 'Ridge Black';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'faherty' and color_name = 'Summer Sand';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'faherty' and color_name = 'Sunset Red';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'faherty' and color_name = 'Washed Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'faherty' and color_name = 'White';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'fearofgod' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'fearofgod' and color_name = 'Brown';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'fearofgod' and color_name = 'Cream White';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'fearofgod' and color_name = 'Dark Brown';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'fearofgod' and color_name = 'Dark Grey';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'fearofgod' and color_name = 'Dark Sapphire';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'fearofgod' and color_name = 'Dirty Ivory';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'fearofgod' and color_name = 'Faded Black';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'fearofgod' and color_name = 'Faded Brown';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'fearofgod' and color_name = 'Iron Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'fearofgod' and color_name = 'Iron Grey Heather/ Seal Heather';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'fearofgod' and color_name = 'Ivory';
  update public.brand_colorways set base_color = 'Blue', shade = 'Medium'
   where brand_key = 'fearofgod' and color_name = 'Medium Indigo';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'fearofgod' and color_name = 'Moss';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'fearofgod' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'fearofgod' and color_name = 'Oatmeal Heather';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'fearofgod' and color_name = 'Oatmeal Heather W Dark Sapphire Pinstripes';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'fearofgod' and color_name = 'Off Black';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'fearofgod' and color_name = 'Seal Heather/ Iron Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'fearofgod' and color_name = 'Stone Blue';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'fearofgod' and color_name = 'Vanilla Heather';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'fearofgod' and color_name = 'Vintage Black';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'fearofgod' and color_name = 'Washed Iron Grey';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'fearofgod' and color_name = 'Washed Vanilla Heather';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'fearofgod' and color_name = 'White';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'fearofgodessentials' and color_name = 'Moss';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'filson' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'filson' and color_name = 'Blaze Orange';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'filson' and color_name = 'Brown';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'filson' and color_name = 'Brown Leather';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'filson' and color_name = 'Burnt Olive';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'filson' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'filson' and color_name = 'Dark Brown';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'filson' and color_name = 'Dark Navy';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'filson' and color_name = 'Dark Olive';
  update public.brand_colorways set base_color = 'Tan', shade = 'Dark'
   where brand_key = 'filson' and color_name = 'Dark Tan';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'filson' and color_name = 'Dark Timber';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'filson' and color_name = 'Faded Black';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'filson' and color_name = 'Forest Green';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'filson' and color_name = 'Harvest Tan';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'filson' and color_name = 'Hawk Brown';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'filson' and color_name = 'Indigo';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'filson' and color_name = 'Light Indigo';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'filson' and color_name = 'Marsh Olive';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'filson' and color_name = 'Military Olive';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'filson' and color_name = 'Natural';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'filson' and color_name = 'Natural Seed';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'filson' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'filson' and color_name = 'Olive';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'filson' and color_name = 'Otter Green';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'filson' and color_name = 'Tan';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'filson' and color_name = 'Vintage Indigo';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'filson' and color_name = 'Washed Faded Black';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'filson' and color_name = 'Washed Fatigue Green';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'fjallraven' and color_name = 'Frost Green';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'fjallraven' and color_name = 'Graphite';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'fjallraven' and color_name = 'Ochre';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'fjallraven' and color_name = 'Ox Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'fjallraven' and color_name = 'Royal Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'fjallraven' and color_name = 'UN Blue';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'Antique Beige';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'Antique Green';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'Antique Grey';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'Antique Military Khaki';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'Army';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'Au Natural';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'AU NATURAL CLEAN';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'BEACH SAND';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'Beige';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'frame' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'frame' and color_name = 'Black Leather';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'frame' and color_name = 'Black Multi';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'frame' and color_name = 'BLACK PLAID';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'Blue Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'BLUE STRIPE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'BRONZE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'BROWN';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'Brown Olive';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'CAMEL';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'frame' and color_name = 'CHAMPAGNE COATED';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'Chestnut';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'Chestnut Multi Plaid';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'CHOCOLATE BROWN';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'CREAM';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'Cream/Brown Stripe';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'frame' and color_name = 'Cream/ Mauve Stripe';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'Cream Multi';
  update public.brand_colorways set base_color = 'Beige', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'DARK BEIGE';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'DARK BROWN';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'DARK CHARCOAL';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'Dark Emerald';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'DARK GREY';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'DARK GREY MELANGE';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'DARK NAVY';
  update public.brand_colorways set base_color = 'Purple', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'DARK ROYAL PURPLE';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'Deep Brown';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'Deep Olive';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'Dusty Beige';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'Dusty Emerald';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'frame' and color_name = 'Dusty Mauve';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'ECRU';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'ESPRESSO';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'FADE TO GREY';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'frame' and color_name = 'GOLD';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'Graphite Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'GREY MELANGE';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'HEATHER GREY';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'HUNTER GREEN';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'Jade Green Plaid';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'KHAKI';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'frame' and color_name = 'Lemon';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Light Grey Melange';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'frame' and color_name = 'Light Leopard Multi';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Light Stone';
  update public.brand_colorways set base_color = 'Tan', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Light Tan';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'frame' and color_name = 'LIGHT TAUPE';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'frame' and color_name = 'Mauve';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'frame' and color_name = 'Midnight Ash';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'Military Green';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'MILK BEIGE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'MOCHA';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'Modern Grey';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'MOSS';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'NATURAL';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'NAVY';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'Navy/ Cream Stripe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'NAVY MULTI';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'Navy Stripe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'Navy Washed';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'OATMEAL HEATHER';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'Ocean Sage';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'OFF WHITE';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'Off White Destructed';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'OFF WHITE GRIND';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'Off White Rip';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'OXFORD BEIGE';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Pale Blue';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Pale Peach';
  update public.brand_colorways set base_color = 'Yellow', shade = 'Light'
   where brand_key = 'frame' and color_name = 'PALE YELLOW';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'frame' and color_name = 'RED';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'frame' and color_name = 'Red Check';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'frame' and color_name = 'Red Washed';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'frame' and color_name = 'Rust';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'Sea Blue';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'SHADOW GREY';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'frame' and color_name = 'Silver Peony Plaid';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'Sky Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'Sky Blue Multi';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'frame' and color_name = 'Smoky Blue';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'frame' and color_name = 'SMOKY GREEN';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'frame' and color_name = 'Smoky Mauve';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'SMOKY MOCHA';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Soft Beige';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'frame' and color_name = 'SOFT BLUE';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Soft Camel';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'frame' and color_name = 'Soft Dune';
  update public.brand_colorways set base_color = 'Green', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Soft Olive';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'frame' and color_name = 'Soft Peach';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'frame' and color_name = 'Soft Pistachio';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'frame' and color_name = 'SOFT TAUPE';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'STONE GREY';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'Vintage Grey';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'frame' and color_name = 'Vintage Mocha';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'frame' and color_name = 'Warm Beige';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'frame' and color_name = 'Warm Cream';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'frame' and color_name = 'Warm Grey';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'frame' and color_name = 'Warm Mauve';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'WHISPER WHITE';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'White';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'White Destruct';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'White Grind';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'White Polka Dot';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'WHITE RAW FRAY';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'frame' and color_name = 'White Stripe';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'frame' and color_name = 'WINE';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'frame' and color_name = 'Yellow Stripe';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'freefly' and color_name = 'Aspen Grey';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'freefly' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'freefly' and color_name = 'Black Sand';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'freefly' and color_name = 'Blue Fog';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'freefly' and color_name = 'Bone';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'freefly' and color_name = 'Bright Lavender';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'freefly' and color_name = 'Bright White';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'freefly' and color_name = 'Calypso Print Light Coral';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'freefly' and color_name = 'Chestnut';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'freefly' and color_name = 'Clear Sky';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'freefly' and color_name = 'Dark Forest';
  update public.brand_colorways set base_color = 'Beige', shade = 'Dark'
   where brand_key = 'freefly' and color_name = 'Dark Khaki';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'freefly' and color_name = 'Deep Navy';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'freefly' and color_name = 'Desert Tan';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'freefly' and color_name = 'Heather Aspen Grey';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'freefly' and color_name = 'Heather Black';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'freefly' and color_name = 'Heather Grey';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'freefly' and color_name = 'Light Coral';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'freefly' and color_name = 'Light Heather Grey';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'freefly' and color_name = 'Nolia Floral Print Stone';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'freefly' and color_name = 'Off White Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'freefly' and color_name = 'Pacific Blue';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'freefly' and color_name = 'Plum';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'freefly' and color_name = 'Rust';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'freefly' and color_name = 'Sand Dune';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'freefly' and color_name = 'Slate Blue';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'freefly' and color_name = 'Smoke';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'freefly' and color_name = 'Smokey Olive';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'freefly' and color_name = 'Stone';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'freefly' and color_name = 'True Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'freefly' and color_name = 'Vintage Camo Black';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'freefly' and color_name = 'Vintage Camo Oil Green';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'freefly' and color_name = 'Windward Blue';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'freepeople' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'freepeople' and color_name = 'Ivory';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'girlfriendcollective' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'girlfriendcollective' and color_name = 'Moss';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'girlfriendcollective' and color_name = 'Plum';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'girlfriendcollective' and color_name = 'Smoke';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'ARCTIC/MALTESE BLUE';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'BONE';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'greysonclothiers' and color_name = 'DARK GREY HEATHER';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'greysonclothiers' and color_name = 'LIGHT GREY HEATHER';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'MALTESE BLUE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'MALTESE BLUE/ARCTIC';
  update public.brand_colorways set base_color = 'Gray', shade = 'Medium'
   where brand_key = 'greysonclothiers' and color_name = 'MEDIUM GREY HEATHER';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'greysonclothiers' and color_name = 'MIDNIGHT MALTESE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'PINK SKY';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'ROYAL BLUE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'SAND';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'SLATE';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'SMOKE HEATHER';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'VARSITY RED';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'VINTAGE INDIGO';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'WOLF BLUE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'greysonclothiers' and color_name = 'WOLF BLUE/ARCTIC';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'gstarraw' and color_name = 'Dark Aged';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'gstarraw' and color_name = 'Raw Indigo';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'gymshark' and color_name = 'Obsidian Green';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'herms' and color_name = 'Gold';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Ash Rose';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Ash Rose EQ Camo';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Ash Rose Tonal';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Black Diamond/Black';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Black/Saddle Brown';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Black Tonal';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Black/White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Blue Mirage Diamond/Sea Storm';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Brown Slate/Delicioso';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Cashmere Rose';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Darkest Navy';
  update public.brand_colorways set base_color = 'Gray', shade = 'Dark'
   where brand_key = 'herschelsupplyco' and color_name = 'Dark Gull Gray';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'herschelsupplyco' and color_name = 'Digi Leopard Light';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'French Blue';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Graphite';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Grey Crosshatch';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Grid - Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Grid Black/Black';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'herschelsupplyco' and color_name = 'Heather Light Grey';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Heron/Black';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Ivy Green';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Ivy Green Diamond';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Ivy Green Tonal';
  update public.brand_colorways set base_color = 'Brown', shade = 'Light'
   where brand_key = 'herschelsupplyco' and color_name = 'Light Brown';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Navy/Saddle brown';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Pink Sheep';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Realtree® Edge Camo White/Blck';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Rose Violet';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Scribble Leopard Sachet Pink';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Vapor Diamond/Charcoal Gray';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Vintage Khaki';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Vintage White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Watercolour Dinos Darkest Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'herschelsupplyco' and color_name = 'Woodland Camo/Black Label';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'jcrew' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'joesjeans' and color_name = 'BARITONE BLUE';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'joesjeans' and color_name = 'BLACK';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'joesjeans' and color_name = 'BRONZE BROWN';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'joesjeans' and color_name = 'BURNT OLIVE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'joesjeans' and color_name = 'CAMEL';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'joesjeans' and color_name = 'CHARCOAL';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'joesjeans' and color_name = 'CHERRY RED';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'joesjeans' and color_name = 'CHOCOLATE';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'joesjeans' and color_name = 'CLEAN WHITE';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'joesjeans' and color_name = 'DARK CHOCOLATE';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'joesjeans' and color_name = 'ECRU';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'joesjeans' and color_name = 'ESPRESSO';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'joesjeans' and color_name = 'GREEN MILIEU';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'joesjeans' and color_name = 'HEATHER GREY';
  update public.brand_colorways set base_color = 'Black', shade = 'Dark'
   where brand_key = 'joesjeans' and color_name = 'JET BLACK';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'joesjeans' and color_name = 'NATURAL';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'joesjeans' and color_name = 'NATURAL STRIPE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'joesjeans' and color_name = 'NAVY';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'joesjeans' and color_name = 'NIGHT SKY';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'joesjeans' and color_name = 'OLIVE';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'joesjeans' and color_name = 'OPTIC WHITE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'joesjeans' and color_name = 'PAGEANT BLUE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'joesjeans' and color_name = 'SAND';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'joesjeans' and color_name = 'SMOKE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'joesjeans' and color_name = 'STONE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'joesjeans' and color_name = 'SUMMER SAND';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'joesjeans' and color_name = 'TRUE NAVY';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'joesjeans' and color_name = 'ULTIMATE GREY';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'joesjeans' and color_name = 'VINTAGE BLUE';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'joesjeans' and color_name = 'WHITE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'joesjeans' and color_name = 'WINDWARD BLUE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'joesjeans' and color_name = 'WINTER SAND';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'lee' and color_name = 'Rigid Indigo';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'longchamp' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'longchamp' and color_name = 'Cognac';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'longchamp' and color_name = 'Graphite';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'longchamp' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'lululemon' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'lululemon' and color_name = 'Black Cherry';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'lululemon' and color_name = 'Dark Olive';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'lululemon' and color_name = 'Heathered Core Ultra Light';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'lululemon' and color_name = 'True Navy';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Aqua';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'mackage' and color_name = 'Army';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'mackage' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'mackage' and color_name = 'Black-Black';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'mackage' and color_name = 'Black-Cream';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'mackage' and color_name = 'Black-Trench';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'mackage' and color_name = 'Blush';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'mackage' and color_name = 'Bright Pink';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'mackage' and color_name = 'Camel';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'mackage' and color_name = 'Cognac';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'mackage' and color_name = 'Cream';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Cream-Navy';
  update public.brand_colorways set base_color = 'Red', shade = 'Dark'
   where brand_key = 'mackage' and color_name = 'Dark Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Denim';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'mackage' and color_name = 'Earth Brown';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'mackage' and color_name = 'Emerald';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'mackage' and color_name = 'Fiery Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Fog Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Klein Blue';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'mackage' and color_name = 'Leaf Green';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'mackage' and color_name = 'Light Camel';
  update public.brand_colorways set base_color = 'Ivory', shade = 'Light'
   where brand_key = 'mackage' and color_name = 'Light Camel-Cream';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'mackage' and color_name = 'Light Grey Mix';
  update public.brand_colorways set base_color = 'Ivory', shade = 'Light'
   where brand_key = 'mackage' and color_name = 'Light Grey Mix-Cream';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'mackage' and color_name = 'Light Military';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Marine Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Mineral Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'mackage' and color_name = 'Navy-Cream';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Navy Melange';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'mackage' and color_name = 'Navy-White';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'mackage' and color_name = 'Off White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Olympic Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Provincial Blue';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'mackage' and color_name = 'Red';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'mackage' and color_name = 'Rose';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mackage' and color_name = 'Sapphire';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'mackage' and color_name = 'Sepia Rose';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'mackage' and color_name = 'Soft Pink';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'mackage' and color_name = 'Taupe';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'mackage' and color_name = 'Taupe Mix-Taupe';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'mackage' and color_name = 'Truffle Brown';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'mackage' and color_name = 'White';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'michaelkors' and color_name = 'Vanilla';
  update public.brand_colorways set base_color = 'Multicolor', shade = null
   where brand_key = 'mother' and color_name = 'Assorted (Open)';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'mother' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'mother' and color_name = 'Black (Charcoal)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mother' and color_name = 'Blue';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'mother' and color_name = 'Blue (Dark)';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'mother' and color_name = 'Blue (Light-Pastel)';
  update public.brand_colorways set base_color = 'Blue', shade = 'Medium'
   where brand_key = 'mother' and color_name = 'Blue (Medium)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mother' and color_name = 'Blue (Navy)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'mother' and color_name = 'Blue (Turquoise-Aqua)';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'mother' and color_name = 'Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'mother' and color_name = 'Grey (Open)';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'mother' and color_name = 'Orange';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'mother' and color_name = 'Pink (Bright)';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'mother' and color_name = 'Red';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'mother' and color_name = 'White';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'mother' and color_name = 'White (Natural)';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'mother' and color_name = 'White (Open)';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'obermeyer' and color_name = 'Bali Blue';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'obermeyer' and color_name = 'Ballet Pink';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'obermeyer' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'obermeyer' and color_name = 'Black ii';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'obermeyer' and color_name = 'Blue Depth';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'obermeyer' and color_name = 'Blue vibes';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'obermeyer' and color_name = 'Bone';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'obermeyer' and color_name = 'Cowboy Blue';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'obermeyer' and color_name = 'Daffy Dayz-Pink';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'obermeyer' and color_name = 'Daylight Blue';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'obermeyer' and color_name = 'Fresno Red';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'obermeyer' and color_name = 'Green Cabin';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'obermeyer' and color_name = 'High Kick Orange';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'obermeyer' and color_name = 'Indigo Mountains';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'obermeyer' and color_name = 'Indy Blue';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'obermeyer' and color_name = 'Ivy Green';
  update public.brand_colorways set base_color = 'Purple', shade = 'Dark'
   where brand_key = 'obermeyer' and color_name = 'Mauve Deep';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'obermeyer' and color_name = 'Midnight Navy';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'obermeyer' and color_name = 'Pink Lem';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'obermeyer' and color_name = 'Red';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'obermeyer' and color_name = 'Roma Red';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'obermeyer' and color_name = 'Slate';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'obermeyer' and color_name = 'Summit Sage';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'obermeyer' and color_name = 'Tropical Pink';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'obermeyer' and color_name = 'Walnut';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'obermeyer' and color_name = 'White';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'All Black';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Amber';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Amethyst';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Ascent Blue Heather';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Atlantic/Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Ivory', shade = 'Dark'
   where brand_key = 'outdoorresearch' and color_name = 'Black/Dark Natural';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Black Heather';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Bronze';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Caramel';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Cherry Blossom';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Chestnut';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Classic Blue';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'outdoorresearch' and color_name = 'Dark Laurel';
  update public.brand_colorways set base_color = 'Ivory', shade = 'Dark'
   where brand_key = 'outdoorresearch' and color_name = 'Dark Natural';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'outdoorresearch' and color_name = 'Dark Navy';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'outdoorresearch' and color_name = 'Dark Olive';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'outdoorresearch' and color_name = 'Dark Olive Heather';
  update public.brand_colorways set base_color = 'Beige', shade = 'Dark'
   where brand_key = 'outdoorresearch' and color_name = 'Dark Sand';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Grey Heather';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Khaki';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Lavender';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'outdoorresearch' and color_name = 'Light Pewter';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Naval Blue';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Pewter';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Pro Khaki';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Pro Khaki/Black';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Pro Khaki/Gravel';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Pro Khaki/Oyster';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Ranger Green';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Sand';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Slate';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Solid Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Spice/Black';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Stardust/Amethyst';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Storm/Black';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Titanium Grey';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'White';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorresearch' and color_name = 'Wolf Grey';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Black Multi';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Blue Dust';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Bone';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Brilliant White';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Canary Melon';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Club Daisy Apricot';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'outdoorvoices' and color_name = 'Dark Bay';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'outdoorvoices' and color_name = 'Dark Olive';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'outdoorvoices' and color_name = 'Dark Sky';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Faded Sky';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Heather Grey';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Hot Coral';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Joggy Green';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Joggy Green Helios';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Lemon Water';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'outdoorvoices' and color_name = 'Light Bay';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Met Blue';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Milk Stone';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Mineral Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'OV Blue';
  update public.brand_colorways set base_color = 'Purple', shade = 'Light'
   where brand_key = 'outdoorvoices' and color_name = 'Pastel Lilac';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Rose Water';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'Sand';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'White';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'outdoorvoices' and color_name = 'White Multi';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'patagonia' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'patagonia' and color_name = 'Classic Navy';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'patagonia' and color_name = 'Forge Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'patagonia' and color_name = 'New Navy';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Army';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Ash';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Blue Spruce';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Blush';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Bone';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Brass';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Burgundy';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Camel';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Champagne';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Charcoal Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Cobalt';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Cognac';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Copper';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Coral';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Cream';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'peruvianconnection' and color_name = 'Deep Teal';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Denim';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Espresso';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Fresco Red';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Gold';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Heather Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Indigo';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Ivory';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Merlot';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'peruvianconnection' and color_name = 'Midnight';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Moss';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Oatmeal';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Olive';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Pearl Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Pewter';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Ruby';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Sage';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Sand';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Sapphire';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Seafoam';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Silver';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Stone';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Taupe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Teal';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Turquoise';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Tuscan Rose';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'Walnut';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'peruvianconnection' and color_name = 'White';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'reebok' and color_name = 'Army Green';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Athletic Grey Marl';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'reebok' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'reebok' and color_name = 'Black/Black/Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'reebok' and color_name = 'Black/Black/White';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'reebok' and color_name = 'Black/Ftwr White';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Black/Grey 6';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'reebok' and color_name = 'Black/White';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Black/White/Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'reebok' and color_name = 'Blue';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'reebok' and color_name = 'Espresso';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'reebok' and color_name = 'Ftwr White/Vector Blue/Vector Red';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Grey 3';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Grey 5';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Grey 6';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'reebok' and color_name = 'Grey Heather';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'reebok' and color_name = 'Light Fog';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'reebok' and color_name = 'Light Grey Marl';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'reebok' and color_name = 'Muted Mauve';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'reebok' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'reebok' and color_name = 'Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'reebok' and color_name = 'Vector Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'reebok' and color_name = 'Vector Navy';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'reebok' and color_name = 'Vector Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'reebok' and color_name = 'Warped Blue';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'reebok' and color_name = 'White';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'reebok' and color_name = 'White/Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'reebok' and color_name = 'White/Black/Gum';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'reebok' and color_name = 'White/White/White';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'skims' and color_name = 'Ochre';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'skims' and color_name = 'Onyx';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'skims' and color_name = 'Sand';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'stevemadden' and color_name = 'BIRCH WHITE';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK BOX';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK EEL';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK LEATHER';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK MULTI';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK PATENT';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK SATIN';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK SUEDE';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK TAN';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLACK WHITE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLUE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLUE HEATHER';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLUE ICE';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLUSH';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'stevemadden' and color_name = 'BLUSH SATIN';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'BONE';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'BONE LEATHER';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'BONE MULTI';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'BROWN';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'BROWN DISTRESSED';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'BROWN LEATHER';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'BROWN MULTI';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'BROWN RAFFIA';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'BROWN SUEDE';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'stevemadden' and color_name = 'BURGUNDY';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'stevemadden' and color_name = 'BURGUNDY LEATHER';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'stevemadden' and color_name = 'CHAMPAGNE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'CHESTNUT SUEDE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'CHOCOLATE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'COGNAC';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'COGNAC LEATHER';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'CREAM';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'stevemadden' and color_name = 'DARK BROWN';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'stevemadden' and color_name = 'DARK ESPRESSO';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'stevemadden' and color_name = 'DEEP FIG';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'DENIM';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'DENIM FABRIC';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'stevemadden' and color_name = 'GOLD';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'stevemadden' and color_name = 'GOLD LEATHER';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'stevemadden' and color_name = 'GOLD MULTI';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'stevemadden' and color_name = 'GREY SUEDE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'IMPERIAL BLUE';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'IVORY';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'stevemadden' and color_name = 'MIDNIGHT';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'NATURAL';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'NATURAL LEATHER';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'stevemadden' and color_name = 'NATURAL RAFFIA';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'NAVY';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'stevemadden' and color_name = 'OLIVE';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'stevemadden' and color_name = 'PINK';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'stevemadden' and color_name = 'RED';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'stevemadden' and color_name = 'RED LEATHER';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'stevemadden' and color_name = 'RUST';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'stevemadden' and color_name = 'SAND';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'stevemadden' and color_name = 'SILVER';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'stevemadden' and color_name = 'TAN';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'stevemadden' and color_name = 'TAN LEATHER';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'stevemadden' and color_name = 'TAN MULTI';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'stevemadden' and color_name = 'TAN SUEDE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'stevemadden' and color_name = 'TAUPE';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'stevemadden' and color_name = 'TAUPE SUEDE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'stevemadden' and color_name = 'VINTAGE BLUE';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'stevemadden' and color_name = 'WALNUT';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'stevemadden' and color_name = 'WHITE';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'stevemadden' and color_name = 'WHITE LEATHER';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'stevemadden' and color_name = 'WHITE MULTI';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'stevemadden' and color_name = 'WINE';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'sweatybetty' and color_name = 'Beetle Blue';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'sweatybetty' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'sweatybetty' and color_name = 'Urban Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Ash';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Ash Luxe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Baritone Blue';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black and White Stripe';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Black/Super Fan WB/Falcon';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Blue/Gray';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black Charming Hearts';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Dress Blues/Blue Quartz';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Dress Blues Luxe';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Dress Blues/Turbulence';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Dress Blues/Turbulence Luxe';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Falcon/Dove';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Falcon/Falcon Camo';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Falcon/Oil Green';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black Gingham';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Heart WB';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black Lace Waist';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black Luxe';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Maple Sugar';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Maple Sugar/Rosewater Lace Waist';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Navy/Iron Grey';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Rugby Tan';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Shifting Sand/Rosewater Luxe';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black Spruced Up';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Black/Stripe WB';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Blue Blizzard';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Blue Blizzard Golfing Snowman';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Blue Blizzard Luxe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Blue Horizon';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Blue Quartz';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Blue/Quartz/Della Robbia';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Blush Scattered Floral';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Brook Green Luxe';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Cabernet Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Cerulean';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Charcoal Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Colony Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Colony Blue Flying South';
  update public.brand_colorways set base_color = 'Blue', shade = 'Dark'
   where brand_key = 'tommyjohn' and color_name = 'Dark Blue';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'tommyjohn' and color_name = 'Dark Forest';
  update public.brand_colorways set base_color = 'Green', shade = 'Dark'
   where brand_key = 'tommyjohn' and color_name = 'Dark Olive';
  update public.brand_colorways set base_color = 'Purple', shade = 'Dark'
   where brand_key = 'tommyjohn' and color_name = 'Dark Purple';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Della Robbia Blue';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Dress Blues/Colony Blue/Oil Green';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Dress Blues/Dress Blues/Super Fan WB/Colony Blue';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Dress Blues/Turbulence/Black';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Earth Red Luxe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Halogen Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Halogen Blue Camellias';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Halogen Blue Ski Mountain';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Heather Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Iron Grey';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Lavender Herb';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Lilac Chiffon';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Lilac Chiffon Luxe';
  update public.brand_colorways set base_color = 'Gray', shade = 'Medium'
   where brand_key = 'tommyjohn' and color_name = 'Medium Heather Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Navy/Colony Blue Tartan Plaid/Dress Blues Kickoff';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Navy/Iron Grey/Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Navy/Vintage Indigo/Cerulean';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Navy/Vintage Indigo/Dress Blues Winston';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Night Sky';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Oatmeal Heather';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Oil Green';
  update public.brand_colorways set base_color = 'Green', shade = 'Light'
   where brand_key = 'tommyjohn' and color_name = 'Pale Lime';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Pointer Dogs Oil Green';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'River Blue';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Rose Petal';
  update public.brand_colorways set base_color = 'Tan', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Rugby Tan';
  update public.brand_colorways set base_color = 'Black', shade = 'Dark'
   where brand_key = 'tommyjohn' and color_name = 'Sea Jet';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Shifting Sand';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Shifting Sand/Black/Blue Blizzard';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Shifting Sand/Rosewater/Earth Red';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Silver Gray';
  update public.brand_colorways set base_color = 'Pink', shade = 'Light'
   where brand_key = 'tommyjohn' and color_name = 'Soft Pink';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Sterling Blue';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Terracotta';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Turbulence/Bronze Green Camo/Oil Green Pointer Dogs';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Turbulence Grey';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Twilight Mauve';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Veiled Pink';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Vintage Indigo';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Vista Blue Luxe';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Vista Blue Micro Sharks';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'tommyjohn' and color_name = 'Walnut';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tommyjohn' and color_name = 'White';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'toryburch' and color_name = 'Tory Red';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tumi' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'tumi' and color_name = 'Black/Gold';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tumi' and color_name = 'Black/Gunmetal';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tumi' and color_name = 'Charcoal';
  update public.brand_colorways set base_color = 'Brown', shade = 'Dark'
   where brand_key = 'tumi' and color_name = 'Dark Brown';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'tumi' and color_name = 'Deep Pine';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tumi' and color_name = 'Hunter Green';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tumi' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'tumi' and color_name = 'Silver';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '001 Black';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '002 Black/Red';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '003 Onyx';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'tyr' and color_name = '008 Black/Gold';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '009 Black/Lime';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '009 BLK/LIME';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '014 Black/Green';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '014 BLK/GREEN';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '019 Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '020 Gunmetal';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '022 Black/Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '025 Blue Ice/Multi';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '030 Grey/Pink';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '036 Graphite';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'tyr' and color_name = '040 Silver';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '041 Smoke';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '043 Silver/Black';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'tyr' and color_name = '050 Light Grey';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '060 Black/White';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '062 Black/Orange';
  update public.brand_colorways set base_color = 'Silver', shade = null
   where brand_key = 'tyr' and color_name = '064 Black/Silver';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tyr' and color_name = '068 Black/Purple';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '074 Smoke/Black';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '077 Navy/Pink';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '093 Black/Blue';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'tyr' and color_name = '094 Black/Fl. Yellow';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '094 Black/Fl. Yellow/Smoke';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '100 White';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'tyr' and color_name = '102 Stone';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '108 White/Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '109 White/Navy';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '113 White/Royal';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '114 White/Aqua';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '116 White/Green';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '119 White/Blue';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'tyr' and color_name = '132 White/Gold';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '135 White/Gray';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '135 White/Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '139 Slate';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '143 White/Grape';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '145 Fresh Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '155 Grey/Blue';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '166 White/Orange';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '186 White/Multi';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '196 White/Grey/Black';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '199 Steel Blue';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '221 White/Black/Red';
  update public.brand_colorways set base_color = 'Multicolor', shade = null
   where brand_key = 'tyr' and color_name = '223 Gold/Multi/Rainbow';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '239 French Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '245 White/Black Gum';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '252 Heather Grey';
  update public.brand_colorways set base_color = null, shade = 'Light'
   where brand_key = 'tyr' and color_name = '254 Light Heather';
  update public.brand_colorways set base_color = 'Gray', shade = 'Light'
   where brand_key = 'tyr' and color_name = '254 Light Heather Grey';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '255 Charcoal Heather';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'tyr' and color_name = '270 Sand';
  update public.brand_colorways set base_color = 'Ivory', shade = null
   where brand_key = 'tyr' and color_name = '289 Off White';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '294 Brt Green';
  update public.brand_colorways set base_color = 'Green', shade = 'Light'
   where brand_key = 'tyr' and color_name = '300 Light Green';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '310 Green';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '314 Olive';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '321 Emerald';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '330 Lime';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '333 Seafoam';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '342 Teal';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '343 Green/Navy';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '345 Blue Moon';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '355 Cobalt';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '362 Lt Blue/Aqua';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '371 Blue/Pink';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'tyr' and color_name = '377 Light Blue/Navy';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '390 Blue/Pink';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '393 INDIGO';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'tyr' and color_name = '396 Midnight';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '397 Sapphire';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '401 Navy';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '402 Navy';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '404 Navy/Red';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '406 Navy/Orange';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '408 Navy/White';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'tyr' and color_name = '409 Navy/Gold';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '420 Blue';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '422 Blue/Black';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '424 Blue/Red';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '435 Teal/Org';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '441 Aqua';
  update public.brand_colorways set base_color = 'Blue', shade = 'Light'
   where brand_key = 'tyr' and color_name = '450 Light Blue';
  update public.brand_colorways set base_color = 'Black', shade = 'Light'
   where brand_key = 'tyr' and color_name = '456 Light Blue/Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '462 Blue/White';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '466 Blue/Green';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'tyr' and color_name = '470 Royal/Gold';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '487 Blue/Green';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '489 Royal/Lime';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '492 Blue/Orange';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '508 Purple/Mint';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tyr' and color_name = '510 Purple';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tyr' and color_name = '520 Lilac';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '543 White/Gum';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '544 Black/Gum';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '551 Fuchsia';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '591 Crimson';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '610 Red';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '611 Red/Multi';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '620 Magenta';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '636 Red/White/Blue';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '640 Red/Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'tyr' and color_name = '641 Red/White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '642 Red/Navy';
  update public.brand_colorways set base_color = 'Pink', shade = 'Dark'
   where brand_key = 'tyr' and color_name = '652 DARK PINK';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '670 Pink';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '671 Pink/Blue';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '680 Blush';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '685 Pink/Orange';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '690 Pink Me Up';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '694 Pink/Black';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '697 Lime/Multi';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'tyr' and color_name = '710 Gold';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'tyr' and color_name = '714 Purple/Gold';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'tyr' and color_name = '720 Yellow';
  update public.brand_colorways set base_color = 'Purple', shade = null
   where brand_key = 'tyr' and color_name = '728 Yellow/Purple';
  update public.brand_colorways set base_color = 'Yellow', shade = null
   where brand_key = 'tyr' and color_name = '730 Fl. Yellow';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '734 Red/Turquoise/Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '745 White/Red/Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '776 Denim';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '778 Purple/Orange';
  update public.brand_colorways set base_color = 'Purple', shade = 'Dark'
   where brand_key = 'tyr' and color_name = '798 Deep Plum';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '802 Orange Multi';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '810 Orange';
  update public.brand_colorways set base_color = 'Orange', shade = null
   where brand_key = 'tyr' and color_name = '820 Fl. Orange';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'tyr' and color_name = '832 Coral';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'tyr' and color_name = '897 TAUPE MULTI';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '907 Olive/Black';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'tyr' and color_name = '927 Dark Shadow';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'tyr' and color_name = '932 Olive Night';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'tyr' and color_name = '934 Windsor Wine';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'tyr' and color_name = '939 Ash Heather';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '961 Black/Multi';
  update public.brand_colorways set base_color = 'Gray', shade = 'Medium'
   where brand_key = 'tyr' and color_name = '966 Medium Grey Heather';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'tyr' and color_name = '986 Blue Ice';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'tyr' and color_name = '995 Blue Rainbow/Black';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'ugg' and color_name = 'Chestnut';
  update public.brand_colorways set base_color = 'Brown', shade = null
   where brand_key = 'ugg' and color_name = 'Chocolate';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'ugg' and color_name = 'Sand';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'verabradley' and color_name = 'Cherry Picking';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'verabradley' and color_name = 'Maison Blue';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'verabradley' and color_name = 'Riverside Denim';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'verabradley' and color_name = 'Vineyard Green Chambray';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'volcom' and color_name = 'Antique Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'volcom' and color_name = 'Asphalt Black';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'volcom' and color_name = 'Black';
  update public.brand_colorways set base_color = 'Gold', shade = null
   where brand_key = 'volcom' and color_name = 'Black Gold';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'volcom' and color_name = 'Blue Wash';
  update public.brand_colorways set base_color = 'Red', shade = null
   where brand_key = 'volcom' and color_name = 'Burgundy';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'volcom' and color_name = 'Charcoal Heather';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'volcom' and color_name = 'Grey';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'volcom' and color_name = 'Harbor Blue';
  update public.brand_colorways set base_color = 'Gray', shade = null
   where brand_key = 'volcom' and color_name = 'Heather Grey';
  update public.brand_colorways set base_color = 'Beige', shade = null
   where brand_key = 'volcom' and color_name = 'Khaki';
  update public.brand_colorways set base_color = 'Beige', shade = 'Light'
   where brand_key = 'volcom' and color_name = 'Light Khaki';
  update public.brand_colorways set base_color = 'Green', shade = 'Light'
   where brand_key = 'volcom' and color_name = 'Light Olive';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'volcom' and color_name = 'Martini Olive';
  update public.brand_colorways set base_color = null, shade = 'Dark'
   where brand_key = 'volcom' and color_name = 'Midnight';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'volcom' and color_name = 'Navy';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'volcom' and color_name = 'New Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'volcom' and color_name = 'Off White Heather';
  update public.brand_colorways set base_color = 'Green', shade = null
   where brand_key = 'volcom' and color_name = 'Olive';
  update public.brand_colorways set base_color = 'Pink', shade = null
   where brand_key = 'volcom' and color_name = 'Olive/Dusty Rose';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'volcom' and color_name = 'Star White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'volcom' and color_name = 'Stormy Blue';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'volcom' and color_name = 'Vintage Black';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'volcom' and color_name = 'Vintage White';
  update public.brand_colorways set base_color = 'Black', shade = null
   where brand_key = 'volcom' and color_name = 'Washed Black Heather';
  update public.brand_colorways set base_color = 'White', shade = null
   where brand_key = 'volcom' and color_name = 'White';
  update public.brand_colorways set base_color = 'Blue', shade = null
   where brand_key = 'wrangler' and color_name = 'Rigid Indigo';
end $$;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00737') on conflict do nothing;
