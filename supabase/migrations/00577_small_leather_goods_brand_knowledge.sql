-- US-2221: Small leather goods (4 brands) — Bellroy, The Ridge, Secrid, Bosca.
-- The last of the four accessory packs (00574 headwear, 00575 eyewear,
-- 00576 jewelry, this).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE STORY ASKED FOR SLG "AS A DISTINCT CLASS FROM HANDBAGS". IT IS, AND HERE
-- IS WHAT MAKES IT ONE.
--
-- 00468 seeded handbags on a single sentence: A BAG CARRIES LESS RECOVERABLE
-- INFORMATION ON ITS BODY THAN A GARMENT DOES. This pack is that sentence one
-- step further, and the step is bigger than it looks:
--
--   A WALLET CARRIES LESS THAN A BAG, AND WHAT LITTLE IT CARRIES WEARS OFF
--   EXACTLY WHERE THE HAND HOLDS IT.
--
-- A garment has a sewn care label. A bag has a hangtag, and sometimes a sewn
-- creed patch (Coach, 00398). A wallet has NEITHER. Its only mark is a small
-- embossed or foil-stamped logo on a panel that is gripped, folded and pocketed
-- every day. SO IDENTIFIABILITY DEGRADES WITH CONDITION — the more used the
-- item, the less recoverable its brand — and that coupling does not exist
-- anywhere else in this KB. A blank-looking wallet is not evidence of a
-- no-name wallet.
--
-- ⚠ AND A HOUSE'S WALLET IS NOT ITS BAG. Coach, Louis Vuitton, Gucci, Dooney &
-- Bourke and Fossil already have packs, all of them written around BAGS. Their
-- small leather goods sit on a different price ladder, wear at different points
-- and are faked at different rates, so a wallet must never inherit a bag's
-- grading or a bag's comp. That is what "distinct class" means operationally.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE CATEGORY'S NAME IS ALREADY WRONG, AND IT IS A GRADING PROBLEM.
--
-- "Small LEATHER goods" — and two of the four brands here make their flagship
-- out of METAL. The Ridge is aluminium, titanium or carbon fibre. Secrid's
-- Cardprotector is anodised aluminium, plastic and stainless steel; only the
-- Miniwallet wraps it in leather. A leather rubric applied to those returns
-- nonsense: there is no grain to scuff, no patina to develop and no dryness to
-- assess, while the real failure modes — anodising wear at the corners, a bent
-- plate, a stretched elastic, a card mechanism that no longer springs — have no
-- leather analogue at all. Recorded as tells so the model is told what to look
-- at rather than left to invent leather defects for an aluminium object.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WEAR ON A WALLET IS CONCENTRATED AND PREDICTABLE, which is the opposite of a
-- garment and is the pack's most useful grading content. Four places carry
-- nearly all of it:
--
--   * THE SPINE — the fold cracks and eventually splits.
--   * THE CARD SLOTS — leather stretches permanently, and a slot that has held
--     a card for a year does not come back.
--   * THE CORNERS — abrade first, against the pocket seam.
--   * THE BILL COMPARTMENT lining — tears along the top edge, and is the defect
--     most often hidden in listing photos because nobody opens it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ THE DESIGN-VS-DEFECT CALL THIS CATEGORY GETS BACKWARDS: PATINA. Bosca's
-- signature line is literally called Old Leather and the house sells it on
-- "signature patinas that only improve with age, use & adventure". Darkening and
-- gloss on that leather are the INTENDED outcome, not wear. Grading a patina as
-- soiling marks the item down for doing the one thing it was designed to do —
-- the same error as calling a Persol Meflecto stem a loose arm (00575) or a
-- vachetta bag's darkening a stain (00468).
--
-- NO DECODERS. No brand here puts a style code on the object; the model name is
-- on the box and in the catalogue. NO SIZE CHARTS — a wallet has no size.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'bellroy', 'Bellroy',
    ARRAY['bellroy']::text[],
    ARRAY['small leather goods','wallets','card holders','bags']::text[],
    $json$[
      {"era":"Founded at Bells Beach / Fitzroy","years":"2010","description":"Bellroy dates itself to 2010, around a kitchen table, from Bells Beach and Fitzroy in Australia. A founding year is not a production date and must never be read as one.","source_url":"https://bellroy.com/about-us","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"The mark is embossed on an outer panel and wears off","detail":"There is no care label and no hangtag on a wallet. The logo is embossed into a panel the hand grips, so a well-used piece can be genuinely unmarked. Absence of a mark is not evidence of a no-name wallet — it is evidence of use."},
      {"tell":"Leather sourcing is a stated claim, not a visible one","detail":"Bellroy states it uses leather from gold-rated Leather Working Group tanneries. That is a supply-chain claim about the maker, not something readable off the object, so it belongs in a description as a brand fact and never as an authentication test."},
      {"tell":"Slimness is the design brief","detail":"These are built to stay thin. A Bellroy that has taken a permanent bulge from being overstuffed has lost the property it was bought for, which is a condition fact worth calling out rather than a cosmetic one."}
    ]$json$::jsonb,
    'Australian carry-goods house, founded 2010. Wallets, card holders and bags. NO DECODER — the model name lives on the box and in the catalogue, never on the object.',
    'https://bellroy.com/about-us', 0.65, true, 'migration:00577'
  ),
  (
    'theridge', 'The Ridge',
    ARRAY['ridge','ridgewallet','theridge']::text[],
    ARRAY['small leather goods','wallets','metal wallets','edc']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"IT IS NOT LEATHER, so do not grade it as leather","detail":"The Ridge is built from aluminium, titanium or carbon fibre, with a patented dual-track plate design and an elastic or money-clip retention. A leather rubric has nothing to say about it. Grade the ANODISING (corner wear, scratches through to bare metal), the PLATES (bent, sprung, no longer parallel), and the ELASTIC or clip (stretched, torn, lost tension)."},
      {"tell":"RFID blocking is a claim about the material, not a condition","detail":"The metal body is what blocks RFID. It is a product property, not a feature that can degrade, so it does not belong in a condition assessment."},
      {"tell":"The warranty travels with the brand, not the item","detail":"The Ridge advertises a lifetime-style replacement warranty. Whether it transfers to a second-hand buyer is between the buyer and the brand — never state or imply that a resold wallet carries it."}
    ]$json$::jsonb,
    'American minimalist metal wallets. ⚠ THE CATEGORY NAME LIES HERE: this is small leather goods with no leather in it. The failure modes are anodising wear, bent plates and dead elastic, none of which a leather rubric can see. NO DECODER, NO SIZE CHART.',
    'https://ridge.com/', 0.60, true, 'migration:00577'
  ),
  (
    'secrid', 'Secrid',
    ARRAY['secrid']::text[],
    ARRAY['small leather goods','wallets','card holders','dutch design']::text[],
    $json$[
      {"era":"Dutch wallet makers since 1995","years":"1995","description":"Secrid dates itself to 1995 and states its wallets are made in Holland. The first Cardprotector won a Red Dot Design Award in 2010, and the Miniwallet took a European Aluminium Award two years later — awards date a DESIGN, never an individual item.","source_url":"https://secrid.com/en-us/","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"THE MECHANISM IS THE ITEM — test it, then say so","detail":"The Cardprotector is anodised aluminium, plastic and stainless steel with a patented mechanism that slides the cards out in one motion. If the lever is stiff, does not return, or no longer fans the cards, the wallet has failed at its only job, and that outweighs any cosmetic grade. A listing that shows the outside and says nothing about the action has not described the item."},
      {"tell":"The Miniwallet is a leather cover over an aluminium core","detail":"Secrid describes the Miniwallet as a leather cover around the aluminium Cardprotector, adding room for four more cards and bills. So one model in the range genuinely IS part leather and part metal, and both parts need grading."},
      {"tell":"Water resistance is a material fact about the core","detail":"Secrid states the aluminium Cardprotector is impervious to water. That says nothing about a leather cover, which is not."}
    ]$json$::jsonb,
    'Dutch card-wallet house, founded 1995, made in Holland. The Cardprotector is aluminium; the Miniwallet is leather over an aluminium core. ⚠ Grade the MECHANISM first — it is what the product is.',
    'https://secrid.com/en-us/', 0.65, true, 'migration:00577'
  ),
  (
    'bosca', 'Bosca',
    ARRAY['bosca','hugobosca']::text[],
    ARRAY['small leather goods','wallets','belts','american heritage']::text[],
    $json$[
      {"era":"Founded in Springfield, Ohio by Hugo Bosca","years":"1911","description":"Bosca dates itself to 1911 in Springfield, Ohio, founded by Hugo Bosca on Italian craft traditions. A founding year printed on a label dates the HOUSE and never the piece.","source_url":"https://www.bosca.com/pages/heritage","confidence":0.65}
    ]$json$::jsonb,
    $json$[
      {"tell":"⚠ PATINA ON OLD LEATHER IS THE PRODUCT, NOT WEAR","detail":"Bosca's signature line is called Old Leather and the house sells it on 'signature patinas that only improve with age, use & adventure' — hand-stained Italian leather that deepens into a gloss. Darkening and sheen there are the INTENDED outcome. Marking an Old Leather wallet down for patina penalises it for doing the one thing it was designed to do. Grade the cracking, the split spine and the stretched slots instead."},
      {"tell":"The mark is a small blind emboss","detail":"No care label, no hangtag. On a heavily used piece the emboss can be nearly invisible under the patina it caused, which is the identifiability-degrades-with-condition problem in its sharpest form."}
    ]$json$::jsonb,
    'American leather house, founded 1911 in Springfield, Ohio; Italian-American men''s wallets, belts and accessories. ⚠ Its signature Old Leather is SOLD ON its patina — do not grade that as soiling.',
    'https://www.bosca.com/pages/heritage', 0.60, true, 'migration:00577'
  )
on conflict (brand_key) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('bellroy', 'Slim Sleeve', ARRAY['slim sleeve']::text[], 'Wallets', 'Unisex', 'wallet',
   'Slim bi-fold leather wallet with pull-tab card access, built to stay thin rather than to hold everything.',
   null, ARRAY['slim sleeve','bifold','slim wallet']::text[],
   'https://bellroy.com/products/slim-sleeve-wallet', 0.65, true, 'migration:00577'),
  ('bellroy', 'Apex Slim Sleeve', ARRAY['apex','apex slim sleeve']::text[], 'Wallets', 'Unisex', 'wallet',
   'The moulded-leather version of the Slim Sleeve.',
   null, ARRAY['apex','moulded leather']::text[],
   'https://bellroy.com/products/apex-slim-sleeve', 0.60, true, 'migration:00577'),
  ('theridge', 'Ridge Wallet', ARRAY['ridge wallet','the ridge']::text[], 'Wallets', 'Unisex', 'wallet',
   'Two metal plates on a patented dual-track, held by an elastic band or a money clip, in aluminium, titanium or carbon fibre. The FINISH is the variant — the shape does not change between them.',
   null, ARRAY['ridge','metal wallet','aluminum','titanium','carbon fiber']::text[],
   'https://ridge.com/collections/wallets', 0.60, true, 'migration:00577'),
  ('secrid', 'Cardprotector', ARRAY['cardprotector','card protector']::text[], 'Wallets', 'Unisex', 'wallet',
   'Anodised aluminium card case holding up to six cards, with the patented slide-out mechanism. No leather at all.',
   null, ARRAY['cardprotector','aluminium','rfid']::text[],
   'https://secrid.com/en-us/wallets/cardprotector/', 0.70, true, 'migration:00577'),
  ('secrid', 'Miniwallet', ARRAY['miniwallet','mini wallet']::text[], 'Wallets', 'Unisex', 'wallet',
   'The Cardprotector wrapped in a leather cover, adding four card slots and a bill compartment for up to ten cards. Part leather, part metal — grade both.',
   null, ARRAY['miniwallet','leather cover','aluminium core']::text[],
   'https://secrid.com/en-us/wallets/miniwallet/', 0.70, true, 'migration:00577'),
  ('bosca', 'Old Leather', ARRAY['old leather','old leather classic']::text[], 'Wallets', 'Men', 'wallet',
   'Hand-stained Italian leather with a glossy finish, sold across bi-folds, executive ID wallets, front-pocket wallets and the Weekend Wallet. ⚠ The patina is the point of the line, not a defect in it.',
   null, ARRAY['old leather','bifold','patina']::text[],
   'https://www.bosca.com/collections/old-leather', 0.65, true, 'migration:00577')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes AND NO brand_size_charts. No brand here puts a style code
-- on the object — the model name is on the box and in the catalogue — and a
-- wallet has no size. Both absences are asserted in
-- services/edge-functions/src/tests/small-leather-goods-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00577') on conflict do nothing;
