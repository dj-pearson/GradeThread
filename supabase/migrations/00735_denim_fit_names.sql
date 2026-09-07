-- US-3125: the denim FIT names for 7 For All Mankind and MOTHER.
--
-- Read on 2026-09-06 from each brand's own Shopify catalogue with
-- scripts/ops/shopify-brand-harvest.mjs, the same route 00732-00734 used.
--
-- -- WHY FITS AND NOT "PRODUCT LINES" ----------------------------------------
--
-- For a denim house the FIT is the product. "MOTHER Hustler" and "7 For All
-- Mankind Slimmy" are how the garment is sold, searched and comped, and a
-- seller who lists a Hustler as "MOTHER jeans" has thrown away the one word
-- that sets the price. These are seeded as category 'fit' for that reason.
--
-- Both brands publish the fit as a tag on every product, so this is the brand's
-- own vocabulary rather than a reseller's.
--
--   7 For All Mankind   30 fits on 1,696 products
--   MOTHER               9 fits on   972 products
--
-- Only fits on EIGHT OR MORE products are seeded -- a fit the brand actually
-- runs, not a one-season experiment.
--
-- -- THREE OTHER BRANDS HAD STYLE TAGS AND ARE DELIBERATELY ABSENT -----------
--
-- The same harvest found tags for three more brands and none of them is a line:
--
--   Steve Madden   "Square Toe", "Platform", "Mule", "Block Heel" -- silhouette
--                  descriptors. Real words, but they describe a shoe rather than
--                  naming a product, and every brand in the category uses them.
--   FRAME          ":camille-platform-heel-black" -- URL handles that leaked
--                  into the tag field. Not a taxonomy at all.
--   AG Jeans       "ERB71207", "1783SUD" -- internal codes rather than names.
--                  Interesting as future DECODER material, useless as a style.
--   Lucchese       "Cowboy" and "Roper" are genuine boot constructions, but they
--                  arrive mixed with "Belts", "Wallets", "Socks" and "Boot Care",
--                  which are departments. Seeding the pair while dropping the
--                  rest needs a judgement about Lucchese's taxonomy that this
--                  data does not support, so nothing is seeded.
--
-- A tag field is not a taxonomy just because it has values in it.

insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified,
   updated_by)
values
  ('7forallmankind', 'Slimmy', ARRAY['slimmy']::text[], 'Slimmy', 'Unisex', 'fit',
   'Named denim fit, carried on 109 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['slimmy','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'The Straight', ARRAY['the straight']::text[], 'The Straight', 'Unisex', 'fit',
   'Named denim fit, carried on 90 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['the straight','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Dojo', ARRAY['dojo']::text[], 'Dojo', 'Unisex', 'fit',
   'Named denim fit, carried on 89 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['dojo','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Lotta', ARRAY['lotta']::text[], 'Lotta', 'Unisex', 'fit',
   'Named denim fit, carried on 67 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['lotta','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Slimmy Tapered', ARRAY['slimmy tapered']::text[], 'Slimmy Tapered', 'Unisex', 'fit',
   'Named denim fit, carried on 50 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['slimmy tapered','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Modern Dojo', ARRAY['modern dojo']::text[], 'Modern Dojo', 'Unisex', 'fit',
   'Named denim fit, carried on 32 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['modern dojo','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Stovepipe Straight', ARRAY['stovepipe straight']::text[], 'Stovepipe Straight', 'Unisex', 'fit',
   'Named denim fit, carried on 30 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['stovepipe straight','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Calie Straight', ARRAY['calie straight']::text[], 'Calie Straight', 'Unisex', 'fit',
   'Named denim fit, carried on 25 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['calie straight','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Leggy Bootcut', ARRAY['leggy bootcut']::text[], 'Leggy Bootcut', 'Unisex', 'fit',
   'Named denim fit, carried on 24 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['leggy bootcut','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'The Skinny', ARRAY['the skinny']::text[], 'The Skinny', 'Unisex', 'fit',
   'Named denim fit, carried on 24 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['the skinny','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Modern Straight', ARRAY['modern straight']::text[], 'Modern Straight', 'Unisex', 'fit',
   'Named denim fit, carried on 22 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['modern straight','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Low Straight', ARRAY['low straight']::text[], 'Low Straight', 'Unisex', 'fit',
   'Named denim fit, carried on 20 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['low straight','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Kimmie', ARRAY['kimmie']::text[], 'Kimmie', 'Unisex', 'fit',
   'Named denim fit, carried on 16 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['kimmie','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Roxanne', ARRAY['roxanne']::text[], 'Roxanne', 'Unisex', 'fit',
   'Named denim fit, carried on 16 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['roxanne','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'The Bootcut', ARRAY['the bootcut']::text[], 'The Bootcut', 'Unisex', 'fit',
   'Named denim fit, carried on 16 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['the bootcut','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'The Jo', ARRAY['the jo']::text[], 'The Jo', 'Unisex', 'fit',
   'Named denim fit, carried on 16 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['the jo','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Austyn', ARRAY['austyn']::text[], 'Austyn', 'Unisex', 'fit',
   'Named denim fit, carried on 15 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['austyn','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Standard', ARRAY['standard']::text[], 'Standard', 'Unisex', 'fit',
   'Named denim fit, carried on 15 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['standard','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Chino', ARRAY['chino']::text[], 'Chino', 'Unisex', 'fit',
   'Named denim fit, carried on 14 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['chino','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Relaxed Skinny', ARRAY['relaxed skinny']::text[], 'Relaxed Skinny', 'Unisex', 'fit',
   'Named denim fit, carried on 12 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['relaxed skinny','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Calie', ARRAY['calie']::text[], 'Calie', 'Unisex', 'fit',
   'Named denim fit, carried on 11 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['calie','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Easy Straight', ARRAY['easy straight']::text[], 'Easy Straight', 'Unisex', 'fit',
   'Named denim fit, carried on 11 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['easy straight','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Original Bootcut', ARRAY['original bootcut']::text[], 'Original Bootcut', 'Unisex', 'fit',
   'Named denim fit, carried on 10 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['original bootcut','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Spencer Flare', ARRAY['spencer flare']::text[], 'Spencer Flare', 'Unisex', 'fit',
   'Named denim fit, carried on 10 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['spencer flare','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'The Slim', ARRAY['the slim']::text[], 'The Slim', 'Unisex', 'fit',
   'Named denim fit, carried on 10 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['the slim','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Retro Flare', ARRAY['retro flare']::text[], 'Retro Flare', 'Unisex', 'fit',
   'Named denim fit, carried on 9 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['retro flare','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Alexa', ARRAY['alexa']::text[], 'Alexa', 'Unisex', 'fit',
   'Named denim fit, carried on 8 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['alexa','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Bonnie', ARRAY['bonnie']::text[], 'Bonnie', 'Unisex', 'fit',
   'Named denim fit, carried on 8 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['bonnie','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Low Cigarette', ARRAY['low cigarette']::text[], 'Low Cigarette', 'Unisex', 'fit',
   'Named denim fit, carried on 8 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['low cigarette','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('7forallmankind', 'Low Skinny', ARRAY['low skinny']::text[], 'Low Skinny', 'Unisex', 'fit',
   'Named denim fit, carried on 8 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['low skinny','fit','denim']::text[],
   'https://www.7forallmankind.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Kick It', ARRAY['kick it']::text[], 'Kick It', 'Women', 'fit',
   'Named denim fit, carried on 16 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['kick it','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Dazzler', ARRAY['dazzler']::text[], 'Dazzler', 'Women', 'fit',
   'Named denim fit, carried on 14 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['dazzler','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Hustler', ARRAY['hustler']::text[], 'Hustler', 'Women', 'fit',
   'Named denim fit, carried on 14 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['hustler','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Lemon Twist', ARRAY['lemon twist']::text[], 'Lemon Twist', 'Women', 'fit',
   'Named denim fit, carried on 13 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['lemon twist','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Hustler Roller', ARRAY['hustler roller']::text[], 'Hustler Roller', 'Women', 'fit',
   'Named denim fit, carried on 10 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['hustler roller','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Weekender', ARRAY['weekender']::text[], 'Weekender', 'Women', 'fit',
   'Named denim fit, carried on 10 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['weekender','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Dodger', ARRAY['dodger']::text[], 'Dodger', 'Women', 'fit',
   'Named denim fit, carried on 8 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['dodger','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Rambler', ARRAY['rambler']::text[], 'Rambler', 'Women', 'fit',
   'Named denim fit, carried on 8 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['rambler','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735'),
  ('mother', 'Reifler', ARRAY['reifler']::text[], 'Reifler', 'Women', 'fit',
   'Named denim fit, carried on 8 products in the brand''s own catalogue.',
   ARRAY['denim']::text[], ARRAY['reifler','fit','denim']::text[],
   'https://www.motherdenim.com/products.json', 0.75, false, 'migration:00735')
on conflict do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00735') on conflict do nothing;
