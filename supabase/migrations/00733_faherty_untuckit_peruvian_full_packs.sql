-- US-3125: full packs for Faherty and Peruvian Connection, and product lines
-- for UNTUCKit -- all from each brand's own Shopify catalogue.
--
-- Read on 2026-09-06 with scripts/ops/shopify-brand-harvest.mjs, the same
-- first-party route 00732 used for Free Fly:
--
--   Faherty              1,250 products
--   UNTUCKit               549 products
--   Peruvian Connection  3,000 products
--
-- -- THREE BRANDS, THREE DIFFERENT ANSWERS ----------------------------------
--
-- The harvester deliberately decides nothing. These three show why: the same
-- query against three catalogues produced one brand worth seeding in full, one
-- worth seeding after filtering, and one whose colours should NOT be seeded at
-- all.
--
-- WARNING: UNTUCKIT GETS NO COLORWAYS, AND THAT IS THE JUDGEMENT, NOT AN
-- OVERSIGHT. Its 22 recurring colour names are Blue, Navy, White, Pink, Black,
-- Green, Tan, Red, Light Blue, Grey. Those are plain colour words, not a brand
-- vocabulary. A colorway earns its place by naming something the seller cannot
-- name themselves -- "Blue Nights" or "Cinnabar" -- and seeding "Blue" adds no
-- information while making the table look covered. UNTUCKit's product LINES are
-- distinctive and are seeded below; its colours are not.
--
-- WARNING: PERUVIAN CONNECTION'S SINGLE COMMONEST "COLOUR" IS NOT A COLOUR.
-- "Print/Pattern" appears on 1,121 of 3,000 products -- more than three times
-- the next entry -- and is a placeholder for anything patterned. It is filtered,
-- along with a small junk list, because a placeholder seeded as a colorway is
-- worse than an empty table: it matches nothing and it looks full.

insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('faherty', 'White', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Black', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Blue Nights', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Light Grey Heather', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Ridge Black', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Dune Navy', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Natural', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Washed Black', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Abyss Navy', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Coastal Sage', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Forest Grove', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Pure White', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Agona Green', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Antique Ivory Heather', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Faded Flag', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Graphite', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Navy', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Olive', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Spellbound', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Summer Sand', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Sunshine Coast Tile', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Blossom Serenade', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Deepwater Stripe', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Granite Heather', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Island Brown', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Poppy Red', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Stormy Lake', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('faherty', 'Sunset Red', ARRAY[]::text[], NULL, NULL, 'https://fahertybrand.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Black', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'White', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Navy', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Ivory', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Ink', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Camel', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Charcoal', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Deep Teal', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Gold', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Midnight', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Espresso', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Denim', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Pearl', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Seafoam', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Malbec', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cream', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Fawn', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Brass', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Sand', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Army', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Oatmeal', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Olive', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Tobacco', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Alabaster', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cabernet', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Bermuda', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Chalk', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cognac', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Maple', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Seaglass', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Silver', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Blue Spruce', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Burgundy', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Fig', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Fresco Red', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Moss', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Peacock', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Ultramarine', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Ash', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Parchment', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Pine', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Pool', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Rum Raisin', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Taupe', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Turquoise', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Beeswax', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Champagne', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cinnabar', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Copper', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Dove', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Merlot', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Pecan', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Pewter', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Ruby', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Sapphire', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Snow', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Truffle', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Adobe', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Blush', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Bone', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Charcoal Heather', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cobalt', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cordovan', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'North Sea', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Paprika', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Persimmon', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Porcelain', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Rosewood', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Rouge', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Seascape', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Teal', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Beet', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Beluga', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cardinal', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Caribe', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Cloud', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Coral', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Delft', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Dune', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Grey', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Heather Grey', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Honey', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Indigo', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Lichen', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Madder', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Mallard', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Malt', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Pearl Grey', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Port', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Putty', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Saddle', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Sage', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Sagebrush', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Stone', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Tuscan Rose', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Walnut', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733'),
  ('peruvianconnection', 'Whiskey', ARRAY[]::text[], NULL, NULL, 'https://www.peruvianconnection.com/products.json', 0.75, false, 'migration:00733')
on conflict do nothing;

-- -- PRODUCT LINES ----------------------------------------------------------
--
-- From each brand's own `style`-shaped tags. Seeded as LINES rather than as
-- individual garments: a line recurs across seasons and departments, a garment
-- does not, and the KB is for the durable half.

insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified,
   updated_by)
values
  ('faherty', 'Reserve', ARRAY['reserve','faherty reserve']::text[],
   'Reserve', 'Unisex', 'line',
   'Faherty''s upper tier -- the name appears as its own catalogue grouping rather than as a garment.',
   ARRAY[]::text[], ARRAY['reserve','premium']::text[],
   'https://fahertybrand.com/products.json', 0.70, false, 'migration:00733'),
  ('faherty', 'Linen', ARRAY['linen','linen shirt']::text[],
   'Linen', 'Unisex', 'line',
   'Linen and linen-blend platform, grouped by the brand as a line in its own right.',
   ARRAY['linen']::text[], ARRAY['linen','summer','shirt']::text[],
   'https://fahertybrand.com/products.json', 0.70, false, 'migration:00733'),
  ('faherty', 'Button Ups', ARRAY['button ups','button-up','patterned shirts','knit shirts']::text[],
   'Button Ups', 'Men', 'line',
   'The largest single grouping in the catalogue at 235 products -- Faherty is a shirt house first.',
   ARRAY[]::text[], ARRAY['button up','shirt','patterned','knit shirt']::text[],
   'https://fahertybrand.com/products.json', 0.70, false, 'migration:00733'),
  ('untuckit', 'Wrinkle-Free', ARRAY['wrinkle-free','wrinkle free']::text[],
   'Wrinkle-Free', 'Unisex', 'line',
   'Treated-cotton shirt and polo platform; one of the two lines the brand groups by.',
   ARRAY['wrinkle-free cotton']::text[], ARRAY['wrinkle free','shirt','polo']::text[],
   'https://www.untuckit.com/products.json', 0.70, false, 'migration:00733'),
  ('untuckit', 'Performance', ARRAY['performance','performance shirts','performance polos']::text[],
   'Performance', 'Unisex', 'line',
   'Synthetic/stretch platform across shirts and polos, the brand''s other grouping.',
   ARRAY['performance knit','stretch']::text[], ARRAY['performance','shirt','polo','stretch']::text[],
   'https://www.untuckit.com/products.json', 0.70, false, 'migration:00733'),
  ('untuckit', 'Flannels & Overshirts', ARRAY['flannel','overshirt','shacket']::text[],
   'Flannels & Overshirts', 'Unisex', 'line',
   'Heavier woven layer, grouped separately from the shirt lines.',
   ARRAY['flannel']::text[], ARRAY['flannel','overshirt','shacket']::text[],
   'https://www.untuckit.com/products.json', 0.70, false, 'migration:00733')
on conflict do nothing;

-- -- WHAT IS NOT HERE ---------------------------------------------------------
--
-- PERUVIAN CONNECTION PRODUCT LINES. Its feed carries ZERO style-shaped tags --
-- the harvester found none, where Faherty had 157 and UNTUCKit 39. The brand
-- groups by garment and construction instead ("Tops & Pullovers, Knit",
-- "Dresses, Cut & Sew", "Cardigans"), which is a taxonomy of shapes rather than
-- of lines. Nothing is seeded rather than promoting a department to a line.
--
-- SIZE CHARTS, for all three, for the reason 00732 gives: a feed publishes the
-- size RUN and brand_size_charts holds BODY MEASUREMENTS, and inventing inches
-- to fill it is the failure the resolver exists to prevent.
--
-- HEX VALUES, for the reason 00732 gives: the feeds publish names, not values.
--
-- THREE MORE BRANDS RUN SHOPIFY AND ARE NOT HERE, because the catalogue request
-- was refused rather than empty -- Todd Snyder answered 403, Johnnie-O and
-- Beyond Yoga answered 429. The harvester THROWS on those rather than reporting
-- an empty catalogue, which is the whole point of that guard: a rate limit read
-- as "this brand has no products" would be recorded as a finding. Retry later.

update public.brand_knowledge
   set updated_by = 'migration:00733',
       notes = case
         when coalesce(notes,'') like '%CATALOGUE READ 2026-09-06%' then notes
         else coalesce(notes,'') || E'\n\n' || 'CATALOGUE READ 2026-09-06 (US-3125): 1,250 products from the brand''s own Shopify feed. 28 colour names on 5+ products seeded as colorways; the vocabulary is distinctive (Blue Nights, Ridge Black, Dune Navy, Abyss Navy, Coastal Sage, Forest Grove, Agona Green). Largest department is Men''s Button Ups at 235 products -- Faherty is a shirt house first. Tag eras, country patterns and authentication tells are unchanged; a product feed cannot answer when a neck label changed.'
       end
 where brand_key = 'faherty';

update public.brand_knowledge
   set updated_by = 'migration:00733',
       notes = case
         when coalesce(notes,'') like '%CATALOGUE READ 2026-09-06%' then notes
         else coalesce(notes,'') || E'\n\n' || 'CATALOGUE READ 2026-09-06 (US-3125): 3,000 products from the brand''s own Shopify feed. 97 colorways seeded. The palette is unusually rich and worth having -- Malbec, Cabernet, Cinnabar, Cordovan, Sagebrush, Madder, Beluga, Delft, Rum Raisin, Tuscan Rose. NOT SEEDED: the commonest option value is Print/Pattern on 1,121 products, which is a placeholder for anything patterned and not a colour. No product lines: the feed carries zero style tags and the brand groups by garment and construction instead.'
       end
 where brand_key = 'peruvianconnection';

update public.brand_knowledge
   set updated_by = 'migration:00733',
       notes = case
         when coalesce(notes,'') like '%CATALOGUE READ 2026-09-06%' then notes
         else coalesce(notes,'') || E'\n\n' || 'CATALOGUE READ 2026-09-06 (US-3125): 549 products from the brand''s own Shopify feed. Product LINES seeded (Wrinkle-Free, Performance, Flannels & Overshirts). COLORWAYS DELIBERATELY NOT SEEDED: the 22 recurring colour names are Blue, Navy, White, Pink, Black, Green, Tan, Red -- plain colour words rather than a brand vocabulary. A colorway earns its place by naming something a seller cannot name themselves, and seeding Blue adds no information while making the table look covered.'
       end
 where brand_key = 'untuckit';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00733') on conflict do nothing;
