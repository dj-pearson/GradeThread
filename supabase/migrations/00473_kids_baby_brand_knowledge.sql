-- US-1993: Kids & baby brand knowledge (6 brands).
--
-- Carter's, Hanna Andersson, Mini Boden, Janie and Jack, The Children's Place,
-- Gymboree. This is the kids/baby pack; it is the first childrenswear-focused
-- group in the KB. All six were passthrough-only, so a "carters" or "gymboree"
-- tag rendered the seller's own casing into the prompt block and the eBay Brand
-- aspect.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT BINDS THIS GROUP: THE SIZE SYSTEM IS AN AGE/MONTHS SYSTEM — AND IT IS NOT
-- ONE SYSTEM. This is the defining problem of kids/baby resale, and it is this
-- group's analog to intimates' three bra-systems (00471) and footwear's US/UK/EU
-- translator (00470).
--
--   A children's listing is priced by SIZE, but "size" here is up to four
--   incompatible axes:
--     • BABY is sized in MONTHS (Newborn, 0-3M, 3-6M, 6-9M, 9-12M, 12-18M,
--       18-24M / 2T) AND cross-referenced by WEIGHT (lb) + HEIGHT (in) — a baby
--       is fitted by weight/height, and the month label is only a proxy.
--     • TODDLER is T-sizes (2T-5T).
--     • KIDS is numeric (4-16) or alpha (XS-XL) — and the SAME numeric label
--       means different garments across brands.
--     • HANNA ANDERSSON is a genuinely DIFFERENT AXIS: a EUROPEAN CM/HEIGHT
--       system (50/60/70/80/90/100/110/120/130/140/150 = the child's HEIGHT in
--       centimetres), not US age at all.
--   The size charts below are TRANSLATORS: months ↔ weight ↔ height ↔ T-size,
--   with the SYSTEM named IN the label and the age→measurement math in the note.
--   HANNA ANDERSSON SIZES BY HEIGHT IN CM is the standout call (the analog of the
--   Victoria's Secret band+cup call, 00471).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ZERO DECODERS, DELIBERATELY — and every candidate is fixtured as a REFUSAL
-- negative in brand-knowledge-golden_test.ts (a refusal that is not tested is a
-- comment). This is the 00470/00472 call: NO decoder clears the bar for this
-- group — not one of the six prints a code that is tag-printed AND regular AND
-- brand-unique in FORMAT (the 00460 test). The identifiers are NAMES.
--
--   * GYMBOREE / THE CHILDREN'S PLACE "style numbers" are web/catalogue SKUs —
--     bare digit runs printed on the hangtag/packaging or in the product URL, not
--     a regular sewn-tag brand-unique code (the Chanel rule, US-1736 — a pattern
--     over a bare digit run mints the KB's costliest false positive from any
--     number on any tag). Refused; the brand is the NAME and, for Gymboree, the
--     COLLECTION/line name.
--   * ⚠ A KIDS SIZE IS NOT A STYLE CODE. A tag reading "24M", "4T", "2T" or "5T"
--     is a SIZE — it is captured by the size charts below, and it must NEVER be
--     read as a decoder that recovers a brand. This is the DIRECT analog of the
--     intimates "A BRA SIZE IS NOT A STYLE CODE" call (00471): the most common
--     alphanumeric on a children's tag is the size, and the costliest mistake
--     would be to treat it as an identifier. Fixtured as a REFUSAL below.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REGISTERED NUMBERS: NONE ARE SEEDED. Childrenswear IS textile (unlike footwear),
-- so an RN/CA registrant WOULD be in scope here — but no registrant could be
-- sourced to a PRIMARY FTC record, and fabricating one is the KB's costliest error
-- (the RN 17257 lesson, 00468). So RN is left empty, owed to the US-1715 queue —
-- the same call intimates (00471) made, and for the same reason: textile, so we
-- say so rather than implying childrenswear is out of RN scope.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TAG ERAS: DOCUMENTED for the two makers with a genuine resale chronology —
-- GYMBOREE (the value nuance of the whole pack, below) and CARTER'S (a heritage
-- house since 1865 with older woven-label eras) — and EMPTY for the four
-- modern-corpus brands (Hanna Andersson, Mini Boden, Janie and Jack, The
-- Children's Place). TAG ERAS EMPTY ON PURPOSE for those four (the athleisure
-- precedent, 00452): they carry no value-driving dated label chronology, so empty
-- is CORRECT, not a gap.
--
-- ⚠ VINTAGE GYMBOREE IS THE PACK'S VALUE NUANCE. Unlike the others,
-- discontinued/"vintage" Gymboree COLLECTIONS from the 1990s-2000s (named,
-- matching sets — a devoted resale/collector following) comp on the COLLECTION /
-- line NAME, well above ordinary modern basics. This is called out in the
-- Gymboree tag_eras, notes and a dedicated style row.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- COLORWAYS: ZERO FOR THE WHOLE GROUP, BY DESIGN. Kids brands ship ordinary
-- descriptive seasonal colours and licensed prints; none prints a STABLE,
-- proprietary NAMED palette that recurs for years and is searched BY NAME (the
-- 00456/00462 rule; the UGG Chestnut / Dr. Martens Cherry Red / Fjällräven Kånken
-- bar is the one a palette must clear). So ZERO colorways are seeded — this is a
-- deliberate call, not a gap.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NAME / WORD COLLISIONS (all carried in brand-normalize.ts, not here) — none of
-- the six CANONICALS is an ordinary word, so NONE is added to
-- DETECT_EXCLUDED_FROM_TEXT. The hazards are all in the SHORT ALIAS FORMS, handled
-- by keeping the bare tokens OUT of the alias map:
--   * a bare "carter" (a surname) is DELIBERATELY ABSENT — only "carters" /
--     "Carter's" resolve. (brandKey strips the apostrophe → "carters".)
--   * a bare "hanna" (a first name) is DELIBERATELY ABSENT — only the full
--     "Hanna Andersson" resolves.
--   * a bare "place" (an ordinary word) is DELIBERATELY ABSENT — only
--     "The Children's Place" / "childrensplace" / the exact whole-field key "tcp"
--     resolve.
--   * a bare "boden" is DELIBERATELY ABSENT — it is the ADULT parent brand; only
--     the "Mini Boden" kids forms resolve (a shared name is not a fold).
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00472
-- convention). Confidence is DELIBERATELY UNEVEN: a widely-published spec is
-- ~0.75; a body-equivalent size approximation is ~0.55 and says so.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('carters', 'Carter''s',
   ARRAY['carters','carter''s','carters oshkosh','justoneyou','justoneyoubycarters','childofmine','simplejoys']::text[],
   ARRAY['baby','bodysuits','sleepers','pajamas','toddler','layette']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Older Carter''s woven labels (heritage)","years":"1865-present (approximate)","description":"COLLECTOR-CORROBORATED, NOT A DATED CHART. Carter''s (founded 1865, Needham Heights, Massachusetts) is one of the oldest US childrenswear houses. Older woven ''Carter''s'' labels and the ''Carter''s of Georgia'' / ''Carter''s Watch the Wear'' eras skew vintage, but the vast majority of resale stock is modern, high-volume basics with no precise dated chronology — treat as a coarse prior only. The month/weight sizing is the durable identity across eras."}]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Carter''s produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; a baby garment is graded on WASH WEAR + stains","detail":"Carter''s has no per-unit serial and no consumer authentication portal. Grade condition. Baby clothing lives its life in the wash and on the floor — the decisive read is PILLING, colour fade, tired snaps/zips and the stains babies produce (formula, food, the neckline/cuff). A bodysuit multipack graded ''EUC'' still needs a snap-crotch + inner-neck photo. Identify by the garment TYPE (footed sleeper, bodysuit, fleece) — Carter''s is high-volume basics, so the value is the SET/lot and condition, not a rare model."},{"tell":"Read the SUB-LABEL — Just One You / Child of Mine / Simple Joys","detail":"Carter''s sells the SAME body under retailer-exclusive sub-labels: Just One You (Target), Child of Mine (Walmart), Simple Joys (Amazon). They are Carter''s-made and fold onto the Carter''s pack; read the sub-label and don''t treat it as a separate brand. ⚠ Carter''s OWNS OshKosh B''gosh, but a shared parent is NOT a signal — OshKosh keeps its own identity and is NOT folded here."}]$j$::jsonb,
   'Founded 1865 in Massachusetts; the largest US childrenswear brand and a baby-basics staple. The resale core is BABY: the FOOTED / ZIP SLEEPER (cotton, snap or zip, the baby staple), the BODYSUIT MULTIPACK (short/long-sleeve one-piece bodysuits, sold in sets) and cotton/fleece separates. Sold under Carter''s and the retailer sub-labels Just One You (Target), Child of Mine (Walmart) and Simple Joys (Amazon). SIZED IN MONTHS + WEIGHT/HEIGHT for baby, T-sizes for toddler, numeric for kids — see the size charts (THE SYSTEM is the signal). NO RN IS SEEDED (childrenswear is textile, so an RN would be in scope, but none is sourced to a primary FTC record). NO DECODER: the identifier is the garment TYPE, not a code; ⚠ a KIDS SIZE like 24M / 2T IS NOT A STYLE CODE. ⚠ Carter''s owns OshKosh B''gosh but OshKosh is NOT folded (a shared parent is not a signal).',
   'https://www.carters.com/', 0.75, false, 'migration:00473'),

  ('hannaandersson', 'Hanna Andersson',
   ARRAY['hanna andersson','hannaandersson','hanna anderson']::text[],
   ARRAY['baby','pajamas','playwear','organic cotton','matching family pajamas']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Swedish-heritage brand, broadly offshore (modern)","note":"Hanna Andersson is a US brand with Swedish design heritage; modern product is broadly offshore. Country is not a date or authenticity tell — but the SIZING is Swedish/European (height in CM), which is the identifier."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the ORGANIC-COTTON pajamas are the icon","detail":"Hanna Andersson has no per-unit serial and no consumer authentication portal. Grade condition. The signature is the ORGANIC-COTTON zip PAJAMAS (the striped ''long johns'') — a durable, premium knit that comps well used; grade the PILLING, the cuff/ankle stretch, the zip and any fade. ⚠ SIZED BY HEIGHT IN CM (50-150), not US age — read the number off the neck label and translate via the size chart; a mis-read cm size is the most common listing error on this brand."},{"tell":"Matching-family sets comp as SETS","detail":"Hanna''s matching family pajama sets (and the coordinating adult/kid pieces) comp as SETS on the collection — a broken set is worth less. Read whether the listing is a single piece or a coordinated set."}]$j$::jsonb,
   'A US childrenswear brand with Swedish design heritage; known for premium ORGANIC-COTTON basics. The resale core: the ORGANIC-COTTON zip PAJAMAS (the striped ''long johns'' — THE icon), Swedish-heritage PLAYWEAR (leggings, dresses, tops) and the MATCHING FAMILY PAJAMA sets. ⚠ SIZED BY HEIGHT IN CM (50 / 60 / 70 / 80 / 90 / 100 / 110 / 120 / 130 / 140 / 150 = the child''s height in centimetres), a genuinely DIFFERENT AXIS from US age — see the dedicated cm/height size chart. NO RN IS SEEDED (textile, but none sourced). NO DECODER: the identifier is the fabric/product, not a code; ⚠ a KIDS SIZE (a cm number, or 2T) IS NOT A STYLE CODE. TAG ERAS EMPTY ON PURPOSE — a modern-corpus brand with no value-driving vintage label chronology (the athleisure precedent, 00452).',
   'https://www.hannaandersson.com/', 0.72, false, 'migration:00473'),

  ('miniboden', 'Mini Boden',
   ARRAY['mini boden','miniboden','minibodenkids','babyboden','baby boden']::text[],
   ARRAY['baby','dresses','playwear','appliqué tops','british childrenswear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"British brand (design), broadly offshore (production)","note":"Mini Boden is the kids line of the British brand Boden; designed in the UK, produced broadly offshore. Country is not a date or authenticity tell — but the SIZING is British (AGE-YEARS + height cm)."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the APPLIQUÉ / embroidery is the identity","detail":"Mini Boden has no per-unit serial and no consumer authentication portal. Grade condition. The Boden aesthetic is bright APPLIQUÉ and EMBROIDERED dresses/tops in sturdy cotton — grade the appliqué (lifting, missing pieces), the embroidery, the print vibrancy and the seams. Mini Boden is a mid-premium brand that comps above mall basics when the appliqué is intact. ⚠ SIZED BY AGE-YEARS (2-3Y, 3-4Y ...) + height in CM, the British system — read the age label off the tag and translate via the size chart."},{"tell":"⚠ Mini Boden is the KIDS line of Boden — not the adult brand","detail":"''Boden'' alone is the ADULT British brand; the childrenswear line is MINI BODEN (with Baby Boden for the youngest). Read the label — a bare ''Boden'' tag on a kids garment is Mini Boden, but the canonical for the kids line is ''Mini Boden'' and the adult brand is NOT folded onto it."}]$j$::jsonb,
   'The kids line of the British brand Boden (with Baby Boden for the youngest). Known for bright APPLIQUÉ / embroidered dresses and tops in sturdy cotton (the Boden print aesthetic), logo PLAYWEAR and durable basics — a mid-premium brand. ⚠ SIZED BY AGE-YEARS (0-3M, 3-6M ... then 2-3Y, 3-4Y, 4-5Y ...) + HEIGHT in cm, the British system — see the age/height size chart (THE SYSTEM is the signal). NO RN IS SEEDED (textile, but none sourced). NO DECODER: the identifier is the product, not a code; ⚠ a KIDS SIZE (2-3Y, or 24M) IS NOT A STYLE CODE. TAG ERAS EMPTY ON PURPOSE — a modern-corpus brand with no value-driving vintage label chronology (the athleisure precedent, 00452). ⚠ ''Boden'' alone is the ADULT brand; only the ''Mini Boden'' kids forms resolve.',
   'https://www.boden.com/', 0.70, false, 'migration:00473'),

  ('janieandjack', 'Janie and Jack',
   ARRAY['janie and jack','janieandjack','janie & jack','janiejack']::text[],
   ARRAY['baby','special occasion','matching sets','knitwear','layette']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Janie and Jack produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the UPSCALE special-occasion pieces comp higher","detail":"Janie and Jack has no per-unit serial and no consumer authentication portal. Grade condition. J&J is the upscale end of mall childrenswear — dressy special-occasion outfits, coordinated matching sets and fine knitwear at a higher MSRP than Carter''s/Children''s Place. Grade the fabric, the buttons/closures, the knit (pilling, snags) and any stain; a pristine special-occasion set comps well. Identify by the COLLECTION and whether it is a coordinated SET."},{"tell":"Matching sets and layette comp as SETS","detail":"J&J is built around COORDINATED, collection-based sets and layette; a complete matching set is worth more than the sum of the pieces. Read whether the listing is a single item or the full set."}]$j$::jsonb,
   'The upscale end of US mall childrenswear (formerly Janie and Jack by Gymboree, now independent). The resale core: UPSCALE SPECIAL-OCCASION outfits (dressy, collection-based, higher MSRP), fine KNITWEAR and LAYETTE — coordinated, matching SETS are the identity. SIZED IN MONTHS for baby (layette), T-sizes for toddler, numeric for kids — see the size charts (THE SYSTEM is the signal). NO RN IS SEEDED (textile, but none sourced). NO DECODER: the identifier is the collection NAME and the set, not a code; ⚠ a KIDS SIZE (18-24M / 2T) IS NOT A STYLE CODE. TAG ERAS EMPTY ON PURPOSE — a modern-corpus brand with no value-driving vintage label chronology (the athleisure precedent, 00452).',
   'https://www.janieandjack.com/', 0.70, false, 'migration:00473'),

  ('thechildrensplace', 'The Children''s Place',
   ARRAY['the children''s place','thechildrensplace','childrens place','children''s place','childrensplace','tcp','the childrens place']::text[],
   ARRAY['kids','value basics','uniforms','graphic tees','jeans']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"The Children''s Place produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; a high-volume VALUE brand — condition + lot is the value","detail":"The Children''s Place has no per-unit serial and no consumer authentication portal. Grade condition. TCP is high-volume, low-MSRP VALUE basics — uniform polos/chinos, graphic tees, ''Place'' logo activewear and jeans. The value is in condition and the LOT/bundle, not a rare model; grade fade, pilling, graphic cracking (on tees) and the knees (on jeans/pants). Identify by the garment type and the ''Place'' logo."},{"tell":"Uniform basics comp as bundles","detail":"TCP''s school-uniform polos and chinos comp as multi-item bundles by size — read the size run and count. A single value tee has little standalone comp; a size-matched lot does."}]$j$::jsonb,
   'A high-volume US VALUE childrenswear retailer. The resale core: school-UNIFORM polos/chinos, GRAPHIC TEES, ''Place'' logo ACTIVEWEAR and JEANS — high volume, low MSRP. SIZED IN MONTHS + WEIGHT for baby, T-sizes for toddler, numeric (4-16) / alpha (XS-XL) for kids — see the size charts (THE SYSTEM is the signal). ⚠ TCP catalogue "style numbers" are WEB/CATALOGUE SKUs (bare digit runs printed on the hangtag or in the URL), NOT a regular tag-printed brand-unique code — refused (the Chanel rule). NO RN IS SEEDED (textile, but none sourced). NO DECODER: ⚠ a KIDS SIZE (a numeric 4-16, or 4T) IS NOT A STYLE CODE. TAG ERAS EMPTY ON PURPOSE — a modern-corpus brand with no value-driving vintage label chronology (the athleisure precedent, 00452).',
   'https://www.childrensplace.com/', 0.70, false, 'migration:00473'),

  ('gymboree', 'Gymboree',
   ARRAY['gymboree','gymbo','gymboree vintage']::text[],
   ARRAY['kids','vintage collections','matching sets','baby','activewear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Vintage Gymboree collections (collector chronology)","years":"1990s-2000s (approximate)","description":"A GENUINE RESALE-COLLECTOR CHRONOLOGY — the pack''s value nuance. Discontinued ''vintage'' Gymboree lines/collections from the 1990s-2000s (named, matching sets with coordinating accessories) have a devoted collector following and comp WELL ABOVE ordinary modern basics, ON THE COLLECTION/LINE NAME. Older woven labels and the ''Gymboree'' script skew to these collectible eras. This is a coarse collector prior, not a precise dated chart — but unlike the modern-corpus brands in this pack, Gymboree genuinely HAS a vintage market."},{"era":"Modern Gymboree (post-relaunch basics)","years":"2010s-present (approximate)","description":"Modern Gymboree (post-bankruptcy relaunch) is ordinary mall basics + gymgo activewear, and comps as such — distinct from the collectible vintage collections above. Read whether a piece is a named vintage collection or a modern basic."}]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Gymboree produces broadly offshore; country is not a date or authenticity tell — but an older woven label may corroborate a vintage collectible era."}]$j$::jsonb,
   $j$[{"tell":"⚠ VINTAGE Gymboree COLLECTIONS comp on the LINE NAME","detail":"Gymboree has no per-unit serial and no consumer authentication portal. Grade condition — BUT read the ERA first: a discontinued 1990s-2000s vintage COLLECTION (a named, matching set) has a devoted collector following and comps on the COLLECTION/LINE NAME, well above modern basics. Identify the collection name and whether the matching set is complete; a broken vintage set is worth far less. Modern Gymboree is ordinary mall basics."},{"tell":"Grade condition; on modern basics the SET/lot is the value","detail":"For modern (post-relaunch) Gymboree, the value is condition + the size-matched lot, not a rare model — grade fade, pilling, snaps and graphics. ⚠ Gymboree/gymgo catalogue ''style numbers'' are web/catalogue SKUs (bare digit runs), not a tag-printed brand-unique code — refused."}]$j$::jsonb,
   'A US mall childrenswear brand with a distinctive resale profile: ⚠ discontinued VINTAGE COLLECTIONS from the 1990s-2000s (named, matching sets) are COLLECTED and comp on the COLLECTION/LINE NAME, well above ordinary basics — the pack''s value nuance. Modern (post-relaunch) Gymboree is mall basics + gymgo ACTIVEWEAR. SIZED IN MONTHS + WEIGHT for baby, T-sizes for toddler, numeric for kids — see the size charts (THE SYSTEM is the signal). ⚠ Gymboree catalogue "style numbers" are WEB/CATALOGUE SKUs (bare digit runs), NOT a regular tag-printed brand-unique code — refused (the Chanel rule). NO RN IS SEEDED (textile, but none sourced). NO DECODER: ⚠ a KIDS SIZE (24M / 3T) IS NOT A STYLE CODE — the vintage VALUE is the collection NAME, never a code. TAG ERAS DOCUMENTED — a genuine vintage-collector chronology (unlike the four modern-corpus brands in this pack).',
   'https://www.gymboree.com/', 0.70, false, 'migration:00473')
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
-- prompt (US-1740). For this group the highest-value fingerprint is the
-- SILHOUETTE / PRINT / CONSTRUCTION that identifies the garment TYPE (a footed
-- sleeper, an appliqué dress, a vintage matching set) — the identifiers are
-- NAMES, not codes, so the style rows lead with the silhouette.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- Carter's
  ('carters', 'Footed / Zip Sleeper', 'Baby', 'sleeper', 'Baby basics',
   'THE baby staple: a one-piece FOOTED sleeper (footie) in soft cotton or fleece, closing with a full-length ZIP or a row of SNAPS, often with fold-over cuffs and a snap-tab collar. ⚠ Sized in MONTHS (NB, 3M, 6M...) — the size, not a code. Grade the snaps/zip, the foot wear, pilling and stains; sold singly or in multipacks.',
   ARRAY['cotton','fleece']::text[], 'current', '$',
   ARRAY['footed sleeper','footie','zip sleeper','snap','baby','carters']::text[],
   'https://www.carters.com/', 0.70, false, 'migration:00473'),
  ('carters', 'Bodysuit Multipack', 'Baby', 'bodysuit', 'Baby basics',
   'THE one-piece BODYSUIT (short- or long-sleeve), snap-crotch, sold in MULTIPACKS of coordinating colours/prints. The everyday baby layer. ⚠ Sized in MONTHS. Grade the snaps, neckline stretch, pilling and stains; the value is the size-matched SET, not a single piece.',
   ARRAY['cotton']::text[], 'current', '$',
   ARRAY['bodysuit','onesie','multipack','snap crotch','baby','carters']::text[],
   'https://www.carters.com/', 0.70, false, 'migration:00473'),
  ('carters', 'Fleece / Little Baby Basics', 'Baby', 'set', 'Baby basics',
   'Cotton/FLEECE separates and coordinating sets (the ''Little Baby Basics'' staples) — pants, tops, cardigans and pram suits. Grade the fleece pill, the snaps and the fit. Sold as size-matched sets/lots; the value is condition + the bundle.',
   ARRAY['cotton','fleece']::text[], 'current', '$',
   ARRAY['fleece','little baby basics','set','separates','carters']::text[],
   'https://www.carters.com/', 0.60, false, 'migration:00473'),
  ('carters', 'Toddler / Kid Separates', 'Kids', 'top', 'Toddler & kid',
   'Toddler and kid separates (graphic tees, leggings, pull-on pants, PJ sets) in T-sizes (2T-5T) and numeric (4-14). High-volume basics — grade fade, graphic cracking and the knees. The value is condition + the size-matched lot.',
   ARRAY['cotton','jersey']::text[], 'current', '$',
   ARRAY['toddler','tee','leggings','pajama','2t','carters']::text[],
   'https://www.carters.com/', 0.60, false, 'migration:00473'),

  -- Hanna Andersson
  ('hannaandersson', 'Organic Cotton Zip Pajamas', 'Kids', 'pajama', 'Sleep',
   'THE ICON: the ORGANIC-COTTON zip PAJAMAS — the striped ''long johns'' (a two-piece or footless one-piece in a signature multi-stripe), premium heavyweight knit with a full-length zip. ⚠ SIZED BY HEIGHT IN CM (50-150), not US age. Grade the pilling, the cuff/ankle stretch, the zip and any fade — they comp well used.',
   ARRAY['organic cotton']::text[], 'current', '$$',
   ARRAY['pajamas','long johns','striped','organic cotton','zip','hanna andersson']::text[],
   'https://www.hannaandersson.com/', 0.70, false, 'migration:00473'),
  ('hannaandersson', 'Swedish Playwear', 'Kids', 'top', 'Playwear',
   'Swedish-heritage PLAYWEAR: durable organic-cotton leggings, dresses, tops and rompers in bright solids and Scandinavian prints. ⚠ SIZED BY HEIGHT IN CM. Grade the knit (pilling, stretch), the print and the seams; a mid-premium brand that comps above mall basics.',
   ARRAY['organic cotton']::text[], 'current', '$$',
   ARRAY['playwear','leggings','dress','romper','organic cotton','hanna andersson']::text[],
   'https://www.hannaandersson.com/', 0.60, false, 'migration:00473'),
  ('hannaandersson', 'Matching Family Pajamas', 'Unisex', 'pajama', 'Sleep',
   'The MATCHING FAMILY PAJAMA sets: coordinating adult + kid + baby pajamas in a shared print (holiday and seasonal). Comps as a SET on the collection/print — a broken set is worth less. Grade the knit and read whether the listing is a single piece or the coordinated set.',
   ARRAY['organic cotton']::text[], 'current', '$$',
   ARRAY['matching family pajamas','holiday','set','coordinating','hanna andersson']::text[],
   'https://www.hannaandersson.com/', 0.60, false, 'migration:00473'),

  -- Mini Boden
  ('miniboden', 'Appliqué Dress / Top', 'Kids', 'dress', 'Playwear',
   'THE Boden aesthetic: a bright APPLIQUÉ and EMBROIDERED dress or top in sturdy cotton (animals, characters, bold motifs), often with contrast trims. ⚠ SIZED BY AGE-YEARS (2-3Y...) + height cm. Grade the appliqué (lifting, missing pieces), the embroidery, the print vibrancy and the seams — the intact appliqué is the value.',
   ARRAY['cotton']::text[], 'current', '$$',
   ARRAY['applique','embroidered','dress','top','boden print','mini boden']::text[],
   'https://www.boden.com/', 0.65, false, 'migration:00473'),
  ('miniboden', 'Logo Playwear', 'Kids', 'top', 'Playwear',
   'Mini Boden logo PLAYWEAR: sturdy cotton tops, leggings, joggers and rompers in bright solids and Boden prints, with the Mini Boden label. ⚠ SIZED BY AGE-YEARS + height cm. Grade the print, the knit and the seams; a mid-premium British brand.',
   ARRAY['cotton']::text[], 'current', '$$',
   ARRAY['logo','playwear','leggings','jogger','romper','mini boden']::text[],
   'https://www.boden.com/', 0.55, false, 'migration:00473'),
  ('miniboden', 'Baby Boden Layette', 'Baby', 'set', 'Baby',
   'BABY BODEN: the youngest line — appliqué bodysuits, rompers, sleepsuits and coordinating sets in sturdy cotton. ⚠ SIZED BY AGE (0-3M, 3-6M...) + height cm, the British system. Grade the snaps, the appliqué and the fabric; comps as coordinated sets.',
   ARRAY['cotton']::text[], 'current', '$$',
   ARRAY['baby boden','layette','romper','sleepsuit','bodysuit','mini boden']::text[],
   'https://www.boden.com/', 0.55, false, 'migration:00473'),

  -- Janie and Jack
  ('janieandjack', 'Special-Occasion Set', 'Kids', 'set', 'Special occasion',
   'THE upscale identity: a dressy SPECIAL-OCCASION outfit / coordinated matching SET (party dresses, suiting, holiday looks) at a higher MSRP than mall basics. Collection-based — comps as a complete SET. Grade the fabric, the closures and any stain; a pristine set comps well.',
   ARRAY['cotton','satin','wool blend']::text[], 'current', '$$$',
   ARRAY['special occasion','matching set','party dress','suiting','janie and jack']::text[],
   'https://www.janieandjack.com/', 0.65, false, 'migration:00473'),
  ('janieandjack', 'Fine Knitwear', 'Kids', 'sweater', 'Knitwear',
   'Fine KNITWEAR: sweaters, cardigans and knit sets in soft cotton/blend, often with detailed stitch or motif. Grade the knit (pilling, snags, holes), the buttons and the fit. A mid-to-upscale piece that comps above mall knitwear.',
   ARRAY['cotton','wool blend']::text[], 'current', '$$',
   ARRAY['knitwear','sweater','cardigan','janie and jack']::text[],
   'https://www.janieandjack.com/', 0.55, false, 'migration:00473'),
  ('janieandjack', 'Layette', 'Baby', 'set', 'Layette',
   'LAYETTE: newborn coordinated sets — footies, gowns, bodysuits and matching accessories (hats, booties) in fine cotton. ⚠ Sized in MONTHS. Grade the snaps, the fabric and any stain; comps as a complete coordinated set.',
   ARRAY['cotton']::text[], 'current', '$$',
   ARRAY['layette','newborn','footie','gown','set','janie and jack']::text[],
   'https://www.janieandjack.com/', 0.55, false, 'migration:00473'),

  -- The Children's Place
  ('thechildrensplace', 'Uniform Polo / Chino', 'Kids', 'polo', 'Uniforms',
   'School-UNIFORM basics: piqué POLOS and twill CHINOS in uniform colours (navy, khaki, white), high volume and low MSRP. Grade fade, collar wear and the knees (chinos). Comps as size-matched BUNDLES, not single pieces — read the size run and count.',
   ARRAY['cotton piqué','twill']::text[], 'current', '$',
   ARRAY['uniform','polo','chino','school','childrens place','tcp']::text[],
   'https://www.childrensplace.com/', 0.65, false, 'migration:00473'),
  ('thechildrensplace', 'Graphic Tee', 'Kids', 'tee', 'Basics',
   'Value GRAPHIC TEES and ''Place'' logo tops — high-volume jersey with printed graphics/licenses. Grade the graphic (cracking, fade), pilling and the neckline. A single tee has little standalone comp; a size-matched lot does.',
   ARRAY['jersey cotton']::text[], 'current', '$',
   ARRAY['graphic tee','place logo','value','childrens place','tcp']::text[],
   'https://www.childrensplace.com/', 0.60, false, 'migration:00473'),
  ('thechildrensplace', 'Place Activewear', 'Kids', 'top', 'Activewear',
   '''Place'' logo ACTIVEWEAR: value joggers, leggings, hoodies and performance tees. Grade the fabric (pill, fade), the elastic and the logo. High-volume basics — the value is condition + the bundle.',
   ARRAY['polyester','jersey']::text[], 'current', '$',
   ARRAY['activewear','jogger','legging','hoodie','place','childrens place']::text[],
   'https://www.childrensplace.com/', 0.55, false, 'migration:00473'),
  ('thechildrensplace', 'Kid / Toddler Jeans', 'Kids', 'jeans', 'Denim',
   'Value JEANS in kid/toddler cuts (skinny, straight, bootcut) with adjustable waist tabs. ⚠ Sized numeric (4-16) / T-sizes; a numeric size is NOT a code. Grade the knees, the wash fade, the adjustable-waist elastic and the hardware.',
   ARRAY['denim']::text[], 'current', '$',
   ARRAY['jeans','denim','adjustable waist','childrens place','tcp']::text[],
   'https://www.childrensplace.com/', 0.55, false, 'migration:00473'),

  -- Gymboree
  ('gymboree', 'Vintage Collection (Matching Set)', 'Kids', 'set', 'Vintage collections',
   '⚠ THE COLLECTOR DRIVER: a discontinued 1990s-2000s VINTAGE COLLECTION — a named, matching SET (dress/top + bottom + coordinating accessories) in a themed print. Comps on the COLLECTION/LINE NAME, well ABOVE modern basics, when the set is COMPLETE. Read the collection name and whether the set is broken; older woven labels corroborate the era.',
   ARRAY['cotton']::text[], '1990s-2000s', '$$',
   ARRAY['vintage','collection','matching set','line name','collector','gymboree']::text[],
   'https://www.gymboree.com/', 0.60, false, 'migration:00473'),
  ('gymboree', 'Modern Basics', 'Kids', 'top', 'Basics',
   'Modern (post-relaunch) Gymboree basics: tees, leggings, dresses and PJ sets in bright prints. Ordinary mall basics — the value is condition + the size-matched lot, NOT a rare model. Grade fade, pilling, snaps and graphics. Distinct from the collectible vintage collections.',
   ARRAY['cotton','jersey']::text[], 'current', '$',
   ARRAY['modern','basics','tee','leggings','dress','gymboree']::text[],
   'https://www.gymboree.com/', 0.55, false, 'migration:00473'),
  ('gymboree', 'Gymgo Activewear', 'Kids', 'top', 'Activewear',
   'The GYMGO activewear line: performance leggings, joggers and tees in stretch fabric. Grade the fabric (pill, fade), the elastic and the logo. A modern basics line — the value is condition + the bundle.',
   ARRAY['polyester','stretch jersey']::text[], 'current', '$',
   ARRAY['gymgo','activewear','legging','jogger','gymboree']::text[],
   'https://www.gymboree.com/', 0.55, false, 'migration:00473')
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
-- ZERO COLORWAYS ARE SEEDED FOR THE WHOLE GROUP, DELIBERATELY. Kids brands ship
-- ordinary descriptive SEASONAL colours and LICENSED prints; none prints a stable,
-- proprietary NAMED palette that recurs for years and is searched BY NAME (the
-- 00456/00462 rule; the Fjällräven Kånken / UGG Chestnut bar is what a palette
-- must clear). So there is NO brand_colorways insert here — colorways zero, by
-- design, not by omission.

-- ── brand_style_codes ──────────────────────────────────────────────────────
-- ZERO STYLE CODES / DECODERS, DELIBERATELY. NO decoder clears the bar for this
-- group — see the header. Gymboree / The Children's Place catalogue "style
-- numbers" are web/catalogue SKUs (bare digit runs, the Chanel rule), and ⚠ A
-- KIDS SIZE IS NOT A STYLE CODE (24M / 4T is the size, captured by the charts
-- below). Every candidate is fixtured as a REFUSAL in
-- brand-knowledge-golden_test.ts. So there is NO brand_style_codes insert here.

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- Mirrored 1:1 into services/edge-functions/src/lib/sizing-charts.ts (the
-- in-code fallback). formatSizingChartsForPrompt renders labels + note IN FULL
-- (US-1740), so the SYSTEM caveat lives in the note. THE SYSTEM is the signal and
-- it is NOT one system: BABY = MONTHS ↔ WEIGHT ↔ HEIGHT; TODDLER = T-sizes; KIDS =
-- numeric / alpha; and HANNA ANDERSSON = HEIGHT IN CM (a different axis). These
-- are TRANSLATORS. Body-equivalent approximations, not brand-published specs —
-- hence the modest confidence.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  -- Carter's — BABY (months ↔ weight ↔ height) + Toddler/Kids.
  ('carters', 'Carter''s', ARRAY['carter''s','carters']::text[], 'Baby',
   'Baby (MONTHS ↔ weight ↔ height)',
   ARRAY['bodysuit','onesie','sleeper','footie','footed','romper','pajama','coverall','layette','one-piece','bib','baby']::text[],
   $j$[{"size":"Preemie (months system)","measurements":{"weight":"up to 6 lb","height":"up to 17 in"}},{"size":"Newborn / NB","measurements":{"weight":"6-9 lb","height":"17-21.5 in"}},{"size":"3M (0-3M)","measurements":{"weight":"9-12.5 lb","height":"21.5-24 in"}},{"size":"6M (3-6M)","measurements":{"weight":"12.5-16.5 lb","height":"24-26.5 in"}},{"size":"9M (6-9M)","measurements":{"weight":"16.5-20.5 lb","height":"26.5-28.5 in"}},{"size":"12M (9-12M)","measurements":{"weight":"20.5-24 lb","height":"28.5-30.5 in"}},{"size":"18M (12-18M)","measurements":{"weight":"24-27 lb","height":"30.5-32.5 in"}},{"size":"24M / 2T (18-24M)","measurements":{"weight":"27-30 lb","height":"32.5-34 in"}}]$j$::jsonb,
   'BABY IS SIZED IN MONTHS — but a baby is fitted by WEIGHT + HEIGHT, and the month label is only a proxy, so THE SYSTEM is months ↔ weight ↔ height (read all three off the tag). ⚠ A KIDS SIZE (24M / 2T) IS THE SIZE, NOT A CODE. Carter''s baby is high-volume basics; grade snaps/zips, pilling and stains, and value the size-matched SET. Body-equivalent approximations, not brand-published specs.',
   'https://www.carters.com/', 0.55, false, 'migration:00473'),
  ('carters', 'Carter''s', ARRAY['carter''s','carters']::text[], 'Kids',
   'Toddler & Kids (2T-5T ↔ numeric 4-16 / XS-XL)',
   ARRAY['tee','shirt','top','pant','pants','legging','short','hoodie','jacket','sweater','pajama','dress','skirt','jeans','uniform','polo','toddler','kid']::text[],
   $j$[{"size":"2T","measurements":{"height":"33-35 in","weight":"29-31 lb","chest":"21"}},{"size":"3T","measurements":{"height":"36-38.5 in","weight":"32-34 lb","chest":"22"}},{"size":"4T / 4 (XS)","measurements":{"height":"39-41 in","weight":"35-39 lb","chest":"23"}},{"size":"5T / 5 (S)","measurements":{"height":"42-44 in","weight":"40-45 lb","chest":"24"}},{"size":"6 / 6X","measurements":{"height":"45-47.5 in","weight":"46-53 lb","chest":"25.5"}},{"size":"7-8 (M)","measurements":{"height":"48-52 in","weight":"54-65 lb","chest":"27"}},{"size":"10-12 (L)","measurements":{"height":"53-58 in","weight":"66-90 lb","chest":"29-30"}},{"size":"14-16 (XL)","measurements":{"height":"59-63 in","weight":"91-115 lb","chest":"32-33"}}]$j$::jsonb,
   'TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-16) or ALPHA (XS-XL) — a DIFFERENT system from baby months, and the SAME numeric label means different garments across brands, so read the SYSTEM off the label. ⚠ A KIDS SIZE (4T / 10-12) IS THE SIZE, NOT A CODE. Body-equivalent approximations, not brand-published specs.',
   'https://www.carters.com/', 0.55, false, 'migration:00473'),

  -- Janie and Jack — BABY (layette, months) + Kids.
  ('janieandjack', 'Janie and Jack', ARRAY['janie and jack','janieandjack','janie & jack']::text[], 'Baby',
   'Baby / Layette (MONTHS ↔ weight ↔ height)',
   ARRAY['bodysuit','onesie','sleeper','footie','romper','layette','gown','set','coverall','baby','pajama']::text[],
   $j$[{"size":"Newborn / NB","measurements":{"weight":"6-9 lb","height":"17-21.5 in"}},{"size":"3M (0-3M)","measurements":{"weight":"9-12.5 lb","height":"21.5-24 in"}},{"size":"6M (3-6M)","measurements":{"weight":"12.5-16.5 lb","height":"24-26.5 in"}},{"size":"12M (6-12M)","measurements":{"weight":"16.5-22 lb","height":"26.5-29 in"}},{"size":"18M (12-18M)","measurements":{"weight":"22-27 lb","height":"29-32 in"}},{"size":"24M / 2T (18-24M)","measurements":{"weight":"27-30 lb","height":"32-34 in"}}]$j$::jsonb,
   'BABY / LAYETTE IS SIZED IN MONTHS, fitted by WEIGHT + HEIGHT — THE SYSTEM is months ↔ weight ↔ height. ⚠ A KIDS SIZE (18-24M / 2T) IS THE SIZE, NOT A CODE. Janie and Jack layette comps as coordinated SETS; grade the snaps, fabric and any stain. Body-equivalent approximations, not brand-published specs.',
   'https://www.janieandjack.com/', 0.55, false, 'migration:00473'),
  ('janieandjack', 'Janie and Jack', ARRAY['janie and jack','janieandjack','janie & jack']::text[], 'Kids',
   'Toddler & Kids (2T-5T ↔ numeric 4-16)',
   ARRAY['dress','top','shirt','pant','pants','sweater','cardigan','skirt','short','suit','set','knit','toddler','kid']::text[],
   $j$[{"size":"2T","measurements":{"height":"33-35 in","weight":"29-31 lb","chest":"21"}},{"size":"3T","measurements":{"height":"36-38.5 in","weight":"32-34 lb","chest":"22"}},{"size":"4T / 4","measurements":{"height":"39-41 in","weight":"35-39 lb","chest":"23"}},{"size":"5 / 5T","measurements":{"height":"42-44 in","weight":"40-45 lb","chest":"24"}},{"size":"6-7","measurements":{"height":"45-49 in","weight":"46-58 lb","chest":"25.5-26.5"}},{"size":"8-10","measurements":{"height":"50-56 in","weight":"59-80 lb","chest":"27-29"}},{"size":"12","measurements":{"height":"57-59 in","weight":"81-95 lb","chest":"30-31"}}]$j$::jsonb,
   'TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-12) — a DIFFERENT system from baby months. Read the SYSTEM off the label. ⚠ A KIDS SIZE IS THE SIZE, NOT A CODE. J&J special-occasion pieces comp as coordinated SETS. Body-equivalent approximations, not brand-published specs.',
   'https://www.janieandjack.com/', 0.55, false, 'migration:00473'),

  -- The Children's Place — BABY (months) + Kids (numeric / alpha).
  ('thechildrensplace', 'The Children''s Place', ARRAY['the children''s place','children''s place','childrens place','thechildrensplace']::text[], 'Baby',
   'Baby (MONTHS ↔ weight ↔ height)',
   ARRAY['bodysuit','onesie','sleeper','footie','romper','pajama','coverall','layette','one-piece','baby']::text[],
   $j$[{"size":"Newborn / NB","measurements":{"weight":"6-9 lb","height":"17-21.5 in"}},{"size":"3M (0-3M)","measurements":{"weight":"9-12.5 lb","height":"21.5-24 in"}},{"size":"6M (3-6M)","measurements":{"weight":"12.5-16.5 lb","height":"24-26.5 in"}},{"size":"9M (6-9M)","measurements":{"weight":"16.5-20.5 lb","height":"26.5-28.5 in"}},{"size":"12M (9-12M)","measurements":{"weight":"20.5-24 lb","height":"28.5-30.5 in"}},{"size":"18M (12-18M)","measurements":{"weight":"24-27 lb","height":"30.5-32.5 in"}},{"size":"24M / 2T (18-24M)","measurements":{"weight":"27-30 lb","height":"32.5-34 in"}}]$j$::jsonb,
   'BABY IS SIZED IN MONTHS, fitted by WEIGHT + HEIGHT — THE SYSTEM is months ↔ weight ↔ height. ⚠ A KIDS SIZE (24M / 2T) IS THE SIZE, NOT A CODE. TCP is high-volume VALUE basics; grade snaps, fade and pilling, and value the size-matched lot. Body-equivalent approximations, not brand-published specs.',
   'https://www.childrensplace.com/', 0.55, false, 'migration:00473'),
  ('thechildrensplace', 'The Children''s Place', ARRAY['the children''s place','children''s place','childrens place','thechildrensplace']::text[], 'Kids',
   'Toddler & Kids (2T-5T ↔ numeric 4-16 / XS-XL)',
   ARRAY['tee','shirt','top','pant','pants','legging','short','hoodie','jacket','jeans','polo','chino','uniform','activewear','jogger','dress','skirt','toddler','kid']::text[],
   $j$[{"size":"2T","measurements":{"height":"33-35 in","weight":"29-31 lb","chest":"21"}},{"size":"3T","measurements":{"height":"36-38.5 in","weight":"32-34 lb","chest":"22"}},{"size":"4T / 4 (XS)","measurements":{"height":"39-41 in","weight":"35-39 lb","chest":"23"}},{"size":"5 / 5T (S)","measurements":{"height":"42-44 in","weight":"40-45 lb","chest":"24"}},{"size":"6-7 (S)","measurements":{"height":"45-49 in","weight":"46-58 lb","chest":"25.5-26.5"}},{"size":"8 (M)","measurements":{"height":"50-52 in","weight":"59-65 lb","chest":"27"}},{"size":"10-12 (L)","measurements":{"height":"53-58 in","weight":"66-90 lb","chest":"28-30"}},{"size":"14-16 (XL)","measurements":{"height":"59-63 in","weight":"91-115 lb","chest":"31-33"}}]$j$::jsonb,
   'TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-16) or ALPHA (XS-XL) — a DIFFERENT system from baby months, and the SAME numeric label differs across brands, so read the SYSTEM off the label. ⚠ A KIDS SIZE (4T / 10-12) IS THE SIZE, NOT A CODE. Uniform basics comp as size-matched bundles. Body-equivalent approximations, not brand-published specs.',
   'https://www.childrensplace.com/', 0.55, false, 'migration:00473'),

  -- Gymboree — BABY (months) + Kids.
  ('gymboree', 'Gymboree', ARRAY['gymboree']::text[], 'Baby',
   'Baby (MONTHS ↔ weight ↔ height)',
   ARRAY['bodysuit','onesie','sleeper','footie','romper','pajama','coverall','set','one-piece','baby']::text[],
   $j$[{"size":"Newborn / NB","measurements":{"weight":"6-9 lb","height":"17-21.5 in"}},{"size":"3M (0-3M)","measurements":{"weight":"9-12.5 lb","height":"21.5-24 in"}},{"size":"6M (3-6M)","measurements":{"weight":"12.5-16.5 lb","height":"24-26.5 in"}},{"size":"12M (6-12M)","measurements":{"weight":"16.5-22 lb","height":"26.5-29 in"}},{"size":"18M (12-18M)","measurements":{"weight":"22-27 lb","height":"29-32 in"}},{"size":"24M / 2T (18-24M)","measurements":{"weight":"27-30 lb","height":"32-34 in"}}]$j$::jsonb,
   'BABY IS SIZED IN MONTHS, fitted by WEIGHT + HEIGHT — THE SYSTEM is months ↔ weight ↔ height. ⚠ A KIDS SIZE (24M / 2T) IS THE SIZE, NOT A CODE. ⚠ For VINTAGE Gymboree the value is the COLLECTION/LINE NAME, not the size. Body-equivalent approximations, not brand-published specs.',
   'https://www.gymboree.com/', 0.55, false, 'migration:00473'),
  ('gymboree', 'Gymboree', ARRAY['gymboree']::text[], 'Kids',
   'Toddler & Kids (2T-5T ↔ numeric 4-14)',
   ARRAY['tee','shirt','top','pant','pants','legging','short','hoodie','dress','skirt','jeans','activewear','gymgo','jogger','set','toddler','kid']::text[],
   $j$[{"size":"2T","measurements":{"height":"33-35 in","weight":"29-31 lb","chest":"21"}},{"size":"3T","measurements":{"height":"36-38.5 in","weight":"32-34 lb","chest":"22"}},{"size":"4T / 4","measurements":{"height":"39-41 in","weight":"35-39 lb","chest":"23"}},{"size":"5 / 5T","measurements":{"height":"42-44 in","weight":"40-45 lb","chest":"24"}},{"size":"6-7","measurements":{"height":"45-49 in","weight":"46-58 lb","chest":"25.5-26.5"}},{"size":"8-10","measurements":{"height":"50-56 in","weight":"59-80 lb","chest":"27-29"}},{"size":"12-14","measurements":{"height":"57-61 in","weight":"81-105 lb","chest":"30-32"}}]$j$::jsonb,
   'TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-14) — a DIFFERENT system from baby months. Read the SYSTEM off the label. ⚠ A KIDS SIZE IS THE SIZE, NOT A CODE — and for a VINTAGE Gymboree COLLECTION the value is the LINE NAME, never a number. Body-equivalent approximations, not brand-published specs.',
   'https://www.gymboree.com/', 0.55, false, 'migration:00473'),

  -- Hanna Andersson — THE STANDOUT: sized by HEIGHT IN CM, a different axis.
  ('hannaandersson', 'Hanna Andersson', ARRAY['hanna andersson','hannaandersson']::text[], 'Kids',
   'Baby & Kids (HEIGHT IN CM ↔ US age)',
   ARRAY['pajama','sleeper','bodysuit','dress','top','tee','pant','legging','romper','onesie','footie','long johns','playwear','baby','kid']::text[],
   $j$[{"size":"50 cm (US Newborn / 0-3M)","measurements":{"height":"up to 21.5 in","usAge":"NB / 0-3M"}},{"size":"60 cm (US 3-6M)","measurements":{"height":"21.5-24 in","usAge":"3-6M"}},{"size":"70 cm (US 6-12M)","measurements":{"height":"24-28 in","usAge":"6-12M"}},{"size":"80 cm (US 12-18M)","measurements":{"height":"28-31 in","usAge":"12-18M"}},{"size":"90 cm (US 18-24M / 2T)","measurements":{"height":"31-35 in","usAge":"18-24M / 2T"}},{"size":"100 cm (US 3T)","measurements":{"height":"35-39 in","usAge":"3T"}},{"size":"110 cm (US 4-5)","measurements":{"height":"39-43 in","usAge":"4-5"}},{"size":"120 cm (US 6-7)","measurements":{"height":"43-47 in","usAge":"6-7"}},{"size":"130 cm (US 8)","measurements":{"height":"47-51 in","usAge":"8"}},{"size":"140 cm (US 10)","measurements":{"height":"51-55 in","usAge":"10"}},{"size":"150 cm (US 12)","measurements":{"height":"55-59 in","usAge":"12"}}]$j$::jsonb,
   'HANNA ANDERSSON SIZES BY HEIGHT IN CM, not US age — 50 / 60 / 70 / 80 / 90 / 100 / 110 / 120 / 130 / 140 / 150 = the child''s HEIGHT in centimetres, a genuinely DIFFERENT AXIS from the US months/T/numeric systems. THE SYSTEM is the signal: read the cm number off the neck label and translate to US age via this chart (90 cm ≈ US 2T, 110 cm ≈ US 4-5, 130 cm ≈ US 8). A mis-read cm size is the most common listing error on this brand. Body-equivalent approximations, not brand-published specs.',
   'https://www.hannaandersson.com/', 0.55, false, 'migration:00473'),

  -- Mini Boden — British AGE-YEARS + height cm.
  ('miniboden', 'Mini Boden', ARRAY['mini boden','miniboden','baby boden']::text[], 'Kids',
   'Baby & Kids (AGE-YEARS ↔ height cm, British)',
   ARRAY['dress','top','tee','pant','legging','romper','bodysuit','onesie','sleeper','sleepsuit','applique','playsuit','short','jumper','baby','kid']::text[],
   $j$[{"size":"0-3M (up to 62 cm)","measurements":{"height":"up to 24 in","age":"0-3 months"}},{"size":"3-6M (62-68 cm)","measurements":{"height":"24-27 in","age":"3-6 months"}},{"size":"6-12M (68-80 cm)","measurements":{"height":"27-31 in","age":"6-12 months"}},{"size":"12-18M (80-86 cm)","measurements":{"height":"31-34 in","age":"12-18 months"}},{"size":"18-24M (86-92 cm)","measurements":{"height":"34-36 in","age":"18-24 months"}},{"size":"2-3Y (92-98 cm)","measurements":{"height":"36-39 in","age":"2-3 years"}},{"size":"3-4Y (98-104 cm)","measurements":{"height":"39-41 in","age":"3-4 years"}},{"size":"4-5Y (104-110 cm)","measurements":{"height":"41-43 in","age":"4-5 years"}},{"size":"5-6Y (110-116 cm)","measurements":{"height":"43-46 in","age":"5-6 years"}},{"size":"7-8Y (122-128 cm)","measurements":{"height":"48-50 in","age":"7-8 years"}},{"size":"9-10Y (134-140 cm)","measurements":{"height":"53-55 in","age":"9-10 years"}}]$j$::jsonb,
   'MINI BODEN IS BRITISH — SIZED BY AGE-YEARS (0-3M, 3-6M ... then 2-3Y, 3-4Y, 4-5Y ...) + HEIGHT in cm, a DIFFERENT system from the US months/T/numeric axis. THE SYSTEM is the signal: read the age-band off the tag (a "2-3Y" label is an AGE, not a US size) and use the height cm to translate. ⚠ A KIDS SIZE (2-3Y / 24M) IS THE SIZE, NOT A CODE. Body-equivalent approximations, not brand-published specs.',
   'https://www.boden.com/', 0.55, false, 'migration:00473')
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
insert into public.applied_migrations (version) values ('00473') on conflict do nothing;
