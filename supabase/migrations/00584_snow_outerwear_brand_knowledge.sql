-- US-2220: ski and snowboard — Burton, Spyder, Volcom, Obermeyer.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MAKES SNOW OUTERWEAR ITS OWN CATEGORY:
--
--   **THE SPEC IS A CLAIM ABOUT THE GARMENT WHEN NEW, AND EVERYTHING THAT
--     ACTUALLY FAILS IS INVISIBLE IN A PHOTOGRAPH.**
--
-- A snow jacket is sold on two numbers — a WATERPROOF rating in millimetres
-- (10K, 20K: how much water pressure the fabric resists) and a BREATHABILITY
-- rating in grams (how much vapour escapes). Both are printed on the hangtag and
-- both are searched for by buyers. Neither can be observed on a used garment, and
-- neither survives use unchanged.
--
-- ⚠ SO THE GRADING QUESTION IS NOT WHAT THE NUMBER SAYS, IT IS WHICH OF THE TWO
-- FAILURE MODES THE ITEM HAS — because one is a consumable and the other is
-- terminal:
--
--   * **DWR (durable water repellent)** is the outer treatment that makes water
--     bead and roll off. It WEARS OFF with use and washing, and it is
--     RE-TREATABLE for a few pounds. A jacket that wets out at the shoulders is
--     a maintenance job, not a dead jacket. GRADE IT AS A CONSUMABLE.
--   * **SEAM TAPE** is the fused strip sealing every stitch line. When it
--     delaminates — lifting, cracking, going crisp — it CANNOT be restored. The
--     garment's waterproofing is over regardless of what the hangtag said.
--     GRADE IT AS TERMINAL.
--
-- That is the same pair as golf's spikes and receptacles (00583): a replaceable
-- consumable beside an unrecoverable one. THE INSPECTION INSTRUCTION IS THE
-- USEFUL PART — turn the jacket inside out and look at the tape over the
-- shoulder and underarm seams. It is the single highest-value thing a seller can
-- photograph in this category, and almost nobody does.
--
-- ⚠ AND "CRITICALLY TAPED" IS A SPEC, NOT A DEFECT. A fully taped garment has
-- every seam sealed; a critically taped one seals only the high-exposure areas
-- (neck, shoulders, chest). The second is a legitimate lower tier that shipped
-- that way from the factory. Reading untaped lower seams as damage marks the
-- garment down for being what it was built as.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO SIZE CHART, and the reason is specific rather than borrowed: snow outerwear
-- is cut to LAYER OVER other clothing, so its alpha size maps to a body
-- measurement PLUS an allowance that varies by maker and by fit line (a slim
-- ski shell and a baggy snowboard jacket in the same nominal L are not the same
-- garment). None of the four publishes a chart this pack could cite, so the
-- honest instruction is the same as everywhere else the numbers are unreliable:
-- measure pit-to-pit and length, and say the fit name if the label carries one.
--
-- NO DECODERS. Nothing here puts a regular, brand-unique style code on the
-- garment.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'burton', 'Burton',
    ARRAY['burton','burtonsnowboards']::text[],
    ARRAY['snowboard','snow outerwear','technical']::text[],
    $json$[
      {"era":"Founded in Vermont by Jake Burton Carpenter","years":"1977","description":"Burton Snowboards became an official company in 1977, built out of a barn in Londonderry, Vermont; the factory and headquarters moved to Burlington in 1992. A founding year on a label dates the HOUSE, never the garment.","source_url":"https://www.burton.com/us/en/content/about-us.html","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"⚠ THE WATERPROOF NUMBER IS A NEW-GARMENT CLAIM","detail":"10K / 20K describes what the fabric resisted when it left the factory. Carry it as a BRAND fact about the model if the label states it; never state or imply that this used jacket still performs to it. The membrane is not what usually fails anyway — see the DWR and seam-tape tells."},
      {"tell":"DWR wearing off is a CONSUMABLE, not damage","detail":"The durable water repellent finish makes water bead and roll off, and it wears away with use and washing. It is re-treatable cheaply, so a jacket that wets out at the shoulders is a maintenance job. Do not grade it as a dead jacket."},
      {"tell":"⚠ SEAM TAPE DELAMINATING IS TERMINAL","detail":"The fused strip sealing each stitch line cannot be restored once it lifts, cracks or goes crisp. When it goes, the waterproofing is over whatever the hangtag said. TURN THE JACKET INSIDE OUT and photograph the tape over the shoulder and underarm seams — it is the highest-value photo in this category and almost nobody takes it."},
      {"tell":"Snow features are worth naming because buyers search them","detail":"Powder skirt, pass pocket, wrist gaiters, pit zips, helmet-compatible hood, RECCO reflector. Say which are present; a missing powder skirt on a model that shipped with one is a real omission."}
    ]$json$::jsonb,
    'Snowboarding house, founded 1977 in Vermont. ⚠ Read the two failure modes before the two numbers: DWR is a consumable, seam tape is terminal. NO SIZE CHART — snow outerwear is cut to layer over, so its alpha carries a maker-specific allowance; measure instead. NO DECODER.',
    'https://www.burton.com/us/en/content/about-us.html', 0.6, true, 'migration:00584'
  ),
  (
    'spyder', 'Spyder',
    ARRAY['spyder','spyderactive','spyderski']::text[],
    ARRAY['ski','snow outerwear','racing','technical']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ THE SPEC IS A NEW-GARMENT CLAIM, and the brand explains the spec itself","detail":"Spyder publishes its own guide to waterproofing and breathability — millimetres for water pressure resisted, grams for vapour passed. Transcribe the numbers if the label carries them, and treat them as a fact about the MODEL rather than about this used item."},
      {"tell":"Fully taped versus critically taped is a SPEC, not a defect","detail":"A fully taped garment seals every seam; a critically taped one seals only neck, shoulders and chest. The second shipped that way. Untaped lower seams on a critically taped jacket are not damage — read them as the tier the garment was built at."},
      {"tell":"Ski cut runs closer than snowboard cut","detail":"Ski outerwear is generally cut nearer the body than snowboard outerwear, so the same alpha letter is a different garment across the two disciplines. Another reason to measure rather than convert."}
    ]$json$::jsonb,
    'Ski outerwear house with a racing heritage. Notable here because it publishes its own explanation of the waterproof and breathability ratings, which is the spec buyers search on. NO SIZE CHART, NO DECODER.',
    'https://www.spyder.com/blogs/expert-guides/waterproofing-and-breathability-in-ski-outerwear', 0.55, true, 'migration:00584'
  ),
  (
    'volcom', 'Volcom',
    ARRAY['volcom','volcomstone']::text[],
    ARRAY['snowboard','snow outerwear','skate','streetwear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ IT SPANS TWO CATEGORIES AND THEY GRADE DIFFERENTLY","detail":"Volcom sells both SNOW outerwear and ordinary skate/street apparel under one name. A Volcom tee is a garment; a Volcom snow jacket carries a waterproof spec, taped seams and a powder skirt. Establish which one is in hand before applying any of the guidance here — the tells about DWR and seam tape mean nothing on a t-shirt."},
      {"tell":"Same two failure modes as the rest of the category","detail":"On the snow line: DWR is a consumable, seam tape is terminal, and the inside-out photo of the shoulder seams is the one worth having."}
    ]$json$::jsonb,
    '⚠ A CROSSOVER BRAND, and that is the fact worth carrying: Volcom covers snow outerwear AND skate/street apparel under one name, so the category has to be established from the GARMENT before any snow-specific guidance applies.',
    'https://www.volcom.com/', 0.45, false, 'migration:00584'
  ),
  (
    'obermeyer', 'Obermeyer',
    ARRAY['obermeyer','sportobermeyer']::text[],
    ARRAY['ski','snow outerwear','technical']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"Ski outerwear, and the same two failure modes","detail":"DWR is a consumable; seam tape delaminating is terminal. Photograph the tape from the inside."},
      {"tell":"⚠ Children's ski wear often has GROW SYSTEMS, and they are a feature","detail":"Extendable cuffs and hems appear on youth ski outerwear so a garment lasts a second season. Let-down seams and the extra fabric folded inside are DESIGN, not alteration damage — the tailoring inlay call from 00581 in a different form."}
    ]$json$::jsonb,
    'Ski outerwear house. Seeded at MODERATE confidence — the brand facts here are limited to what could be sourced. ⚠ Its youth range uses grow systems; do not read a let-down hem as damage.',
    'https://www.obermeyer.com/', 0.45, false, 'migration:00584'
  )
on conflict (brand_key) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('burton', 'Snow jacket', ARRAY['burton jacket','burton snow jacket']::text[], 'Snow outerwear', 'Unisex', 'jacket',
   'Snowboard outerwear carrying a waterproof/breathability spec, taped seams and snow features (powder skirt, pass pocket, wrist gaiters). Seeded as one line because the model names turn over every season and none is durable identity.',
   null, ARRAY['snowboard','jacket','powder skirt','taped seams']::text[],
   'https://www.burton.com/us/en/content/about-us.html', 0.45, false, 'migration:00584'),
  ('spyder', 'Ski jacket', ARRAY['spyder jacket']::text[], 'Snow outerwear', 'Unisex', 'jacket',
   'Ski outerwear, generally cut closer to the body than snowboard outerwear at the same nominal size.',
   null, ARRAY['ski','jacket','taped seams']::text[],
   'https://www.spyder.com/blogs/expert-guides/waterproofing-and-breathability-in-ski-outerwear', 0.45, false, 'migration:00584'),
  ('volcom', 'Snow jacket', ARRAY['volcom snow']::text[], 'Snow outerwear', 'Unisex', 'jacket',
   '⚠ The SNOW line specifically — distinct from Volcom''s skate and street apparel, which carries none of this category''s specs or features.',
   null, ARRAY['snow','jacket','crossover']::text[],
   'https://www.volcom.com/', 0.4, false, 'migration:00584'),
  ('obermeyer', 'Ski jacket', ARRAY['obermeyer jacket']::text[], 'Snow outerwear', 'Unisex', 'jacket',
   'Ski outerwear. The youth range commonly includes a grow system — extendable cuffs and hem.',
   null, ARRAY['ski','jacket','grow system']::text[],
   'https://www.obermeyer.com/', 0.4, false, 'migration:00584')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes AND NO brand_size_charts. See the header: nothing here
-- carries a brand-unique tag code, and snow outerwear is cut to layer over so its
-- alpha size carries a maker-specific allowance that a chart would misstate.
-- Both absences are asserted in
-- services/edge-functions/src/tests/snow-outerwear-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00584') on conflict do nothing;
