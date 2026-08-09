-- US-2220: scrubs and uniform — FIGS, Cherokee, WonderWink. The story names this
-- and vintage tees (00579) as the two highest-volume misses, and calls scrubs
-- "one of the highest-volume resale categories" the KB did not cover at all.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MAKES UNIFORM DIFFERENT FROM APPAREL, AND IT IS NOT THE GARMENT SHAPE.
--
--   1. **IT IS SOLD AS SEPARATES THAT SIZE INDEPENDENTLY.** A scrub top and a
--      scrub pant are two products with two size runs, frequently bought in
--      different sizes by the same person. A listing that says "size M" has said
--      half of what a buyer needs, and a matched SET is worth more than the two
--      pieces apart. This is why no single size chart is seeded per brand — one
--      chart would flatten two independent runs into a claim neither supports.
--   2. **COLOUR IS COMPLIANCE, NOT TASTE.** Hospitals mandate scrub colour by
--      role and by unit, so colour is the PRIMARY search term in this category
--      rather than a preference, and a discontinued colour carries a real premium
--      because a nurse whose unit wears it cannot simply pick another. Treat the
--      colour name as identity, not decoration.
--   3. **THE DEFECTS ARE OCCUPATIONAL AND THEY ARE TERMINAL.** Bleach spotting,
--      betadine/iodine, and blood are the category's characteristic damage, and
--      unlike almost everything else this KB grades they cannot be discounted
--      into acceptability: the garment has to read as clean in a clinical
--      setting. A bleach spot on a scrub top is closer to a hole than to a stain.
--
-- ⚠ NOTE THE CONTRAST WITH 00579, WHICH SHIPPED THE SAME DAY. In vintage tees the
-- wear IS the product and fade is the premium. In scrubs the identical
-- observation — a faded, softened, spotted garment — is the failure. Two
-- categories, opposite readings of the same photograph, which is exactly why
-- per-category guidance exists rather than one condition rubric.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ THE COLLISION THIS PACK FOUND, AND IT IS WITH A BRAND ALREADY IN THE KB:
--
--   **"DICKIES" ON A SCRUB TOP IS NOT THE WORKWEAR HOUSE.**
--
-- Careismatic Brands publishes its portfolio: Cherokee, Infinity, Healing Hands,
-- **Dickies Medical**, Med Couture, heartsoul, AllHeart and Medelita. So Dickies
-- Medical is a Careismatic line carrying the Dickies name under licence — while
-- `dickies` has been a canonical brand in this KB since 00389, pointed at the
-- workwear house whose packs, tells and sizing are about work pants.
--
-- This is 00468's Fossil trap in a new costume: a manufacturer producing licensed
-- product under another house's name. Resolving a scrub top onto the workwear
-- pack would hand it the wrong sizing chart and the wrong tells. So
-- `Dickies Medical` is seeded as its OWN canonical rather than folded onto
-- `Dickies` — the Marc-by-Marc-Jacobs rule (00468): a shared name is not a fold.
--
-- ⚠ AND A NEGATIVE THAT WAS CHECKED RATHER THAN ASSUMED: **WonderWink is NOT in
-- Careismatic's published portfolio.** The obvious guess — that every big scrub
-- label rolls up to the same parent — is wrong, and its ownership could not be
-- sourced. Nothing is claimed about it. An unsourced corporate relationship is
-- the same class of invention as an unsourced era.
--
-- NO DECODERS. No brand here puts a style code on the garment; the line name is
-- printed on the tag as words ("Workwear Revolution", "WonderWORK"), which is a
-- NAME and falls to the Rag & Bone `Fit 2` refusal.
--
-- NO SIZE CHARTS, for reason (1) above and because none of the three publishes a
-- chart this pack could cite. Alpha sizing here runs XXS-5XL with petite and tall
-- variants; seeding a single chart per brand would invent a precision that
-- separates do not have.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'figs', 'FIGS',
    ARRAY['figs','wearfigs','figsscrubs']::text[],
    ARRAY['scrubs','uniform','healthcare apparel','direct to consumer']::text[],
    $json$[
      {"era":"Co-founded, direct-to-consumer","years":"2013","description":"FIGS dates itself to 2013, founded by Heather Hasson and Trina Spear as a digitally native, direct-to-consumer healthcare apparel brand. It sells its own product rather than through the uniform-shop channel the older houses use, which is why its resale supply is newer and more uniform in condition.","source_url":"https://www.wearfigs.com/pages/our-story","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"The fabric line is the model","detail":"FIGS sells named technical fabrics rather than one house cloth, and the fabric is what a buyer searches. Read the tag for the line, not just the silhouette."},
      {"tell":"⚠ A PERFORMANCE FINISH CLAIM DOES NOT SURVIVE RESALE","detail":"Antimicrobial, fluid-repellent and similar finishes are applied treatments that degrade with laundering, and there is no way to verify one on a used garment. Repeat the BRAND's claim only as a brand fact about the model; never state or imply that THIS second-hand garment still has it."},
      {"tell":"Colour is compliance, not taste","detail":"Hospitals mandate scrub colour by role and unit, so the colour name is the primary search term and a discontinued colour carries a premium. Name it exactly."}
    ]$json$::jsonb,
    'Direct-to-consumer healthcare apparel, founded 2013. NO DECODER and NO SIZE CHART - scrubs are separates that size independently, so one chart per brand would flatten two runs into a claim neither supports. ⚠ Never carry a performance-finish claim onto a used garment.',
    'https://www.wearfigs.com/pages/our-story', 0.65, true, 'migration:00580'
  ),
  (
    'cherokeeuniforms', 'Cherokee Uniforms',
    ARRAY['cherokeeuniforms','cherokeescrubs','cherokeemedical']::text[],
    ARRAY['scrubs','uniform','healthcare apparel']::text[],
    $json$[
      {"era":"Launched under Strategic Partners, Chatsworth CA","years":"1995","description":"Cherokee's medical line launched in 1995 as part of Strategic Partners Inc. of Chatsworth, California, and grew into the largest medical apparel line in the world. The company is now Careismatic Brands, headquartered in Santa Monica.","source_url":"https://www.careismatic.com/cherokee","confidence":0.6}
    ]$json$::jsonb,
    $json$[
      {"tell":"⚠ CHEROKEE UNIFORMS IS NOT THE CHEROKEE FASHION LABEL","detail":"The medical line is a Careismatic brand. The Cherokee name has also been licensed to general apparel over the years, so a Cherokee tag on a non-medical garment is a different product with a different value - do not let a scrub pack claim it."},
      {"tell":"The line name is printed as words on the tag","detail":"Workwear Revolution, Infinity and the rest are read off the tag as text. There is no numeric style code on the garment, so nothing here can be decoded from a cut tag."},
      {"tell":"Occupational stains are terminal, not discountable","detail":"Bleach spotting, betadine and blood are this category's characteristic damage, and a scrub has to read as clean in a clinical setting. Grade a bleach spot closer to a hole than to a stain."}
    ]$json$::jsonb,
    'The largest medical apparel line, launched 1995, now a Careismatic brand. ⚠ Seeded under brand_key cherokeeuniforms rather than "cherokee" DELIBERATELY - the bare Cherokee name has been licensed across general apparel, and a scrub pack must not claim those garments.',
    'https://www.careismatic.com/cherokee', 0.6, true, 'migration:00580'
  ),
  (
    'wonderwink', 'WonderWink',
    ARRAY['wonderwink','wink','winkscrubs']::text[],
    ARRAY['scrubs','uniform','healthcare apparel']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ ITS OWNERSHIP IS NOT CLAIMED HERE, AND THAT IS DELIBERATE","detail":"WonderWink does NOT appear in Careismatic Brands' published portfolio, so the obvious guess that every large scrub label shares a parent is wrong. No ownership is asserted because none could be sourced - an unsourced corporate relationship is the same class of invention as an unsourced era."},
      {"tell":"The line is on the tag as a word","detail":"WonderWORK, Thrive, Origins, W123 and the Wink lines are printed as names. A name is not a decoder - it would recover the brand from any tag carrying an ordinary word."},
      {"tell":"Same occupational defects as the rest of the category","detail":"Bleach spotting, betadine and blood; plus pilling at the thigh, a stretched drawstring, and pocket sag from carrying shears and a phone all shift."}
    ]$json$::jsonb,
    'Scrub house with a broad named-line range (WonderWORK, Thrive, Origins, W123, the Wink lines). Lines seeded at MODERATE confidence - they are consistently listed across the uniform-retail channel rather than stated on a first-party page. ⚠ No ownership claim, deliberately.',
    'https://winkscrubs.com/collections/wonderwork', 0.5, false, 'migration:00580'
  )
on conflict (brand_key) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('figs', 'Technical Collection', ARRAY['technical collection','figs technical']::text[], 'Scrubs', 'Unisex', 'scrubs',
   'FIGS'' range of named performance fabrics, sold as the reason to buy rather than as a silhouette. The fabric line is what a buyer searches and it is on the tag.',
   null, ARRAY['technical','performance fabric','scrubs']::text[],
   'https://www.wearfigs.com/en-US/pages/figs-anatomy', 0.6, true, 'migration:00580'),
  ('cherokeeuniforms', 'Workwear Revolution', ARRAY['workwear revolution','revolution']::text[], 'Scrubs', 'Unisex', 'scrubs',
   'Poly/rayon/spandex twill line for men and women, with cellphone compartments, hidden instrument loops, bungee loops and multiple pockets. The pocket layout is the identifying feature in a photo.',
   null, ARRAY['workwear revolution','twill','pockets']::text[],
   'https://www.cherokeeuniforms.com/workwear-revolution-women-scrubs.html', 0.6, true, 'migration:00580'),
  ('wonderwink', 'WonderWORK', ARRAY['wonderwork']::text[], 'Scrubs', 'Unisex', 'scrubs',
   'The value line in the WonderWink range, carried across the uniform-retail channel and on the brand''s own store.',
   null, ARRAY['wonderwork','value line']::text[],
   'https://winkscrubs.com/collections/wonderwork', 0.5, false, 'migration:00580'),
  ('wonderwink', 'Thrive', ARRAY['thrive','wonderwink thrive']::text[], 'Scrubs', 'Unisex', 'scrubs',
   'A named WonderWink line sold on sustainability and water-repellency claims. ⚠ Those are the finish claims that do not survive resale — carry them as brand facts about the model, never as a property of a used garment.',
   null, ARRAY['thrive','water repellent']::text[],
   'https://www.scrubsandbeyond.com/wonderwink-thrive.html', 0.45, false, 'migration:00580')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes and NO brand_size_charts, both deliberate. The line name
-- is printed as WORDS on the tag, and a name is the Rag & Bone `Fit 2` refusal;
-- and scrubs are separates that size independently, so a single chart per brand
-- would flatten two runs. Asserted in
-- services/edge-functions/src/tests/scrubs-uniform-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00580') on conflict do nothing;
