-- US-3125: Free Fly, a FULL pack -- colorways, product lines and a style-code
-- decoder, all from the brand's own catalogue.
--
-- 00731 seeded Free Fly as a minimal row: identity, category focus and an
-- FTC-sourced RN, with tag_eras/country_patterns/authentication_tells empty and
-- the notes saying so. This is the other half.
--
-- -- THE SOURCE IS THE BRAND'S OWN CATALOGUE --------------------------------
--
-- freeflyapparel.com runs Shopify, which serves /products.json by default.
-- 1,008 products read on 2026-09-06 with scripts/ops/shopify-brand-harvest.mjs.
-- That is FIRST-PARTY: "Storm Cloud" is the brand's name for the colour, not a
-- reseller's guess at "grey", and the size run is the brand's own run.
--
-- WARNING: THIS IS NOT SCRAPING A SITE THAT SAID NO. petermillar.com serves an
-- Imperva block page to automation -- and serves it as HTTP 200, so a status
-- check reads it as success. The harvester THROWS on a 200 whose body is not the
-- feed, for exactly that reason. Free Fly publishes this endpoint; Peter Millar
-- does not, and that is why PM still has zero colorways.
--
-- -- COLORWAYS: 56 of 206, and the cut is deliberate ------------------------
--
-- The catalogue carries 206 distinct colour names. Seeded here are the 56 that
-- appear on FIVE OR MORE products -- a house colour rather than a one-off
-- capsule or a collab. The tail is real but it is not knowledge: a colour on a
-- single discontinued shirt helps nobody grade or list.
--
-- WARNING: NO HEX VALUES, DELIBERATELY. The feed publishes colour NAMES and not
-- colour VALUES. Eyedropping a hex from a product photo would be a guess wearing
-- a fact's clothing -- lighting, fabric and JPEG compression all move it -- so
-- the column stays null until the brand publishes one. US-3127 AC4 says this in
-- general; this is the first pack it applies to.

insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('freefly', 'Black', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Storm Cloud', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Ocean Mist', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Pacific Blue', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Black Sand', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Sea Pine', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Plum', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Vintage Camo Oil Green', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Bright White', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Dark Forest', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Smokey Olive', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Vintage Camo', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Bone', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Cement', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Fossil', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Anthracite', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Fig', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Heather Birch', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Dark Khaki', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Off White Heather', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Stone', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Birch', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Deep Navy', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Heather Black', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Stormy Sea', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Clear Sky', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Fatigue', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Tropic Sea', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Desert Tan', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Heather Grey', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Smoke', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Windward Blue', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Blue Fog', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Calypso Print Light Coral', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Coriander', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Heather Aspen Grey', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Nolia Floral Print Stone', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Redwood', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Sandstone', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Sea Salt', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Tea', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Floral Camo', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Light Heather Grey', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Slate Blue', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Vintage Camo Black', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Woodland Camo', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Aspen Grey', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Bluestone', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Bright Lavender', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Chestnut', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'French Oak', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Heather Sea Pine', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Light Coral', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Rust', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Sand Dune', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'True Navy', ARRAY[]::text[], NULL, NULL, 'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732')
on conflict do nothing;

-- -- PRODUCT LINES ----------------------------------------------------------
--
-- Derived by counting the brand's own `product_style:` tags across 1,008
-- products. These are the fabric/construction PLATFORMS Free Fly builds on, and
-- they recur across departments -- a "Bamboo Shade Hoodie" exists in Mens,
-- Womens, Youth and Toddler. That is what makes them lines rather than styles.

insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified,
   updated_by)
values
  ('freefly', 'Breeze', ARRAY['breeze','active breeze','pull-on breeze']::text[],
   'Breeze', 'Unisex', 'line', 'Woven quick-dry shorts and pants platform; named by inseam (Breeze Short 6, 8; Skort 13, 15).',
   ARRAY['woven','quick-dry']::text[],   ARRAY['breeze','short','skort','pant','inseam']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Bamboo Lightweight', ARRAY['bamboo lightweight','lwh','bamboo lightweight fleece']::text[],
   'Bamboo Lightweight', 'Unisex', 'line', 'The core bamboo-viscose jersey platform, and the widest line in the catalogue. "Bamboo Lightweight Fleece" is the brushed-back weight of the same platform, not a separate line.',
   ARRAY['bamboo viscose','jersey']::text[],   ARRAY['bamboo','lightweight','hoodie','fleece','crew','jogger']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Bamboo Shade', ARRAY['bamboo shade','shade hoodie']::text[],
   'Bamboo Shade', 'Unisex', 'line', 'Sun-protection bamboo layer -- hoodies and long sleeves. Runs across Mens, Womens, Youth AND Toddler, which is the tell that Shade is a platform rather than a style.',
   ARRAY['bamboo viscose','sun protection']::text[],   ARRAY['bamboo','shade','sun','upf','hoodie','long sleeve']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Elevate', ARRAY['elevate','elevate lightweight']::text[],
   'Elevate', 'Unisex', 'line', 'Lightweight performance knit -- tees, tanks, hoodies and a polo. Distinct from the bamboo platforms.',
   ARRAY['performance knit']::text[],   ARRAY['elevate','lightweight','tee','tank','polo','hoodie']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Northcoast Fleece', ARRAY['northcoast','north coast','northcoast fleece']::text[],
   'Northcoast Fleece', 'Unisex', 'line', 'Heavier fleece platform; pullover hoodies and crews.',
   ARRAY['fleece']::text[],   ARRAY['northcoast','fleece','pullover','crew']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'All Day', ARRAY['all day','all day pocket']::text[],
   'All Day', 'Women', 'line', 'Womens leggings and pocket shorts platform.',
   ARRAY['stretch knit']::text[],   ARRAY['all day','legging','pocket','short']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Seawool', ARRAY['seawool']::text[],
   'Seawool', 'Unisex', 'line', 'Wool-blend platform; flannel shirts. The smallest named line in the catalogue.',
   ARRAY['wool blend','seawool']::text[],   ARRAY['seawool','wool','flannel','shirt']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Bamboo Flex', ARRAY['bamboo flex','flex pocket tee','flex polo']::text[],
   'Bamboo Flex', 'Unisex', 'line', 'Stretch bamboo platform -- pocket tees and polos.',
   ARRAY['bamboo viscose','stretch']::text[],   ARRAY['bamboo','flex','pocket tee','polo']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Motion', ARRAY['motion','motion boxer','bamboo motion']::text[],
   'Motion', 'Men', 'line', 'Mens bamboo underwear platform (Motion Boxer Brief).',
   ARRAY['bamboo viscose']::text[],   ARRAY['motion','boxer','brief','underwear']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732'),
  ('freefly', 'Palmera', ARRAY['palmera','palmera trunk']::text[],
   'Palmera', 'Men', 'line', 'Mens swim trunk platform.',
   ARRAY['woven','swim']::text[],   ARRAY['palmera','trunk','swim','board short']::text[],
   'https://freeflyapparel.com/products.json', 0.75, false, 'migration:00732')
on conflict do nothing;

-- -- STYLE CODE --------------------------------------------------------------
--
-- Free Fly SKUs are <STYLE>-<COLOUR>-<SIZE>, e.g. WRIBLS-672-XS, and an older
-- two-part form that runs the style and colour together, e.g. BBB447-S.
--
-- WARNING: THE MIDDLE THREE DIGITS ARE A COLOUR SLOT AND THIS DECODER REFUSES TO
-- DECODE THEM, which is the whole reason this entry is worth having. It looks
-- like a brand-wide colourway id and it is not. Measured across the catalogue:
-- 133 distinct three-digit codes, of which 99 map to exactly one colour name
-- and 34 DO NOT --
--
--     447  ->  Slate Blue        AND  Storm Cloud
--     672  ->  Charcoal, Desert Tan, Plum
--     719  ->  Black, Storm Cloud, Woodland Camo
--
-- so the code is a per-style colour INDEX, not a brand-wide identifier. A
-- decoder that emitted "672 = Charcoal" would be wrong roughly a quarter of the
-- time, and confidently. The capture therefore takes STYLE and SIZE only, and
-- the colour group is deliberately non-capturing.
--
-- This is the decoder bar's fourth question in another form: what does this part
-- of the identifier actually name? Here, only the brand knows.

insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples,
   source_url, confidence, verified, updated_by)
values
  ('freefly', 'style_number',
   'Free Fly SKU, used as the catalogue key and printed on the size/care label. Shape is <STYLE>-<COLOUR>-<SIZE> (WRIBLS-672-XS), with an older run-together form <STYLE><COLOUR>-<SIZE> (BBB447-S). The style token is letters, or letters followed by digits, and is stable across colours and sizes -- BBB is the Bamboo Motion Boxer Brief in both 310 and 447. THE THREE-DIGIT MIDDLE GROUP IS NOT DECODED ON PURPOSE: it is a per-style colour index, not a brand-wide colourway id. 133 codes seen, 34 of them carrying more than one colour name across styles (447 is Slate Blue and Storm Cloud; 672 is Charcoal, Desert Tan and Plum), so any mapping would be confidently wrong about a quarter of the time. Recovers the BRAND and the STYLE off a care label when the neck tag has been cut out.',
   '^(?<style>[A-Z]{2,6}\d{0,4})-?(?:\d{3})-(?<size>[0-9A-Z]{1,5})$',
   '[{"field":"styleCode","from":"style"},{"field":"size","from":"size"}]'::jsonb,
   '["WRIBLS-672-XS","BBB447-S","MRVBS-325-XL"]'::jsonb,
   'https://freeflyapparel.com/products.json', 0.70, false, 'migration:00732')
on conflict do nothing;

-- -- WHAT IS NOT HERE ---------------------------------------------------------
--
-- SIZE CHARTS. The feed gives the size RUN and not the size CHART: alpha
-- XS-XXXL, toddler 2T-5T, mens waist 28-40 and waist x inseam 30x30-40x32,
-- womens numeric 0-16. That is real and useful, but brand_size_charts exists to
-- hold BODY MEASUREMENTS, and inventing inches to fill it would be the exact
-- failure the resolver is meant to prevent. The run goes in the brand notes
-- instead, and a chart waits for a sourced measurement table.
--
-- TAG ERAS, COUNTRY PATTERNS, AUTHENTICATION TELLS. Still empty, still not
-- researched, and 00731's notes still say so. A product feed cannot answer when
-- a neck label changed.

update public.brand_knowledge
   set confidence = 0.70,
       updated_by = 'migration:00732',
       notes = case
         when coalesce(notes,'') like '%SIZE RUN%' then notes
         else coalesce(notes,'') || E'\n\n' ||
              'CATALOGUE READ 2026-09-06 (US-3125), 1,008 products from the brand''s own ' ||
              'Shopify feed: 206 distinct colour names (56 seeded, those on 5+ products), ' ||
              '10 product lines and a decodable SKU. SIZE RUN, recorded here because it ' ||
              'is not a measurement chart: alpha XS-XXXL, toddler 2T-5T, mens waist 28-40 ' ||
              'and waist x inseam 30x30-40x32, womens numeric 0-16. Departments: Womens, ' ||
              'Mens, Youth, Toddler, Hats, Beanies, plus a little footwear. Tag eras, ' ||
              'country patterns and authentication tells remain NOT RESEARCHED.'
       end
 where brand_key = 'freefly';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00732') on conflict do nothing;
