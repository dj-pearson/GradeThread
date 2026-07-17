-- US-1991: Intimates, loungewear & shapewear brand knowledge (8 brands).
--
-- SKIMS, Spanx, Victoria's Secret, PINK, Aerie, Savage X Fenty, Calvin Klein,
-- Tommy John. This is a HIGH-VOLUME resale category and its identity problem is
-- NOT the one the footwear/heritage packs had — see the through-line below.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT BINDS THIS GROUP: THE FIT + THE SIZE SYSTEM IS THE PRODUCT, AND THE SIZE
-- SYSTEM IS NOT ONE SYSTEM.
--
--   The story note puts it exactly: "Bra/shapewear sizing systems matter." Unlike
--   the footwear pack (00470), where the size is a single stamped number to READ,
--   an intimates listing spans THREE incompatible size systems that a seller and
--   the model routinely conflate:
--     1. BRA sizing — BAND (30-44) + CUP (A-DDD/G), a two-axis system where the
--        cup letter is RELATIVE to the band (a 34B and a 36A share a cup volume).
--        This is the category's hardest signal and the reason VS / Savage X /
--        Calvin Klein each carry a dedicated band+cup translator chart.
--     2. SHAPEWEAR / bodysuit sizing — alpha XS-4X (Skims, Spanx, Savage X are
--        size-inclusive), graded on COMPRESSION not just fit.
--     3. APPAREL / loungewear / underwear — ordinary alpha XS-XXL or a waist run.
--   The charts here are TRANSLATORS with the system named IN THE LABEL and the
--   cup-difference math written into the note (the 00459/00470 lesson: the
--   cross-map lives where the model reads it).
--
--   The STYLE side is a NAMED FABRIC LINE for all eight — Fits Everybody, Soft
--   Lounge, Faux Leather Leggings, Bombshell, Body by Victoria, Xtra VIP, Modern
--   Cotton, Second Skin, Cool Cotton — never a regular tag-printed brand-unique
--   code. So the fingerprint leads with the LINE + the fit/fabric tell.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ZERO DECODERS, DELIBERATELY — and every candidate is fixtured as a REFUSAL
-- negative in brand-knowledge-golden_test.ts (a refusal that is not tested is a
-- comment). This is the 00466/00470 call: not one of these eight prints a code
-- that clears the bar (tag-printed AND regular AND brand-unique in FORMAT).
--
--   * CALVIN KLEIN underwear style numbers (NB1476, U2664G) — the U-prefix on the
--     women's line looks regular, but the number is a WEB/CATALOGUE SKU printed on
--     the retail packaging and hangtag, not established as a regular sewn-tag code,
--     and CK spans licensed product (fragrance, watches, home) where the same
--     format hazard as Fossil (00468) lives. Refused; the LINE is the identifier.
--   * SPANX style numbers (2437, 10005R) — a bare 4-5 digit run (the Chanel rule,
--     US-1736), a web SKU, not a sewn-tag code. Refused.
--   * A BRA SIZE IS NOT A STYLE CODE. "34DDD" is the single most tempting token on
--     an intimates tag and it decodes to NOTHING about the model — it is captured
--     by the size charts, never by a style decoder.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TWO SUB-BRAND CALLS (both carried in brand-normalize.ts, not here):
--
--   1. AERIE IS PROMOTED TO ITS OWN CANONICAL, reversing the US-1739 fold onto
--      American Eagle — a DELIBERATE, DOCUMENTED supersession, not an oversight.
--      The US-1739 call was made in the MALL/BASICS context ("same band → fold,
--      the Gap/GapBody play"). It is WRONG for intimates: eBay has a first-class
--      "Aerie" catalogue brand, and Aerie bralettes / OFFLINE leggings / undies
--      comp on their OWN ladder, nothing like American Eagle denim. Folding it
--      would price an Aerie bralette off a jeans comp. "Aerie" is an ordinary
--      noun (an eagle's nest) so it is ALSO added to DETECT_EXCLUDED_FROM_TEXT —
--      reachable by TAG, never minted from prose (the KEEN/aerie precedent).
--   2. PINK IS ITS OWN CANONICAL, NOT folded onto Victoria's Secret. VS PINK is a
--      separately-branded, LOWER-band, younger collegiate line searched as "PINK"
--      on its own — the Hollister rule (00458: the parent company never decides a
--      fold; the price band and the eBay catalogue do). "PINK" is an ordinary
--      COLOUR word, so it too is added to DETECT_EXCLUDED_FROM_TEXT (the same
--      defence as MOTHER/FRAME/Express) — reachable by tag, never guessed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CALVIN KLEIN IS PROMOTED from its shallow 00389 alias-only shell to a FULL pack
-- (the story note's instruction). The on-conflict update overwrites the shell's
-- aliases/category_focus/notes with the intimates-grounded pack; its verified flag
-- is left as 00389 set it (the on-conflict set does not touch `verified`).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REGISTERED NUMBERS: NONE ARE SEEDED. These ARE textile products (unlike 00470's
-- leather footwear), so an RN would be in-scope — but no registrant could be tied
-- to a PRIMARY FTC record with confidence, and fabricating one is the KB's
-- costliest error (the RN 17257 lesson, 00468). Left empty, owed to US-1715.
--
-- TAG ERAS: DOCUMENTED for the two brands with a genuine, value-driving vintage
-- label chronology — VICTORIA'S SECRET (the "Gold Label"/gold-script Made-in-USA
-- 80s-90s lingerie a collector market chases) and CALVIN KLEIN (the 90s CK
-- one-logo / Calvin Klein Jeans era) — EMPTY for the six modern brands (Skims
-- 2019, Savage X 2018, Aerie 2006, PINK 2004, Spanx 2000, Tommy John 2008) with
-- no collectible vintage tag corpus (the athleisure precedent, 00452).
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00470
-- convention). Confidence is DELIBERATELY UNEVEN: a brand-published spec is ~0.8;
-- a collector-corroborated tell is ~0.6 and says so.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('skims', 'SKIMS',
   ARRAY['skims','skimsbody','skimssolutionwear','skimscozy']::text[],
   ARRAY['shapewear','bodysuits','loungewear','bras','underwear','dresses']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"SKIMS is produced broadly offshore; country is not a date or authenticity tell for this brand."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"SKIMS is one of the most COUNTERFEITED intimates brands (dupes are rampant), but the guidance is channel-based, not a set of reliable per-unit photo tells — there is no serial. Grade condition. Identify by the FABRIC LINE (Fits Everybody rib, Soft Lounge modal, Cotton Rib, Sculpting) and the extensive nude/skin-tone colourway (see brand_colorways)."},{"tell":"The FABRIC HAND and shape retention are the grade on shapewear/lounge","detail":"On a Fits Everybody or Sculpting piece the elastane can pill, thin or lose recovery (bagging at the seat/knee), and Soft Lounge modal pills — those are the real defects and they need a close FABRIC photo. Ordinary wash-softening is not damage; a stretched-out, non-recovering waistband/leg opening is."}]$j$::jsonb,
   'Founded 2019 by Kim Kardashian with Jens and Emma Grede; a "solutionwear" (shapewear + loungewear + underwear + bras) brand built on a SIZE-INCLUSIVE range (XXS-4X) and a large NUDE/SKIN-TONE colour palette (Sand, Sienna, Clay, Cocoa, Umber, Onyx...) that is searched BY NAME (see brand_colorways). Core lines: FITS EVERYBODY (seamless rib), SOFT LOUNGE (modal loungewear/slip dresses), COTTON RIB, and the SCULPTING shapewear (bodysuits/shorts). NO RN IS SEEDED (none sourced to a primary record). NO DECODER: the model is a NAMED FABRIC LINE, and SKIMS article numbers are web/catalogue SKUs. TAG ERAS EMPTY ON PURPOSE — a 2019 brand with no vintage tag corpus (the athleisure precedent, 00452).',
   'https://skims.com/', 0.80, false, 'migration:00471'),

  ('spanx', 'Spanx',
   ARRAY['spanx','spanxinc','spanxshapewear']::text[],
   ARRAY['shapewear','leggings','bodysuits','hosiery','loungewear','underwear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"Spanx is produced broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; identify the LINE and the COMPRESSION level","detail":"Spanx has no per-unit serial and no consumer authentication portal. Grade condition. The value read is the LINE and its compression: the iconic FAUX LEATHER LEGGINGS and AirEssentials loungewear (fashion, high resale) comp very differently from the firm shapewear (OnCore, Higher Power, Thinstincts). Identify by the printed line name, not the number."},{"tell":"Shape retention + the coated finish are the grade","detail":"On firm shapewear a packed-out, non-recovering compression panel is a real defect; on the Faux Leather Leggings the COATED FINISH can crack/peel at the knee and waistband — require a close photo of the coating and the waistband. Ordinary softening is not damage."}]$j$::jsonb,
   'Founded 2000 by Sara Blakely; the modern SHAPEWEAR pioneer, now also a major LEGGINGS/loungewear seller. Resale-relevant icons: the FAUX LEATHER LEGGINGS (the single biggest resale driver), AIRESSENTIALS (buttery loungewear sets), and the firm-shaping OnCore / Higher Power / Thinstincts / Bra-llelujah lines. Sizes run alpha XS-3X (shapewear often with a compression tier). NO RN IS SEEDED (none sourced). NO DECODER: the model is a NAMED LINE, and the Spanx style number (e.g. 2437, 10005R) is a bare digit run / web SKU, refused (the Chanel rule, US-1736). TAG ERAS EMPTY ON PURPOSE — a 2000 brand whose value is current-line, not a dated vintage corpus.',
   'https://spanx.com/', 0.80, false, 'migration:00471'),

  ('victoriassecret', 'Victoria''s Secret',
   ARRAY['victoriassecret','victoriasecret','victoriassecrets','vsecret','vslingerie']::text[],
   ARRAY['bras','panties','lingerie','sleepwear','loungewear','swim']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Vintage \"Victoria's Secret Gold Label\" / gold-script Made-in-USA lingerie","years":"1980s-1990s (approximate)","description":"COLLECTOR-CORROBORATED, NOT A DATED CHART. The early Victoria's Secret (founded 1977; the modern mall era began under The Limited from 1982) produced a GOLD-LABEL / gold-script line, some Made in USA, that a vintage-lingerie collector market chases — the satin slips, robes and bras of that era comp ABOVE ordinary modern VS. Older gold-script logo tags skew older/collectible; no precise dated label chronology is sourced, so treat the label era as a COARSE prior, not a year."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA (some vintage Gold Label), broadly offshore (modern)","note":"COARSE VINTAGE PRIOR ONLY: a Made-in-USA gold-script VS piece skews older/collectible, but the vast majority of modern VS is made offshore and country does not authenticate or precisely date a piece."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Victoria's Secret is heavily COUNTERFEITED (bras/panties dupes), but the guidance is channel-based, not a set of reliable per-unit photo tells — there is no serial. Grade condition. Identify by the BRA LINE (Bombshell, Body by Victoria, Very Sexy, T-Shirt Bra) and read the band+cup off the tag (see the size chart)."},{"tell":"On a bra the ELASTIC and the underwire are the grade","detail":"A bra lives or dies on its elastic recovery (a stretched-out, non-snapping band is a real defect), the underwire (poking through, bent), the hook-and-eye, and the foam-cup shape (creased/collapsed padding). None of it reads off a flat front shot — require a photo of the band/hooks stretched and the cup interior. Pilling and greying of white are wear."}]$j$::jsonb,
   'Founded 1977; the dominant mall LINGERIE brand (bras, panties, sleepwear, loungewear, PINK is a SEPARATE sub-brand with its own pack). Resale-relevant bra LINES: BOMBSHELL (the add-2-cup-sizes push-up), BODY BY VICTORIA (smooth t-shirt bra), VERY SEXY, and the plain T-Shirt Bra. Bras size on the BAND (30-44) + CUP (A-DDD) two-axis system — the Bombshell adds two cup sizes of padding, so its labelled size runs small on volume (see the chart note). ⚠ A VINTAGE GOLD-LABEL / gold-script Made-in-USA piece is a genuine collectible prior (see tag_eras). NO RN IS SEEDED (none sourced to a primary record). NO DECODER: the model is a NAMED LINE and a BRA SIZE IS NOT A STYLE CODE (it is captured by the size chart).',
   'https://www.victoriassecret.com/', 0.80, false, 'migration:00471'),

  ('pink', 'PINK',
   ARRAY['victoriassecretpink','vspink','pinknation','pinkbyvictoriassecret']::text[],
   ARRAY['bralettes','panties','loungewear','leggings','hoodies','sleepwear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"PINK is produced broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; identify by the PINK logo + the DOG mascot","detail":"PINK (Victoria's Secret PINK) has no per-unit serial and no consumer authentication portal. Grade condition. Identify by the PINK wordmark + the corgi/dog mascot and the COLLEGIATE/campus logo graphics; the value is trend/logo-driven (the graphic loungewear and the Wear Everywhere bras)."},{"tell":"⚠ PINK IS NOT VICTORIA'S SECRET — comp it separately","detail":"PINK is a LOWER-band, younger collegiate line, NOT the VS lingerie label; a PINK legging/hoodie comps well BELOW a VS piece and is searched as its own brand. Read the exact label — a bralette that says PINK is not a Body by Victoria bra. On graphic loungewear the PRINT/logo condition (cracking, fading) is part of the grade."}]$j$::jsonb,
   'Victoria''s Secret PINK — a SEPARATE sub-brand (founded 2004): younger, lower-price collegiate loungewear, bralettes, panties, leggings and campus/logo hoodies, plus the WEAR EVERYWHERE bras/bralettes. ⚠ IT IS ITS OWN CANONICAL, deliberately NOT folded onto Victoria''s Secret — a lower band, separately searched (the Hollister rule, 00458: the parent never decides a fold). ⚠ "PINK" IS AN ORDINARY COLOUR WORD and is added to DETECT_EXCLUDED_FROM_TEXT (brand-normalize.ts) so it is reachable BY TAG but never GUESSED from prose. Apparel sizes alpha XS-XL; bralettes S-XL; Wear Everywhere bras band+cup. NO RN IS SEEDED. NO DECODER: the model is a NAMED LINE. TAG ERAS EMPTY ON PURPOSE — a 2004 brand whose value is current-logo, not a vintage corpus.',
   'https://www.victoriassecret.com/us/pink', 0.75, false, 'migration:00471'),

  ('aerie', 'Aerie',
   ARRAY['aerie','aeriebyamericaneagle','aerieoffline','offlinebyaerie','aeriereal']::text[],
   ARRAY['bralettes','underwear','leggings','loungewear','swim','activewear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"Aerie is produced broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; identify by the line (Real / OFFLINE / Chill)","detail":"Aerie has no per-unit serial and no consumer authentication portal. Grade condition. Identify by the sub-line: OFFLINE (activewear/leggings), Real Me / Real Sunnie (bras/bralettes), and the Chill loungewear. The value is trend/loungewear-driven."},{"tell":"On leggings + bralettes the ELASTANE recovery is the grade","detail":"An OFFLINE legging or a Real bralette is graded on waistband/leg-opening recovery and pilling — a stretched-out, non-recovering band or a pilled crotch gusset is a real defect and needs a close fabric photo. Ordinary wash-softening is not damage."}]$j$::jsonb,
   'American Eagle''s intimates / loungewear / activewear sub-brand (founded 2006): bralettes, underwear, the OFFLINE activewear/leggings line, loungewear and swim, marketed on a body-positive ("Real") platform. ⚠ IT IS ITS OWN CANONICAL — this pack PROMOTES Aerie out of the US-1739 fold onto American Eagle, because in the intimates category Aerie is a first-class eBay brand searched on its own and comps on its OWN ladder (an Aerie bralette is not an AE jean). ⚠ "AERIE" IS AN ORDINARY NOUN (an eagle''s nest) and is added to DETECT_EXCLUDED_FROM_TEXT so it is reachable BY TAG but never GUESSED from prose. Apparel/legging sizes alpha XXS-XXL; bras/bralettes S-XL + band+cup. NO RN IS SEEDED. NO DECODER: the model is a NAMED LINE. TAG ERAS EMPTY ON PURPOSE — a 2006 brand with no vintage tag corpus.',
   'https://www.ae.com/us/en/c/aerie/aerie-shop/cat6420015', 0.75, false, 'migration:00471'),

  ('savagexfenty', 'Savage X Fenty',
   ARRAY['savagexfenty','savagex','savagefenty','savagexfentybyrihanna']::text[],
   ARRAY['bras','lingerie','underwear','loungewear','corsets','sleepwear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"Savage X Fenty is produced broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the Xtra VIP membership is a retail nuance, not auth","detail":"Savage X Fenty has no per-unit serial and no consumer authentication portal. Grade condition. Identify by the LINE and the inclusive band+cup / XS-4X sizing. Note the brand runs a MEMBERSHIP (Xtra VIP) pricing model — that affects a piece's original price context but is NOT an authenticity signal and never enters the grade."},{"tell":"On a bra/bodysuit the elastic + hardware are the grade","detail":"Elastic recovery, the underwire, hook-and-eye and any lace/mesh snags decide a lingerie grade — require a photo of the band stretched and the cup interior. Lace pulls and a stretched band are real defects; wash-softening is not."}]$j$::jsonb,
   'Founded 2018 by Rihanna; a SIZE-INCLUSIVE lingerie brand (bras 30A-46DDD, undies/loungewear XS-4X) built on an extended fit range and a membership (Xtra VIP) retail model. Resale-relevant categories: bras, lingerie sets, undies, corsets and loungewear. Bras size on the BAND + CUP two-axis system across an inclusive range (see the chart). NO RN IS SEEDED (none sourced). NO DECODER: the model is a NAMED LINE, and a bra size is not a style code. TAG ERAS EMPTY ON PURPOSE — a 2018 brand with no vintage tag corpus.',
   'https://www.savagex.com/', 0.80, false, 'migration:00471'),

  ('calvinklein', 'Calvin Klein',
   ARRAY['calvinklein','ck','calvinkleinunderwear','ckunderwear','calvinkleinjeans','ckjeans','ckone']::text[],
   ARRAY['underwear','bras','bralettes','loungewear','sleepwear','apparel']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Vintage 90s Calvin Klein / \"CK\" one-logo / Calvin Klein Jeans","years":"1990s (approximate)","description":"COLLECTOR-CORROBORATED, NOT A DATED CHART. The 1990s Calvin Klein — the \"CK\" one-logo era, the Calvin Klein Jeans logo, and the Kate Moss / Mark Wahlberg WAISTBAND-LOGO underwear campaigns — is a genuine vintage market: 90s CK denim, tees and the logo-waistband boxer briefs comp above ordinary modern CK basics. Older logo/label styles skew vintage; no precise dated label chronology is sourced, so treat as a COARSE prior."}]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (modern), some vintage Made in USA","note":"COARSE PRIOR ONLY: a Made-in-USA vintage CK piece skews older, but modern Calvin Klein is broadly offshore and country does not authenticate or precisely date a piece."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Calvin Klein — and the LOGO-WAISTBAND underwear especially — is one of the most COUNTERFEITED marks in the category; the guidance is channel-based, not a reliable set of per-unit photo tells, and CK spans LICENSED product (fragrance, watches, home) that is not this apparel brand. Grade condition. Identify by the line (Modern Cotton, the logo-waistband boxer brief, Sculpted bralette)."},{"tell":"On a logo-waistband brief the WAISTBAND is the whole product","detail":"The elastic logo WAISTBAND is the value and the grade: a stretched-out, greyed or cracked-logo waistband is a real defect and reads only from a close, stretched photo of the band. The brief body pilling/thinning is secondary. Grade the waistband explicitly."}]$j$::jsonb,
   'Founded 1968 by Calvin Klein; in THIS pack the resale-relevant identity is the INTIMATES/underwear core — the LOGO-WAISTBAND boxer briefs/trunks, MODERN COTTON (bralettes/bras/undies), the Sculpted and Perfectly Fit bras, and loungewear/sleepwear — alongside the broader CK Jeans/apparel. ⚠ PROMOTED from the shallow 00389 alias-only shell to this full pack (the story instruction). Men''s/women''s underwear sizes alpha S-XL (waist run); bras/bralettes band+cup or XS-XL. ⚠ A VINTAGE 90s CK / one-logo piece is a genuine collectible prior (see tag_eras). NO RN IS SEEDED (none sourced to a primary record). NO DECODER: the model is a NAMED LINE and the underwear style number (NB1476, U2664G) is a web/packaging SKU, refused (the Fossil licensed-product hazard, 00468).',
   'https://www.calvinklein.us/', 0.80, false, 'migration:00471'),

  ('tommyjohn', 'Tommy John',
   ARRAY['tommyjohn','tommyjohnunderwear','tommyjohnwear']::text[],
   ARRAY['underwear','undershirts','loungewear','sleepwear','bras','socks']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"Tommy John is produced broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; identify by the FABRIC line","detail":"Tommy John (a premium men's + women's underwear/undershirt maker) has no per-unit serial and no consumer authentication portal. Grade condition. Identify by the fabric line: SECOND SKIN (the signature micromodal), COOL COTTON, AIR (mesh), and the no-wedgie waistband / stay-tucked undershirt construction."},{"tell":"The WAISTBAND and fabric recovery are the grade","detail":"A Tommy John brief/trunk is graded on the no-roll waistband recovery, the micromodal fabric (pilling/thinning/pin-holes at high-wear seams) and any greying — require a close fabric + waistband photo. Ordinary softening is not damage; a stretched, non-recovering waistband is."}]$j$::jsonb,
   'Founded 2008; a premium men''s (and women''s) UNDERWEAR / undershirt brand known for "second skin" micromodal fabric, the no-wedgie / no-roll WAISTBAND and the stay-tucked undershirt. Resale-relevant fabric lines: SECOND SKIN (micromodal), COOL COTTON, AIR (mesh), plus loungewear and the women''s line. Sizes alpha S-XXL. NO RN IS SEEDED (none sourced). NO DECODER: the model is a NAMED FABRIC LINE, and Tommy John article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — a 2008 brand with no vintage tag corpus.',
   'https://tommyjohn.com/', 0.80, false, 'migration:00471')
on conflict (brand_key) do update set
  canonical_brand      = excluded.canonical_brand,
  aliases              = excluded.aliases,
  category_focus       = excluded.category_focus,
  registered_numbers   = excluded.registered_numbers,
  tag_eras             = excluded.tag_eras,
  country_patterns     = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells,
  notes                = excluded.notes,
  source_url           = excluded.source_url,
  confidence           = excluded.confidence,
  updated_by           = excluded.updated_by;

-- ── brand_styles ───────────────────────────────────────────────────────────
-- brandPackPromptBlock renders visual_fingerprint VERBATIM into the extract
-- prompt (US-1740). For intimates the highest-value fingerprint is the FABRIC
-- LINE + the fit/construction cue that separates lookalike lines and the "the
-- fit/elastic is the grade" instruction, so the style rows lead with those.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- SKIMS
  ('skims', 'Fits Everybody', 'Women', 'shapewear', 'Solutionwear',
   'THE ICON: the seamless STRETCH-RIB (or smooth) line — thongs, briefs, bodysuits, bralettes in a buttery 4-way-stretch fabric, in the full nude/skin-tone palette. ⚠ Separable from Soft Lounge by the FIRMER, seamless second-skin hand vs Soft Lounge''s drapey modal. Grade the elastane recovery + pilling.',
   ARRAY['nylon','elastane','seamless rib']::text[], '2019-present', '$$',
   ARRAY['fits everybody','seamless','bodysuit','thong','skims']::text[],
   'https://skims.com/', 0.80, false, 'migration:00471'),
  ('skims', 'Soft Lounge', 'Women', 'loungewear', 'Loungewear',
   'The drapey MODAL loungewear line: long slip dresses, long-sleeve tops, leggings and sets in a soft matte modal, again in the skin-tone palette. ⚠ Separable from Fits Everybody by the DRAPEY, non-compressive modal hand. The slip dress is the resale driver. Grade for modal pilling.',
   ARRAY['modal','elastane']::text[], '2019-present', '$$',
   ARRAY['soft lounge','slip dress','modal','loungewear','skims']::text[],
   'https://skims.com/', 0.75, false, 'migration:00471'),
  ('skims', 'Sculpting Bodysuit / Shorts', 'Women', 'shapewear', 'Shapewear',
   'The FIRM shapewear line: sculpting bodysuits, mid-thigh shorts and briefs with real compression (a different product from the everyday Fits Everybody). Graded on COMPRESSION-panel recovery. Comp against the sculpting line, not the seamless rib.',
   ARRAY['nylon','elastane','powermesh']::text[], 'current', '$$',
   ARRAY['sculpting','shapewear','bodysuit','shorts','skims']::text[],
   'https://skims.com/', 0.65, false, 'migration:00471'),
  ('skims', 'Cotton Rib', 'Women', 'underwear', 'Cotton',
   'The everyday COTTON-RIB line: tanks, tees, briefs, boxers and dresses in a ribbed cotton, again in the skin-tone + core colour palette. Separable from the synthetic Fits Everybody by the matte cotton hand. Grade for pilling + shape loss.',
   ARRAY['cotton','elastane','rib']::text[], 'current', '$',
   ARRAY['cotton rib','tank','boxer','underwear','skims']::text[],
   'https://skims.com/', 0.60, false, 'migration:00471'),

  -- Spanx
  ('spanx', 'Faux Leather Leggings', 'Women', 'leggings', 'Fashion',
   'THE resale ICON: a coated/faux-leather high-waisted legging with a compressive smoothing waistband and a glossy PU-coated finish. ⚠ The COATED sheen is the cue (vs an ordinary matte legging). Grade the coating for cracking/peeling at the knee + the waistband recovery. Comes in regular, quilted and moto seams.',
   ARRAY['faux leather (PU-coated)','ponte','elastane']::text[], 'current', '$$',
   ARRAY['faux leather leggings','coated','high waist','spanx']::text[],
   'https://spanx.com/', 0.80, false, 'migration:00471'),
  ('spanx', 'AirEssentials', 'Women', 'loungewear', 'Loungewear',
   'The buttery LOUNGEWEAR line: jogger, hoodie, half-zip, wide-leg and jumpsuit in a soft brushed "air" knit. A high-volume set seller. Grade for pilling + shape retention; identify by the AirEssentials line label.',
   ARRAY['nylon','elastane','brushed knit']::text[], 'current', '$$',
   ARRAY['airessentials','jogger','hoodie','loungewear','spanx']::text[],
   'https://spanx.com/', 0.70, false, 'migration:00471'),
  ('spanx', 'OnCore / Higher Power / Thinstincts', 'Women', 'shapewear', 'Firm shapewear',
   'The FIRM shaping lines: OnCore (mid-thigh/bodysuit firm control), Higher Power (high-waisted shorts), Thinstincts (mid control). ⚠ These are firm SHAPEWEAR, not fashion leggings — comp separately. Graded on compression-panel recovery. Read the exact line off the tag.',
   ARRAY['nylon','elastane','powermesh']::text[], 'current', '$$',
   ARRAY['oncore','higher power','thinstincts','shapewear','spanx']::text[],
   'https://spanx.com/', 0.65, false, 'migration:00471'),

  -- Victoria's Secret
  ('victoriassecret', 'Bombshell', 'Women', 'bra', 'Push-up bra',
   'THE add-2-cup-sizes push-up bra: a heavily padded push-up whose labelled size runs SMALL on volume (the padding adds two cup sizes). ⚠ Separable from Body by Victoria by the thick, projecting foam cup. Grade the foam for creasing/collapse + the band elastic. Available in the "Shine"/embellished variants.',
   ARRAY['nylon','elastane','molded foam']::text[], 'current', '$$',
   ARRAY['bombshell','push-up','add two cups','bra','victorias secret']::text[],
   'https://www.victoriassecret.com/', 0.75, false, 'migration:00471'),
  ('victoriassecret', 'Body by Victoria', 'Women', 'bra', 'T-shirt bra',
   'The smooth everyday T-SHIRT BRA line: lightly lined, seamless-cup, invisible under a tee. ⚠ Separable from the Bombshell by the THIN, non-projecting lined cup. Grade the elastic recovery + underwire; the line is on the tag.',
   ARRAY['nylon','elastane','lightly lined']::text[], 'current', '$$',
   ARRAY['body by victoria','t-shirt bra','seamless','bra','victorias secret']::text[],
   'https://www.victoriassecret.com/', 0.65, false, 'migration:00471'),
  ('victoriassecret', 'Very Sexy', 'Women', 'bra', 'Lingerie',
   'The lace/lingerie-forward line: push-up and demi styles with lace and mesh detailing, a lingerie (not t-shirt) look. Grade the lace for snags/pulls + the elastic. Comp against the lingerie line, not the plain t-shirt bra.',
   ARRAY['nylon','elastane','lace','mesh']::text[], 'current', '$$',
   ARRAY['very sexy','lace','demi','lingerie','victorias secret']::text[],
   'https://www.victoriassecret.com/', 0.60, false, 'migration:00471'),

  -- PINK
  ('pink', 'Wear Everywhere', 'Women', 'bra', 'Bralettes & bras',
   'PINK''s core bra/bralette line: push-up, lightly lined and bralette styles at a lower band than VS lingerie. ⚠ Separable from a Victoria''s Secret Body by Victoria bra by the PINK label + the younger, lower-price construction. Grade the elastic + cup; comp on the PINK ladder, not VS.',
   ARRAY['nylon','elastane','lightly lined']::text[], 'current', '$$',
   ARRAY['wear everywhere','bralette','push-up','pink','bra']::text[],
   'https://www.victoriassecret.com/us/pink', 0.65, false, 'migration:00471'),
  ('pink', 'Campus / Logo Loungewear', 'Women', 'loungewear', 'Loungewear',
   'THE volume driver: collegiate/campus and PINK-logo hoodies, sweatpants, leggings and sets, often with the corgi/dog mascot and rhinestone/print graphics. ⚠ The PRINT/logo condition (cracking, fading) is part of the grade. Trend/logo-driven; comp by the exact graphic and drop.',
   ARRAY['cotton','polyester','fleece']::text[], 'current', '$',
   ARRAY['campus','logo hoodie','sweatpants','pink','loungewear']::text[],
   'https://www.victoriassecret.com/us/pink', 0.60, false, 'migration:00471'),

  -- Aerie
  ('aerie', 'OFFLINE', 'Women', 'leggings', 'Activewear',
   'THE activewear driver: OFFLINE leggings (Real Me high-waist, Real Me Crossover) and matching sets in a compressive brushed knit. ⚠ Separable from the loungewear by the compressive, activewear hand + the OFFLINE label. Grade the waistband/leg-opening recovery + pilling.',
   ARRAY['nylon','elastane','brushed knit']::text[], 'current', '$$',
   ARRAY['offline','real me','leggings','crossover','aerie']::text[],
   'https://www.ae.com/us/en/c/aerie/aerie-shop/cat6420015', 0.70, false, 'migration:00471'),
  ('aerie', 'Real Me / Real Sunnie Bralette', 'Women', 'bra', 'Bralettes',
   'Aerie''s core BRALETTE lines: Real Me and Real Sunnie — soft, wireless, lightly lined bralettes at a young/loungewear price. Grade the elastic + fabric recovery; read the line off the tag. Comp on the Aerie ladder.',
   ARRAY['nylon','elastane','modal']::text[], 'current', '$',
   ARRAY['real me','real sunnie','bralette','wireless','aerie']::text[],
   'https://www.ae.com/us/en/c/aerie/aerie-shop/cat6420015', 0.60, false, 'migration:00471'),
  ('aerie', 'Chill Loungewear', 'Women', 'loungewear', 'Loungewear',
   'The Chill/soft loungewear line: oversized tees, joggers, hoodies and the boxer/short sets in a soft brushed knit. Trend-driven; grade for pilling + print condition. Comp by the exact drop.',
   ARRAY['cotton','polyester','brushed knit']::text[], 'current', '$',
   ARRAY['chill','loungewear','joggers','boxers','aerie']::text[],
   'https://www.ae.com/us/en/c/aerie/aerie-shop/cat6420015', 0.55, false, 'migration:00471'),

  -- Savage X Fenty
  ('savagexfenty', 'Xtra VIP Bra / Lingerie', 'Women', 'bra', 'Lingerie',
   'The core bra/lingerie line across an INCLUSIVE band+cup range (30A-46DDD): push-up, unlined and lace styles. Grade the elastic recovery, underwire + lace for snags. The "Xtra VIP" is a membership price tier, not a model — read the actual style/line off the tag.',
   ARRAY['nylon','elastane','lace','mesh']::text[], '2018-present', '$$',
   ARRAY['savage x','fenty','bra','lingerie','inclusive','savage x fenty']::text[],
   'https://www.savagex.com/', 0.70, false, 'migration:00471'),
  ('savagexfenty', 'Undies & Loungewear', 'Women', 'underwear', 'Underwear',
   'The undies + loungewear range (XS-4X): thongs, briefs, cheeky, plus lounge sets and corsets. Size-inclusive. Grade the elastic + fabric recovery; comp by the specific line.',
   ARRAY['nylon','elastane','cotton']::text[], 'current', '$',
   ARRAY['undies','thong','loungewear','corset','savage x fenty']::text[],
   'https://www.savagex.com/', 0.55, false, 'migration:00471'),

  -- Calvin Klein
  ('calvinklein', 'Logo-Waistband Boxer Brief', 'Men', 'underwear', 'Underwear',
   'THE ICON: the elastic LOGO WAISTBAND boxer brief/trunk (CALVIN KLEIN or CK woven into the band). ⚠ The waistband IS the product — grade it explicitly for stretch/greying/cracked-logo. Sold in Cotton Stretch, Micro and the "Steel"/"Modern Cotton" variants. Read the waistband + the line off the tag.',
   ARRAY['cotton','elastane','logo waistband']::text[], 'heritage-present', '$$',
   ARRAY['boxer brief','logo waistband','trunk','ck','calvin klein']::text[],
   'https://www.calvinklein.us/', 0.75, false, 'migration:00471'),
  ('calvinklein', 'Modern Cotton', 'Women', 'bra', 'Bralettes & bras',
   'The MODERN COTTON line: soft cotton-modal logo-band bralettes, bras and undies (the women''s counterpart to the men''s logo waistband). ⚠ Separable from a Sculpted/Perfectly Fit bra by the soft unlined bralette construction + the exposed logo band. Grade the band elastic + fabric.',
   ARRAY['cotton','modal','elastane','logo band']::text[], 'current', '$$',
   ARRAY['modern cotton','bralette','logo band','ck','calvin klein']::text[],
   'https://www.calvinklein.us/', 0.65, false, 'migration:00471'),
  ('calvinklein', 'CK Jeans / 90s One-Logo (vintage)', 'Unisex', 'apparel', 'Vintage',
   'The vintage 90s driver: Calvin Klein Jeans denim and the "CK" one-logo tees/sweats of the 1990s, a genuine vintage market. ⚠ Comp against the VINTAGE ladder (a 90s CK Jeans logo tee is not a modern basic). Read the tag era (see tag_eras) + the logo style.',
   ARRAY['cotton','denim']::text[], '1990s', '$$',
   ARRAY['ck jeans','one logo','90s','vintage','calvin klein']::text[],
   'https://www.calvinklein.us/', 0.55, false, 'migration:00471'),

  -- Tommy John
  ('tommyjohn', 'Second Skin', 'Men', 'underwear', 'Underwear',
   'THE signature line: MICROMODAL "second skin" boxer briefs/trunks with the no-roll waistband, in a silky drapey hand. ⚠ Separable from Cool Cotton by the ultra-soft micromodal (vs a crisper cotton) hand. Grade the waistband recovery + micromodal pilling/pin-holes at seams.',
   ARRAY['micromodal','elastane','no-roll waistband']::text[], 'current', '$$',
   ARRAY['second skin','micromodal','boxer brief','no wedgie','tommy john']::text[],
   'https://tommyjohn.com/', 0.75, false, 'migration:00471'),
  ('tommyjohn', 'Cool Cotton', 'Men', 'underwear', 'Underwear',
   'The COOL COTTON line: a crisper, breathable cotton-blend boxer brief/trunk with the no-roll waistband. Separable from Second Skin by the cottonier hand. Grade the waistband + fabric recovery.',
   ARRAY['cotton','elastane','no-roll waistband']::text[], 'current', '$$',
   ARRAY['cool cotton','boxer brief','breathable','tommy john']::text[],
   'https://tommyjohn.com/', 0.60, false, 'migration:00471'),
  ('tommyjohn', 'Stay-Tucked Undershirt', 'Men', 'undershirt', 'Undershirts',
   'The STAY-TUCKED undershirt: a longer-cut, deep-V or crew undershirt engineered to stay tucked, in Second Skin or Cool Cotton fabric. Grade for pit staining, thinning + shape. Read the fabric line off the tag.',
   ARRAY['micromodal','cotton','elastane']::text[], 'current', '$$',
   ARRAY['undershirt','stay tucked','deep v','tommy john']::text[],
   'https://tommyjohn.com/', 0.55, false, 'migration:00471')
on conflict (brand_key, style_name, department) do update set
  category           = excluded.category,
  product_line       = excluded.product_line,
  visual_fingerprint = excluded.visual_fingerprint,
  fabric_tech        = excluded.fabric_tech,
  era                = excluded.era,
  msrp_band          = excluded.msrp_band,
  keywords           = excluded.keywords,
  source_url         = excluded.source_url,
  confidence         = excluded.confidence,
  updated_by         = excluded.updated_by;

-- ── brand_colorways ────────────────────────────────────────────────────────
-- ONE BRAND QUALIFIES. SKIMS built its identity on a proprietary NUDE/SKIN-TONE
-- palette (Sand, Sienna, Clay, Cocoa, Umber, Onyx, Oxide, Ochre) that recurs
-- across Fits Everybody / Soft Lounge / Cotton for years and is searched BY NAME —
-- a true internal dictionary (the UGG Chestnut / Clarks Beeswax precedent, 00459/
-- 00470). The other seven ship ordinary descriptive colour words (black, nude,
-- pink) that rotate per season and form no stable dictionary, so none are seeded
-- (the 00456/00462/00470 rule — a colour table is only for a proprietary NAMED
-- palette, not for ordinary words). hex left null: these are skin-tone families
-- checkable by eye against the photo, not exact swatches.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('skims', 'Sand', ARRAY[]::text[], null,
   'A pale warm neutral — the lightest of the core SKIMS nude/skin-tone family. A proprietary NAMED colourway searched by name, checkable by eye against the photo.',
   'https://skims.com/', 0.70, false, 'migration:00471'),
  ('skims', 'Sienna', ARRAY[]::text[], null,
   'A warm mid tan/caramel skin tone in the core SKIMS nude family. Named and durable across seasons.',
   'https://skims.com/', 0.70, false, 'migration:00471'),
  ('skims', 'Clay', ARRAY[]::text[], null,
   'A muted rosy-brown mid skin tone in the SKIMS nude family. Named and durable.',
   'https://skims.com/', 0.65, false, 'migration:00471'),
  ('skims', 'Cocoa', ARRAY[]::text[], null,
   'A medium-deep brown skin tone in the SKIMS nude family. Named and durable.',
   'https://skims.com/', 0.65, false, 'migration:00471'),
  ('skims', 'Umber', ARRAY[]::text[], null,
   'A deep warm brown skin tone in the SKIMS nude family. Named and durable.',
   'https://skims.com/', 0.65, false, 'migration:00471'),
  ('skims', 'Onyx', ARRAY['onyx black']::text[], null,
   'The deepest of the SKIMS core neutrals — a near-black. A named core colourway.',
   'https://skims.com/', 0.65, false, 'migration:00471'),
  ('skims', 'Oxide', ARRAY[]::text[], null,
   'A muted terracotta/clay-red seasonal colour recurring in the SKIMS palette. Named.',
   'https://skims.com/', 0.55, false, 'migration:00471'),
  ('skims', 'Ochre', ARRAY[]::text[], null,
   'A muted golden-yellow seasonal colour in the SKIMS palette. Named.',
   'https://skims.com/', 0.55, false, 'migration:00471')
on conflict (brand_key, color_name) do update set
  aliases    = excluded.aliases,
  hex        = excluded.hex,
  years      = excluded.years,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  updated_by = excluded.updated_by;

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- THE STORY'S KEY SIGNAL ("bra/shapewear sizing systems matter"). These charts
-- carry the THREE incompatible systems named in the header, and the system is
-- written INTO the label + the note (the 00459/00470 lesson: the cross-map lives
-- where the model reads it). Measurements are body-equivalent approximations in
-- INCHES, not brand-published specs — hence the modest confidence.
-- formatSizingChartsForPrompt renders labels + note IN FULL (US-1740), so the
-- cup-difference math + fit caveats live in the note.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  -- SKIMS — size-inclusive alpha apparel/shapewear/lounge.
  ('skims', 'SKIMS', ARRAY['skims']::text[], 'Women',
   'Intimates apparel / shapewear (alpha XXS-4X, body inches)',
   ARRAY['shapewear','bodysuit','loungewear','underwear','dress','top','legging','brief','thong','tank']::text[],
   $j$[{"size":"XXS","measurements":{"bust":"30-31","waist":"23-24","hip":"33-34"}},{"size":"XS","measurements":{"bust":"32-33","waist":"25-26","hip":"35-36"}},{"size":"S","measurements":{"bust":"34-35","waist":"27-28","hip":"37-38"}},{"size":"M","measurements":{"bust":"36-37.5","waist":"29-30.5","hip":"39-40.5"}},{"size":"L","measurements":{"bust":"38.5-40","waist":"32-33.5","hip":"42-43.5"}},{"size":"XL","measurements":{"bust":"41-43","waist":"35-37","hip":"45-47"}},{"size":"2X","measurements":{"bust":"44-46.5","waist":"38-40.5","hip":"48-50.5"}},{"size":"3X","measurements":{"bust":"47.5-50","waist":"42-44.5","hip":"52-54.5"}},{"size":"4X","measurements":{"bust":"51-53.5","waist":"46-48.5","hip":"56-58.5"}}]$j$::jsonb,
   'SKIMS is SIZE-INCLUSIVE (XXS-4X) and its fabric is COMPRESSIVE: the Fits Everybody/Sculpting lines are meant to fit snug, so size to the BODY measurement, not to the flat-garment measurement (a Fits Everybody piece measures much smaller than the body it fits). Bust/waist/hip are the primary signals. THE FABRIC IS THE GRADE — a stretched-out, non-recovering piece is a defect. Body-equivalent approximations, not brand-published specs.',
   'https://skims.com/', 0.55, false, 'migration:00471'),

  -- Spanx — shapewear/legging alpha, compression-graded.
  ('spanx', 'Spanx', ARRAY['spanx']::text[], 'Women',
   'Shapewear / leggings (alpha XS-3X, body inches)',
   ARRAY['shapewear','legging','bodysuit','short','loungewear','faux leather','oncore','bra']::text[],
   $j$[{"size":"XS","measurements":{"waist":"25-26","hip":"35-36"}},{"size":"S","measurements":{"waist":"27-28.5","hip":"37-38.5"}},{"size":"M","measurements":{"waist":"29.5-31","hip":"39.5-41"}},{"size":"L","measurements":{"waist":"32-34","hip":"42-44"}},{"size":"XL","measurements":{"waist":"35-37","hip":"45-47"}},{"size":"1X","measurements":{"waist":"38-40.5","hip":"48-50.5"}},{"size":"2X","measurements":{"waist":"41.5-44","hip":"52-54.5"}},{"size":"3X","measurements":{"waist":"45-47.5","hip":"56-58.5"}}]$j$::jsonb,
   'Spanx sizes alpha XS-3X. ⚠ FIRM SHAPEWEAR (OnCore/Higher Power) is graded on COMPRESSION and runs true-to-snug — the smoothing panel is meant to be tight; size to the body, not the flat garment. The FAUX LEATHER LEGGINGS are a fashion legging (comp separately) and their COATED FINISH is part of the grade (cracking at the knee). Waist is the primary signal, hip secondary. Body-equivalent approximations, not brand-published specs.',
   'https://spanx.com/', 0.55, false, 'migration:00471'),

  -- Victoria's Secret — the BRA band+cup translator (the category's hardest signal).
  ('victoriassecret', 'Victoria''s Secret', ARRAY['victoria''s secret','victorias secret','victoriassecret']::text[], 'Women',
   'Bras (BAND + CUP two-axis system, underbust inches)',
   ARRAY['bra','bralette','bombshell','push-up','t-shirt bra','lingerie','demi']::text[],
   $j$[{"size":"Band 30 (underbust ~26-27in)","measurements":{"underbust":"26-27"}},{"size":"Band 32 (underbust ~28-29in)","measurements":{"underbust":"28-29"}},{"size":"Band 34 (underbust ~30-31in)","measurements":{"underbust":"30-31"}},{"size":"Band 36 (underbust ~32-33in)","measurements":{"underbust":"32-33"}},{"size":"Band 38 (underbust ~34-35in)","measurements":{"underbust":"34-35"}},{"size":"Band 40 (underbust ~36-37in)","measurements":{"underbust":"36-37"}},{"size":"Band 42 (underbust ~38-39in)","measurements":{"underbust":"38-39"}}]$j$::jsonb,
   '⚠ A BRA SIZE IS TWO AXES: the BAND number (30-44) is the UNDERBUST, and the CUP letter is RELATIVE — it is (bust minus band): A=+1in, B=+2in, C=+3in, D=+4in, DD/E=+5in, DDD/F=+6in, G=+7in. So a 34B and a 36A share a cup VOLUME but a different band (sister sizes). READ THE STAMPED BAND+CUP off the tag and state both. ⚠ THE BOMBSHELL ADDS TWO CUP SIZES of padding, so a labelled Bombshell 34B fits a smaller bust than a plain 34B. Elastic recovery + underwire condition are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.victoriassecret.com/', 0.55, false, 'migration:00471'),
  ('victoriassecret', 'Victoria''s Secret', ARRAY['victoria''s secret','victorias secret','victoriassecret']::text[], 'Women',
   'Panties / apparel (alpha XS-XL, body inches)',
   ARRAY['panty','panties','underwear','thong','sleepwear','loungewear','top','swim']::text[],
   $j$[{"size":"XS","measurements":{"waist":"24-25","hip":"34-35"}},{"size":"S","measurements":{"waist":"26-27","hip":"36-37"}},{"size":"M","measurements":{"waist":"28-29.5","hip":"38-39.5"}},{"size":"L","measurements":{"waist":"30.5-32","hip":"40.5-42"}},{"size":"XL","measurements":{"waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'VS panties/apparel size alpha XS-XL; waist + hip are the primary signals. Panties are a hygiene-sensitive category — grade condition and note new-with-tags vs worn explicitly. Body-equivalent approximations, not brand-published specs.',
   'https://www.victoriassecret.com/', 0.50, false, 'migration:00471'),

  -- PINK — young apparel/loungewear alpha + bralette.
  ('pink', 'PINK', ARRAY['pink']::text[], 'Women',
   'Loungewear / apparel (alpha XS-XL, body inches)',
   ARRAY['loungewear','hoodie','sweatpants','legging','top','tee','panty','bralette','sleepwear']::text[],
   $j$[{"size":"XS","measurements":{"bust":"31-32","waist":"24-25","hip":"34-35"}},{"size":"S","measurements":{"bust":"33-34","waist":"26-27","hip":"36-37"}},{"size":"M","measurements":{"bust":"35-36.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L","measurements":{"bust":"37.5-39","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL","measurements":{"bust":"40-42","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   '⚠ PINK IS NOT VICTORIA''S SECRET — a younger, LOWER-band line; comp a PINK hoodie/legging on the PINK ladder, not the VS lingerie one. Apparel sizes alpha XS-XL; bust/waist/hip are the signals. On graphic loungewear the PRINT/logo condition (cracking, fading) is part of the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.victoriassecret.com/us/pink', 0.50, false, 'migration:00471'),

  -- Aerie — young apparel/legging alpha + bralette.
  ('aerie', 'Aerie', ARRAY['aerie']::text[], 'Women',
   'Apparel / leggings / bralettes (alpha XXS-XXL, body inches)',
   ARRAY['legging','offline','bralette','loungewear','top','tee','swim','underwear','activewear']::text[],
   $j$[{"size":"XXS","measurements":{"bust":"30-31","waist":"23-24","hip":"33-34"}},{"size":"XS","measurements":{"bust":"32-33","waist":"25-26","hip":"35-36"}},{"size":"S","measurements":{"bust":"34-35","waist":"27-28","hip":"37-38"}},{"size":"M","measurements":{"bust":"36-37.5","waist":"29-30.5","hip":"39-40.5"}},{"size":"L","measurements":{"bust":"38.5-40","waist":"32-33.5","hip":"42-43.5"}},{"size":"XL","measurements":{"bust":"41-43","waist":"35-37","hip":"45-47"}},{"size":"XXL","measurements":{"bust":"44-46","waist":"38-40","hip":"48-50"}}]$j$::jsonb,
   'Aerie sizes alpha XXS-XXL. ⚠ THE OFFLINE LEGGINGS ARE COMPRESSIVE ACTIVEWEAR — size to the body, not the flat garment. Bust/waist/hip are the signals; the bralettes (Real Me/Real Sunnie) size S-XL. The elastane RECOVERY is the grade on leggings/bralettes. Body-equivalent approximations, not brand-published specs.',
   'https://www.ae.com/us/en/c/aerie/aerie-shop/cat6420015', 0.50, false, 'migration:00471'),

  -- Savage X Fenty — the INCLUSIVE bra band+cup + undies/apparel XS-4X.
  ('savagexfenty', 'Savage X Fenty', ARRAY['savage x fenty','savagexfenty','savage x']::text[], 'Women',
   'Bras (INCLUSIVE BAND + CUP, underbust inches)',
   ARRAY['bra','bralette','lingerie','push-up','unlined','corset']::text[],
   $j$[{"size":"Band 30 (underbust ~26-27in)","measurements":{"underbust":"26-27"}},{"size":"Band 32 (underbust ~28-29in)","measurements":{"underbust":"28-29"}},{"size":"Band 34 (underbust ~30-31in)","measurements":{"underbust":"30-31"}},{"size":"Band 36 (underbust ~32-33in)","measurements":{"underbust":"32-33"}},{"size":"Band 38 (underbust ~34-35in)","measurements":{"underbust":"34-35"}},{"size":"Band 40 (underbust ~36-37in)","measurements":{"underbust":"36-37"}},{"size":"Band 42 (underbust ~38-39in)","measurements":{"underbust":"38-39"}},{"size":"Band 44 (underbust ~40-41in)","measurements":{"underbust":"40-41"}},{"size":"Band 46 (underbust ~42-43in)","measurements":{"underbust":"42-43"}}]$j$::jsonb,
   '⚠ SAVAGE X FENTY IS SIZE-INCLUSIVE (bras 30A-46DDD). A BRA SIZE IS TWO AXES: the BAND (30-46) is the UNDERBUST, and the CUP letter is RELATIVE — (bust minus band): A=+1in, B=+2in, C=+3in, D=+4in, DD/E=+5in, DDD/F=+6in. Sister sizes share a cup VOLUME across bands (34B ≈ 36A). READ THE STAMPED BAND+CUP and state both. Elastic + underwire + lace snags are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.savagex.com/', 0.55, false, 'migration:00471'),
  ('savagexfenty', 'Savage X Fenty', ARRAY['savage x fenty','savagexfenty','savage x']::text[], 'Women',
   'Undies / loungewear (alpha XS-4X, body inches)',
   ARRAY['undies','underwear','thong','brief','loungewear','set']::text[],
   $j$[{"size":"XS","measurements":{"waist":"24-25","hip":"34-35"}},{"size":"S","measurements":{"waist":"26-27","hip":"36-37"}},{"size":"M","measurements":{"waist":"28-29.5","hip":"38-39.5"}},{"size":"L","measurements":{"waist":"30.5-32","hip":"40.5-42"}},{"size":"XL","measurements":{"waist":"33-35","hip":"43-45"}},{"size":"1X","measurements":{"waist":"36-38.5","hip":"46-48.5"}},{"size":"2X","measurements":{"waist":"39.5-42","hip":"49.5-52"}},{"size":"3X","measurements":{"waist":"43-45.5","hip":"53-55.5"}},{"size":"4X","measurements":{"waist":"46.5-49","hip":"57-59.5"}}]$j$::jsonb,
   'Savage X undies/loungewear are SIZE-INCLUSIVE (XS-4X); waist + hip are the signals. Undies are hygiene-sensitive — grade condition and note new-with-tags vs worn explicitly. Body-equivalent approximations, not brand-published specs.',
   'https://www.savagex.com/', 0.50, false, 'migration:00471'),

  -- Calvin Klein — men's underwear waist run + women's bralette.
  ('calvinklein', 'Calvin Klein', ARRAY['calvin klein','calvinklein']::text[], 'Men',
   'Underwear (alpha S-XL, waist inches)',
   ARRAY['underwear','boxer brief','trunk','brief','boxer','undershirt']::text[],
   $j$[{"size":"S (waist ~28-30in)","measurements":{"waist":"28-30"}},{"size":"M (waist ~32-34in)","measurements":{"waist":"32-34"}},{"size":"L (waist ~36-38in)","measurements":{"waist":"36-38"}},{"size":"XL (waist ~40-42in)","measurements":{"waist":"40-42"}}]$j$::jsonb,
   'Calvin Klein men''s underwear sizes alpha S-XL to a WAIST inch run (read it off the tag / packaging). ⚠ THE LOGO WAISTBAND IS THE PRODUCT and the grade: a stretched, greyed or cracked-logo band is a defect (grade it explicitly). Body-equivalent approximations, not brand-published specs.',
   'https://www.calvinklein.us/', 0.55, false, 'migration:00471'),
  ('calvinklein', 'Calvin Klein', ARRAY['calvin klein','calvinklein']::text[], 'Women',
   'Bras / bralettes / undies (alpha XS-XL, body inches)',
   ARRAY['bra','bralette','modern cotton','underwear','panty','loungewear']::text[],
   $j$[{"size":"XS","measurements":{"bust":"31-32","waist":"24-25","hip":"34-35"}},{"size":"S","measurements":{"bust":"33-34","waist":"26-27","hip":"36-37"}},{"size":"M","measurements":{"bust":"35-36.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L","measurements":{"bust":"37.5-39","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL","measurements":{"bust":"40-42","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'CK women''s Modern Cotton bralettes/bras/undies size alpha XS-XL (band+cup on the structured bras — see the VS/Savage X note for the two-axis system); bust/waist/hip are the signals. The exposed logo band + elastic recovery are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.calvinklein.us/', 0.50, false, 'migration:00471'),

  -- Tommy John — men's underwear/undershirt waist+alpha run.
  ('tommyjohn', 'Tommy John', ARRAY['tommy john','tommyjohn']::text[], 'Men',
   'Underwear / undershirts (alpha S-XXL, waist inches)',
   ARRAY['underwear','boxer brief','trunk','brief','undershirt','loungewear']::text[],
   $j$[{"size":"S (waist ~28-30in)","measurements":{"waist":"28-30"}},{"size":"M (waist ~31-33in)","measurements":{"waist":"31-33"}},{"size":"L (waist ~34-36in)","measurements":{"waist":"34-36"}},{"size":"XL (waist ~37-40in)","measurements":{"waist":"37-40"}},{"size":"XXL (waist ~41-44in)","measurements":{"waist":"41-44"}}]$j$::jsonb,
   'Tommy John men''s underwear/undershirts size alpha S-XXL to a WAIST inch run (read it off the tag). The SECOND SKIN (micromodal) vs COOL COTTON fabric line is the identifier — read it off the tag. The no-roll WAISTBAND recovery + fabric pilling are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://tommyjohn.com/', 0.55, false, 'migration:00471')
on conflict (brand_key, department, garment) do update set
  brand_label    = excluded.brand_label,
  brand_match    = excluded.brand_match,
  category_match = excluded.category_match,
  rows           = excluded.rows,
  note           = excluded.note,
  source_url     = excluded.source_url,
  confidence     = excluded.confidence,
  updated_by     = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00471') on conflict do nothing;
