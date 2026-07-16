-- US-1733: Athleisure & activewear brand knowledge group (6 brands).
--
-- Under Armour, Vuori, Gymshark, Fabletics, Beyond Yoga, Sweaty Betty — the tier
-- of activewear below the flagships (Lululemon 00390 / Alo 00447 / Athleta 00448).
--
-- The through-line for this group: identity is read from the FABRIC PLATFORM, not
-- a style code. Beyond Yoga (Spacedye), Fabletics (PowerHold), Gymshark (Vital vs
-- Adapt) and Under Armour (HeatGear/ColdGear) all brand their fabric and print it
-- on the garment; the confusable pairs within each brand are fabric siblings.
-- Under Armour is the ONLY brand in this group with a decodable tag code (its
-- 7-digit style number is documented by UA's own help center as tag-printed), so
-- it gets the group's only brand_style_codes row. The others get NO decoder — a
-- web/catalog SKU that is not tag-printed and not decodable is deliberately NOT
-- seeded as one (the Beyond Yoga SD/HR/IT prefix and the Fabletics/Gymshark web
-- SKUs are recorded as informational tells instead).
--
-- Two sizing traps are seeded as first-class facts because they are the costliest
-- resale errors in this group:
--   * Sweaty Betty labels UK sizes: UK 12 = US 8 (offset -4) — but the offset
--     BREAKS above UK 14 (UK 16-18 -> US 12, UK 18-20 -> US 14), so a blind
--     "subtract 4" converter is wrong at XL/XXL.
--   * Gymshark, despite also being a UK brand, does NOT use UK numerics — it
--     labels international XS-XXL. There is no numeric trap. (Verified against
--     Gymshark's own size guide; the Sweaty Betty analogy does not carry over.)
--
-- Data-only, idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  ('underarmour', 'Under Armour', ARRAY['under armour','underarmour','ua','under armor']::text[],
   ARRAY['activewear','training','performance','mens','womens']::text[],
   $j$[{"pattern":"Imported","note":"Manufactured offshore (Asia / Central America); country of origin varies by garment and is NOT a reliable authentication signal on its own."}]$j$::jsonb,
   $j$[{"tell":"GEAR platform is printed on the garment","detail":"HeatGear (built for 75F and above), ColdGear (55F and below, dual-layer: smooth face + brushed interior), AllSeasonGear (55-75F). The wordmark on the tag/garment IS the line — this is the primary Under Armour disambiguation and needs no code."},{"tell":"Tag-printed 7-digit style number","detail":"Genuine garments carry a 7-digit style number on a small white label beneath the wash/care label — tops: left inside seam; bottoms: back of the inside waistband — sometimes prefixed STYLE or a season code (FW24 / SS25). ABSENCE is a flag; PRESENCE proves nothing (counterfeiters copy it)."},{"tell":"The -001 color suffix is NOT a tag field","detail":"Retailer SKUs render as 1361518-001, but the 3-digit color suffix is catalog metadata, not verified as tag-printed, and 001=Black is not a verified brand-wide convention. Do not decode the suffix."},{"tell":"Never auto-authenticate","detail":"Under Armour is heavily counterfeited and NO single tell is dispositive — logo/stitching heuristics come only from low-authority sources. Route to human review; never emit an authentic/fake verdict. Flag inconsistencies in condition_notes only."}]$j$::jsonb,
   'Under Armour identity = the GEAR platform printed on the garment (HeatGear / ColdGear / AllSeasonGear) + the tag-printed 7-digit style number. Founded 1996 by Kevin Plank (started in a DC-area basement; Baltimore HQ from late 1998). RN omitted — not sourceable.',
   'https://help.underarmour.ca/s/article/What-are-the-differences-between-COLDGEAR-HEATGEAR-and-ALLSEASONGEAR?language=en_US', 0.85, false, 'migration:00452'),

  ('vuori', 'Vuori', ARRAY['vuori','vuori clothing','vuori performance apparel']::text[],
   ARRAY['activewear','athleisure','performance','mens','womens']::text[],
   $j$[{"pattern":"Imported","note":"US brand (HQ San Diego County CA; flagship Encinitas) manufacturing offshore. No reliable country-of-origin tell — do not use as an authentication signal."}]$j$::jsonb,
   $j$[{"tell":"Trademarked fabric names","detail":"DreamKnit (Ponto, Clean Elevation) and Kore / HardKore are the brand fabric marks. Presence is consistent with genuine; absence or misspelling is a SOFT flag only."},{"tell":"Composition matches the named fabric","detail":"Ponto DreamKnit = 89% recycled polyester / 11% elastane; Clean Elevation DreamKnit Move = 87% recycled polyester / 13% elastane. A care tag far off these for a claimed style is a soft inconsistency, not proof."},{"tell":"Knit vs woven separates the lines","detail":"Ponto/Clean Elevation are soft brushed KNITs; Kore/Banks/HardKore shorts are WOVEN. The hand of the fabric is the fastest line-level tell."},{"tell":"Never auto-authenticate","detail":"No Vuori-specific counterfeit decoder, RN, tag code or serial exists that could prove authenticity programmatically. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Vuori (Finnish for "mountain") — founded 2015 by Joe Kudla, Encinitas/San Diego CA. Men''s-FIRST origin (women''s added 2018); the current gender mix is reported roughly even, so do NOT assert a men''s-majority business. Identity = style name + trademarked fabric (DreamKnit / Kore). No tag decoder. RN omitted — not sourceable.',
   'https://en.wikipedia.org/wiki/Vuori', 0.80, false, 'migration:00452'),

  ('gymshark', 'Gymshark', ARRAY['gymshark','gym shark']::text[],
   ARRAY['activewear','gym','athleisure','womens','mens']::text[],
   $j$[{"pattern":"Imported","note":"UK brand (Solihull, England) manufacturing offshore — Made in China / Vietnam / Turkey on the care label is NORMAL and is not a counterfeit tell."}]$j$::jsonb,
   $j$[{"tell":"UK brand but NOT UK numeric sizing","detail":"CRITICAL and counterintuitive: despite being UK-founded, Gymshark labels INTERNATIONAL alpha sizes — women XXS-XXL, men XS-3XL. There is NO UK-numeric-to-US trap here (unlike Sweaty Betty). The sole exception is Elite Pants, which use an inch waist (28-40) with Regular/Tall inseams."},{"tell":"Seamless family = the knit pattern","detail":"Vital Seamless is MARL (heathered two-tone) with a contouring dot texture. Adapt is PRINTED — Camo / Animal / Fleck. Marl+dots means Vital, NOT Adapt. There is no such thing as Adapt Marl."},{"tell":"Fabric weight matches the collection","detail":"Gymshark publishes gsm per line (Adapt ~420, Lift ~410, Whitney ~230). A limp garment claiming to be Adapt is a real signal — but weigh it, do not eyeball it."},{"tell":"Never auto-authenticate","detail":"No public brand-verified authentication standard exists for Gymshark; tag-print and logo heuristics come from low-authority sources only. Flag for human review; never auto-pass or auto-fail."}]$j$::jsonb,
   'Gymshark identity = the seamless knit family (Vital marl vs Adapt print) + published gsm. UK brand (founded 2012, Ben Francis, Solihull) that labels INTERNATIONAL XS-XXL, not UK numerics. No tag decoder — its public identifier is a web SKU/URL slug with an embedded season code (SS25), which is not tag-printed. RN omitted — not sourceable.',
   'https://support.gymshark.com/en/articles/11204065-women-s-size-guide', 0.85, false, 'migration:00452'),

  ('fabletics', 'Fabletics', ARRAY['fabletics','fabletics men','fabletics sport']::text[],
   ARRAY['activewear','athleisure','womens','mens']::text[],
   $j$[{"pattern":"Imported","note":"Country-of-origin pattern not sourceable — omitted rather than guessed. Do not use origin as a Fabletics signal."}]$j$::jsonb,
   $j$[{"tell":"VIP dual-tier pricing — never comp against list price","detail":"HIGHEST-VALUE FABLETICS FACT. Fabletics is a VIP-membership subscription brand ($59.95/mo credit) showing a high regular price beside a much lower VIP price (20-50% off; new-member offers go to ~$12/pair). The regular price is a ceiling almost nobody pays. Used PowerHold leggings ask ~$12-39 against a $49-99 claimed retail. Comp on SOLD prices only; never anchor to a seller-claimed MSRP."},{"tell":"Fabric platform is the product identity","detail":"The official fabric guide ranks five platforms by compression: PowerHold (max) > Motion365 (high) > SculptKnit (med) > PureLuxe (med-light) > Seamless (light). Genuine titles read [Style] + [Fabric] + [Rise/Length], e.g. Define PowerHold High-Waisted 7/8 Legging."},{"tell":"Registered fabric wordmark","detail":"PowerHold and Motion365 carry the registered mark in official titles. A listing citing a fabric Fabletics does not have (e.g. Oasis) is more likely seller error than counterfeit. NOTE: the fabric name is NOT verified as printed on the interior tag — do not build a tag-OCR rule on it."},{"tell":"Never auto-authenticate","detail":"Low-ASP, high-volume DTC brand with no meaningful counterfeit market and no published authentication standard. The realistic resale risk is MISLABELING (wrong fabric, wrong silhouette, wrong size), not forgery. Never emit an authenticity verdict."}]$j$::jsonb,
   'Fabletics identity = FABRIC PLATFORM (PowerHold / Motion365 / SculptKnit / PureLuxe / Seamless). Founded July 2013 by Adam Goldenberg, Don Ressler and Ginger Ressler; Kate Hudson took a ~20% stake in 2015 and is a MARKETING co-founder, not a founder of record. Men''s line launched April 2020. Yitty (Lizzo, 2022) is a SISTER brand, not a Fabletics sub-line — list it separately. No tag decoder. RN omitted.',
   'https://www.fabletics.com/guides/fabric', 0.80, false, 'migration:00452'),

  ('beyondyoga', 'Beyond Yoga', ARRAY['beyond yoga','beyondyoga']::text[],
   ARRAY['activewear','athleisure','yoga','womens']::text[],
   $j$[{"pattern":"Made in California / Made in the USA (PER PRODUCT)","note":"Domestic manufacture is claimed at PRODUCT level on core knits (Spacedye SD3463 reads Made in California; POWERBEYOND reads Made in the USA) — NOT as a brand-wide fact, and Levi's own brand page is silent on it. Likely US-sewn from IMPORTED fabric. Verify per item; foreign origin is NOT a fake verdict."}]$j$::jsonb,
   $j$[{"tell":"Spacedye is the #1 identifier — and it is never flat","detail":"Yarn is dyed BEFORE knitting, so every Spacedye colorway is heathered/marled with visible tonal depth — including the blacks and navies (Darkest Night, Nocturnal Navy read as deep heathered charcoal/navy). If the fabric photographs as a dead-flat solid, it is NOT Spacedye."},{"tell":"Composition separates the fabric platforms","detail":"Spacedye 87% polyester / 13% elastane; Featherweight Spacedye 94% poly / 6% spandex; Heather Rib 84% polyester / 16% Lycra; POWERBEYOND 75% polyester / 25% elastane. A care tag contradicting the claimed platform is a real inconsistency. Lycra IS elastane — that naming variant is not a mismatch."},{"tell":"Name grammar is compositional","detail":"Titles read [FABRIC PLATFORM] + [SILHOUETTE] + [RISE/LENGTH] + [GARMENT], e.g. Spacedye Caught In The Midi High Waisted Legging. At Your Leisure / Caught In The Midi / Out Of Pocket are SILHOUETTES, not fabrics — parse against the grammar rather than as opaque style names."},{"tell":"SD/HR/IT web code prefix encodes the fabric (LOOKUP ONLY)","detail":"Official product URLs carry a 2-letter + 4-digit code whose prefix maps to the fabric: SD=Spacedye, HR=Heather Rib, IT=POWERBEYOND (SD3243 and HR3243 share a silhouette block across fabrics). This is WEB-SIDE ONLY — no evidence it is printed on the tag — so it is an informational tell and a listing/URL parse aid, NOT a tag decoder."},{"tell":"Never auto-authenticate","detail":"No Beyond Yoga-specific counterfeit guide or tag-security feature exists; the brand has no visible counterfeit ecosystem. Route authenticity to human review and weight toward correct ATTRIBUTION, not forgery detection."}]$j$::jsonb,
   'Beyond Yoga identity = the FABRIC PLATFORM, and Spacedye''s heathered face is the whole game (vs Heather Rib''s visible vertical rib — both are heathered, so look for the RIB to separate them). Acquired by Levi Strauss & Co: announced 2021-08-05, closed September 2021. Size-inclusive XXS-4X. No tag decoder. RN omitted — not sourceable.',
   'https://beyondyoga.com/pages/fabric-guide', 0.80, false, 'migration:00452'),

  ('sweatybetty', 'Sweaty Betty', ARRAY['sweaty betty','sweatybetty','sweaty betty london']::text[],
   ARRAY['activewear','athleisure','yoga','running','womens']::text[],
   $j$[{"pattern":"Imported","note":"UK brand (founded 1998, Notting Hill, London) manufacturing offshore; country of origin on the tag varies and is NOT a reliable authentication signal."}]$j$::jsonb,
   $j$[{"tell":"UK SIZING — the costliest error on this brand","detail":"CRITICAL. Sweaty Betty labels UK numeric sizes (6-20) and/or XXS-XXL. Per the brand's own guide the UK->US offset is MINUS 4 through UK 14: UK 8=US 4, UK 10=US 6, UK 12=US 8. Mis-listing a UK 12 as a US 12 is a two-size overstatement. TRAP: the offset BREAKS above UK 14 — UK 16-18 collapses to US 12 and UK 18-20 to US 14 — so never subtract 4 blindly at XL/XXL."},{"tell":"Letter sizes map to UK RANGES at the top","detail":"XS=8, S=10, M=12, L=14, but XL=16-18 and XXL=18-20. A letter-only tag therefore cannot be resolved to a single UK number at XL/XXL — measure the garment."},{"tell":"Women's-only brand","detail":"Sweaty Betty is a women's brand; a men's Sweaty Betty garment is a strong red flag."},{"tell":"SB web code is lookup-only","detail":"Brand URLs expose codes like SB5400 / SB6438Z, but they were observed ONLY on the website, are not verified as tag-printed, and encode nothing (size and color live in separate URL segments). Use for exact catalog lookup, never as a parsed/decoded field."},{"tell":"Never auto-authenticate","detail":"No sourceable RN, no tag-decodable serial, no published hologram/date-code system. Counterfeits are not the main risk for this brand — SIZE MIS-STATEMENT is. Route authenticity to human review."}]$j$::jsonb,
   'Sweaty Betty identity = the legging family + UK sizing. UK brand (founded 1998, London), acquired by Wolverine World Wide 2021-08-02 for $410M. Power is the flagship legging FAMILY (a fabric/platform spanning many silhouettes, not one SKU); "bum-sculpting" is ZERO GRAVITY''s marketing, not Power''s. No tag decoder. RN omitted — not sourceable.',
   'https://www.sweatybetty.com/size-guide', 0.80, false, 'migration:00452')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- Under Armour: the GEAR trio is the disambiguation (each maps to a stated
-- temperature band and is printed on the garment).
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('underarmour', 'HeatGear', ARRAY['heatgear','heat gear','hg']::text[], 'Unisex', 'base layer', 'HeatGear',
   'HEATGEAR wordmark printed on the tag/garment. Thin, smooth, tight-knit synthetic — the ORIGINAL platform (the sweat-soaked-tee origin story). Built for 75F and ABOVE; the warm-weather sibling of ColdGear.',
   ARRAY['HeatGear']::text[], '1996-present', '$25-$45', ARRAY['heatgear','compression','wicking','base layer']::text[],
   'https://help.underarmour.ca/s/article/What-are-the-differences-between-COLDGEAR-HEATGEAR-and-ALLSEASONGEAR?language=en_US', 0.90, false, 'migration:00452'),
  ('underarmour', 'ColdGear', ARRAY['coldgear','cold gear','cg','coldgear infrared']::text[], 'Unisex', 'base layer', 'ColdGear',
   'COLDGEAR wordmark on the tag. DUAL-LAYER — smooth face with a brushed/fleecy interior; traps heat in while wicking moisture out. Built for 55F and BELOW. The brushed interior is the fastest tactile separator from HeatGear.',
   ARRAY['ColdGear','ColdGear Infrared']::text[], 'current', '$40-$80', ARRAY['coldgear','infrared','thermal','base layer']::text[],
   'https://help.underarmour.ca/s/article/What-are-the-differences-between-COLDGEAR-HEATGEAR-and-ALLSEASONGEAR?language=en_US', 0.90, false, 'migration:00452'),
  ('underarmour', 'AllSeasonGear', ARRAY['allseasongear','all season gear','asg']::text[], 'Unisex', 'top', 'AllSeasonGear',
   'ALLSEASONGEAR wordmark on the tag. Mid-weight — sits BETWEEN HeatGear and ColdGear in hand and weight; built for 55-75F. Wicks sweat but is not dual-layer.',
   ARRAY['AllSeasonGear']::text[], 'current', '$30-$60', ARRAY['allseasongear','all season','training']::text[],
   'https://help.underarmour.ca/s/article/What-are-the-differences-between-COLDGEAR-HEATGEAR-and-ALLSEASONGEAR?language=en_US', 0.85, false, 'migration:00452'),
  ('underarmour', 'UA Storm', ARRAY['storm','ua storm','armour fleece storm']::text[], 'Unisex', 'jacket', 'Storm',
   'STORM callout on the garment. FLEECE with a water-repellent finish — water beads on the face without sacrificing breathability. A fleece/hoodie technology, not a base layer.',
   ARRAY['Storm']::text[], 'current', '$55-$100', ARRAY['storm','water repellent','fleece','hoodie']::text[],
   'https://www.underarmour.com/en-us/c/technology/storm/', 0.80, false, 'migration:00452'),
  ('underarmour', 'UA Iso-Chill', ARRAY['iso-chill','iso chill','isochill']::text[], 'Unisex', 'top', 'Iso-Chill',
   'ISO-CHILL on the tag; the fabric feels COOL TO THE TOUCH. Ribbon-shaped nylon fibers disperse heat, plus a titanium-dioxide treatment that pulls heat off the skin.',
   ARRAY['Iso-Chill']::text[], '2020-present', '$30-$70', ARRAY['iso-chill','cooling','tee','polo']::text[],
   'https://about.underarmour.com/news/2020/01/ua-iso-chill', 0.85, false, 'migration:00452'),
  ('underarmour', 'Project Rock', ARRAY['project rock','the rock','dwayne johnson']::text[], 'Unisex', 'top', 'Project Rock',
   'Dwayne Johnson signature collab: Brahma bull mark and BLOOD SWEAT RESPECT graphics; released as capsule drops (incl. the annual Veterans Day UA Freedom capsule). Sits ON TOP of a gear platform (often HeatGear/Iso-Chill), so it is a collab line rather than a fabric.',
   ARRAY[]::text[], '2018-present', '$35-$120', ARRAY['project rock','brahma bull','iron paradise','collab']::text[],
   'https://about.underarmour.com/en/stories/2018/11/blood--sweat--respect.html', 0.75, false, 'migration:00452'),

  -- Vuori: knit (Ponto/Clean Elevation) vs woven (Kore/Banks) is the split.
  ('vuori', 'Kore Short', ARRAY['kore','kore short']::text[], 'Men', 'short', 'Kore',
   'The flagship men''s short and the #1 Vuori resale identifier. Lightweight 4-way-stretch WOVEN with a straight hem; lined OR unlined variants. Inseams 5"/7"/9" (NOT 7.5"). vs Banks: Banks is unlined-only and water-oriented. vs HardKore: HardKore is ripstop with side vents.',
   ARRAY['4-way stretch woven']::text[], '2015-present', null, ARRAY['kore','kore short','one short every sport']::text[],
   'https://vuoriclothing.com/pages/mens-athletic-shorts-guide', 0.85, false, 'migration:00452'),
  ('vuori', 'Ponto Performance Jogger', ARRAY['ponto','ponto jogger','ponto pant']::text[], 'Men', 'jogger', 'Ponto',
   'The signature soft line. Brushed, heathered soft KNIT jogger with zip pockets and an elastic cuff. The KNIT hand is what separates it from the WOVEN Kore/Meta — that is the fastest Vuori line call.',
   ARRAY['DreamKnit']::text[], 'current', '$110', ARRAY['ponto','dreamknit','performance jogger']::text[],
   'https://vuoriclothing.com/products/ponto-performance-jogger-black-heather', 0.88, false, 'migration:00452'),
  ('vuori', 'Banks Session Short', ARRAY['banks','banks short','banks session']::text[], 'Men', 'short', 'Banks',
   'UNLINED quick-dry stretch woven with a relaxed fit — the land-to-sea / gym-to-water short. Inseams 5"/7". The unlined build is the separator from the (often lined) Kore.',
   ARRAY['4-way stretch woven','quick-dry']::text[], 'current', null, ARRAY['banks','banks session','quick dry','boardshort']::text[],
   'https://vuoriclothing.com/pages/mens-athletic-shorts-guide', 0.80, false, 'migration:00452'),
  ('vuori', 'Clean Elevation Legging', ARRAY['clean elevation']::text[], 'Women', 'legging', 'DreamKnit Move',
   'The women''s flagship legging: ultra high-rise, 7/8 length, NO SIDE SEAMS, hidden waistband zip pocket, suede-soft hand. The seam-free build is the objective tell.',
   ARRAY['DreamKnit Move']::text[], 'current', '$98', ARRAY['clean elevation','dreamknit move','high rise legging']::text[],
   'https://vuoriclothing.com/products/womens-clean-elevation-legging-black-heather', 0.85, false, 'migration:00452'),
  ('vuori', 'Meta Pant', ARRAY['meta','meta pant','meta jogger']::text[], 'Men', 'pant', 'Meta',
   'FIVE-POCKET pant silhouette (chino/jean cut, NOT a jogger) in a stretchy moisture-wicking knit. The 5-pocket cut is what separates it from Ponto.',
   ARRAY[]::text[], 'current', null, ARRAY['meta','meta pant','5-pocket']::text[],
   'https://vuoriclothing.com/collections/mens-meta-collection', 0.70, false, 'migration:00452'),

  -- Gymshark: the seamless-knit families. Marl = Vital, print = Adapt.
  ('gymshark', 'Vital Seamless', ARRAY['vital','vital seamless','vital seamless 2.0']::text[], 'Women', 'legging', 'Vital',
   'The #1 Gymshark resale identifier. MARL (heathered two-tone) seamless knit with a signature contouring DOT texture; ribbed waistband with internal power mesh. MARL + DOTS = Vital, never Adapt (~326gsm, medium weight).',
   ARRAY['seamless knit']::text[], 'current', null, ARRAY['vital','seamless','marl','legging']::text[],
   'https://www.gymshark.com/blog/article/gymshark-leggings-comparison', 0.85, false, 'migration:00452'),
  ('gymshark', 'Adapt Seamless', ARRAY['adapt','adapt camo','adapt animal','adapt fleck']::text[], 'Women', 'legging', 'Adapt',
   'PRINTED seamless knit — Camo (the original), Animal (abstract animal print, external bum scrunch), Fleck (speckled jacquard, no scrunch). PRINT + heft = Adapt (~420gsm, high compression, squat-proof). There is NO "Adapt Marl" — marl belongs to Vital.',
   ARRAY['seamless knit']::text[], 'current', null, ARRAY['adapt','camo','animal','fleck','seamless']::text[],
   'https://www.gymshark.com/blog/article/gymshark-adapt-collections', 0.85, false, 'migration:00452'),
  ('gymshark', 'Whitney', ARRAY['whitney','whitney simmons','adapt x whitney']::text[], 'Women', 'legging', 'Whitney',
   'Whitney Simmons collab. Lightweight (~230gsm) nylon-rich BRUSHED exterior, smooth waistband, invisible bum scrunch. Adapt x Whitney = Animal/Fleck with a waistband 1.5in shorter plus exclusive tones.',
   ARRAY[]::text[], 'current', null, ARRAY['whitney','simmons','collab','brushed']::text[],
   'https://www.gymshark.com/blog/article/gymshark-adapt-collections', 0.80, false, 'migration:00452'),
  ('gymshark', 'Apex', ARRAY['apex','apex seamless','apex limit','apex lift']::text[], 'Unisex', 'legging', 'Apex',
   'The performance line across several sub-variants: 4-way stretch with heat-mapped ventilation panels. Distinguished by the engineered vent zones rather than a knit pattern.',
   ARRAY['BRZE','ESNCE']::text[], 'current', null, ARRAY['apex','brze','esnce','performance']::text[],
   'https://www.gymshark.com/collections/apex', 0.70, false, 'migration:00452'),
  ('gymshark', 'Legacy', ARRAY['legacy','legacy fitness']::text[], 'Men', 'top', 'Legacy',
   'Retro line: the ORIGINAL (retro) Gymshark logo with classic bodybuilding cuts. Woven/jersey, NOT seamless. IMPORTANT: a retro-logo Gymshark garment is Legacy — it is not evidence of a fake.',
   ARRAY[]::text[], 'current', null, ARRAY['legacy','retro logo','bodybuilding']::text[],
   'https://www.gymshark.com/collections/legacy', 0.70, false, 'migration:00452'),

  -- Fabletics: the official compression ladder IS the taxonomy.
  ('fabletics', 'PowerHold', ARRAY['powerhold','power hold','define powerhold']::text[], 'Women', 'legging', 'PowerHold',
   'The #1 Fabletics identifier and the MAX-compression fabric on the official ladder. Thickest, most opaque, squat-proof in ALL colors, with a brushed matte near-cotton hand (not slick/shiny). Often paired with a power-mesh-lined waistband on the Define silhouette. Thick+matte+opaque+compressive => PowerHold; buttery/slick/thin => PureLuxe or Seamless.',
   ARRAY['PowerHold']::text[], 'current', '$49-$99 regular / VIP 20-50% off (often ~$39.95; new-member ~$12-24)', ARRAY['powerhold','max compression','squat proof','define']::text[],
   'https://www.fabletics.com/guides/fabric', 0.85, false, 'migration:00452'),
  ('fabletics', 'Motion365', ARRAY['motion365','motion 365']::text[], 'Women', 'legging', 'Motion365',
   'HIGH compression on the official ladder — the hybrid: PowerHold-level compression WITH notably higher breathability and a smoother, more resilient (nylon-dominant) hand. Separate from PowerHold by breathability/lighter weight at similar compression.',
   ARRAY['Motion365']::text[], 'current', 'VIP from ~$39.95', ARRAY['motion365','high compression','breathable']::text[],
   'https://www.fabletics.com/guides/fabric', 0.75, false, 'migration:00452'),
  ('fabletics', 'SculptKnit', ARRAY['sculptknit','sculpt knit']::text[], 'Women', 'legging', 'SculptKnit',
   'MED compression — the ENGINEERED-KNIT one. Look for visible zonal/paneled knit structure and ventilation zones KNITTED IN (not cut-and-sewn seams); targeted zonal compression. The engineered contour panels are the tell.',
   ARRAY['SculptKnit']::text[], 'current', 'VIP from ~$39.95', ARRAY['sculptknit','targeted compression','engineered knit','contour']::text[],
   'https://www.fabletics.com/guides/fabric', 0.75, false, 'migration:00452'),
  ('fabletics', 'PureLuxe', ARRAY['pureluxe','pure luxe']::text[], 'Women', 'legging', 'PureLuxe',
   'MED-LIGHT compression — the BUTTERY one. Super-soft with the most stretch and the least hold; polyester-dominant (unlike nylon-based Motion365/SculptKnit) so it reads softer and more yielding. Marketed for studio/low-impact.',
   ARRAY['PureLuxe']::text[], 'current', 'VIP from ~$39.95', ARRAY['pureluxe','buttery soft','light compression','studio']::text[],
   'https://www.fabletics.com/guides/fabric', 0.75, false, 'migration:00452'),
  ('fabletics', 'Seamless', ARRAY['seamless','fabletics seamless']::text[], 'Women', 'legging', 'Seamless',
   'LIGHT compression — circular-knit with NO SIDE SEAMS. This is the most OBJECTIVE tell on the whole Fabletics ladder because it is a construction fact rather than a hand-feel judgment: no side seam => Seamless, regardless of hand. Lightest weight, second-skin feel, often with ribbed/banded knit zones.',
   ARRAY['Seamless']::text[], 'current', null, ARRAY['seamless','no side seam','second skin','light compression']::text[],
   'https://www.fabletics.com/guides/fabric', 0.80, false, 'migration:00452'),

  -- Beyond Yoga: fabric platform, and Spacedye's heather is the whole game.
  ('beyondyoga', 'Spacedye', ARRAY['spacedye','space dye','space-dye']::text[], 'Women', 'legging', 'Spacedye',
   'THE #1 Beyond Yoga identifier. Yarn dyed BEFORE knitting => a subtle heathered/marled variation with visible tonal depth across the whole garment, NEVER a flat solid — including the blacks/navies (Darkest Night, Nocturnal Navy read as deep heathered charcoal/navy). If it photographs dead-flat, it is not Spacedye. Silhouettes on this platform: At Your Leisure, Caught In The Midi, Out Of Pocket.',
   ARRAY['Spacedye']::text[], 'core platform, current', '$68-$118', ARRAY['spacedye','space dye','heathered','marled','buttery soft']::text[],
   'https://beyondyoga.com/pages/fabric-guide', 0.85, false, 'migration:00452'),
  ('beyondyoga', 'Heather Rib', ARRAY['heather rib','heatherrib']::text[], 'Women', 'legging', 'Heather Rib',
   'Separates from Spacedye by STRUCTURE, not color: a visible vertical RIB (raised wales running the garment length) vs Spacedye''s smooth flat knit. BOTH are heathered, so heather alone does NOT separate them — look for the rib. Its colorways carry the word "Heather" (Black Heather, Cream Heather), a strong text tell. 84% polyester / 16% Lycra.',
   ARRAY['Heather Rib']::text[], 'current', null, ARRAY['heather rib','ribbed','rib legging','street jogger']::text[],
   'https://beyondyoga.com/collections/heather-rib', 0.75, false, 'migration:00452'),
  ('beyondyoga', 'POWERBEYOND', ARRAY['powerbeyond','power beyond','powerbeyond strive']::text[], 'Women', 'legging', 'POWERBEYOND',
   'Disambiguates from Spacedye by being FLAT-SOLID, not heathered — a sport/compression aesthetic. Hardware tell: a contoured 4in waistband with a POWERMESH insert at the front panel (visibly sheer-ish mesh texture); pocket versions have slanted side pockets with powermesh bags. 75% polyester / 25% elastane — notably higher elastane than Spacedye. A "2.0" in the title is a recency signal.',
   ARRAY['POWERBEYOND']::text[], 'current', '~$99-$110', ARRAY['powerbeyond','strive','compression','powermesh','midi']::text[],
   'https://beyondyoga.com/products/powerbeyond-strive-pocket-midi-legging-2-0-black-it3565', 0.80, false, 'migration:00452'),
  ('beyondyoga', 'Featherweight Spacedye', ARRAY['featherweight spacedye','featherweight']::text[], 'Women', 'legging', 'Featherweight Spacedye',
   'Same heathered space-dyed look as core Spacedye but visibly LIGHTER and more translucent — a layering weight. HIGH MISATTRIBUTION RISK: resale listings routinely call this plain "Spacedye". The care-tag composition is the reliable separator: 94% poly / 6% spandex vs core Spacedye''s 87/13.',
   ARRAY['Featherweight Spacedye']::text[], 'current', null, ARRAY['featherweight','layering','lightweight','spacedye']::text[],
   'https://beyondyoga.com/pages/fabric-guide', 0.70, false, 'migration:00452'),

  -- Sweaty Betty: Power is a FAMILY, not a SKU; bum-sculpting is Zero Gravity.
  ('sweatybetty', 'Power', ARRAY['power','power legging','power workout legging','power 7/8']::text[], 'Women', 'legging', 'Power',
   'The flagship/signature legging FAMILY and the highest-volume Sweaty Betty item in resale. Sculpting sweat-wicking fabric with a supportive (non-constricting) waistband; sold full-length, 7/8, cropped and flared. IMPORTANT: Power is a FABRIC/PLATFORM spanning many sub-styles (Pocket, UltraSculpt, Pace) — do NOT treat it as one SKU. NOTE: "bum-sculpting" is Zero Gravity''s marketing, not Power''s.',
   ARRAY['Power fabric']::text[], 'long-running core, pre- and post-2021', '~$108 typical (SB leggings $44-$158)', ARRAY['power','workout legging','7/8','sculpting']::text[],
   'https://www.sweatybetty.com/content/leggings-guide', 0.85, false, 'migration:00452'),
  ('sweatybetty', 'Power UltraSculpt High-Waisted', ARRAY['ultrasculpt','power ultrasculpt']::text[], 'Women', 'legging', 'Power',
   'The highest-compression Power variant. Cleanest photo-level discriminator vs standard Power: a super-high-waisted BONDED waistband (smooth — no stitched elastic casing) PLUS two side slip pockets. 62% polyamide / 38% elastane. Reported as the modern replacement for the older High-Waisted Power.',
   ARRAY['Power fabric']::text[], 'current', '~$108-$128', ARRAY['ultrasculpt','high-waisted','bonded waistband','compressive']::text[],
   'https://www.sweatybetty.com/us/shop/bottoms/leggings/power-ultrasculpt-high-waisted-workout-leggings-SB6438Z_Black_FullLength.html', 0.85, false, 'migration:00452'),
  ('sweatybetty', 'Zero Gravity', ARRAY['zero gravity','zero gravity running legging']::text[], 'Women', 'legging', 'Zero Gravity',
   'The family the brand actually markets as BUM-SCULPTING (its category page is titled "Bum Sculpting Leggings") — NOT Power. Running-specific: waist drawcord, breathable mesh panels, rear phone pocket, placed sculpting seams, lighter than Power, UPF 40+. The drawcord + mesh + back pocket combination is the photo tell.',
   ARRAY['Italian compression fabric']::text[], 'current', '~$128-$158', ARRAY['zero gravity','bum sculpting','running','mesh panel','drawcord']::text[],
   'https://www.sweatybetty.com/us/shop/bottoms/leggings/zero-gravity-leggings', 0.70, false, 'migration:00452'),
  ('sweatybetty', 'All Day', ARRAY['all day','all day legging']::text[], 'Women', 'legging', 'All Day',
   'The LIGHTEST-support family — lightweight comfort positioned for rest days/casual, NOT training; the lowest compression of the confirmed families. Lowest resale value of the legging families: do NOT comp it against Power.',
   ARRAY[]::text[], 'current', '~$44-$88', ARRAY['all day','everyday legging','lightweight','rest day']::text[],
   'https://www.sweatybetty.com/content/leggings-guide', 0.72, false, 'migration:00452')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Under Armour ONLY ────────────────────────────────────
-- UA is the only brand in this group with a code that is BOTH tag-printed and
-- regular (documented by UA's own help center). The pattern is anchored so a
-- malformed code returns NO match rather than a false positive, and the optional
-- FW##/SS## season prefix decodes to season+year (feeding the US-1768
-- date_before_brand cross-check — UA was founded in 1996).
--
-- Deliberately NOT decoded: the 3-digit "-001" color suffix. It appears in
-- retailer SKUs, is NOT verified as tag-printed, and "001 = Black" is not a
-- verified brand-wide convention — decoding it would be invention.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('underarmour', 'style_number',
   'Tag-printed 7-digit style number on the small white label beneath the wash/care label (tops: left inside seam; bottoms: back of the inside waistband), optionally prefixed STYLE and/or a season code (FW24 / SS25).',
   '^(?:STYLE\s*)?(?:(?<season>FW|SS)(?<year>\d{2})\s*)?(?<style>\d{7})$',
   $j${"fieldMap":{"season":"season","year":"year","style":"styleCode"},"transforms":{"season":"upper","year":"year2to4"},"confidence":0.75}$j$::jsonb,
   $j$[{"code":"1361518","expected":{"styleCode":"1361518"}},{"code":"STYLE 1361518","expected":{"styleCode":"1361518"}},{"code":"FW24 1361518","expected":{"styleCode":"1361518","season":"FW","year":"2024"}},{"code":"1361518-001","expected":null,"note":"The retailer color suffix is intentionally NOT matched — it is not verified as tag-printed."}]$j$::jsonb,
   'https://help.underarmour.com/s/article/Where-do-I-find-the-style-number-of-a-product', 0.75, false, 'migration:00452')
on conflict (brand_key, decoder_kind) do nothing;

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Only where the brand genuinely uses proprietary NAMED colors. Deliberately
-- NOT seeded: Under Armour (plain descriptive names + an unverified 3-digit
-- code), Fabletics (no evidence of a named-colorway system; colors rotate per
-- drop), Vuori (a "<color> Heather" pattern, not a finite dictionary).
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('beyondyoga', 'Darkest Night', ARRAY['darkest night']::text[], null, null, 'https://beyondyoga.com/products/spacedye-caught-in-the-midi-high-waisted-legging-darkest-night-sd3243', 0.90, false, 'migration:00452'),
  ('beyondyoga', 'Nocturnal Navy', ARRAY['nocturnal navy']::text[], null, null, 'https://beyondyoga.com/products/spacedye-out-of-pocket-high-waisted-midi-legging-nocturnal-navy-sd3452', 0.85, false, 'migration:00452'),
  ('beyondyoga', 'Black Heather', ARRAY['black heather']::text[], null, null, 'https://beyondyoga.com/products/heather-rib-morning-jog-hoodie-black-heather-hr2229', 0.85, false, 'migration:00452'),
  ('beyondyoga', 'Cream Heather', ARRAY['cream heather']::text[], null, null, 'https://beyondyoga.com/products/heather-rib-prep-cropped-tank-cream-heather-hr4682', 0.80, false, 'migration:00452'),
  ('sweatybetty', 'Black', ARRAY['black']::text[], '#000000', null, 'https://www.sweatybetty.com/us/shop/bottoms/leggings/power-workout-leggings--SB5400_Black.html', 0.90, false, 'migration:00452'),
  ('sweatybetty', 'Urban Grey', ARRAY['urban grey','urban gray']::text[], null, null, 'https://www.sweatybetty.com/shop/bottoms/leggings/super-soft-yoga-leggings-SB6916_UrbanGrey_FullLength.html', 0.85, false, 'migration:00452'),
  ('sweatybetty', 'Beetle Blue', ARRAY['beetle blue']::text[], null, null, 'https://www.sweatybetty.com/us/shop/bottoms/leggings/power-workout-leggings-SB5400_BeetleBlueTieDyePrint.html', 0.80, false, 'migration:00452'),
  ('gymshark', 'Obsidian Green', ARRAY['obsidian green']::text[], null, null, 'https://www.gymshark.com/products/gymshark-apex-seamless-high-rise-leggings-obsidian-green-cucumber-green-ss22', 0.75, false, 'migration:00452')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts (INCHES, BODY measurements) ───────────────────────────
-- Every chart below is BODY measurement (the wearer), NOT flat-garment: a
-- compression legging measures far smaller flat than its listed hip. The note on
-- each row says so, because comparing these to a flat-lay tape is the #1 way to
-- misgrade a size in this category.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('underarmour', 'Under Armour', ARRAY['under armour','underarmour','ua']::text[], 'Men', 'Tops', ARRAY['top','tee','shirt','hoodie','polo','compression','jacket','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"31-34"}},{"size":"SM","measurements":{"chest":"34-37"}},{"size":"MD","measurements":{"chest":"37-41"}},{"size":"LG","measurements":{"chest":"41-44"}},{"size":"XL","measurements":{"chest":"44-48"}},{"size":"XXL","measurements":{"chest":"48-52"}},{"size":"3XL","measurements":{"chest":"52-56"}},{"size":"4XL","measurements":{"chest":"56-60"}}]$json$::jsonb,
   'BODY measurement (tape under the arms at the fullest part of the chest) — NOT flat-garment. From UA''s official guide. NOTE: widely-syndicated retailer charts show XS 30-32 / MD 38-40, which CONTRADICT UA''s official values used here — prefer these.',
   'https://www.underarmour.com/en-us/t/size-guide/mens-tops/', 0.85, false, 'migration:00452'),
  ('underarmour', 'Under Armour', ARRAY['under armour','underarmour','ua']::text[], 'Men', 'Bottoms', ARRAY['bottom','pant','short','jogger','legging','tight']::text[],
   $json$[{"size":"XS","measurements":{"waist":"28"}},{"size":"SM","measurements":{"waist":"30"}},{"size":"MD","measurements":{"waist":"32-33"}},{"size":"LG","measurements":{"waist":"34-36"}},{"size":"XL","measurements":{"waist":"38-40"}},{"size":"XXL","measurements":{"waist":"42-44"}},{"size":"3XL","measurements":{"waist":"46-48"}},{"size":"4XL","measurements":{"waist":"50-52"}}]$json$::jsonb,
   'BODY measurement (natural waistline, tape not squeezed) — NOT flat-garment. UA official guide.',
   'https://www.underarmour.com/en-us/t/size-guide/mens-bottoms/', 0.85, false, 'migration:00452'),
  ('underarmour', 'Under Armour', ARRAY['under armour','underarmour','ua']::text[], 'Women', 'Tops', ARRAY['top','tee','tank','bra','shirt','hoodie','jacket','long sleeve']::text[],
   $json$[{"size":"XXS","measurements":{"bust":"31-32.5","numeric":"00"}},{"size":"XS","measurements":{"bust":"32.5-33.5","numeric":"0-2"}},{"size":"SM","measurements":{"bust":"33.5-36","numeric":"4-6"}},{"size":"MD","measurements":{"bust":"36-38","numeric":"8-10"}},{"size":"LG","measurements":{"bust":"38-41","numeric":"12-14"}},{"size":"XL","measurements":{"bust":"41-44","numeric":"16"}},{"size":"XXL","measurements":{"bust":"44-47","numeric":"18"}},{"size":"3XL","measurements":{"bust":"47-50","numeric":"20"}}]$json$::jsonb,
   'BODY measurement (tape under the arms at the fullest part of the chest) — NOT flat-garment. UA official guide; the alpha sizes carry a numeric equivalent (XXS=00 … 3XL=20).',
   'https://www.underarmour.com/en-us/t/size-guide/womens-tops/', 0.85, false, 'migration:00452'),
  ('underarmour', 'Under Armour', ARRAY['under armour','underarmour','ua']::text[], 'Women', 'Bottoms', ARRAY['bottom','legging','pant','short','capri','tight']::text[],
   $json$[{"size":"XXS","measurements":{"waist":"24.5-25.5","hip":"33-34.5","numeric":"00"}},{"size":"XS","measurements":{"waist":"25.5-27","hip":"34.5-36","numeric":"0-2"}},{"size":"SM","measurements":{"waist":"27-29","hip":"36-38","numeric":"4-6"}},{"size":"MD","measurements":{"waist":"29-31","hip":"38-40","numeric":"8-10"}},{"size":"LG","measurements":{"waist":"31-34","hip":"40-43","numeric":"12-14"}},{"size":"XL","measurements":{"waist":"34-37","hip":"43-46","numeric":"16"}},{"size":"XXL","measurements":{"waist":"37-40","hip":"46-49","numeric":"18"}},{"size":"1X","measurements":{"waist":"39-43.5","hip":"47-50.5","numeric":"16W-18W"}},{"size":"2X","measurements":{"waist":"43.5-48.5","hip":"50.5-54.5","numeric":"20W-22W"}},{"size":"3X","measurements":{"waist":"48.5-53","hip":"54.5-58","numeric":"24W-26W"}}]$json$::jsonb,
   'BODY measurement (natural waistline; hips at the fullest) — NOT flat-garment. UA official guide. NOTE the separate W (plus) run — 1X/2X/3X OVERLAP XL/XXL rather than continuing past them, so 1X is not simply "bigger than XXL".',
   'https://www.underarmour.com/en-us/t/size-guide/womens-bottoms/', 0.85, false, 'migration:00452'),

  ('vuori', 'Vuori', ARRAY['vuori']::text[], 'Men', 'Tops', ARRAY['top','tee','shirt','hoodie','crew','jacket','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"33-35"}},{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"37-40"}},{"size":"L","measurements":{"chest":"40-43"}},{"size":"XL","measurements":{"chest":"43-47"}},{"size":"XXL","measurements":{"chest":"47-51"}}]$json$::jsonb,
   'BODY measurement in inches — NOT flat-garment (never compare to a flat-lay pit-to-pit). Range-style values are characteristic of a body chart; the retailer rendering labels the basis ambiguously, hence the capped confidence.',
   'https://peterglenn-content.s3.amazonaws.com/size_charts/VUORI.html', 0.60, false, 'migration:00452'),
  ('vuori', 'Vuori', ARRAY['vuori']::text[], 'Men', 'Bottoms', ARRAY['bottom','short','pant','jogger','kore','banks','meta','ponto']::text[],
   $json$[{"size":"XS","measurements":{"waist":"27-29","hip":"33-35"}},{"size":"S","measurements":{"waist":"29-32","hip":"35-37"}},{"size":"M","measurements":{"waist":"32-35","hip":"37-41"}},{"size":"L","measurements":{"waist":"35-38","hip":"41-44"}},{"size":"XL","measurements":{"waist":"38-43","hip":"44-47"}},{"size":"XXL","measurements":{"waist":"43-47","hip":"47-50"}}]$json$::jsonb,
   'BODY measurement in inches — NOT flat-garment. Vuori men''s bottoms are ALPHA-sized (XS-XXL), not numeric waist. INSEAM is a SEPARATE axis, not a size: Kore 5/7/9in; HardKore 5/7in; Banks Session 5/7in; Sunday Short 8in; Ponto Jogger 28in / Regular / Long. Capture inseam as its own attribute.',
   'https://peterglenn-content.s3.amazonaws.com/size_charts/VUORI.html', 0.60, false, 'migration:00452'),
  ('vuori', 'Vuori', ARRAY['vuori']::text[], 'Women', 'Bottoms', ARRAY['bottom','legging','short','jogger','pant','clean elevation']::text[],
   $json$[{"size":"XXS","measurements":{"waist":"23-24","hip":"33-34"}},{"size":"XS","measurements":{"waist":"24-26","hip":"34-36"}},{"size":"S","measurements":{"waist":"26-28","hip":"36-38"}},{"size":"M","measurements":{"waist":"28-30","hip":"38-40"}},{"size":"L","measurements":{"waist":"30-32","hip":"40-42"}},{"size":"XL","measurements":{"waist":"32-34","hip":"42-44"}},{"size":"XXL","measurements":{"waist":"35-37","hip":"44-47"}}]$json$::jsonb,
   'BODY measurement in inches — NOT flat-garment. Clean Elevation also has a Long (tall) inseam variant. The XXL hip renders as both 44-46 and 45-47 across sources — that single row is low confidence.',
   'https://peterglenn-content.s3.amazonaws.com/size_charts/VUORI.html', 0.55, false, 'migration:00452'),

  ('gymshark', 'Gymshark', ARRAY['gymshark','gym shark']::text[], 'Women', 'Bottoms', ARRAY['bottom','legging','short','jogger','tight']::text[],
   $json$[{"size":"XXS","measurements":{"waist":"24","hip":"35.5"}},{"size":"XS","measurements":{"waist":"26","hip":"37.5"}},{"size":"S","measurements":{"waist":"28","hip":"39.5"}},{"size":"M","measurements":{"waist":"30","hip":"41.5"}},{"size":"L","measurements":{"waist":"32","hip":"43.5"}},{"size":"XL","measurements":{"waist":"34","hip":"45.5"}},{"size":"XXL","measurements":{"waist":"36","hip":"47.7"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment (do not compare to a flat-lay of a compression legging). Gymshark publishes cm with inches alongside; inches are the brand''s own figures. Gymshark labels INTERNATIONAL alpha sizes, NOT UK numerics — there is no UK-to-US numeric trap here despite the UK origin. Inside leg 28.5-32.5in varies by Short/Regular/Tall.',
   'https://support.gymshark.com/en/articles/11204065-women-s-size-guide', 0.85, false, 'migration:00452'),
  ('gymshark', 'Gymshark', ARRAY['gymshark','gym shark']::text[], 'Women', 'Tops', ARRAY['top','tee','tank','bra','crop','hoodie','jacket','long sleeve']::text[],
   $json$[{"size":"XXS","measurements":{"bust":"31.5"}},{"size":"XS","measurements":{"bust":"33.5"}},{"size":"S","measurements":{"bust":"35.5"}},{"size":"M","measurements":{"bust":"37.5"}},{"size":"L","measurements":{"bust":"39.5"}},{"size":"XL","measurements":{"bust":"41.5"}},{"size":"XXL","measurements":{"bust":"43.5"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Gymshark labels this dimension "chest" in its own guide. International alpha sizing (XXS-XXL), not UK numerics.',
   'https://support.gymshark.com/en/articles/11204065-women-s-size-guide', 0.85, false, 'migration:00452'),
  ('gymshark', 'Gymshark', ARRAY['gymshark','gym shark']::text[], 'Men', 'Tops', ARRAY['top','tee','t-shirt','hoodie','tank','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"37"}},{"size":"S","measurements":{"chest":"39"}},{"size":"M","measurements":{"chest":"41"}},{"size":"L","measurements":{"chest":"43"}},{"size":"XL","measurements":{"chest":"45"}},{"size":"XXL","measurements":{"chest":"47"}},{"size":"3XL","measurements":{"chest":"49"}}]$json$::jsonb,
   'BODY measurement (chest measured ~1in below the underarm) — NOT flat-garment. No UK/US mapping is published for Gymshark menswear.',
   'https://support.gymshark.com/en/articles/11204266-men-s-size-guide', 0.85, false, 'migration:00452'),
  ('gymshark', 'Gymshark', ARRAY['gymshark','gym shark']::text[], 'Men', 'Bottoms', ARRAY['bottom','short','jogger','pant','tight']::text[],
   $json$[{"size":"XS","measurements":{"waist":"29.5"}},{"size":"S","measurements":{"waist":"31.5"}},{"size":"M","measurements":{"waist":"33.5"}},{"size":"L","measurements":{"waist":"35.5"}},{"size":"XL","measurements":{"waist":"37.5"}},{"size":"XXL","measurements":{"waist":"39.5"}},{"size":"3XL","measurements":{"waist":"41.5"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Inside leg 32in standard. EXCEPTION: Elite Pants use an inch waist (28-40) with Regular (31in) / Tall (34in) inseams rather than alpha sizes.',
   'https://support.gymshark.com/en/articles/11204266-men-s-size-guide', 0.85, false, 'migration:00452'),

  ('fabletics', 'Fabletics', ARRAY['fabletics']::text[], 'Women', 'Bottoms', ARRAY['bottom','legging','pant','short','jogger','capri','tight']::text[],
   $json$[{"size":"XXS","measurements":{"waist":"24-25","hip":"33-35","numeric":"00"}},{"size":"XS","measurements":{"waist":"25.5-26.5","hip":"36-37","numeric":"0-2"}},{"size":"S","measurements":{"waist":"27-28","hip":"37.5-38.5","numeric":"4-6"}},{"size":"M","measurements":{"waist":"29-31","hip":"39-41","numeric":"8-10"}},{"size":"L","measurements":{"waist":"32-34","hip":"42-44","numeric":"12-14"}},{"size":"XL","measurements":{"waist":"35-37","hip":"45-47","numeric":"16-18"}},{"size":"XXL/1X","measurements":{"waist":"38-41","hip":"48-51"}},{"size":"2X","measurements":{"waist":"41-43","hip":"51-53","numeric":"20-22"}},{"size":"3X","measurements":{"waist":"43-45","hip":"53-55","numeric":"24-26"}},{"size":"4X","measurements":{"waist":"45-47","hip":"55-57","numeric":"28-30"}}]$json$::jsonb,
   'BODY measurement (the guide instructs the WEARER to measure) — NOT flat-garment. Range XXS-4X. Fabletics publishes ONE unified body chart for tops and bottoms. Bottoms also carry a length variant (7/8, 27in inseam) surfaced in the product title, not this chart. The XXL/1X numeric equivalent is omitted deliberately: the source renders XL and XXL/1X both as US 16-18, which is an artifact — the measurements are monotonic and trustworthy, the numeric map at that row is not.',
   'https://www.fabletics.com/womens/size-guide', 0.60, false, 'migration:00452'),
  ('fabletics', 'Fabletics', ARRAY['fabletics']::text[], 'Women', 'Tops', ARRAY['top','tee','tank','shirt','bra','hoodie','jacket','dress','long sleeve']::text[],
   $json$[{"size":"XXS","measurements":{"bust":"30-31.5","waist":"24-25","numeric":"00"}},{"size":"XS","measurements":{"bust":"32-33.5","waist":"25.5-26.5","numeric":"0-2"}},{"size":"S","measurements":{"bust":"34.5-35.5","waist":"27-28","numeric":"4-6"}},{"size":"M","measurements":{"bust":"36-38","waist":"29-31","numeric":"8-10"}},{"size":"L","measurements":{"bust":"39-41","waist":"32-34","numeric":"12-14"}},{"size":"XL","measurements":{"bust":"42-44","waist":"35-37","numeric":"16-18"}},{"size":"XXL/1X","measurements":{"bust":"45-48","waist":"38-41"}},{"size":"2X","measurements":{"bust":"48-50","waist":"41-43","numeric":"20-22"}},{"size":"3X","measurements":{"bust":"50-52","waist":"43-45","numeric":"24-26"}},{"size":"4X","measurements":{"bust":"52-54","waist":"45-47","numeric":"28-30"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Range XXS-4X. Sports bras size alpha (XXS-4X), NOT band+cup. Same XXL/1X numeric-map caveat as the bottoms chart.',
   'https://www.fabletics.com/womens/size-guide', 0.60, false, 'migration:00452'),
  ('fabletics', 'Fabletics', ARRAY['fabletics']::text[], 'Men', 'Tops', ARRAY['top','tee','t-shirt','hoodie','jacket','short','pant','jogger','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36","waist":"26-29","hip":"36-37"}},{"size":"S","measurements":{"chest":"37-38","waist":"29-31","hip":"37.5-38.5"}},{"size":"M","measurements":{"chest":"39-40","waist":"31-33","hip":"39-41"}},{"size":"L","measurements":{"chest":"41-42","waist":"33-35","hip":"42-44"}},{"size":"XL","measurements":{"chest":"44-45","waist":"36-39","hip":"45-47"}},{"size":"XXL","measurements":{"chest":"47-48","waist":"40-43","hip":"47-49"}},{"size":"2X","measurements":{"chest":"49-52","waist":"44-48","hip":"51-53"}},{"size":"3X","measurements":{"chest":"53-56","waist":"49-52","hip":"53-55"}},{"size":"4X","measurements":{"chest":"57-60","waist":"53-56","hip":"55-57"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Fabletics Men launched April 2020; one chart covers men''s tops and bottoms. Men''s bottoms carry an inseam variant that is a SEPARATE axis: Short (up to 5''7"), Regular (5''8"-5''10"), Tall (5''11"+). NOTE: XXL and 2X are listed as DISTINCT sizes with different chests (47-48 vs 49-52) — unusual and possibly a rendering artifact; verify before relying on that distinction.',
   'https://www.fabletics.com/mens/size-guide', 0.60, false, 'migration:00452'),

  ('beyondyoga', 'Beyond Yoga', ARRAY['beyond yoga','beyondyoga']::text[], 'Women', 'Tops', ARRAY['top','tank','tee','shirt','bra','hoodie','sweatshirt','dress','bodysuit','long sleeve']::text[],
   $json$[{"size":"XXS","measurements":{"bust":"31.5","waist":"25","numeric":"0"}},{"size":"XS","measurements":{"bust":"32-34","waist":"26-27.5","numeric":"0-2"}},{"size":"S","measurements":{"bust":"34.5-36","waist":"28-29.5","numeric":"4-6"}},{"size":"M","measurements":{"bust":"36.5-38","waist":"30-31.5","numeric":"8-10"}},{"size":"L","measurements":{"bust":"38.5-40","waist":"32-33.5","numeric":"12-14"}},{"size":"XL","measurements":{"bust":"40.5-42","waist":"34-35.5","numeric":"16-18"}},{"size":"XXL","measurements":{"bust":"42.5-45","waist":"36-39.5","numeric":"20-22"}},{"size":"1X","measurements":{"bust":"45-47","waist":"41-43","numeric":"18-20"}},{"size":"2X","measurements":{"bust":"48-51","waist":"44-47","numeric":"22-24"}},{"size":"3X","measurements":{"bust":"52-55","waist":"48-51","numeric":"26-28"}},{"size":"4X","measurements":{"bust":"56-60","waist":"52-56","numeric":"30-32"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. From the official guide (highest-trust BY chart), full XXS-4X. Official rule: when bust and waist suggest two sizes, go with the BUST. WARNING — do NOT cross-use this waist column with the Bottoms chart: the two charts give different waists for the same alpha size (tops XS waist 26-27.5 vs bottoms XS 25-26.5) and different alpha-to-numeric maps (tops XS=0-2 vs bottoms XS=2-4). The map is also NON-MONOTONIC across the standard/extended boundary (XXL=20-22 but 1X=18-20).',
   'https://beyondyoga.com/pages/size-guide', 0.85, false, 'migration:00452'),
  ('beyondyoga', 'Beyond Yoga', ARRAY['beyond yoga','beyondyoga']::text[], 'Women', 'Bottoms', ARRAY['bottom','legging','jogger','pant','short','capri','skirt','tight']::text[],
   $json$[{"size":"XXS","measurements":{"waist":"23-24.5","hip":"32-34","numeric":"0-2"}},{"size":"XS","measurements":{"waist":"25-26.5","hip":"34-37","numeric":"2-4"}},{"size":"S","measurements":{"waist":"27-29","hip":"38-40","numeric":"4-6"}},{"size":"M","measurements":{"waist":"30-32","hip":"41-43","numeric":"6-8"}},{"size":"L","measurements":{"waist":"33-35","hip":"44-46","numeric":"10-12"}},{"size":"XL","measurements":{"waist":"36-38","hip":"47-49","numeric":"14-16"}},{"size":"XXL","measurements":{"waist":"39-41","hip":"50-52","numeric":"18-20"}},{"size":"1X","measurements":{"waist":"39-41","hip":"50-52","numeric":"18-20"}},{"size":"2X","measurements":{"waist":"42-45","hip":"53-56","numeric":"22-24"}},{"size":"3X","measurements":{"waist":"46-49","hip":"57-60","numeric":"26-28"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. NOTE: XXL and 1X are IDENTICAL here (both 39-41 waist / 50-52 hip, both US 18-20) — they are parallel entry points into the standard vs extended blocks, so 1X is NOT strictly larger than XXL. BY sells bottoms through 4X but the 4X bottoms measurements are not sourceable and are deliberately NOT extrapolated. Reproduced by an authorized retailer rather than fetched from the official guide, hence the capped confidence.',
   'https://www.scheels.com/size-chart/beyond-yoga-womens-bottoms-size-chart/', 0.70, false, 'migration:00452'),

  ('sweatybetty', 'Sweaty Betty', ARRAY['sweaty betty','sweatybetty']::text[], 'Women', 'Bottoms', ARRAY['bottom','legging','pant','short','jogger','trouser','tight']::text[],
   $json$[{"size":"UK 6 / XXS","measurements":{"waist":"23","hip":"34","us":"2"}},{"size":"UK 8 / XS","measurements":{"waist":"25","hip":"36","us":"4"}},{"size":"UK 10 / S","measurements":{"waist":"27","hip":"38","us":"6"}},{"size":"UK 12 / M","measurements":{"waist":"29","hip":"40","us":"8"}},{"size":"UK 14 / L","measurements":{"waist":"31","hip":"42","us":"10"}},{"size":"UK 16-18 / XL","measurements":{"waist":"33","hip":"44","us":"12"}},{"size":"UK 18-20 / XXL","measurements":{"waist":"36","hip":"46.5","us":"14"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment (a compression legging measures far smaller flat than its listed hip). Inches are the brand''s own published figures (the guide prints both cm and inches). CRITICAL UK SIZING: the UK-to-US offset is MINUS 4 through UK 14 (UK 12 = US 8), but it BREAKS above that — UK 16-18 collapses to US 12 and UK 18-20 to US 14. Never subtract 4 blindly at XL/XXL. Mis-listing a UK 12 as a US 12 is a two-size overstatement and the costliest error on this brand.',
   'https://www.sweatybetty.com/size-guide', 0.90, false, 'migration:00452'),
  ('sweatybetty', 'Sweaty Betty', ARRAY['sweaty betty','sweatybetty']::text[], 'Women', 'Tops', ARRAY['top','tee','t-shirt','tank','vest','sweatshirt','hoodie','jacket','long sleeve']::text[],
   $json$[{"size":"UK 6 / XXS","measurements":{"bust":"30","waist":"23","hip":"34","us":"2"}},{"size":"UK 8 / XS","measurements":{"bust":"32","waist":"25","hip":"36","us":"4"}},{"size":"UK 10 / S","measurements":{"bust":"34","waist":"27","hip":"38","us":"6"}},{"size":"UK 12 / M","measurements":{"bust":"36","waist":"29","hip":"40","us":"8"}},{"size":"UK 14 / L","measurements":{"bust":"38","waist":"31","hip":"42","us":"10"}},{"size":"UK 16-18 / XL","measurements":{"bust":"40","waist":"33","hip":"44","us":"12"}},{"size":"UK 18-20 / XXL","measurements":{"bust":"43","waist":"36","hip":"46.5","us":"14"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Brand-published inches. Same UK-to-US caveat as the bottoms chart (offset -4 through UK 14, then it compresses). Letter sizes map to UK RANGES at the top (XL = UK 16-18, XXL = UK 18-20) so a letter-only tag cannot resolve to one UK number there. EXCLUDES sports bras, which use standard UK bra sizing (e.g. 32B) on wired styles and XS-XL on non-wired.',
   'https://www.sweatybetty.com/size-guide', 0.90, false, 'migration:00452')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00452') on conflict do nothing;
