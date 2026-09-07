-- US-3125: nineteen heritage, workwear and surf brands, and colorways for the 3 whose palettes earn it.
--
-- Catalogues read 2026-09-06 with scripts/ops/shopify-brand-harvest.mjs. Same
-- rules as 00734 and 00739 throughout: a colour on five or more products, a
-- brand with at least eight such colours and no more than 35%% plain colour
-- words, base_color and shade from the brand's own facet where it publishes one
-- and aspect-normalize's family table otherwise.
--
-- -- REGISTERED NUMBERS: FIVE OF NINETEEN -----------------------------------
--
--     Duck Camp           RN 167300   Duck Camp LLC
--     Katin               RN 92787    KATIN USA, INC.
--     Marine Layer        RN 140892   MARINE LAYER INC
--     Ministry of Supply  RN 160361   Ministry of Supply
--     Outerknown          RN 144067   OUTERKNOWN LLC
--
-- The other fourteen are REFUSED rather than guessed, and the register makes the
-- reason plain each time. Darn Tough, OluKai and Rothy's return NOTHING, which
-- is a legitimate absence. The rest return a registrant that is not the label:
--
--     Howler Brothers  ->  HEARD DESIGN LLC
--     Linksoul         ->  TEEDUP DF, LLC
--     Mack Weldon      ->  BDB VENTURES, INC.
--     Psycho Bunny     ->  GOD AND GOLD
--     Roark            ->  three hits, none of them the travel label
--
-- Each is probably the operating company. "Probably" is what the Longchamp trap
-- is made of, so each waits for a source that says so.
--
-- -- SIX BRANDS PUBLISH NO COLOUR OPTION AT ALL ------------------------------
--
-- 3sixteen, belstaff, brixton, ironheart, parkhurst, percival, rogueterritory, tombolo, whitesboots carry sizes and NO Color option at all.
-- nicksboots (8 colours, none on 5+ products), railcar (5 colours, none on 5+ products), saturdaysnyc (8 colours, none on 5+ products) publish colours that never recur. They
-- still get a brand row -- the brand is worth knowing -- and their colorways
-- wait for a different source. An empty colorway table for them means the feed
-- does not say, not that the brand has one colour.
--
-- Seeded colours: jkboots (18), onia (23), rvca (58).
-- Palette refused: bather (14 colours, 93%% plain).
-- Palette refused: corridornyc (19 colours, 84%% plain).
-- Palette refused: nakedandfamous (2 colours).
-- Palette refused: schott (34 colours, 56%% plain).
--

insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   notes, source_url, confidence, verified, updated_by)
values

  ('3sixteen', '3sixteen', ARRAY['3sixteen','three sixteen']::text[], ARRAY['denim','selvage','menswear','japanese fabric']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.3sixteen.com/', 0.60, false, 'migration:00743'),
  ('bather', 'Bather', ARRAY['bather']::text[], ARRAY['swim','menswear','resort','trunks']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://bather.com/', 0.60, false, 'migration:00743'),
  ('belstaff', 'Belstaff', ARRAY['belstaff']::text[], ARRAY['motorcycle','waxed cotton','outerwear','heritage']::text[], ARRAY['RN 137608']::text[],
   'RN 137608 is FTC-record sourced -- registrant "BELSTAFF NORTH AMERICA INC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.belstaff.com/', 0.60, false, 'migration:00743'),
  ('brixton', 'Brixton', ARRAY['brixton']::text[], ARRAY['headwear','menswear','california','heritage']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.brixton.com/', 0.60, false, 'migration:00743'),
  ('corridornyc', 'Corridor', ARRAY['corridor','corridor nyc','corridornyc']::text[], ARRAY['menswear','shirts','embroidery','new york']::text[], ARRAY['RN 155582']::text[],
   'RN 155582 is FTC-record sourced -- registrant "Corridor Clothiers LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://corridornyc.com/', 0.60, false, 'migration:00743'),
  ('ironheart', 'Iron Heart', ARRAY['iron heart','ironheart']::text[], ARRAY['denim','heavyweight','selvage','japanese']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.ironheart.co.uk/', 0.60, false, 'migration:00743'),
  ('jkboots', 'JK Boots', ARRAY['jk boots','jkboots','j.k. boots']::text[], ARRAY['footwear','boots','work boots','made in usa']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://jkboots.com/', 0.60, false, 'migration:00743'),
  ('nakedandfamous', 'Naked & Famous Denim', ARRAY['naked and famous','naked & famous','nakedandfamous']::text[], ARRAY['denim','selvage','japanese fabric','novelty']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.nakedandfamousdenim.com/', 0.60, false, 'migration:00743'),
  ('nicksboots', 'Nicks Boots', ARRAY['nicks boots','nicksboots','nick s boots']::text[], ARRAY['footwear','boots','work boots','made in usa']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://nicksboots.com/', 0.60, false, 'migration:00743'),
  ('onia', 'Onia', ARRAY['onia']::text[], ARRAY['swim','resort','menswear','womenswear']::text[], ARRAY['RN 124917']::text[],
   'RN 124917 is FTC-record sourced -- registrant "ONIA LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://onia.com/', 0.60, false, 'migration:00743'),
  ('parkhurst', 'Parkhurst', ARRAY['parkhurst','parkhurst brand']::text[], ARRAY['knitwear','menswear','made in usa']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://parkhurstbrand.com/', 0.60, false, 'migration:00743'),
  ('percival', 'Percival', ARRAY['percival','percival clo']::text[], ARRAY['menswear','knitwear','london','print']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.percivalclo.com/', 0.60, false, 'migration:00743'),
  ('railcar', 'Railcar Fine Goods', ARRAY['railcar','railcar fine goods']::text[], ARRAY['denim','made in usa','workwear']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.railcarfinegoods.com/', 0.60, false, 'migration:00743'),
  ('rogueterritory', 'Rogue Territory', ARRAY['rogue territory','rogueterritory','rgt']::text[], ARRAY['denim','workwear','made in usa','selvage']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.rogueterritory.com/', 0.60, false, 'migration:00743'),
  ('rvca', 'RVCA', ARRAY['rvca','ruca']::text[], ARRAY['surf','skate','menswear','art']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.rvca.com/', 0.60, false, 'migration:00743'),
  ('saturdaysnyc', 'Saturdays NYC', ARRAY['saturdays nyc','saturdaysnyc','saturdays new york city']::text[], ARRAY['surf','menswear','new york','casual']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.saturdaysnyc.com/', 0.60, false, 'migration:00743'),
  ('schott', 'Schott NYC', ARRAY['schott','schott nyc','schott bros']::text[], ARRAY['leather jackets','peacoat','heritage','made in usa']::text[], ARRAY['RN 18606']::text[],
   'RN 18606 is FTC-record sourced -- registrant "SCHOTT NYC CORP.". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.schottnyc.com/', 0.60, false, 'migration:00743'),
  ('tombolo', 'Tombolo', ARRAY['tombolo','tombolo company']::text[], ARRAY['camp shirts','print','menswear','resort']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://tombolocompany.com/', 0.60, false, 'migration:00743'),
  ('whitesboots', 'White''s Boots', ARRAY['whites boots','white s boots','whitesboots']::text[], ARRAY['footwear','boots','work boots','made in usa']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://whitesboots.com/', 0.60, false, 'migration:00743')
on conflict (brand_key) do nothing;

insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, base_color, shade,
   source_url, confidence, verified, updated_by)
values

  ('jkboots', 'Arrowhead Heritage Leather', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Bison Pebbled/Rough Leather', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Black Smooth Leather', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Black Smooth/Rough Leather', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Brown Smooth Leather', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Brown Smooth/Rough Leather', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Chocolate', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Coal', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Cognac', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Dune', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Harvest Heritage Leather', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Midnight', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Oxblood Heritage Leather', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Pheasant Heritage Leather', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Redwood', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Redwood Smooth/Rough Leather', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('jkboots', 'Trapper Heritage Leather', ARRAY[]::text[], NULL, NULL, null, null, 'https://jkboots.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Baby Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Black/White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Brown', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Brown/White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Deep Navy', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Egret', ARRAY[]::text[], NULL, NULL, null, null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Egret/Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Espresso', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Forest', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Midnight', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Midnight/Egret', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Mist Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Noir Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Ochre', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Sage', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Sky', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Sky/Egret', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Sky/White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'Stone', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('onia', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://onia.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Amethyst Smoke', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Antique White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Aqua Haze', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Army', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Balsam Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Blue Belt', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Blue Hawaii', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Blue Haze', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Brown Stone', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Camo', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Ceramic', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Chocolate', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Cloud', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Cocoa', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Coyote', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Crystal Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Dark Denim', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Duck Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Fatigue', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Flame Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Garage Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Green Tea', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Heather Grey', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Hunter Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Khaki', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Lead', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Light Blue', ARRAY[]::text[], NULL, NULL, 'Blue', 'Light', 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Light Khaki', ARRAY[]::text[], NULL, NULL, 'Beige', 'Light', 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Light Tan', ARRAY[]::text[], NULL, NULL, 'Tan', 'Light', 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Madder Brown', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Marine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Martini Olive Print', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Mocha', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Moody Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Moss', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Mushroom', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Natural', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Ochre', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Olive', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Orchid', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Pale Mauve', ARRAY[]::text[], NULL, NULL, 'Purple', 'Light', 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Pine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Pirate Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'RVCA Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Red Earth', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Rvca Black Floral', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Sage Leaf', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Sky Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Smoke', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Sunshine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Tan', ARRAY[]::text[], NULL, NULL, 'Tan', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Vintage Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Vintage White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Washed Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'Whisper White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743'),
  ('rvca', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.rvca.com/products.json', 0.75, false, 'migration:00743')
on conflict do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00743') on conflict do nothing;
