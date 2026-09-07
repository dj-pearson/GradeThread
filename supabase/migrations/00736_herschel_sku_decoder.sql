-- US-3125: Herschel's SKU decoder, and the colour codes it resolves.
--
-- Read on 2026-09-06 from the brand's own catalogue with
-- scripts/ops/shopify-brand-harvest.mjs. Herschel SKUs are
--
--     <4-5 digit style>-<4-5 digit colour>-<size>    40123-07175-OS
--
-- -- WHY THIS ONE IS SEEDED AND FREE FLY'S COLOUR GROUP WAS NOT --------------
--
-- 00732 refused to decode Free Fly's middle segment because it looked like a
-- brand-wide colourway id and was a per-style index: 34 of its 133 codes carried
-- more than one colour name, so a mapping would have been confidently wrong
-- about a quarter of the time.
--
-- Herschel was put through exactly the same test and passed it outright:
--
--     224 distinct middle codes
--     224 map to EXACTLY ONE colour name
--       0 ambiguous
--
-- So here the segment really is a colourway id, and 07614 really is Creeper.
-- The decoder captures it, and the codes are attached to the colorway rows as
-- aliases so a code on a care label resolves to the name a buyer searches.
--
-- The shape is also the most consistent in the whole harvest: 1,571 of 1,575
-- SKUs match, against a median nearer a quarter across the 44 brands read.
--
-- Both segments are 4 OR 5 digits, not 5. A strict 5-5 pattern matches 99%% and
-- silently drops 19 SKUs -- including one of Ash Rose's two codes, 0686 -- which
-- is the kind of near-miss that looks like a clean rule right up until someone
-- scans the garment it excludes.
--
-- -- WHAT IS NOT CLAIMED ------------------------------------------------------
--
-- The STYLE segment is not decoded into a product name. 341 style codes
-- appear and the catalogue does not publish a name for each, so a lookup table
-- would be guesswork. The decoder returns the code itself, which is what the
-- live catalogue is keyed on anyway.

insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples,
   source_url, confidence, verified, updated_by)
values
  ('herschelsupplyco', 'style_number',
   'Herschel SKU, and the strongest decoder in the 2026-09-06 catalogue sweep. Shape is <4-5 digit style>-<4-5 digit colour>-<size>, e.g. 40123-07175-OS (OS = one size on bags). 1,571 of 1,575 SKUs match it - 100% to the nearest point, and the most consistent SKU in the whole 44-brand sweep, where the median brand''s dominant shape covers about a quarter of its catalogue. THE MIDDLE SEGMENT IS A REAL COLOURWAY ID, unlike Free Fly''s (00732): all 224 codes seen resolve to exactly one colour name, zero ambiguous, so 07614 is Creeper and 07817 is Asphalt/Black Destroy. Those codes are attached to brand_colorways.aliases, so a code read off a care label resolves to the name a buyer searches. The STYLE segment is returned as a code and NOT translated into a product name: 341 style codes appear and the catalogue publishes no name for each, so a lookup would be guesswork.',
   '^(?<style>\d{4,5})-(?<colorway>\d{4,5})-(?<size>[A-Z0-9/]{1,6})$',
   '[{"field":"styleCode","from":"style"},{"field":"colorway","from":"colorway"},{"field":"size","from":"size"}]'::jsonb,
   '["40123-07175-OS","30227-07175-OS","11863-07175-OS"]'::jsonb,
   'https://herschel.com/products.json', 0.80, false, 'migration:00736')
on conflict do nothing;

-- The colour codes, attached to the colorways 00734 seeded. Only codes that
-- resolve to exactly one colour are used; a code carrying two names would be
-- the Free Fly failure and is dropped rather than guessed at.
do $$
begin
  update public.brand_colorways set aliases = ARRAY['GC100']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = '100';
  update public.brand_colorways set aliases = ARRAY['GC025']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = '25';
  update public.brand_colorways set aliases = ARRAY['GC250']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = '250';
  update public.brand_colorways set aliases = ARRAY['GC050']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = '50';
  update public.brand_colorways set aliases = ARRAY['06537']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Abbey Stone';
  update public.brand_colorways set aliases = ARRAY['07462']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Abstract Bricks Black';
  update public.brand_colorways set aliases = ARRAY['07463']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Abstract Bricks Blue';
  update public.brand_colorways set aliases = ARRAY['07157']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Acai';
  update public.brand_colorways set aliases = ARRAY['08369']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Acid Lime Green';
  update public.brand_colorways set aliases = ARRAY['06584']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Antique Bronze';
  update public.brand_colorways set aliases = ARRAY['02077','0686']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ash Rose';
  update public.brand_colorways set aliases = ARRAY['06361']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ash Rose EQ Camo';
  update public.brand_colorways set aliases = ARRAY['04044']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ash Rose Tonal';
  update public.brand_colorways set aliases = ARRAY['06708']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ash Rose/Gloss Finish';
  update public.brand_colorways set aliases = ARRAY['07817']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Asphalt/Black Destroy';
  update public.brand_colorways set aliases = ARRAY['06746']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Barbados Cherry';
  update public.brand_colorways set aliases = ARRAY['07118']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Barbados Cherry/Black';
  update public.brand_colorways set aliases = ARRAY['06807']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Beech';
  update public.brand_colorways set aliases = ARRAY['01827']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Beetle';
  update public.brand_colorways set aliases = ARRAY['07793']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Bering Sea Diamond/ Dark Denim';
  update public.brand_colorways set aliases = ARRAY['07041']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Bitter Chocolate';
  update public.brand_colorways set aliases = ARRAY['07127']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Bitter Chocolate/Dark Roast';
  update public.brand_colorways set aliases = ARRAY['00001','0001']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black';
  update public.brand_colorways set aliases = ARRAY['07814']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black Block';
  update public.brand_colorways set aliases = ARRAY['07391']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black Diamond/Black';
  update public.brand_colorways set aliases = ARRAY['07525']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black Marled';
  update public.brand_colorways set aliases = ARRAY['02191']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black Reflective';
  update public.brand_colorways set aliases = ARRAY['05881']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black Tonal';
  update public.brand_colorways set aliases = ARRAY['06707']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black/Gloss Finish';
  update public.brand_colorways set aliases = ARRAY['04735']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black/Saddle Brown';
  update public.brand_colorways set aliases = ARRAY['00055']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black/Tan';
  update public.brand_colorways set aliases = ARRAY['01149']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Black/White';
  update public.brand_colorways set aliases = ARRAY['06694']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Blanc De Blanc Tonal';
  update public.brand_colorways set aliases = ARRAY['07413']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Blocked Gray';
  update public.brand_colorways set aliases = ARRAY['04154']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Blue Mirage';
  update public.brand_colorways set aliases = ARRAY['07460']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Blue Mirage Diamond/Sea Storm';
  update public.brand_colorways set aliases = ARRAY['07495']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Blurred Dots';
  update public.brand_colorways set aliases = ARRAY['07550']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Bright Red';
  update public.brand_colorways set aliases = ARRAY['07766']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Bright Red/Black';
  update public.brand_colorways set aliases = ARRAY['08005']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Brown Dog';
  update public.brand_colorways set aliases = ARRAY['07082']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Brown Slate/Delicioso';
  update public.brand_colorways set aliases = ARRAY['07201']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Burgers and Fries';
  update public.brand_colorways set aliases = ARRAY['07150']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Burnt Brick';
  update public.brand_colorways set aliases = ARRAY['07748']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cakes';
  update public.brand_colorways set aliases = ARRAY['07241']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cashmere Rose';
  update public.brand_colorways set aliases = ARRAY['07767']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cashmere Rose/Saddle Brown';
  update public.brand_colorways set aliases = ARRAY['07329']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Check This';
  update public.brand_colorways set aliases = ARRAY['07342']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Check This Confetti';
  update public.brand_colorways set aliases = ARRAY['07343']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Check This Hawaiian Surf';
  update public.brand_colorways set aliases = ARRAY['07787']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Checkerboard';
  update public.brand_colorways set aliases = ARRAY['08251']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cheeseburger';
  update public.brand_colorways set aliases = ARRAY['06332']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cherry Red';
  update public.brand_colorways set aliases = ARRAY['07245']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Chocolate Chip';
  update public.brand_colorways set aliases = ARRAY['07506']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cloud Grid';
  update public.brand_colorways set aliases = ARRAY['07788']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Clover Reflective';
  update public.brand_colorways set aliases = ARRAY['07156']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Confetti';
  update public.brand_colorways set aliases = ARRAY['07333']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Confetti/Saddle Brown';
  update public.brand_colorways set aliases = ARRAY['05488']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cows';
  update public.brand_colorways set aliases = ARRAY['07614']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Creeper';
  update public.brand_colorways set aliases = ARRAY['07136']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cyanotype Flrl-Blk Bty/Irn Gt';
  update public.brand_colorways set aliases = ARRAY['04898']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Cyber Yellow';
  update public.brand_colorways set aliases = ARRAY['07434']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dark Green';
  update public.brand_colorways set aliases = ARRAY['07458']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dark Green/Mountain View';
  update public.brand_colorways set aliases = ARRAY['07394']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dark Gull Gray';
  update public.brand_colorways set aliases = ARRAY['06551']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dark Sea';
  update public.brand_colorways set aliases = ARRAY['07086']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dark Sea/Tan';
  update public.brand_colorways set aliases = ARRAY['04394']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Darkest Navy';
  update public.brand_colorways set aliases = ARRAY['06184']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dazzling Blue';
  update public.brand_colorways set aliases = ARRAY['06792']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'December Sky';
  update public.brand_colorways set aliases = ARRAY['07554']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Deep Depths/Dusty Olive';
  update public.brand_colorways set aliases = ARRAY['07555']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Deep Lichen Plaited';
  update public.brand_colorways set aliases = ARRAY['06818']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Digi Leopard';
  update public.brand_colorways set aliases = ARRAY['07764']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Digi Leopard Light';
  update public.brand_colorways set aliases = ARRAY['06821']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dizzy Daisy';
  update public.brand_colorways set aliases = ARRAY['07288']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dragonfruit Reflective';
  update public.brand_colorways set aliases = ARRAY['07556']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Dusk Plaited';
  update public.brand_colorways set aliases = ARRAY['07404']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Enchanted Garden';
  update public.brand_colorways set aliases = ARRAY['07615']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Enderman';
  update public.brand_colorways set aliases = ARRAY['02112']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Eucalyptus';
  update public.brand_colorways set aliases = ARRAY['07459']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Eucalyptus | Natural';
  update public.brand_colorways set aliases = ARRAY['07027']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Falling Florals';
  update public.brand_colorways set aliases = ARRAY['07405']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Fashion Dogs';
  update public.brand_colorways set aliases = ARRAY['05487']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Flowers';
  update public.brand_colorways set aliases = ARRAY['07395']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'French Blue';
  update public.brand_colorways set aliases = ARRAY['07772']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'French Blue/Saddle Brown';
  update public.brand_colorways set aliases = ARRAY['07790']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'French Oak Diamond/Cobblestone';
  update public.brand_colorways set aliases = ARRAY['07773']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Fuchsia Purple';
  update public.brand_colorways set aliases = ARRAY['06917']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Graphic Daisy';
  update public.brand_colorways set aliases = ARRAY['02973']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Graphite';
  update public.brand_colorways set aliases = ARRAY['07875']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Grass Block';
  update public.brand_colorways set aliases = ARRAY['07792']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Gray Green Diamnd/Winter Moss';
  update public.brand_colorways set aliases = ARRAY['07560']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Green Gables/Vtg White Stitch';
  update public.brand_colorways set aliases = ARRAY['07318']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Grey Crosshatch';
  update public.brand_colorways set aliases = ARRAY['06813']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Grid - Black';
  update public.brand_colorways set aliases = ARRAY['06814']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Grid - London Fog';
  update public.brand_colorways set aliases = ARRAY['07774']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Grid Black/Black';
  update public.brand_colorways set aliases = ARRAY['07781']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Grid Naval Academy/Magnet';
  update public.brand_colorways set aliases = ARRAY['07775']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Grid Pelican/Roasted Cashew';
  update public.brand_colorways set aliases = ARRAY['07782']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'HSC Slime';
  update public.brand_colorways set aliases = ARRAY['07155']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Hawaiian Surf';
  update public.brand_colorways set aliases = ARRAY['07332']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Hawaiian Surf/Saddle Brown';
  update public.brand_colorways set aliases = ARRAY['0096']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heather Black';
  update public.brand_colorways set aliases = ARRAY['0478']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heather Light Gray';
  update public.brand_colorways set aliases = ARRAY['06113','0759']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heather Light Grey';
  update public.brand_colorways set aliases = ARRAY['07347']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heather Light Grey 4-Tone';
  update public.brand_colorways set aliases = ARRAY['07770']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heather Light Grey Reflective';
  update public.brand_colorways set aliases = ARRAY['06210']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heather Light Grey/Black';
  update public.brand_colorways set aliases = ARRAY['07212']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heron';
  update public.brand_colorways set aliases = ARRAY['07334']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Heron/Black';
  update public.brand_colorways set aliases = ARRAY['07393']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Huckleberry';
  update public.brand_colorways set aliases = ARRAY['07783']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Huckleberry Diamond';
  update public.brand_colorways set aliases = ARRAY['04281']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ivy Green';
  update public.brand_colorways set aliases = ARRAY['07784']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ivy Green Diamond';
  update public.brand_colorways set aliases = ARRAY['07070']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ivy Green Tonal';
  update public.brand_colorways set aliases = ARRAY['04488']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ivy Green/Chicory Coffee';
  update public.brand_colorways set aliases = ARRAY['06333']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Laurel Oak';
  update public.brand_colorways set aliases = ARRAY['07768']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Leopard Scribble Black Oyster';
  update public.brand_colorways set aliases = ARRAY['07769']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Leopard Scribble Sesame';
  update public.brand_colorways set aliases = ARRAY['07760']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Light Brown';
  update public.brand_colorways set aliases = ARRAY['07057']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Major Brown';
  update public.brand_colorways set aliases = ARRAY['07531']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Mazarine Blue';
  update public.brand_colorways set aliases = ARRAY['07418']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Mediterranea';
  update public.brand_colorways set aliases = ARRAY['07151']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Metal';
  update public.brand_colorways set aliases = ARRAY['07324']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Metal/Ghost Gray';
  update public.brand_colorways set aliases = ARRAY['07876']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Minecraft Multi';
  update public.brand_colorways set aliases = ARRAY['07794']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Minimal Gray Diamnd/Gray Ridge';
  update public.brand_colorways set aliases = ARRAY['06889']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Monster Trucks';
  update public.brand_colorways set aliases = ARRAY['05854']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Mood Indigo';
  update public.brand_colorways set aliases = ARRAY['07720']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Moody Bloom';
  update public.brand_colorways set aliases = ARRAY['05456']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Moonbeam';
  update public.brand_colorways set aliases = ARRAY['06108']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Moonbeam Tonal';
  update public.brand_colorways set aliases = ARRAY['07076']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Moonbeam/Black';
  update public.brand_colorways set aliases = ARRAY['07128']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Morning Dove/Dark Shadow';
  update public.brand_colorways set aliases = ARRAY['04124']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Natural';
  update public.brand_colorways set aliases = ARRAY['07789']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Nautical Blue Reflective';
  update public.brand_colorways set aliases = ARRAY['00007']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Navy';
  update public.brand_colorways set aliases = ARRAY['06867']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Navy/Gloss Finish';
  update public.brand_colorways set aliases = ARRAY['02564']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Navy/Saddle brown';
  update public.brand_colorways set aliases = ARRAY['03548']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Navy/Tan';
  update public.brand_colorways set aliases = ARRAY['05910']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Oatmeal';
  update public.brand_colorways set aliases = ARRAY['07158']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Oceana';
  update public.brand_colorways set aliases = ARRAY['07818']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Oceana/Dark Navy Destroy';
  update public.brand_colorways set aliases = ARRAY['07081']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ombre Blue/After Midnight';
  update public.brand_colorways set aliases = ARRAY['06811']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Opera Mauve';
  update public.brand_colorways set aliases = ARRAY['07084']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Opera Mauve/Saddle Brown';
  update public.brand_colorways set aliases = ARRAY['07877']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Orange Block';
  update public.brand_colorways set aliases = ARRAY['08004']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Orange Cat';
  update public.brand_colorways set aliases = ARRAY['06501']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Oxblood Red Quilted';
  update public.brand_colorways set aliases = ARRAY['07190']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Paper Garden';
  update public.brand_colorways set aliases = ARRAY['07427']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Paper Garden Strawberry Moon';
  update public.brand_colorways set aliases = ARRAY['07785']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Patches Black';
  update public.brand_colorways set aliases = ARRAY['07786']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Patches Green Gables';
  update public.brand_colorways set aliases = ARRAY['08007']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Pepperoni';
  update public.brand_colorways set aliases = ARRAY['02945']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Pineneedle';
  update public.brand_colorways set aliases = ARRAY['08006']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Pink Daisy';
  update public.brand_colorways set aliases = ARRAY['06800']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Pink Lemonade';
  update public.brand_colorways set aliases = ARRAY['07616']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Pink Sheep';
  update public.brand_colorways set aliases = ARRAY['07777']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Pixel Spray Downtown Brown';
  update public.brand_colorways set aliases = ARRAY['07776']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Pixel Spray Moss Gray';
  update public.brand_colorways set aliases = ARRAY['06827']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Playing Cats';
  update public.brand_colorways set aliases = ARRAY['07511']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Ponderosa Pine';
  update public.brand_colorways set aliases = ARRAY['05655']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Port';
  update public.brand_colorways set aliases = ARRAY['07191']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Race Cars';
  update public.brand_colorways set aliases = ARRAY['07819']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Racing Rd/Brbds Chrry Destroy';
  update public.brand_colorways set aliases = ARRAY['00919']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Raven Crosshatch';
  update public.brand_colorways set aliases = ARRAY['07175']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Realtree APX™ Camo';
  update public.brand_colorways set aliases = ARRAY['07795']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Realtree Edge® Camo Pink/Black';
  update public.brand_colorways set aliases = ARRAY['07796']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Realtree® Edge Camo White/Blck';
  update public.brand_colorways set aliases = ARRAY['07532']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Regatta';
  update public.brand_colorways set aliases = ARRAY['07164']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Rose Violet';
  update public.brand_colorways set aliases = ARRAY['06677']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Rosin';
  update public.brand_colorways set aliases = ARRAY['02759','03272']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Saddle Brown';
  update public.brand_colorways set aliases = ARRAY['06027']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Salsa';
  update public.brand_colorways set aliases = ARRAY['07402']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Scribble Leopard Sachet Pink';
  update public.brand_colorways set aliases = ARRAY['07077']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Shadow Pixel Black';
  update public.brand_colorways set aliases = ARRAY['07073']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Shadow Pixel Moonbeam';
  update public.brand_colorways set aliases = ARRAY['07192']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Sharks';
  update public.brand_colorways set aliases = ARRAY['06536']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Skipper Blue';
  update public.brand_colorways set aliases = ARRAY['06578']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Skyway';
  update public.brand_colorways set aliases = ARRAY['07757']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Snoopy and Woodstock Black';
  update public.brand_colorways set aliases = ARRAY['07759']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Snoopy and Woodstock Pastel Lc';
  update public.brand_colorways set aliases = ARRAY['06810']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Sodalite Blue';
  update public.brand_colorways set aliases = ARRAY['07608']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Sodalite Blue Reflective';
  update public.brand_colorways set aliases = ARRAY['07791']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Soft Silt Dmnd/Chicory Coffee';
  update public.brand_colorways set aliases = ARRAY['08245']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Sprinkle Donut';
  update public.brand_colorways set aliases = ARRAY['06890']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Stencil Checker Opera Mauve';
  update public.brand_colorways set aliases = ARRAY['06891']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Stencil Checker Sodalite Blue';
  update public.brand_colorways set aliases = ARRAY['05486']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Stripes';
  update public.brand_colorways set aliases = ARRAY['07119']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Surf the Wb/Drkst Nvy/Lmn Chrm';
  update public.brand_colorways set aliases = ARRAY['06722']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Tangerine Tango';
  update public.brand_colorways set aliases = ARRAY['02122']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Tango Red';
  update public.brand_colorways set aliases = ARRAY['08008']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Taxi';
  update public.brand_colorways set aliases = ARRAY['07698']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'The End';
  update public.brand_colorways set aliases = ARRAY['07697']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'The Nether';
  update public.brand_colorways set aliases = ARRAY['07696']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'The Overworld';
  update public.brand_colorways set aliases = ARRAY['04523']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Tiger Camo';
  update public.brand_colorways set aliases = ARRAY['07294']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Trailing Floral Heat Emboss';
  update public.brand_colorways set aliases = ARRAY['07149']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Trellis';
  update public.brand_colorways set aliases = ARRAY['07454']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Vapor Diamond/Charcoal Gray';
  update public.brand_colorways set aliases = ARRAY['07390']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Varsity Burgundy';
  update public.brand_colorways set aliases = ARRAY['07319']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Varsity Grey Crosshatch';
  update public.brand_colorways set aliases = ARRAY['07412']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Varsity Pine';
  update public.brand_colorways set aliases = ARRAY['02073']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Vermillion Orange';
  update public.brand_colorways set aliases = ARRAY['07039']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Vintage Khaki';
  update public.brand_colorways set aliases = ARRAY['06726']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Vintage White';
  update public.brand_colorways set aliases = ARRAY['07346']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Vintage White 4-Tone';
  update public.brand_colorways set aliases = ARRAY['07527']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Vintage White Marled';
  update public.brand_colorways set aliases = ARRAY['06793']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Violet Quartz';
  update public.brand_colorways set aliases = ARRAY['04983']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Warp Check';
  update public.brand_colorways set aliases = ARRAY['07398']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Watercolour Dinos Darkest Navy';
  update public.brand_colorways set aliases = ARRAY['01588','06531']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'White';
  update public.brand_colorways set aliases = ARRAY['01821']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'White/Black';
  update public.brand_colorways set aliases = ARRAY['07389']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Wild Daisy Skyway';
  update public.brand_colorways set aliases = ARRAY['05751']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Wild Horses';
  update public.brand_colorways set aliases = ARRAY['06663']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Windward Blue';
  update public.brand_colorways set aliases = ARRAY['00032']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Woodland Camo';
  update public.brand_colorways set aliases = ARRAY['07120']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Woodland Camo/Black';
  update public.brand_colorways set aliases = ARRAY['07129']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Woodland Camo/Black Label';
  update public.brand_colorways set aliases = ARRAY['00332']::text[], updated_by = 'migration:00736'
   where brand_key = 'herschelsupplyco' and color_name = 'Zebra';
end $$;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00736') on conflict do nothing;
