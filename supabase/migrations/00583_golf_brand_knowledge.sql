-- US-2220: golf — FootJoy, Greyson Clothiers, Callaway, Titleist.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ FIRST, A CORRECTION TO THE STORY'S OWN PREMISE. US-2220 lists Titleist among
-- the golf brands the KB should carry. Titleist is an EQUIPMENT house, not an
-- apparel one: its own gear range is bags, headwear, travel gear, accessories and
-- gloves, and it does not sell polos. So a Titleist item reaching a CLOTHING
-- grading system is overwhelmingly a HAT or a GLOVE, and the row below is seeded
-- for those rather than for a shirt line that does not exist.
--
-- Recorded rather than quietly skipped, because the next reader will otherwise
-- wonder why the brand looks thin — it is thin on purpose, and the thinness is
-- the finding.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MAKES GOLF ITS OWN CATEGORY: **THE LOGO IS PART OF THE ITEM.**
--
-- A golf polo very often carries an embroidered chest logo that is NOT the
-- maker's: a club, a tournament, a resort, or a corporate outing. That mark
-- changes who the buyer is, in both directions —
--
--   * a famous course or championship is the reason a particular buyer wants it,
--     and it is the string they search;
--   * a corporate-outing logo narrows the market instead, because it is somebody
--     else's company on your chest.
--
-- So the logo must ALWAYS be transcribed, and it must be transcribed as what it
-- is rather than folded into the brand. ⚠ THIS PACK DELIBERATELY MAKES NO CLAIM
-- ABOUT A PREMIUM: that course logos trade actively is observable, but no figure
-- for how much they add could be sourced, and an invented multiplier would be
-- worse than silence. Name the logo; let the comps price it.
--
-- ⚠ AND THE LOGO IS NOT THE BRAND. A Pebble Beach logo on a polo does not make
-- the garment a "Pebble Beach" product in the brand field — the maker is whoever
-- is on the neck label. Putting the course in the brand field mis-files the item
-- and breaks the comp set. This is the band-tee rule from 00579 in a new costume:
-- the blank maker and the graphic are different fields.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WIDTH, AGAIN — AND THIS IS THE SECOND FOOTWEAR CATEGORY IN A ROW WHERE IT IS A
-- SIZE RATHER THAN A PREFERENCE (western boots were 00582). FootJoy states it
-- offers the most width options in golf: men N / M / W / XW, women N to W. A golf
-- shoe listed without its width has been half-sized, exactly as a boot is.
--
-- ⚠ AND GOLF SHOES HAVE A CONSUMABLE THE REST OF FOOTWEAR DOES NOT. Spiked models
-- take REPLACEABLE soft spikes that wear out with normal use and cost very little
-- to change. So worn or missing spikes are a CONSUMABLE, not damage, and grading
-- them as sole wear marks the shoe down for something the next owner fixes for a
-- few pounds. What DOES matter is the spike RECEPTACLES — if those are stripped,
-- the shoe cannot take new spikes and the sole is genuinely finished.
--
-- The inverse of the western-boot call in 00582, and worth holding beside it: a
-- worn sole on a cemented boot is the end of the boot; a worn spike on a golf
-- shoe is a consumable. Same-looking photograph, opposite grade.
--
-- NO DECODERS. Nothing here puts a regular, brand-unique style code on the
-- garment.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'footjoy', 'FootJoy',
    ARRAY['footjoy','fj']::text[],
    ARRAY['golf','footwear','gloves','apparel']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"WIDTH IS PART OF THE SIZE, and FootJoy has the most of them","detail":"FootJoy states it offers the most width options in golf — men N / M / W / XW, women N to W. A golf shoe listed without its width has been half-sized, exactly as a western boot is. Transcribe the width letter from the box or the tongue label."},
      {"tell":"⚠ WORN SPIKES ARE A CONSUMABLE, NOT DAMAGE","detail":"Spiked models take REPLACEABLE soft spikes that wear out with ordinary use and cost very little to change. Grading them as sole wear marks the shoe down for something the next owner fixes for a few pounds. What DOES matter is the spike RECEPTACLES: if those are stripped the shoe cannot take new spikes and the sole is finished."},
      {"tell":"Spiked and spikeless are different products","detail":"FootJoy sells both as separate lines. Say which it is — a spikeless shoe has no receptacles to strip and no spikes to replace, so the whole paragraph above does not apply to it."}
    ]$json$::jsonb,
    'The dominant golf shoe house, also gloves and apparel. ⚠ Width is a size here, the same as western boots (00582) — and the SPIKE call is the inverse of the boot-sole call: a worn spike is a consumable, a worn cemented boot sole is the end of the boot. NO DECODER.',
    'https://www.footjoy.com/golf-shoe-fitting-guide.html', 0.6, true, 'migration:00583'
  ),
  (
    'greysonclothiers', 'Greyson Clothiers',
    ARRAY['greyson','greysonclothiers']::text[],
    ARRAY['golf','apparel','performance','premium']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"Premium performance golf apparel, founded by Charlie Schaefer","detail":"Positioned as luxury golf and lifestyle rather than course-only, and worn on tour by Jon Rahm, Shane Lowry and Tyrrell Hatton. The tour association is a demand signal, not an authentication one."},
      {"tell":"⚠ A CHEST LOGO MAY NOT BE THE MAKER","detail":"Golf apparel frequently carries a club, tournament or corporate logo that is not the brand. Read the NECK LABEL for the maker and transcribe the chest logo separately — putting a course in the brand field mis-files the item and breaks the comp set."}
    ]$json$::jsonb,
    'Premium golf and lifestyle apparel. Seeded because the golf category in this KB was empty and this is the apparel-first end of it.',
    'https://greysonclothiers.com/pages/our-story', 0.55, true, 'migration:00583'
  ),
  (
    'callaway', 'Callaway',
    ARRAY['callaway','callawaygolf','callawayapparel']::text[],
    ARRAY['golf','apparel','equipment']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"An equipment house with a real apparel line","detail":"Unlike Titleist, Callaway does carry apparel, so a Callaway polo is an ordinary product rather than something needing explanation. Read the neck label as usual."},
      {"tell":"⚠ A CHEST LOGO MAY NOT BE THE MAKER","detail":"Same as the rest of the category: the club or tournament logo is a separate field from the brand."}
    ]$json$::jsonb,
    'Golf equipment house that also sells apparel. NO DECODER.',
    'https://www.callawaygolf.com/', 0.45, false, 'migration:00583'
  ),
  (
    'titleist', 'Titleist',
    ARRAY['titleist']::text[],
    ARRAY['golf','headwear','gloves','accessories']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ IT IS AN EQUIPMENT BRAND — EXPECT A HAT OR A GLOVE, NOT A SHIRT","detail":"Titleist's own gear range is bags, headwear, travel gear, accessories and gloves; it does not sell polos. So a Titleist item arriving at a clothing grader is overwhelmingly a cap or a glove. This row exists to set that expectation, not to describe an apparel line."},
      {"tell":"A Titleist cap is headwear and grades as headwear","detail":"Read it against the headwear guidance (00574) — crown, brim, sweatband — rather than against an apparel rubric."}
    ]$json$::jsonb,
    '⚠ SEEDED AS A CORRECTION TO THIS STORY''S OWN PREMISE. US-2220 lists Titleist as a golf apparel brand; it is an EQUIPMENT house whose own range is bags, headwear, travel, accessories and gloves, with no polos. The row is deliberately thin and the thinness is the finding — in a clothing context this brand means a cap or a glove.',
    'https://mediacenter.titleist.com/en-CAS/about/', 0.5, true, 'migration:00583'
  )
on conflict (brand_key) do nothing;

-- ── brand_size_charts — the golf-shoe width axis ───────────────────────────
-- Under the generic key convention established by 00389, 00581 and 00582. The
-- letters differ from western boots (N/M/W/XW rather than B/D/EE/EEE), which is
-- itself the point: the two footwear categories do NOT share a width alphabet and
-- must never be converted into each other.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match,
   rows, note, source_url, confidence, verified, updated_by)
values
  (
    'golfshoewidth', 'Golf shoe widths (FootJoy convention)', ARRAY[]::text[], 'Men',
    'Golf shoe widths (letter axis)',
    ARRAY['golf shoe','shoe','footwear','spiked','spikeless']::text[],
    $json$[
      {"size":"N","measurements":{"width_rank":"1"}},
      {"size":"M","measurements":{"width_rank":"2"}},
      {"size":"W","measurements":{"width_rank":"3"}},
      {"size":"XW","measurements":{"width_rank":"4"}}
    ]$json$::jsonb,
    'FootJoy states it offers the most width options in golf: men N / M / W / XW, women N to W. A golf shoe listed without its width has been half-sized. ⚠ THE VALUE IS A RANK, NOT A MEASUREMENT — nobody publishes golf-shoe width in inches, and inventing one would be false precision. ⚠ AND THIS ALPHABET IS NOT THE WESTERN BOOT ALPHABET: boots run B / D / EE / EEE (00582). The two categories use different letters for the same idea and must never be converted into one another — a boot EE is not a golf W.',
    'https://www.footjoy.com/golf-shoe-fitting-guide.html', 0.6, true, 'migration:00583'
  )
on conflict (brand_key, department, garment) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('footjoy', 'Premiere Series', ARRAY['premiere series']::text[], 'Golf shoes', 'Men', 'shoes',
   'A spiked dress-leaning golf shoe line carried on FootJoy''s own site.',
   null, ARRAY['premiere','spiked','golf shoe']::text[],
   'https://www.footjoy.com/men/golf-shoes/spiked/premiere-series---field/001PSF.html', 0.5, true, 'migration:00583'),
  ('footjoy', 'FJ Traditions', ARRAY['traditions','fj traditions']::text[], 'Golf shoes', 'Men', 'shoes',
   'Traditionally styled spiked golf shoe, per FootJoy''s own product page.',
   null, ARRAY['traditions','spiked','classic']::text[],
   'https://www.footjoy.com/men/golf-shoes/spiked/traditions/000FJT.html', 0.5, true, 'migration:00583'),
  ('greysonclothiers', 'Polo', ARRAY['greyson polo']::text[], 'Golf apparel', 'Men', 'polo',
   'The core performance polo. Seeded as one line because the seasonal names change and none is durable enough to be identity.',
   null, ARRAY['polo','performance']::text[],
   'https://greysonclothiers.com/collections/mens-golf-wear', 0.4, false, 'migration:00583'),
  ('callaway', 'Golf polo', ARRAY['callaway polo']::text[], 'Golf apparel', 'Men', 'polo',
   'Core apparel offering. Seeded as one line for the same reason.',
   null, ARRAY['polo','golf']::text[],
   'https://www.callawaygolf.com/', 0.4, false, 'migration:00583'),
  ('titleist', 'Cap', ARRAY['titleist hat','titleist cap']::text[], 'Headwear', 'Unisex', 'hat',
   'The Titleist item most likely to reach a clothing grader. ⚠ Grade it against the headwear guidance (00574), not an apparel rubric.',
   null, ARRAY['cap','hat','golf']::text[],
   'https://www.titleist.com/golf-gear/', 0.5, true, 'migration:00583')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes. Nothing here puts a regular, brand-unique style code on
-- the garment. Asserted in services/edge-functions/src/tests/golf-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00583') on conflict do nothing;
