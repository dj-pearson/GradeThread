-- US-3125: seventeen golf, denim and British menswear brands.
--
-- Catalogues read 2026-09-07 with scripts/ops/shopify-brand-harvest.mjs. Same
-- rules as 00734 and 00739: a colour on five or more products, a brand with at
-- least eight such colours and no more than 35% plain colour words, base_color
-- and shade from the brand's own facet where it publishes one and
-- aspect-normalize's family table otherwise.
--
-- Crown Northampton also probed as a feed and could not be harvested; it is
-- absent rather than refused, and worth retrying.
--
-- -- REGISTERED NUMBERS: FIVE OF SEVENTEEN -----------------------------------
--
--     Fair Harbor   RN 155448   Fair Harbor Clothing Inc   [Women's and Men's apparel]
--     LOHLA Sport   RN 162861   LOHLA SPORT, LLC           [Women's apparel]
--     Primo Golf    RN 177757   Primo Golf LLC
--     Triarchy      RN 133772   TRIARCHY DESIGN, LLC       [BLOUSES BAGS SHIRTS JEANS DRESSES]
--     Warp + Weft   RN 154221   Warp + Weft LLC            [Baby Children's Men's Women's]
--
-- -- FAIR HARBOR IS THE VINTAGE RULE AT ITS MOST USEFUL ----------------------
--
-- The register returns TWO plausible Fair Harbors:
--
--     RN 155448   Fair Harbor Clothing Inc      [Women's and Men's apparel]
--     RN 72499    FAIR HARBOR SPORTSWEAR, INC.
--
-- Both keep the label. Both add only a generic trade word. On the name test
-- alone this is the Primitive ambiguity from 00747 and the honest answer would
-- be to refuse both. The NUMBER separates them: 72499 sits well below Stussy's
-- 94974 and so was issued decades before Fair Harbor was founded in 2014, while
-- 155448 sits alongside the other 2010s brands in this corpus.
--
-- 00750 introduced that rule as a way to REJECT a hit. This is the first time it
-- has been used to CHOOSE between two, which is the more valuable job. Bear
-- Bottom is the plain rejection in the same run: BEAR BOTTOMS at 49079 and BEAR
-- BOTTOM BABY PRODUCTS at 90484 are both far too early for a 2014 brand.
--
-- -- TWELVE REFUSED ----------------------------------------------------------
--
-- Albam, Blackhorse Lane, Boyish, Folk, Foray Golf, Kestin, Oliver Spencer,
-- State the Label and Wax London return NOTHING -- and seven of those nine are
-- British or Australian, which is the 00752 finding again from a different
-- angle. A label that does not manufacture for the US market has no reason to
-- hold a US registered number.
--
-- Devereux returns three registrations all held by 13 STRIPES, LP, and Straight
-- Down returns ROWLEY MILLER SPORTS INC. Both are very probably the operating
-- company and neither name shares a token with its label, so both wait for a
-- source that says so.
--
-- -- COLOURS ----------------------------------------------------------------
--
-- Seeded: devereux (10), straightdown (93).
-- Palette refused, too few or too plain: bearbottom (37, 38% plain), boyish (2), foraygolf (14, 57% plain), lohlasport (7), primogolf (10, 60% plain), triarchy (1).
-- No colour survives the filter: albam (0 raw), blackhorselane (4 raw), fairharbor (0 raw), folkclothing (0 raw), kestin (0 raw), oliverspencer (0 raw), statethelabel (0 raw), warpweft (0 raw), waxlondon (0 raw).
--
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   notes, source_url, confidence, verified, updated_by)
values

  ('albam', 'Albam', ARRAY['albam','albam clothing']::text[], ARRAY['menswear','british','workwear','utility']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.albamclothing.com/', 0.60, false, 'migration:00754'),
  ('bearbottom', 'Bear Bottom', ARRAY['bear bottom','bearbottom','bear bottom clothing']::text[], ARRAY['menswear','shorts','basics','casual']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://bearbottomclothing.com/', 0.60, false, 'migration:00754'),
  ('blackhorselane', 'Blackhorse Lane Ateliers', ARRAY['blackhorse lane','blackhorse lane ateliers','blackhorselane']::text[], ARRAY['denim','selvedge','british','made in london']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://blackhorselane.com/', 0.60, false, 'migration:00754'),
  ('boyish', 'Boyish Jeans', ARRAY['boyish','boyish jeans']::text[], ARRAY['denim','womenswear','sustainable','vintage-inspired']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://boyish.com/', 0.60, false, 'migration:00754'),
  ('devereux', 'Devereux', ARRAY['devereux','devereux golf','dvx']::text[], ARRAY['golf','menswear','polo','lifestyle']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://devereuxgolf.com/', 0.60, false, 'migration:00754'),
  ('fairharbor', 'Fair Harbor', ARRAY['fair harbor','fairharbor','fair harbor clothing']::text[], ARRAY['swim','boardshorts','menswear','recycled']::text[], ARRAY['RN 155448']::text[],
   'RN 155448 is FTC-record sourced -- registrant "Fair Harbor Clothing Inc". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://fairharborclothing.com/', 0.60, false, 'migration:00754'),
  ('folkclothing', 'Folk', ARRAY['folk','folk clothing','folkclothing']::text[], ARRAY['menswear','british','utility','contemporary']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.folkclothing.com/', 0.60, false, 'migration:00754'),
  ('foraygolf', 'Foray Golf', ARRAY['foray','foray golf','foraygolf']::text[], ARRAY['golf','womenswear','polo','performance']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://foraygolf.com/', 0.60, false, 'migration:00754'),
  ('kestin', 'Kestin', ARRAY['kestin','kestin hare']::text[], ARRAY['menswear','scottish','utility','outerwear']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://kestin.co/', 0.60, false, 'migration:00754'),
  ('lohlasport', 'LOHLA Sport', ARRAY['lohla','lohla sport','lohlasport']::text[], ARRAY['golf','womenswear','activewear','performance']::text[], ARRAY['RN 162861']::text[],
   'RN 162861 is FTC-record sourced -- registrant "LOHLA SPORT, LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://lohlasport.com/', 0.60, false, 'migration:00754'),
  ('oliverspencer', 'Oliver Spencer', ARRAY['oliver spencer','oliverspencer']::text[], ARRAY['menswear','british','tailoring','contemporary']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.oliverspencer.co.uk/', 0.60, false, 'migration:00754'),
  ('primogolf', 'Primo Golf', ARRAY['primo','primo golf','primo golf apparel']::text[], ARRAY['golf','menswear','polo','performance']::text[], ARRAY['RN 177757']::text[],
   'RN 177757 is FTC-record sourced -- registrant "Primo Golf LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://primogolfapparel.com/', 0.60, false, 'migration:00754'),
  ('statethelabel', 'State the Label', ARRAY['state','state the label','statethelabel']::text[], ARRAY['womenswear','linen','australian','resort']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.statethelabel.com/', 0.60, false, 'migration:00754'),
  ('straightdown', 'Straight Down', ARRAY['straight down','straightdown']::text[], ARRAY['golf','menswear','polo','california']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.straightdown.com/', 0.60, false, 'migration:00754'),
  ('triarchy', 'Triarchy', ARRAY['triarchy']::text[], ARRAY['denim','sustainable','womenswear','waterless']::text[], ARRAY['RN 133772']::text[],
   'RN 133772 is FTC-record sourced -- registrant "TRIARCHY DESIGN, LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://triarchy.com/', 0.60, false, 'migration:00754'),
  ('warpweft', 'Warp + Weft', ARRAY['warp + weft','warp and weft','warpweft','warp weft']::text[], ARRAY['denim','size inclusive','sustainable','jeans']::text[], ARRAY['RN 154221']::text[],
   'RN 154221 is FTC-record sourced -- registrant "Warp + Weft LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://warpweftworld.com/', 0.60, false, 'migration:00754'),
  ('waxlondon', 'Wax London', ARRAY['wax london','waxlondon','wax']::text[], ARRAY['menswear','british','knitwear','contemporary']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.waxlondon.com/', 0.60, false, 'migration:00754')
on conflict (brand_key) do nothing;

insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, base_color, shade,
   source_url, confidence, verified, updated_by)
values

  ('devereux', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Black / White', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Bone', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Faded Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Marine Layer', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Mineral', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Succulent Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'Western Sky', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('devereux', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://devereuxgolf.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Amethyst', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Bering', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Blue Shade', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Blueberry', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Bronze', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Camo Carbon', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Camo Indigo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Camo Petrol', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Cantalope', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Carbon', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Carolina', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Cascade', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Cashew', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Celery', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Chambray', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Charcoal', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Charcoal Heather', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Coastal', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Coconut', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Cosmic', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Cream', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Dark Black', ARRAY[]::text[], NULL, NULL, 'Black', 'Dark', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Dark Forest', ARRAY[]::text[], NULL, NULL, 'Green', 'Dark', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Dark Grey Heather', ARRAY[]::text[], NULL, NULL, 'Gray', 'Dark', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Dark Raspberry', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Flag Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Gemstone', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Geranium', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Haze', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Heather', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Herb', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Indigo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Ink', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Lake', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Lavender', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Light Grey Heather', ARRAY[]::text[], NULL, NULL, 'Gray', 'Light', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Light Khaki', ARRAY[]::text[], NULL, NULL, 'Beige', 'Light', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Light Mint', ARRAY[]::text[], NULL, NULL, 'Green', 'Light', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Light Pink', ARRAY[]::text[], NULL, NULL, 'Pink', 'Light', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Lilac', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Lilac / Tidal', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Maison', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Mineral', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Mint', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Moonlight', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Moss', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Mulberry', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Nantucket', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'New Heather', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'New Indigo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'New Indigo / Flag Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'New Indigo / Lilac', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'New Indigo / White / Flag Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Niagara', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Oatmeal', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Ocean', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Olive', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Oxblood', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Pale Pink', ARRAY[]::text[], NULL, NULL, 'Pink', 'Light', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Pale Yellow', ARRAY[]::text[], NULL, NULL, 'Yellow', 'Light', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Pearl', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Peonie', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Petrol', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Pink Dawn', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Pink Floyd', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Pink Floyd / Moonlight', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Pink Lemonade', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Powder', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Provence', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Punch', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Rosewine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Sage', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Sandstone', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Sea Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Sea Spray', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Shine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Silver', ARRAY[]::text[], NULL, NULL, 'Silver', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Skipper', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Soft Pink', ARRAY[]::text[], NULL, NULL, 'Pink', 'Light', 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Spritz', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Stone', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Storm', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Sunshine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Tidal', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'Violet', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'White / Flag Red / New Indigo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'White / New Indigo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754'),
  ('straightdown', 'White Indigo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.straightdown.com/products.json', 0.75, false, 'migration:00754')
on conflict do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00754') on conflict do nothing;
