-- US-3125: twenty-two workwear, sleepwear, uniform and sport brands, plus a repair.
--
-- Catalogues read 2026-09-07 with scripts/ops/shopify-brand-harvest.mjs. Same
-- rules as 00734 and 00739 throughout: a colour on five or more products, a
-- brand with at least eight such colours and no more than 35% plain colour
-- words, base_color and shade from the brand's own facet where it publishes one
-- and aspect-normalize's family table otherwise.
--
-- -- REGISTERED NUMBERS: ELEVEN OF TWENTY-TWO --------------------------------
--
--     Bad Birdie       RN 158230   Bad Birdie LLC          [Men's and Women's apparel]
--     Cinch            RN 133773   CINCH, LLC              [WOMEN'S ACTIVEWEAR]
--     Jaanuu           RN 142367   JAANUU, INC.            [WOMEN'S AND MEN'S CLOTHING]
--     Lake Pajamas     RN 158314   LAKE WEEKEND WEAR LLC   [WOMEN'S APPAREL]
--     Lunya            RN 141460   LUNYA                   [SHIRTS SLEEPWEAR BLOUSES DRESSES]
--     Malbon Golf      RN 159657   Malbon Golf, LLC.       [Men's apparel]
--     NOBULL           RN 151714   NOBULL, INC.            [APPAREL ACCESSORIES ATHLETIC FOOTWEAR]
--     Pactimo          RN 137181   Pactimo, LLC            [SPORTS APPAREL]
--     Printfresh       RN 159907   Printfresh LLC          [Women's apparel]
--     Rowing Blazers   RN 153752   Rowing Blazers LTD      [Men's apparel]
--     Ten Thousand     RN 147972   TEN THOUSAND, INC.      [ACTIVEWEAR SHORTS PANTS SHIRTS]
--
-- Two carry a caveat worth writing down rather than smoothing over. CINCH, LLC
-- is the only exact-name registrant among seven hits, so it passes the name
-- test, but its product line reads WOMEN'S ACTIVEWEAR while Cinch is western
-- menswear denim. Register product lines are often narrow or stale and the name
-- is the rule, so it is seeded -- and flagged here, because a future reader
-- checking this RN against the brand deserves to know the mismatch was seen.
--
-- LAKE WEEKEND WEAR LLC keeps the label's distinctive token ("Lake") and swaps
-- the product noun for generic trade words, which the 00743 rule permits.
--
-- -- ELEVEN REFUSED ----------------------------------------------------------
--
-- Nisolo, PANGAIA, Sunspel, Tea Collection, Universal Works and Xtratuf return
-- NOTHING. A legitimate absence, not a failed lookup.
--
-- Five return a registrant that is not the label, which is the Billabong shape
-- from 00747 three more times over:
--
--     BRUNT Workwear   ->  Maverick Work Wear, Inc.
--     Eberjey          ->  WORLD THREADS INC        [LINGERIE SLEEPWEAR SWIMWEAR]
--     Pair of Thieves  ->  Stateside Merchancts, LLC   (the register's own typo)
--     Smartwool        ->  VF OUTDOOR, LLC
--     Lo & Sons        ->  seventeen "& Sons" registrants, none of them the label
--
-- Eberjey and Smartwool are the tempting ones: a lingerie-and-sleepwear product
-- line fits Eberjey exactly, and VF really does own Smartwool. Neither name
-- shares a token with its label, and a matching product line breaks a tie
-- between same-name registrants -- it never stands in for a name.
--
-- -- COLOURS ----------------------------------------------------------------
--
-- Seeded: jaanuu (44), loandsons (61), lunya (12), malbongolf (45), pactimo (10), pangaia (11), smartwool (51), teacollection (67), tenthousand (28), xtratuf (137).
-- Palette refused, too few or too plain: bruntworkwear (12, 42% plain), cinch (19, 79% plain), pairofthieves (6), rowingblazers (24, 67% plain).
-- No colour survives the filter: badbirdie (0 raw), eberjey (0 raw), lakepajamas (2 raw), nisolo (0 raw), printfresh (2 raw), sunspel (0 raw), universalworks (0 raw).
-- Feed refused us outright (HTTP 503, every attempt): nobull.
--
-- Those brands still get a KB row, because the brand is worth knowing. An empty
-- colorway set means the feed does not say, never that the brand has one colour.
--
-- -- FIRST, A REPAIR: 00747 CREATED TWO DUPLICATE BRANDS --------------------
--
-- 00456 and 00462 minted brand keys by STRIPPING accented characters rather
-- than transliterating them, so Stuessy became `stssy` and Aime Leon Dore
-- became `aimleondore`. That was deliberate and is pinned by
-- brand-knowledge-golden_test.ts, which even names it "the Stussy 'stssy'
-- lesson". Those keys stay.
--
-- 00747 did not know that, minted the obvious `stussy` and `aimeleondore`, and
-- so seeded two brands the KB already had. This folds the new rows back into
-- the established keys -- the registered numbers and the 26 Aime Leon Dore
-- colorways survive, the duplicate rows do not -- and leaves the golden test
-- and its keys untouched.
--
-- The lesson generalises: `herms` (Hermes) and `szane` (Sezane) carry the same
-- shape. Before seeding a brand whose name has an accent, check for the
-- stripped key as well as the obvious one.

update public.brand_colorways c set brand_key = 'aimleondore'
 where c.brand_key = 'aimeleondore'
   and not exists (select 1 from public.brand_colorways x
                    where x.brand_key = 'aimleondore' and x.color_name = c.color_name);
delete from public.brand_colorways where brand_key = 'aimeleondore';

-- The two rows above cannot be UPDATED until their tag_eras carry provenance.
--
-- `brand_knowledge_tag_eras_sourced` is a NOT VALID check, so it never looked at
-- the rows that already existed -- but Postgres DOES check any row an UPDATE
-- touches, so adding a registered number to a 2026-07 brand row fails on a
-- constraint about something else entirely. That is the whole trap: the
-- constraint is invisible until you write.
--
-- ⚠ 90 rows currently fail it, not the 11 US-3126 records. Whoever picks that
-- story up should re-measure before planning it, and should expect this failure
-- on ANY future migration that updates an existing brand row.
--
-- The fix here is deliberately narrow: for these two rows only, each datable era
-- inherits the source_url and confidence the ROW already asserts. That is a
-- restatement of an existing claim, not new research, which is why it is safe to
-- do without a citation hunt -- and why it is not applied to the other 88.

update public.brand_knowledge k
   set tag_eras = (
     select jsonb_agg(
              case when coalesce(e ->> 'years', '') ~ '(\d{4}|\d0s)'
                    and (coalesce(e ->> 'source_url', '') = ''
                         or jsonb_typeof(e -> 'confidence') is distinct from 'number')
                   then e || jsonb_build_object('source_url', k.source_url,
                                                'confidence', k.confidence)
                   else e end)
       from jsonb_array_elements(k.tag_eras) e)
 where k.brand_key in ('aimleondore', 'stssy')
   and not public.tag_eras_all_sourced(k.tag_eras);

update public.brand_knowledge set registered_numbers = ARRAY['RN 142781']::text[]
 where brand_key = 'aimleondore' and cardinality(registered_numbers) = 0;
update public.brand_knowledge set registered_numbers = ARRAY['RN 94974']::text[]
 where brand_key = 'stssy' and cardinality(registered_numbers) = 0;

delete from public.brand_knowledge where brand_key in ('aimeleondore', 'stussy');

insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   notes, source_url, confidence, verified, updated_by)
values

  ('badbirdie', 'Bad Birdie', ARRAY['bad birdie','badbirdie','bad birdie golf']::text[], ARRAY['golf','menswear','polo','graphic']::text[], ARRAY['RN 158230']::text[],
   'RN 158230 is FTC-record sourced -- registrant "Bad Birdie LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.badbirdiegolf.com/', 0.60, false, 'migration:00748'),
  ('bruntworkwear', 'BRUNT Workwear', ARRAY['brunt','brunt workwear','bruntworkwear']::text[], ARRAY['workwear','boots','menswear','trades']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.bruntworkwear.com/', 0.60, false, 'migration:00748'),
  ('cinch', 'Cinch', ARRAY['cinch','cinch jeans']::text[], ARRAY['western','denim','menswear','rodeo']::text[], ARRAY['RN 133773']::text[],
   'RN 133773 is FTC-record sourced -- registrant "CINCH, LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.cinchjeans.com/', 0.60, false, 'migration:00748'),
  ('eberjey', 'Eberjey', ARRAY['eberjey']::text[], ARRAY['sleepwear','lingerie','loungewear','womenswear']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.eberjey.com/', 0.60, false, 'migration:00748'),
  ('jaanuu', 'Jaanuu', ARRAY['jaanuu']::text[], ARRAY['scrubs','medical uniforms','workwear']::text[], ARRAY['RN 142367']::text[],
   'RN 142367 is FTC-record sourced -- registrant "JAANUU, INC.". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.jaanuu.com/', 0.60, false, 'migration:00748'),
  ('lakepajamas', 'Lake Pajamas', ARRAY['lake','lake pajamas','lakepajamas']::text[], ARRAY['sleepwear','pima cotton','womenswear','loungewear']::text[], ARRAY['RN 158314']::text[],
   'RN 158314 is FTC-record sourced -- registrant "LAKE WEEKEND WEAR LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.lakepajamas.com/', 0.60, false, 'migration:00748'),
  ('loandsons', 'Lo & Sons', ARRAY['lo & sons','lo and sons','loandsons']::text[], ARRAY['bags','travel','accessories']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.loandsons.com/', 0.60, false, 'migration:00748'),
  ('lunya', 'Lunya', ARRAY['lunya']::text[], ARRAY['sleepwear','loungewear','womenswear','washable silk']::text[], ARRAY['RN 141460']::text[],
   'RN 141460 is FTC-record sourced -- registrant "LUNYA". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.lunya.co/', 0.60, false, 'migration:00748'),
  ('malbongolf', 'Malbon Golf', ARRAY['malbon','malbon golf','malbongolf']::text[], ARRAY['golf','streetwear','menswear','collabs']::text[], ARRAY['RN 159657']::text[],
   'RN 159657 is FTC-record sourced -- registrant "Malbon Golf, LLC.". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.malbongolf.com/', 0.60, false, 'migration:00748'),
  ('nisolo', 'Nisolo', ARRAY['nisolo']::text[], ARRAY['footwear','leather','sustainable','accessories']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.nisolo.com/', 0.60, false, 'migration:00748'),
  ('nobull', 'NOBULL', ARRAY['nobull','no bull','nobull project']::text[], ARRAY['training','footwear','activewear','crossfit']::text[], ARRAY['RN 151714']::text[],
   'RN 151714 is FTC-record sourced -- registrant "NOBULL, INC.". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.nobullproject.com/', 0.60, false, 'migration:00748'),
  ('pactimo', 'Pactimo', ARRAY['pactimo']::text[], ARRAY['cycling','bib shorts','jerseys','activewear']::text[], ARRAY['RN 137181']::text[],
   'RN 137181 is FTC-record sourced -- registrant "Pactimo, LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.pactimo.com/', 0.60, false, 'migration:00748'),
  ('pairofthieves', 'Pair of Thieves', ARRAY['pair of thieves','pairofthieves']::text[], ARRAY['socks','underwear','menswear','basics']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.pairofthieves.com/', 0.60, false, 'migration:00748'),
  ('pangaia', 'PANGAIA', ARRAY['pangaia','the pangaia']::text[], ARRAY['sustainable apparel','loungewear','materials science']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.pangaia.com/', 0.60, false, 'migration:00748'),
  ('printfresh', 'Printfresh', ARRAY['printfresh','print fresh']::text[], ARRAY['sleepwear','pajamas','block print','womenswear']::text[], ARRAY['RN 159907']::text[],
   'RN 159907 is FTC-record sourced -- registrant "Printfresh LLC". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.printfresh.com/', 0.60, false, 'migration:00748'),
  ('rowingblazers', 'Rowing Blazers', ARRAY['rowing blazers','rowingblazers']::text[], ARRAY['preppy','rugby shirts','menswear','heritage']::text[], ARRAY['RN 153752']::text[],
   'RN 153752 is FTC-record sourced -- registrant "Rowing Blazers LTD". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.rowingblazers.com/', 0.60, false, 'migration:00748'),
  ('smartwool', 'Smartwool', ARRAY['smartwool','smart wool']::text[], ARRAY['merino','socks','baselayer','outdoor']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.smartwool.com/', 0.60, false, 'migration:00748'),
  ('sunspel', 'Sunspel', ARRAY['sunspel']::text[], ARRAY['menswear','t-shirts','sea island cotton','british']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.sunspel.com/', 0.60, false, 'migration:00748'),
  ('teacollection', 'Tea Collection', ARRAY['tea collection','teacollection','tea']::text[], ARRAY['kids','childrenswear','prints','globally inspired']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.teacollection.com/', 0.60, false, 'migration:00748'),
  ('tenthousand', 'Ten Thousand', ARRAY['ten thousand','tenthousand','10000']::text[], ARRAY['training','activewear','menswear','shorts']::text[], ARRAY['RN 147972']::text[],
   'RN 147972 is FTC-record sourced -- registrant "TEN THOUSAND, INC.". ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.tenthousand.cc/', 0.60, false, 'migration:00748'),
  ('universalworks', 'Universal Works', ARRAY['universal works','universalworks']::text[], ARRAY['menswear','workwear','british','utility']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://universalworks.co.uk/', 0.60, false, 'migration:00748'),
  ('xtratuf', 'Xtratuf', ARRAY['xtratuf','xtra tuf','xtratufs']::text[], ARRAY['boots','fishing','waterproof','deck boots']::text[], ARRAY[]::text[],
   'NO REGISTERED NUMBER SEEDED: the FTC register either returns nothing for this brand (a legitimate absence, not a failed lookup) or returns a registrant whose name is not the label, which is refused rather than guessed. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.xtratuf.com/', 0.60, false, 'migration:00748')
on conflict (brand_key) do nothing;

insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, base_color, shade,
   source_url, confidence, verified, updated_by)
values

  ('jaanuu', 'Apricot', ARRAY[]::text[], NULL, NULL, 'Orange', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Birch', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Blossom', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Burgundy', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Carbon Gray', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Caribbean Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Ceil Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Charcoal', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Cider', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Clay', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Coral', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Deep Eggplant', ARRAY[]::text[], NULL, NULL, 'Purple', 'Dark', 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Deep Olive', ARRAY[]::text[], NULL, NULL, 'Green', 'Dark', 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Electric Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Emerald Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Fog', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Galaxy', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Heather Gray', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Lavender', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Marina', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Mauve', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Midnight Green', ARRAY[]::text[], NULL, NULL, 'Green', 'Dark', 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Midnight Navy', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Mint', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Mocha', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Moon Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Ocean', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Olive', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Rose Quartz', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Rosewood', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Royal Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Sage', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Sand', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Sienna', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Sky Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Solar Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Storm Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Surf', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Teal', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Titanium', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Trench', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('jaanuu', 'Wild Berry', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.jaanuu.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black - Textured Nylon', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black - Tyvek', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gold/Azure - Nylon', ARRAY[]::text[], NULL, NULL, 'Gold', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gold/Camel - Nappa', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gold/Camel - Nylon', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gold/Camel - Sheepskin', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gold/Grey - Nappa', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gold/Grey - Saffiano', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gold/Lavender - Nylon', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gunmetal/Grey - Nappa', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gunmetal/Grey - Nylon', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Gunmetal/Grey - Sheepskin', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Silver/Grey - Nappa', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Silver/Grey - Nylon', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Silver/Grey - Saffiano', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Silver/Lavender - Nappa', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Black/Silver/Lavender - Nylon', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Cabernet - Eco Friendly Canvas', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Cabernet - Nylon', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Cabernet/Gold/Camel - Nylon', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Cognac - Sheepskin', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Dark Green - Eco Friendly Canvas', ARRAY[]::text[], NULL, NULL, 'Green', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Dark Green/Gold/Camel - Nylon', ARRAY[]::text[], NULL, NULL, 'Beige', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Dark Tan/Gold/Camel - Nylon', ARRAY[]::text[], NULL, NULL, 'Beige', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Dark Tan/Gold/Camel - Saffiano', ARRAY[]::text[], NULL, NULL, 'Beige', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Deep Navy - 600D Recycled Poly', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Deep Navy - Eco Friendly Canvas', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Deep Navy/Gold/Azure - Nylon', ARRAY[]::text[], NULL, NULL, 'Gold', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Deep Navy/Gold/Camel - Nappa', ARRAY[]::text[], NULL, NULL, 'Beige', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Deep Navy/Gold/Camel - Nylon', ARRAY[]::text[], NULL, NULL, 'Beige', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Deep Navy/Gold/Camel - Saffiano', ARRAY[]::text[], NULL, NULL, 'Beige', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Dove Grey - Eco Friendly Canvas', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Golden Brown - 600D Recycled Poly', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Graphite/Brass/Grey - Saffiano', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Green - Sheepskin', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Green - Textured Nylon', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Grey - 600D Recycled Poly', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Grey/Silver/Azure - Nylon', ARRAY[]::text[], NULL, NULL, 'Silver', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Ivory - Sheepskin', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Ivory/Gold/Camel - Nylon', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Ivory/Gold/Camel - Saffiano', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Leaf Print - Tyvek', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Light Grey/Gold/Grey - Nappa', ARRAY[]::text[], NULL, NULL, 'Gray', 'Light', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Light Grey/Gold/Grey - Saffiano', ARRAY[]::text[], NULL, NULL, 'Gray', 'Light', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Midnight Ash - Eco Friendly Canvas', ARRAY[]::text[], NULL, NULL, 'Gray', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Natural - Eco Friendly Canvas', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Natural/Dark Green - Eco Friendly Canvas Colorblock', ARRAY[]::text[], NULL, NULL, 'Multicolor', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Natural/Deep Navy - Eco Friendly Canvas Colorblock', ARRAY[]::text[], NULL, NULL, 'Multicolor', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Natural/Midnight Ash - Eco Friendly Canvas Colorblock', ARRAY[]::text[], NULL, NULL, 'Multicolor', 'Dark', 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Natural/Thistle - Eco Friendly Canvas Colorblock', ARRAY[]::text[], NULL, NULL, 'Multicolor', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Navy - Tyvek', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Navy Camo - 600D Recycled Poly', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Navy Fruit - Tyvek', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Navy Hawaii Emoji - Tyvek', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Onyx - 600D Recycled Poly', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Rose Quartz/Gold/Camel - Nappa', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Rose Quartz/Gold/Camel - Saffiano', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Sienna/Gold/Camel - Nappa', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'Thistle - Eco Friendly Canvas', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'White Hawaii Emoji - Tyvek', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('loandsons', 'White Zodiac Emoji - Tyvek', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.loandsons.com/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Current Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Deep Blue', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Delicate Pink', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Hushed Tan', ARRAY[]::text[], NULL, NULL, 'Tan', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Immersed Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Meditative Grey', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Napping Dove Heather', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Sincere White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Storm Grey Heather', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Summer Harvest', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Tranquil White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('lunya', 'Whisper Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.lunya.co/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'AEGEAN BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'ARSHAM GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BARK CAMO', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BEIGE', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BLACK', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BLACK STEALTH CAMO', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BLACK STONE WASHED DENIM', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BLUE SHADOW', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BLUEBERRY', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BRIGHT WHITE', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'BROWN', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'CORAL HAZE', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'CREAM', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'CREAM / OLIVINE', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'DARK SLATE', ARRAY[]::text[], NULL, NULL, 'Gray', 'Dark', 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'DENIM', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'DIRECTOIRE BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'DUSTY NAVY', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'FOREST', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'GARDEN GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'GREEN TINT', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'IVORY', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'JET BLACK', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'LIGHT BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', 'Light', 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'LIGHT KHAKI', ARRAY[]::text[], NULL, NULL, 'Beige', 'Light', 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'MARMALADE', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'MIDNIGHT', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'MILITARY GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'NAVY', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'OFF WHITE', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'OLD ROSE', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'OLIVINE', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'PASTEL BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', 'Light', 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'PLUM WINE', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'ROSY TOUCH', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'SAGE GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'SUBDUED BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'SURF SPRAY', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'TAN', ARRAY[]::text[], NULL, NULL, 'Tan', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'TAUPE', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'VANILLA', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'VINTAGE INDIGO', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'WHISPER WHITE', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('malbongolf', 'WHITE', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.malbongolf.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Alpine Deep', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Blue Sky', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Bluebird Haze', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Canyon Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Manic', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Midnight Navy', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'Mountain Twilight', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'PAC26 FD+T Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pactimo', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.pactimo.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Blush Drift', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Burnt Horizon', ARRAY[]::text[], NULL, NULL, 'Orange', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Cosmos Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Grey Marl', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Iron Fade', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Nocturne Plum', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Obsidian Core', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Ocean Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'Soft Void', ARRAY[]::text[], NULL, NULL, null, 'Light', 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('pangaia', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.pangaia.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Ash', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Burnt Sienna', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Carnival', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Chalk Violet Heather', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Charcoal', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Charcoal Heather', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Chestnut', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Copper Heather', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Coral Reef', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Currant', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Dark Teal Heather', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Deep Navy', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Dusty Teal', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Eggplant', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Emerald Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Fern Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Frosty Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Green Tea', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Honey Gold', ARRAY[]::text[], NULL, NULL, 'Gold', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Icy Lavender Sky', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Iron Heather', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Laguna Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Lavender Sky Heather', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Light Gray', ARRAY[]::text[], NULL, NULL, 'Gray', 'Light', 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Light Gray Heather', ARRAY[]::text[], NULL, NULL, 'Gray', 'Light', 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Medium Gray', ARRAY[]::text[], NULL, NULL, 'Gray', 'Medium', 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Mink', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Mink Heather', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Mocha', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Mocha Heather', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Moonbeam', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Natural', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Nightfall Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Nightfall Blue-Deep Navy', ARRAY[]::text[], NULL, NULL, 'Blue', 'Dark', 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Pacific Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Pewter Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Picante', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Pistachio', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Power Pink', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Purple Dawn', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Purple Eclipse', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Purple Iris', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Purple Storm', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Serene Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Twilight Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Twilight Blue Heather', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Ultra Violet', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Wild Salmon', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('smartwool', 'Winter Moss', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.smartwool.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Bedford Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Blue And Yellow Macaws', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Blue Tide', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Canal Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Carnation Toss', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Carnival Butterfly', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Cassis', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Chalk', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Checkerboard', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Cherry Blossom', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Cloud', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Coronet Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Cosmic Berry', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Creole Pink', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Daisy Deluxe', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Desert Rose', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Dried Rosemary', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Flamenco Fan Rose', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Flutter Fiesta', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Garden Party', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Garden Party Check', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Glaze Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Honeysuckle Rose', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Hydrangea', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Imperial', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Indigo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Jet Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Light Grey Heather', ARRAY[]::text[], NULL, NULL, 'Gray', 'Light', 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Light Laguna', ARRAY[]::text[], NULL, NULL, null, 'Light', 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Majorelle Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Marvelous Marble', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Med Heather Grey', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Mica', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Mineral', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Monk Parakeet', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Mosaic Floral', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Mulberry', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Naval Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Nightfall', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Nouveau Poppy', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Orchid Ditsy', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Oversized Tropical Leaf', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Parkside', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Pearl Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Pepper', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Perennial Pink', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Pineneedle', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Pink Lady', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Plum Blossom', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Pomme', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Poppy Poppies', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Red Wagon', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Rio De Janeiro Rainbow', ARRAY[]::text[], NULL, NULL, 'Multicolor', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Sachet Pink', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Salmon', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Sangria', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Scenic Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Scuba', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Sunflowers', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Sunset Pink', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Swedish Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Thunder', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Toucan Banana Tree', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Triumph', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Turkish Rose', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Urchin Purple', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('teacollection', 'Viridian', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.teacollection.com/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Admiral Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Black', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Black (Old SKU)', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Black Camo', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Bluefin', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Bone', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Brick Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Dark Olive', ARRAY[]::text[], NULL, NULL, 'Green', 'Dark', 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Dusk Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Fir', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Hydro Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Iron', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Iron (Old SKU)', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Maroon', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Medium Grey', ARRAY[]::text[], NULL, NULL, 'Gray', 'Medium', 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Mesa Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Midnight', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Mineral', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Navy', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Navy (Old SKU)', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'OD Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'OD Green (Old SKU)', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Off White', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Pine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Rover', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Salt', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Serpentine Camo', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('tenthousand', 'Stone', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.tenthousand.cc/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'AQUA', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLACK', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLACK MAHI', ARRAY[]::text[], NULL, NULL, 'Black', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLUE NAVY YELLOW', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLUE SHARK CAMO', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLUE WHITE', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLUSH', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLUSH PEACH', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BLUSH PINK', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BONE WHITE MARLIN', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BRN', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BROWN', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'BUBBLE GUM', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Baltic Sea Swirl', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Beige / Duck Camo', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Big Bird Yellow', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Black / Deep Storm', ARRAY[]::text[], NULL, NULL, 'Black', 'Dark', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Black and Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Black and Yellow', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Blue / Dolphin Floral', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Blue Camo', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Bone / Deep Storm', ARRAY[]::text[], NULL, NULL, 'Ivory', 'Dark', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Brown / Tin Fish', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Bubble Gum Swirl', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'CAMO', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'CARAMEL SWIRL', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'CHOCOLATE TAN', ARRAY[]::text[], NULL, NULL, 'Tan', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'CLOUD', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'CLOUD MULTI', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'CORAL SAILFISH', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Camouflage', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Chocolate Chip', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Cookie Monster Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Coral', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Cork', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'DUCK CAMO', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'DUCK CAMO GRAY', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'DUCK CAMO SWIRL', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Dark Brown / Realtree Edge', ARRAY[]::text[], NULL, NULL, 'Brown', 'Dark', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Dark Gull Grey', ARRAY[]::text[], NULL, NULL, 'Gray', 'Dark', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Dark Olive / Spice', ARRAY[]::text[], NULL, NULL, 'Green', 'Dark', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Deep Storm', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Deep Storm Swirl', ARRAY[]::text[], NULL, NULL, null, 'Dark', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'EARTH BROWN', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Elmo Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Fig', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Fossil / Stone', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'GARDEN GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'GREY', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Ginger Spice', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Gray', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Green and Yellow', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Grey / Iceberg', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Grey / Sailfish Sketch', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'HOT PINK', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Halibut Print', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'IVORY DUCK CAMO', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'IVORY NAVY', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Ice Duck Camo', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Iceberg', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Ivory', ARRAY[]::text[], NULL, NULL, 'Ivory', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Khaki', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'LAVA', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'LAVENDER', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'LEGION BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Legacy Brown', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Legacy Brown Kelp', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Legacy Grey', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Legacy Marine', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Legacy Moss', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Legacy Sahara', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Legion Blue / Rust Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Light Blue', ARRAY[]::text[], NULL, NULL, 'Blue', 'Light', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'MAHI GREEN', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'MISTY ROSE', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'MOSSY OAK BOTTOMLAND', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'MOSSY OAK COUNTRY DNA', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Medium (D)', ARRAY[]::text[], NULL, NULL, null, 'Medium', 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Moss Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Mossyoak Bottomland', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'NAVY', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'NAVY BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'NAVY RED', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'NAVY SHARK', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'NAVY YELLOW', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'NEON PINK', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'NVA', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Navy and Green', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'OLIVE', ARRAY[]::text[], NULL, NULL, 'Green', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Octopus Print', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Orange', ARRAY[]::text[], NULL, NULL, 'Orange', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Orange / White', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Orchid', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'PINK', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'PINK SEAHORSE', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'PURPLE', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'PURPLE AND YELLOW', ARRAY[]::text[], NULL, NULL, 'Yellow', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Paint Splatter', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Peach Fuzz', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Pool Blue / Turtle Floral', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Purple Haze', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'RED', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'RED AND GREY', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'RED AND WHITE', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'RED GREY', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Red / White / Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Red and Brown', ARRAY[]::text[], NULL, NULL, 'Brown', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Red, White, and Blue Swirl', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Retro Blue / Oak Buff', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Rose Violet', ARRAY[]::text[], NULL, NULL, 'Purple', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Rust Red', ARRAY[]::text[], NULL, NULL, 'Red', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'SAND', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'SKY BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'SKY BLUE MARLIN', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'STORMY BLUE', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Sahara Swirl', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Sand Dollar print', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Sand Storm', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Sesame Street Multi', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Sesame Street White Multi', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Skipper Blue', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Skyway', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Skyway Floral', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Sorbet Swirl', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Stingray Grey', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Stone', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Stormy Duck Camo', ARRAY[]::text[], NULL, NULL, null, null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'TAN MULTI', ARRAY[]::text[], NULL, NULL, 'Tan', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Taupe', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Teal', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Transformative Teal', ARRAY[]::text[], NULL, NULL, 'Blue', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Ultimate Grey', ARRAY[]::text[], NULL, NULL, 'Gray', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'WHITE', ARRAY[]::text[], NULL, NULL, 'White', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'WHITE MULTI PINK', ARRAY[]::text[], NULL, NULL, 'Pink', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748'),
  ('xtratuf', 'Warm Taupe', ARRAY[]::text[], NULL, NULL, 'Beige', null, 'https://www.xtratuf.com/products.json', 0.75, false, 'migration:00748')
on conflict do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00748') on conflict do nothing;
