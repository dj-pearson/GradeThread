-- US-2220: western — Ariat, Justin, Lucchese. The story names those three plus
-- Stetson; STETSON IS ALREADY SEEDED, by 00574's headwear pack, and its western
-- hats are covered there. Seeding it again would duplicate a row that already
-- carries the X-rating tell, so this pack takes the three boot houses and leaves
-- the hat house where it is. The packs compose; they do not overlap.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MAKES WESTERN ITS OWN CATEGORY: **WIDTH IS A SIZE, NOT A PREFERENCE.**
--
-- Most footwear resale ignores width entirely — a sneaker is listed as "10" and
-- nobody asks. A western boot is sized on TWO axes, and the second one is on the
-- box and usually on the boot:
--
--     B    narrow
--     D    medium — the default men's width
--     EE   wide          (Justin also prints this as XW)
--     EEE  extra wide
--
-- The rule of thumb is that the further the letter is from A, the wider the
-- boot. **A western boot listed without its width has been half-sized**, and the
-- buyer cannot infer it — a D and an EEE in the same length are different boots.
--
-- ⚠ AND THE LENGTH ITSELF IS BRAND-RELATIVE, which is the [[brand-kb-sizing-units]]
-- rule arriving in footwear:
--
--   * ARIAT runs about HALF A SIZE SMALL and fits broad.
--   * LUCCHESE runs about HALF A SIZE LARGE and is NARROW through the toe box —
--     reported as its D fitting like another maker's B or C. So a Lucchese D and
--     an Ariat D are not the same width, and the same printed length is two
--     different boots.
--
-- These offsets are seeded as TELLS rather than as charts, deliberately: they are
-- consistent across the retail channel but none of the three publishes a numeric
-- conversion, and a chart would give the offset a precision the sourcing does not
-- support. Directional guidance plus "measure the insole" is the honest form.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ THE COMPLIANCE FACT, AND IT IS THE MOST CONSEQUENTIAL THING IN THIS PACK:
--
--   **AN EXOTIC SKIN IS A LEGAL QUESTION BEFORE IT IS A MATERIAL.**
--
-- Western boots are the KB's densest category for exotic leathers, and they split
-- on a line that has nothing to do with price:
--
--   * CAIMAN, CROCODILE, ALLIGATOR and PYTHON are CITES-listed. Moving one across
--     a border can require documentation, and the penalties for getting it wrong
--     are not small.
--   * OSTRICH — the full-quill skin most associated with the category — is
--     generally NOT CITES-listed.
--
-- So the skin is a LISTING COMPLIANCE fact, exactly as the real-coyote ruff is on
-- a Canada Goose parka (00460). The seeded tells say to NAME the skin and to flag
-- the CITES ones for cross-border sale; they deliberately do NOT tell a seller
-- whether a particular shipment is lawful, because that depends on the two
-- countries, the species and the paperwork — none of which a grading system can
-- see. ⚠ AND IDENTIFYING AN EXOTIC SKIN FROM A PHOTOGRAPH IS NOT RELIABLE:
-- caiman is routinely sold as alligator, and embossed cowhide is sold as both.
-- Never assert a species the seller has not stated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CONSTRUCTION IS VALUE HERE, unlike in most categories. A welted boot can be
-- resoled and a cemented one cannot, so a worn sole means "needs $150 of work" on
-- one boot and "end of life" on the other. That single fact moves the grade more
-- than the cosmetics do, and it is the thing a photo of the upper cannot show.
--
-- NO DECODERS. Western boots carry a style number on the box and often stamped
-- inside the shaft, but the formats are not brand-unique — bare digit runs and
-- short alphanumerics that any maker could emit. The 00460 bar refuses them.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'ariat', 'Ariat',
    ARRAY['ariat','ariatinternational']::text[],
    ARRAY['western','boots','equestrian','workwear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ RUNS ABOUT HALF A SIZE SMALL, AND FITS BROAD","detail":"Consistently reported across the retail channel. So an Ariat 10 is not a Lucchese 10 and neither is a sneaker 10. State the printed size AND the measured insole length; do not convert between makers."},
      {"tell":"WIDTH IS PART OF THE SIZE","detail":"B narrow, D medium, EE wide, EEE extra wide. A listing without the width has given half the size, and the buyer cannot infer it."},
      {"tell":"Construction decides what a worn sole means","detail":"A welted boot can be resoled; a cemented one cannot. Say which it is — the same visible sole wear is a repair on one boot and the end of the other."}
    ]$json$::jsonb,
    'Western and equestrian footwear. ⚠ Runs about half a size SMALL and broad. NO DECODER — the style number is on the box and its format is not brand-unique. Sizing offsets are seeded as tells rather than charts because no maker publishes a numeric conversion.',
    'https://bootjack.com/blogs/blog/are-western-boots-true-to-size-expert-fit-guide-sizing-tips', 0.5, false, 'migration:00582'
  ),
  (
    'justin', 'Justin Boots',
    ARRAY['justin','justinboots']::text[],
    ARRAY['western','boots','workwear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"Publishes its own width chart, and prints EEE as XW","detail":"Justin documents B (narrow), D (medium) and EE (wide), with XW as its name for EEE. A seller reading 'XW' off a box is reading a width, not a length — transcribe it as the width."},
      {"tell":"WIDTH IS PART OF THE SIZE","detail":"Same as the rest of the category: a boot listed without its width has been half-sized."},
      {"tell":"Construction decides what a worn sole means","detail":"Welted boots are resoleable; cemented ones are not."}
    ]$json$::jsonb,
    'American western and work boot house. The one brand here that publishes a width chart of its own. NO DECODER.',
    'https://www.justinboots.com/en/boot-prints/boot-width-chart.html', 0.55, true, 'migration:00582'
  ),
  (
    'lucchese', 'Lucchese',
    ARRAY['lucchese','luccheseboots']::text[],
    ARRAY['western','boots','exotic leather','luxury']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ RUNS ABOUT HALF A SIZE LARGE, AND NARROW","detail":"Reported as its D fitting the way another maker's B or C fits, especially through the toe box. So a Lucchese D and an Ariat D are not the same width, and the same printed length is two different boots. This is the pair that makes cross-brand boot conversion impossible: one house runs small and broad, the other large and narrow."},
      {"tell":"⚠ EXOTIC SKINS ARE A COMPLIANCE FACT BEFORE THEY ARE A MATERIAL","detail":"Caiman, crocodile, alligator and python are CITES-listed and moving one across a border can require documentation; ostrich generally is not listed. NAME the skin and flag the CITES ones for cross-border sale. Do not advise on whether a shipment is lawful — that depends on both countries, the species and the paperwork."},
      {"tell":"⚠ DO NOT IDENTIFY A SKIN FROM A PHOTOGRAPH","detail":"Caiman is routinely sold as alligator and embossed cowhide is sold as both. Never assert a species the seller has not stated; a wrong species claim on an exotic is a legal exposure, not a description error."},
      {"tell":"The tier is the construction as much as the skin","detail":"A welted, resoleable boot at this price is expected. Say whether the sole is original and whether it has been resoled."}
    ]$json$::jsonb,
    'Texas bootmaker, the luxury tier of the category and the densest for exotic leathers. ⚠ Runs about half a size LARGE and narrow — the exact inverse of Ariat, which is why cross-brand conversion is refused here. NO DECODER. ⚠ Exotic skins are a listing-compliance fact; see the CITES tell.',
    'https://www.lucchese.com/pages/boot-fit', 0.5, false, 'migration:00582'
  )
on conflict (brand_key) do nothing;

-- ── brand_size_charts — THE WIDTH AXIS ─────────────────────────────────────
-- One chart, under a generic key, because the width LETTERS are a shared
-- convention (Justin publishes them; the others use the same letters) even though
-- the actual fit behind them is brand-relative. The per-brand offsets deliberately
-- live in tells instead — see the header for why a chart would overstate them.
-- The generic-key precedent is 00389's `genericmensalpha` and 00581's
-- `tailoringmenswear`.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match,
   rows, note, source_url, confidence, verified, updated_by)
values
  (
    'westernbootwidth', 'Western boot widths (US convention)', ARRAY[]::text[], 'Men',
    'Boot widths (letter axis)',
    ARRAY['boot','western boot','cowboy boot','roper','footwear']::text[],
    $json$[
      {"size":"B","measurements":{"width_rank":"1"}},
      {"size":"D","measurements":{"width_rank":"2"}},
      {"size":"EE","measurements":{"width_rank":"3"}},
      {"size":"EEE","measurements":{"width_rank":"4"}}
    ]$json$::jsonb,
    'WIDTH IS THE SECOND SIZE AXIS and a boot listed without it has been half-sized. B narrow, D medium (the men''s default), EE wide, EEE extra wide — Justin prints EEE as XW. ⚠ The value here is a RANK, not a measurement: no maker publishes the width in inches, and inventing one would be false precision. The rule of thumb is that the further the letter is from A, the wider the boot. ⚠ AND THE LETTER IS BRAND-RELATIVE — Lucchese''s D is reported to fit like another maker''s B or C — so a width letter must never be converted between brands. Measure the insole and say the printed size.',
    'https://www.justinboots.com/en/boot-prints/boot-width-chart.html', 0.55, true, 'migration:00582'
  )
on conflict (brand_key, department, garment) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('ariat', 'Western boot', ARRAY['ariat boot']::text[], 'Boots', 'Unisex', 'boots',
   'Western and work boots across a broad range. Seeded as a single line because the model names change constantly and none could be sourced first-party.',
   null, ARRAY['western','boot']::text[],
   'https://bootjack.com/blogs/blog/are-western-boots-true-to-size-expert-fit-guide-sizing-tips', 0.4, false, 'migration:00582'),
  ('justin', 'Western boot', ARRAY['justin boot']::text[], 'Boots', 'Unisex', 'boots',
   'Western and work boots. Widths B/D/EE with XW printed for EEE, per the maker''s own width chart.',
   null, ARRAY['western','boot','width']::text[],
   'https://www.justinboots.com/en/boot-prints/boot-width-chart.html', 0.5, true, 'migration:00582'),
  ('lucchese', 'Classics', ARRAY['lucchese classics']::text[], 'Boots', 'Unisex', 'boots',
   'The handmade upper tier, frequently in exotic skins and welted so it can be resoled. ⚠ Where the skin is caiman, crocodile, alligator or python, it is CITES-listed — name it and flag it for cross-border sale.',
   null, ARRAY['classics','exotic','welted']::text[],
   'https://www.lucchese.com/pages/boot-anatomy', 0.45, false, 'migration:00582')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes. Western style numbers live on the box and are bare digit
-- runs or short alphanumerics that any maker could emit — the 00460 bar refuses
-- them. Asserted in services/edge-functions/src/tests/western-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00582') on conflict do nothing;
