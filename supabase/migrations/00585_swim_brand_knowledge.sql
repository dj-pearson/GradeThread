-- US-2220: swim — Speedo, TYR, Vilebrequin, Andie. The last of the seven
-- categories this story opened with.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MAKES SWIM ITS OWN CATEGORY:
--
--   **CHLORINE CONSUMES THE GARMENT, AND IT DOES IT INVISIBLY.**
--
-- Chlorine attacks the ELASTANE first, snapping its molecular chains. The suit
-- loses recovery and then sags, bags and goes translucent. A non-resistant suit
-- can lose over 60% of its tensile strength after roughly 300 hours in
-- chlorinated water — which for a swimmer training regularly is a single season.
--
-- ⚠ SO A COMPETITION SUIT CAN BE FUNCTIONALLY SPENT WHILE STILL LOOKING FINE IN
-- A PHOTOGRAPH. There is no stain, no tear and no fade to grade; the fibre has
-- simply stopped recovering. This is the sharpest version of the problem the snow
-- pack (00584) and the golf pack (00583) both hit: the failure that ends the item
-- is not the one the camera sees.
--
-- ⚠ AND THE BEST PREDICTOR IS ON THE CARE LABEL, WHICH IS UNUSUAL. Fibre content
-- ranks the expected life, and it is printed:
--
--     PBT / polyester blends   most chlorine-resistant — hold shape far longest
--     polyester + spandex      highly resistant
--     nylon + spandex          moderate; breaks down fastest
--
-- So in this one category READ THE COMPOSITION BEFORE THE PHOTOS. A nylon-elastane
-- suit with heavy pool use is near the end of its life whatever it looks like; a
-- PBT suit with the same history probably is not. State the composition in the
-- listing — it is the fact a buyer actually needs and almost nobody gives.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ THE HYGIENE LINER IS A LISTING-ELIGIBILITY FACT, NOT A CONDITION NOTE.
--
-- Swim bottoms ship with a disposable hygienic liner, and return and consignment
-- policies across the trade commonly require it INTACT along with the original
-- tags — Urban Outfitters, Summersalt, Plato's Closet and Shein all state some
-- version of it. So whether the liner is present can decide whether an item can
-- be listed or accepted at all, before anyone discusses its condition.
--
-- ⚠ THIS PACK DOES NOT STATE ANY PARTICULAR MARKETPLACE'S RULE. Policies differ
-- and change, and eBay maintains its own used-clothing policy covering this area.
-- The honest instruction is: RECORD whether the liner and tags are present, and
-- check the destination marketplace's own policy — the same flag-do-not-adjudicate
-- discipline the CITES tell uses in 00582.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO SIZE CHART. Swim splits into two sizing worlds that share no scale —
-- competition suits run a numeric scale while fashion swim runs alpha — and none
-- of the four publishes a chart this pack could cite. Inventing one would be the
-- false precision brand-kb-sizing-units.md exists to prevent.
--
-- NO DECODERS. Nothing here carries a regular, brand-unique tag code.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'speedo', 'Speedo',
    ARRAY['speedo']::text[],
    ARRAY['swim','competition','training','swimwear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ READ THE COMPOSITION BEFORE THE PHOTOS","detail":"Chlorine attacks elastane first, so the suit loses recovery and sags before it shows any stain or tear. Fibre content ranks the expected life and it is printed on the care label: PBT/polyester blends last longest, polyester-spandex is close behind, nylon-spandex breaks down fastest. A heavily-used nylon-elastane suit is near the end whatever the photograph shows."},
      {"tell":"⚠ A TRAINING SUIT IS A CONSUMED ITEM","detail":"A non-resistant suit can lose most of its tensile strength within a few hundred hours of pool time — a single season for someone training regularly. Ask how it was used, not just how it looks. Pool use and open-water or leisure use are different histories."},
      {"tell":"Sagging and translucency are the failure, not cosmetic wear","detail":"Loss of recovery IS the defect in this category. A suit that no longer springs back at the leg openings or has gone see-through when stretched is finished, even with no visible damage."}
    ]$json$::jsonb,
    'Competition and training swimwear. ⚠ The care label predicts remaining life better than the photographs do — an inversion unique to this category in the KB. NO SIZE CHART, NO DECODER.',
    'https://www.speedo.com/', 0.5, false, 'migration:00585'
  ),
  (
    'tyr', 'TYR',
    ARRAY['tyr','tyrsport']::text[],
    ARRAY['swim','competition','training','triathlon']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ SAME COMPOSITION RULE AS THE REST OF THE CATEGORY","detail":"PBT and polyester blends survive chlorine far longer than nylon-elastane. Read the label; it is the best available predictor of how much life is left."},
      {"tell":"⚠ A bare 'TYR' is three letters and needs the tag to confirm it","detail":"Short brand marks are easy to mistake in a photo. Confirm from the care label or the printed logo rather than from a silhouette."}
    ]$json$::jsonb,
    'Competition, training and triathlon swimwear. Same chlorine-degradation rules as the rest of the category.',
    'https://www.tyr.com/', 0.45, false, 'migration:00585'
  ),
  (
    'vilebrequin', 'Vilebrequin',
    ARRAY['vilebrequin']::text[],
    ARRAY['swim','luxury','mens swim shorts','resort']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ THE PRINT IS THE MODEL, AND IT IS NOT THE BRAND","detail":"This house sells men's swim shorts on seasonal prints, and the print name is what a buyer searches. Transcribe it as the STYLE or the print — never into the brand field. The graphic-is-not-the-brand rule, arriving in swimwear."},
      {"tell":"Leisure swim is not pool swim","detail":"Resort swim shorts see far less chlorine than a training suit, so the composition rule bites much less hard here. Ask about use before assuming the elastane is spent."}
    ]$json$::jsonb,
    'French luxury men''s swim shorts, sold on seasonal prints. ⚠ The print is a style, not a brand — see the-graphic-is-not-the-brand.',
    'https://www.vilebrequin.com/', 0.45, false, 'migration:00585'
  ),
  (
    'andie', 'Andie',
    ARRAY['andie','andieswim']::text[],
    ARRAY['swim','direct to consumer','womens swimwear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ THE HYGIENE LINER DECIDES LISTABILITY BEFORE CONDITION DOES","detail":"Swim bottoms ship with a disposable hygienic liner, and return and consignment policies across the trade commonly require it intact along with the original tags. RECORD whether the liner and tags are present. Do NOT state any particular marketplace's rule — policies differ and change; check the destination's own."},
      {"tell":"Same composition rule","detail":"Chlorine degrades elastane first. Read the care label."}
    ]$json$::jsonb,
    'Direct-to-consumer women''s swimwear. Carries the hygiene-liner tell for the category. ⚠ Flag the liner; do not adjudicate a marketplace policy.',
    'https://andieswim.com/', 0.4, false, 'migration:00585'
  )
on conflict (brand_key) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('speedo', 'Training suit', ARRAY['speedo training']::text[], 'Swim', 'Unisex', 'swimwear',
   'Pool training swimwear. ⚠ The fibre content on the care label predicts remaining life better than any photograph — PBT/polyester lasts, nylon-elastane does not.',
   null, ARRAY['training','pool','pbt','polyester']::text[],
   'https://www.speedo.com/', 0.4, false, 'migration:00585'),
  ('tyr', 'Training suit', ARRAY['tyr training']::text[], 'Swim', 'Unisex', 'swimwear',
   'Pool and triathlon swimwear, same composition rule.',
   null, ARRAY['training','triathlon']::text[],
   'https://www.tyr.com/', 0.4, false, 'migration:00585'),
  ('vilebrequin', 'Swim shorts', ARRAY['vilebrequin shorts','moorea']::text[], 'Swim', 'Men', 'swimwear',
   'Men''s swim shorts sold on seasonal prints. ⚠ The PRINT is the searchable model and belongs in the style, never the brand field.',
   null, ARRAY['swim shorts','print','resort']::text[],
   'https://www.vilebrequin.com/', 0.4, false, 'migration:00585'),
  ('andie', 'Swimsuit', ARRAY['andie swimsuit']::text[], 'Swim', 'Women', 'swimwear',
   'Women''s swimwear. ⚠ Record whether the hygienic liner and tags are intact — it can decide listability before condition is discussed.',
   null, ARRAY['swimsuit','hygiene liner']::text[],
   'https://andieswim.com/', 0.4, false, 'migration:00585')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes AND NO brand_size_charts. Swim splits into two sizing
-- worlds that share no scale (numeric competition, alpha fashion) and none of the
-- four publishes a chart this pack could cite. Both absences are asserted in
-- services/edge-functions/src/tests/swim-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00585') on conflict do nothing;
