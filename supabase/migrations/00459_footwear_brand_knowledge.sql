-- US-1740: Footwear (apparel-adjacent) brand knowledge group (7 brands, 7 rows).
--
-- New Balance, Dr. Martens, UGG, Birkenstock, Converse, Vans, Cole Haan.
--
-- WHAT MAKES THIS GROUP DIFFERENT FROM EVERY PRIOR ONE: THE SIZE IS NOT
-- MEASURABLE — IT IS STAMPED. This is the first non-garment pack in the epic and
-- the distinction is not cosmetic, it INVERTS what a size chart is for.
--
-- Every prior group's charts turn a MEASUREMENT into a size: measure the bust
-- across the underarm seam, double it, read off the row. That whole procedure is
-- unavailable here. You cannot measure a shoe's size off a photo — the number is
-- STAMPED on the insole, the tongue label or the outsole, and reading it is an
-- OCR job, not a tape-measure job. So the chart's purpose changes completely:
--
--     PRIOR GROUPS:  measurement -> size          (an ESTIMATOR)
--     THIS GROUP:    the brand's number -> every other brand's number
--                                                 (a TRANSLATOR)
--
-- Which is exactly why the story note puts "US/UK/EU cross-maps are the priority"
-- ahead of decoders. The cross-map IS the product here.
--
-- AND THE NUMBER IS IN A SYSTEM THE TAG DOES NOT NAME. This is the single
-- highest-value fact in the pack, and it is worth more than everything else in it
-- combined:
--
--     A Dr. Martens stamped "7"  is a UK 7  = US MEN'S 8  = US WOMEN'S 9.
--     A Birkenstock stamped "38" is an EU 38 = US WOMEN'S 7-7.5.
--
-- Neither shoe says "UK" or "EU" anywhere on it. A seller reads "7", lists a US 7,
-- and has mis-sized the boot by a full size — a guaranteed return, and one the
-- seller has no way to detect. That is not a pricing refinement like the last three
-- groups' era/line traps. It is a WRONG LISTING, and no amount of photo reasoning
-- fixes it, because the photo is not wrong: the shoe really does say 7.
--
-- THE SIZE-SYSTEM MAP (the pack's reason to exist):
--
--     Dr. Martens    UK       — unisex, whole UK sizes only, no half sizes.
--     Birkenstock    EU       — whole EU sizes only, no half sizes.
--     New Balance    US       — plus a WIDTH letter that is part of the product.
--     UGG            US       — runs LARGE.
--     Converse       US       — dual-tagged M/W, offset TWO, runs LARGE.
--     Vans           US       — dual-tagged M/W, offset ONE AND A HALF.
--     Cole Haan      US       — plus widths.
--
-- CONVERSE AND VANS ARE THE SAME SHOE AND DO NOT SIZE THE SAME, which is this
-- group's quiet trap and the one most likely to be got wrong by a confident model.
-- Both are black canvas lace-ups at the same price band from the same shelf, and
-- both dual-tag men's AND women's on one label. The offsets are DIFFERENT:
--
--     Converse M8  =  W10     (offset 2)
--     Vans     M8  =  W9.5    (offset 1.5)
--
-- There is no way to reason this out from a photo, and the two brands are adjacent
-- enough that a model that learns one will apply it to the other. Both offsets are
-- written into the size labels themselves rather than left to a note.
--
-- THE WIDTH LETTER MEANS DIFFERENT THINGS BY DEPARTMENT — New Balance's specific
-- trap and a genuinely nasty one, because the same character is correct in both
-- readings:
--
--     "D"  on a MEN'S New Balance   = STANDARD width.
--     "D"  on a WOMEN'S New Balance = WIDE.
--
-- So "New Balance 990 D" is either an ordinary shoe or a wide-fitting one, and only
-- the department decides. Width is not a footnote on this brand — it is part of the
-- product and part of what a buyer searches, and a D-width women's shoe listed as
-- plain is a return.
--
-- ONE DECODER — New Balance, and it is the first in this epic to capture a SECOND
-- field beyond the brand. The story note asks for it by name ("New Balance model
-- numbers; coordinate with resolveStyleCode()") and it passes all three tests:
--
--     printed?      YES — on the tongue label and the box, as the product's name.
--     regular?      YES — [MWU] + 3-4 digits + optional suffix (M990GL6, W574).
--     brand-unique? YES — because of the PREFIX LETTER. A bare "990" is three
--                   digits and is nothing; "M990" is a New Balance model number.
--                   The prefix is what earns this decoder.
--
-- It captures gender from that prefix (M->Men, W->Women) as well as the style code
-- — the first decoder here to fill two fields. "U" (unisex) deliberately matches
-- but does NOT capture: unisex is not a gender, and writing "U" into the gender
-- field would be worse than leaving it empty.
--
-- DR. MARTENS GETS NO DECODER, AND THAT IS THE PACK'S HARDEST REFUSAL. Its article
-- numbers — 1460, 1461, 2976 — are the most famous numbers in footwear, they are
-- genuinely printed on the tag, and they are a genuinely regular closed set. They
-- fail brand-unique anyway, and the reason is exactly the New Balance reason read
-- backwards: THEY HAVE NO PREFIX. "1460" is four digits. Four digits is not a
-- brand — it is a year, a lot number, a price, a Levi's cut code. The decoder that
-- would recover a cut-tag DM boot would also rebrand anything with a 4-digit number
-- on it, and the whole point of this epic is that a confident wrong answer costs
-- more than no answer. The numbers ship as brand_styles, where they identify the
-- PIECE and never the brand.
--
-- FOUR COLORWAYS BRANDS — the first colorways in FOUR groups, and the drought
-- breaking here is not a coincidence. 00456/00457/00458 seeded none: their colours
-- are seasonal English words ("Ivory", "Sage", "Heather Grey"), which are nothing
-- to seed. Footwear is the opposite by nature — a shoe ships in a small, STABLE,
-- named palette that is reissued for decades and that buyers search by name:
--
--     UGG "Chestnut"          — the colour the brand is known by.
--     Dr. Martens "Cherry Red" — an oxblood, and not a red.
--     Birkenstock "Habana"    — a dark brown, and not a Spanish word to translate.
--
-- These are the proprietary names this table exists for. They are seeded at modest
-- confidence and verified=false: they are the kind of fact the US-1715 queue is
-- for. Uniqlo's colour NUMBER stayed out of 00458 because a mis-decoded mapping is
-- silent; a NAMED colourway is checkable by eye, so it can ship for review.
--
-- CROSS-BRAND / CORPORATE MAP:
--   * NIKE OWNS CONVERSE. A Nike corporate mark inside a Chuck Taylor is ORDINARY
--     provenance and is NOT a counterfeit signal — and NOT a reason to fold: it is
--     separately branded, separately searched, and keeps its own canonical.
--   * VF CORP owns Vans (and The North Face, 00453). Same note.
--   * DECKERS owns UGG. Same note.
--   * "UGG" IS A CONTESTED GENERIC. In Australia "ugg boot" is a generic term for
--     a sheepskin boot and is made by many makers; in the US "UGG" is Deckers'
--     trademark. So an Australian-made sheepskin boot marked "ugg" is genuinely
--     NOT this brand. See the UGG row — this is the pack's Gap-grade token problem.
--   * "VANS" IS AN ORDINARY ENGLISH PLURAL. See the Vans row.
--
-- PLURALIZATION IS THE FOOTWEAR NORM and it interacts with the two matchers
-- DIFFERENTLY — a real asymmetry this group is the first to surface. Shoes are worn
-- and named in pairs: "UGGs", "Vans", "Birks", "Docs", "Chucks". findSizingCharts'
-- brandTextMatches is LEADING-boundary only (00457), so "uggs" DOES reach UGG's
-- charts. detectBrandInText is bounded on BOTH sides, so "UGGs" does NOT resolve
-- there. That asymmetry is CORRECT and must not be "fixed": the trailing boundary
-- is what stops "Gap" firing on "gaps", and rebranding every "gaps" is a worse bug
-- than missing a plural in a barcode title. The plural is handled where it is safe
-- instead — as an alias KEY (an exact whole-field lookup) in brand-normalize.ts.
--
-- NEVER AUTO-AUTHENTICATE — the epic's hard line, and footwear raises the stakes:
-- UGG and Dr. Martens are two of the most counterfeited products in this entire
-- knowledge base. That raises the stakes and does not change the stance. Flag
-- inconsistencies in condition notes and stop.
--
-- Data-only. Every fact carries source_url + confidence and lands verified=false
-- for the US-1715 admin verify queue. Idempotent throughout.

-- ── brand_knowledge ─────────────────────────────────────────────────────────

-- New Balance (row EXISTS from 00389, alias-only — this fills it). The one brand
-- in the pack with a decoder, and the only one where WIDTH is part of the product.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('newbalance', 'New Balance',
  ARRAY['newbalance','newbalances','nb']::text[],
  ARRAY['footwear','sneakers','running','lifestyle','athletic']::text[],
  $j$[{"era":"Made in USA / Made in England","years":"ongoing","description":"New Balance runs domestic MADE IN USA (the 990/993/992 family) and MADE IN ENGLAND (the 1500/577 family) lines at a materially higher spec and price band than the same-numbered imported product. The origin is printed on the tongue label, the box and the shoe. This is a LINE fact, not an era, and it is the most common silent mis-comp on the brand — a Made in USA 990 and an imported 990-family shoe are not the same money."},{"era":"990 series versioning","years":"1982-present","description":"The 990 has run through numbered versions (990v1 through v6). The version is part of the product and part of what buyers search; it is printed on the box and often on the tongue label. Versions are NOT interchangeable in price — early versions and the original are collectible. The version is not reliably readable from a photo."},{"era":"Grey Days / heritage grey","years":"ongoing","description":"New Balance's signature heritage grey colourway is a long-running brand identity the company markets deliberately. Informational and price-relevant on the Made in USA lines; not an authenticity test and not a date."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a New Balance item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE WIDTH LETTER MEANS DIFFERENT THINGS BY DEPARTMENT","detail":"THE New Balance call, and a genuinely nasty one because the same character is CORRECT in both readings. On MEN'S New Balance, D is the STANDARD width (B narrow, 2E wide, 4E extra wide). On WOMEN'S New Balance, B is the STANDARD width and D is WIDE (2A narrow, 2E extra wide). So a 'D' width is an ordinary men's shoe and a WIDE women's shoe, and only the department decides which. Width is not a footnote on this brand — it is part of the product, it is stamped on the tongue label beside the size, and it is what a buyer with a wide foot searches. A women's D listed as plain is a return. Read the department AND the width letter together; never carry one department's reading onto the other."},{"tell":"THE MODEL NUMBER'S PREFIX LETTER IS WHAT IDENTIFIES THE BRAND","detail":"New Balance model numbers are [M|W|U] + 3-4 digits + an optional colour/version suffix (M990GL6, W574, U327). The PREFIX is the whole tell: a bare '990' is three digits and is nothing, while 'M990' can only be a New Balance model number. The prefix also encodes the department (M = men's, W = women's, U = unisex), so it recovers the brand AND the gender from a tongue label alone even when the box is long gone. Note the digits alone must NEVER be read as a brand."},{"tell":"MADE IN USA / MADE IN ENGLAND IS A DIFFERENT PRODUCT AT A DIFFERENT PRICE","detail":"CRITICAL and the brand's biggest silent mis-comp. The domestic Made in USA (990/993/992) and Made in England (1500/577) lines are built to a higher spec and sell in a materially higher band than the imported product — and the origin is printed on the tongue label, the box and the shoe. It is a LINE, not an era. It FOLDS onto the brand 'New Balance' (there is no separate eBay catalogue brand), so the style is the only place the distinction can survive into a listing. If the label says Made in USA, say so."},{"tell":"THE SIZE IS STAMPED, NOT MEASURED","detail":"CROSS-CUTTING — true of every brand in this footwear group and of nothing in the apparel groups. A shoe's size cannot be measured off a photo the way a garment's can: it is STAMPED on the tongue label, the insole or the outsole and must be READ. Read the size, the width and the department off that stamp. Do not infer a shoe size from the apparent proportions of a photo — there is no reliable way to do it and a confident guess is a return."},{"tell":"'NB' is a two-letter token, not a brand","detail":"CROSS-BRAND: 'NB' is New Balance's own common abbreviation AND an ordinary two-letter string (nota bene, and any number of unrelated acronyms). It is safe only as a whole-brand-field value on an actual garment, never as a token found in surrounding text."}]$j$::jsonb,
  'US sizing PLUS a WIDTH letter that is part of the product, not a footnote. THE WIDTH LETTER MEANS DIFFERENT THINGS BY DEPARTMENT: D is STANDARD on men''s but WIDE on women''s (men''s B/D/2E/4E; women''s 2A/B/D/2E) — the same character is correct in both readings and only the department decides. Model numbers are [M|W|U] + 3-4 digits + optional suffix (M990GL6, W574) and THE PREFIX LETTER IS THE TELL — a bare "990" is three digits and is nothing, while "M990" can only be New Balance; the prefix also encodes the department. MADE IN USA (990/993/992) and MADE IN ENGLAND (1500/577) are higher-spec LINES at a materially higher band than the same-numbered imported product — printed on the tongue label, and the most common silent mis-comp on the brand; they fold onto the brand but MUST be disclosed. 990-series VERSION (v1-v6) is part of the product and is not readable from a photo. THE SIZE IS STAMPED, NOT MEASURED — read it off the tongue label, never infer it. NEVER auto-authenticate.',
  'https://www.newbalance.com/', 0.72, false, 'migration:00459')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Dr. Martens (NEW row — was passthrough-only, so a "doc martens" tag rendered the
-- seller's casing into the prompt block and the eBay Brand aspect). THE UK-SIZING
-- brand: the single highest-value fact in this pack.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('drmartens', 'Dr. Martens',
  ARRAY['drmartens','drmarten','doctormartens','docmartens','docmarten','docmartins','airwair']::text[],
  ARRAY['footwear','boots','leather','punk','heritage']::text[],
  $j$[{"era":"Made in England / Vintage line","years":"1960-present (domestic production reduced ~2003, retained as a premium line)","description":"Dr. Martens moved the bulk of production offshore around 2003 and retained a MADE IN ENGLAND line (marketed as 'Vintage', built at Cobbs Lane, Wollaston). MIE boots sell in a materially higher band than the standard imported product. The origin is printed on the heel loop and the footbed. This is a LINE fact, not an era, and it is the brand's biggest silent mis-comp. Pre-2003 English-made boots are collectible in their own right."},{"era":"Original 1460 lineage","years":"1960-present","description":"The 8-eye 1460 boot has been in continuous production since 1 April 1960 (the article number encodes that date). The silhouette has barely changed in 65 years, which is exactly why the boot CANNOT be dated from a photo — a 2024 pair and a 1994 pair look alike. Only the heel loop, the footbed stamp and the construction date it. Informational; not an authenticity test."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Dr. Martens item authentic. Flag inconsistencies in condition notes only. Dr. Martens is among the most counterfeited products in this entire knowledge base, which raises the stakes and does not change the stance."},{"tell":"THE SIZE ON THE TAG IS A UK SIZE — AND THE TAG DOES NOT SAY SO","detail":"THE Dr. Martens call and the single highest-value fact in this brand group. Dr. Martens is a British brand sized in UK sizes, and the number stamped on the boot is a UK number with NO system marked anywhere on it. A boot stamped '7' is a UK 7 = US MEN'S 8 = US WOMEN'S 9 = EU 41. A seller who reads '7' and lists a US 7 has mis-sized the boot by a FULL SIZE, and nothing in the photo will contradict them — the boot really does say 7. This is not a pricing refinement; it is a wrong listing and a guaranteed return. ALWAYS convert the stamped number from UK before listing a US size, and state the UK number in the listing so the buyer can check."},{"tell":"DR. MARTENS IS UNISEX-SIZED AND HAS NO HALF SIZES","detail":"CRITICAL and a direct consequence of the UK sizing above. The brand grades ONE unisex UK run — there is no separate men's and women's size scale, so a single UK number maps to BOTH a US men's and a US women's size (UK 7 = US M8 = US W9), and both belong in the listing. There are also NO HALF SIZES in the standard run: whole UK sizes only. So a listing claiming a 'US 8.5' Dr. Martens is describing a size the brand does not make, and a boot stamped with a half size is a signal to look harder, not to round."},{"tell":"THE ARTICLE NUMBER NAMES THE PIECE, NEVER THE BRAND","detail":"The pack's hardest refusal, and the reason this brand has no decoder despite having the most famous numbers in footwear. 1460 (8-eye boot), 1461 (3-eye shoe) and 2976 (Chelsea) are genuinely printed and genuinely regular — and they are FOUR DIGITS with no prefix. Four digits is not a brand: it is a year, a lot number, a price, another brand's cut code. Contrast New Balance in this same group, whose model numbers earn a decoder precisely BECAUSE of the prefix letter ('M990' can only be New Balance; '1460' can be anything). Use these numbers to identify the PIECE when the brand is already known. Never recover the brand from them."},{"tell":"MADE IN ENGLAND IS A DIFFERENT PRODUCT AT A DIFFERENT PRICE","detail":"CRITICAL. Dr. Martens moved most production offshore around 2003 and kept a MADE IN ENGLAND line (marketed as 'Vintage') at a materially higher band. The origin is printed on the HEEL LOOP and the footbed — not on the silhouette, which is identical. It is a LINE, not an era, and it folds onto the brand (there is no separate eBay catalogue brand), so the style is the only place it can survive into a listing. Pre-2003 English-made pairs are collectible in their own right. If the heel loop says Made in England, say so."},{"tell":"AirWair is the brand's own mark and IS brand-unique","detail":"The yellow heel loop reads 'AirWair with Bouncing Soles' — AirWair is Dr. Martens' own registered mark for the air-cushioned sole and is a coined term. Unlike the article numbers, it does identify the brand. The yellow welt stitch and the grooved sole edge are the brand's signature construction. Note these are IDENTIFICATION aids only: they are also the most copied features on the market, so their presence is NOT evidence of authenticity and must never be reported as such."},{"tell":"The silhouette cannot date the boot","detail":"GRADING-RELEVANT: the 1460 has been in continuous production essentially unchanged since 1960, so a 2024 pair and a 1994 pair look alike in a photo. Do not claim a vintage era from the shape. Only the heel loop, the footbed stamp and the construction can date it — and if they do not support the claim, do not make it."}]$j$::jsonb,
  'BRITISH brand, sized in UK SIZES — and THE TAG DOES NOT SAY "UK". This is the highest-value fact in this brand group: a boot stamped "7" is a UK 7 = US MEN''S 8 = US WOMEN''S 9 = EU 41, so a seller who reads "7" and lists a US 7 is a FULL SIZE wrong and the photo will not contradict them. ALWAYS convert from UK and state the UK number. UNISEX-SIZED (one UK run maps to both a US men''s and a US women''s size — list both) with NO HALF SIZES in the standard run: a "US 8.5" Dr. Martens is a size the brand does not make. THE ARTICLE NUMBERS (1460 8-eye, 1461 3-eye, 2976 Chelsea) name the PIECE and NEVER the brand — four digits with no prefix is not a brand (contrast New Balance''s "M990", where the prefix is what earns a decoder). MADE IN ENGLAND ("Vintage", Cobbs Lane) is a higher-spec LINE at a higher band, printed on the HEEL LOOP, not visible in the silhouette — it folds onto the brand but MUST be disclosed. AirWair is the brand''s own coined mark and IS brand-unique. The 1460 has been unchanged since 1960, so the SILHOUETTE CANNOT DATE THE BOOT. Heavily counterfeited. NEVER auto-authenticate.',
  'https://www.drmartens.com/', 0.72, false, 'migration:00459')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- UGG (NEW row — passthrough-only before this). The pack's Gap-grade token problem:
-- "ugg" is a CONTESTED GENERIC and a real trademark at the same time.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('ugg', 'UGG',
  ARRAY['ugg','uggs','uggaustralia','uggboots']::text[],
  ARRAY['footwear','boots','sheepskin','slippers','loungewear']::text[],
  $j$[{"era":"UGG Australia branding","years":"~1995-2016","description":"Deckers marketed the brand as 'UGG Australia' on the label until a rebrand to plain 'UGG' around 2016. An 'UGG Australia' label DATES a pair to the earlier period — it is NOT a claim that the boot was made in Australia (Deckers' production is overseas), and it is NOT an authenticity test in either direction. This distinction matters because the word 'Australia' on the label is exactly what a naive reading turns into a false provenance claim."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label an UGG item authentic. Flag inconsistencies in condition notes only. UGG is among the most counterfeited products in this entire knowledge base, which raises the stakes and does not change the stance."},{"tell":"'UGG' IS A CONTESTED GENERIC AND A REAL TRADEMARK AT THE SAME TIME","detail":"THE UGG call and this pack's Gap-grade token problem, with a twist Gap does not have. In AUSTRALIA and New Zealand 'ugg boot' is a GENERIC term for a sheepskin boot, made and sold under that word by many unrelated makers; in the US 'UGG' is Deckers' trademark and this brand. So a sheepskin boot marked 'ugg' is NOT necessarily this brand — unlike 'Gap', where the ambiguity is with an ordinary English word and the brand always wins on a brand field. Here the ambiguity is with ANOTHER REAL PRODUCT of the same kind. Read this brand from the actual Deckers UGG label and its sunburst logo, never from the word 'ugg' describing a sheepskin boot. If the label is a different maker's, it is a different brand and must be listed as one."},{"tell":"'UGG AUSTRALIA' ON THE LABEL DOES NOT MEAN MADE IN AUSTRALIA","detail":"CRITICAL, and the most likely false claim on this brand. 'UGG Australia' was the brand's LABEL until roughly 2016 — it dates a pair to the earlier branding and says nothing about where it was made (Deckers' production is overseas). Never turn the word 'Australia' on the label into a country-of-origin or a provenance claim in a listing. Read origin from the country-of-manufacture stamp, not from the brand name."},{"tell":"UGG RUNS LARGE and the sheepskin PACKS DOWN — both, and they compound","detail":"CRITICAL for sizing AND for grading, and the two facts point the same way. UGG's classic sheepskin boots run LARGE (the brand's own guidance is to size DOWN, and the classics are whole sizes only). Separately, the sheepskin lining COMPRESSES and moulds to the wearer's foot with use — so a worn pair fits larger than a new pair of the same stamped size. That flattening is NORMAL WEAR and the expected behaviour of the material: it is worth DISCLOSING as wear, but it is not a defect of manufacture and the boot is not 'stretched out' or mislabelled. Grade the compression honestly; do not treat it as damage."},{"tell":"THE SLIPPERS ARE THE VOLUME PRODUCT, NOT THE BOOTS","detail":"PRICE-RELEVANT and counter to the obvious assumption. The Tasman slipper and the Mini/Ultra Mini silhouettes have carried the brand's resale demand in recent years, frequently above the tall classic boot that made the name. Do not assume the tall Classic is the valuable one. The exact silhouette (Ultra Mini vs Mini vs Short vs Tall) is a real price difference, it is legible from the photo, and it must be identified precisely rather than collapsed into 'UGG boots'."}]$j$::jsonb,
  'US sizing that RUNS LARGE — the brand''s own guidance is to size DOWN, and the classic sheepskin boots are WHOLE SIZES ONLY. THE SHEEPSKIN PACKS DOWN with wear (it moulds to the foot), so a worn pair fits larger than a new pair of the same stamped size: that is NORMAL WEAR and the material behaving as designed — disclose it, but never grade it as a defect or call the boot "stretched out". "UGG" IS A CONTESTED GENERIC: in Australia/NZ "ugg boot" is a generic term for a sheepskin boot made by many unrelated makers, while in the US it is Deckers'' trademark — so a boot marked "ugg" is NOT necessarily this brand, and the ambiguity is with ANOTHER REAL PRODUCT rather than an ordinary word. Read the brand from the Deckers UGG label, never from the word. "UGG AUSTRALIA" (the label until ~2016) DATES a pair and does NOT mean made in Australia — never turn it into a provenance claim. THE SLIPPERS ARE THE VOLUME PRODUCT: Tasman and the Mini/Ultra Mini often out-resell the tall Classic, and the exact silhouette is a real price difference that IS legible from a photo. Owned by Deckers. Heavily counterfeited. NEVER auto-authenticate.',
  'https://www.ugg.com/', 0.70, false, 'migration:00459')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Birkenstock (NEW row — passthrough-only before this). The EU-ONLY brand, and the
-- other half of this pack's "the tag does not name its system" problem.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('birkenstock', 'Birkenstock',
  ARRAY['birkenstock','birkenstocks']::text[],
  ARRAY['footwear','sandals','clogs','cork footbed','german']::text[],
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Birkenstock item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE SIZE ON THE FOOTBED IS AN EU SIZE — AND ONLY AN EU SIZE","detail":"THE Birkenstock call, and the other half of this group's defining problem. Birkenstock is a GERMAN brand graded in EU sizes ONLY (36-46) — there is no US-numbered run at all, and the number stamped in the footbed carries no system marking. A sandal stamped '38' is an EU 38 = US WOMEN'S 7-7.5, not a US 8. There are also NO HALF SIZES: whole EU sizes only, which is why the US equivalents in this pack's chart are RANGES rather than single numbers. A listing claiming a 'Birkenstock US 8' is translating a number the brand never printed — do the conversion deliberately, and state the EU number in the listing so the buyer can check it themselves."},{"tell":"THE WIDTH IS STAMPED AS A FOOT ICON, NOT A LETTER","detail":"CRITICAL, brand-specific, and easy to miss because it is not a character. Birkenstock grades two widths — REGULAR and NARROW — and marks them with a small FOOT-SHAPED ICON on the footbed beside the size: a WIDE-looking foot icon means REGULAR width, and a NARROW-looking foot icon means NARROW. There is no 'D' or 'B' letter to read. Narrow is a genuinely different product to a buyer who needs it and it is searched by name. Read the icon off the footbed photo; if the footbed is not photographed or the icon is worn away, say the width is unconfirmed rather than assuming regular."},{"tell":"THE FOOTBED IS THE PRODUCT AND ITS WEAR IS THE GRADE","detail":"THE grading call on this brand, and it has no equivalent in the apparel groups. The cork-latex footbed moulds to its wearer's foot by design — that is the entire product concept. So a used pair carries a genuine, visible FOOT IMPRESSION, and that impression is NORMAL and expected, not damage. What IS a defect: cork CRUMBLING or flaking at the exposed edge, a SEPARATED sole, and a heavily darkened/compressed suede footbed liner. Grade the impression as wear and the crumbling as damage — they are different things and are easy to conflate. Note the footbed and sole are both genuinely REPLACEABLE by a cobbler, which is a real fact about the product's value and worth mentioning where the wear is advanced."},{"tell":"THE MODEL NAMES ARE PLACE NAMES","detail":"CROSS-BRAND: Arizona, Boston, Gizeh, Madrid and Milano are Birkenstock's model names AND ordinary place names. They identify the PIECE only on an actual Birkenstock, and must never be read as a brand token or as a country of origin. Birkenstock is GERMAN — a sandal called 'Arizona' is not American and a clog called 'Boston' is not from Massachusetts."},{"tell":"The Boston clog is the volume product","detail":"PRICE-RELEVANT: the Boston clog has carried the brand's resale demand well above the Arizona two-strap sandal that made the name. Do not assume the Arizona is the valuable one. The silhouettes are clearly distinguishable in a photo (the Boston is a closed-toe clog; the Arizona is an open two-strap sandal) and must be identified precisely."}]$j$::jsonb,
  'GERMAN brand graded in EU SIZES ONLY (36-46) — there is NO US-numbered run, and the number stamped in the footbed carries no system marking. A sandal stamped "38" is an EU 38 = US WOMEN''S 7-7.5, not a US 8. NO HALF SIZES (whole EU sizes only), which is why every US equivalent is a RANGE. State the EU number in the listing. THE WIDTH IS A FOOT ICON, NOT A LETTER: regular vs narrow is marked by a small foot-shaped icon on the footbed beside the size (wide icon = REGULAR, narrow icon = NARROW) — there is no D/B letter to read; if the footbed is not photographed, say the width is unconfirmed rather than assuming regular. THE FOOTBED IS THE PRODUCT AND ITS WEAR IS THE GRADE: the cork-latex footbed MOULDS to its wearer by design, so a visible FOOT IMPRESSION is NORMAL and expected, not damage — but cork CRUMBLING at the edge, a SEPARATED sole and a darkened/compressed liner ARE defects. Footbeds and soles are genuinely cobbler-replaceable, which is real value. Model names (Arizona, Boston, Gizeh, Madrid) are PLACE NAMES — they name the piece only on an actual Birkenstock and never a country of origin. The BOSTON CLOG is the volume product, above the Arizona. NEVER auto-authenticate.',
  'https://www.birkenstock.com/', 0.70, false, 'migration:00459')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Converse (row EXISTS from 00389, alias-only). Half of the Converse/Vans offset
-- trap, and the owner of the M-prefixed style codes that collide with New Balance's
-- model-number FORMAT. See the brand-normalize.ts note and the header.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('converse', 'Converse',
  ARRAY['converse','chucktaylor','allstar','chuck70']::text[],
  ARRAY['footwear','sneakers','canvas','skate','heritage']::text[],
  $j$[{"era":"Chuck 70 vs standard All Star","years":"Chuck 70 reissued 2013-present","description":"The Chuck 70 is a premium reissue of the 1970s All Star spec and sits in a materially higher band than the standard Chuck Taylor All Star. It is NOT an era — both are in production RIGHT NOW, side by side. The two are near-identical in silhouette and are separated only by details (heavier canvas, a glossy off-white midsole, the vintage star-chevron heel patch and a black license-plate tag). Confusing them is the brand's most common mis-comp in both directions."},{"era":"Made in USA lineage","years":"pre-2001 domestic production","description":"Converse manufactured domestically until around 2001 (the company entered bankruptcy that year; Nike acquired the brand in 2003). Pre-2001 US-made Chucks are a genuine vintage collectible with their own buyers. The origin is printed on the label and the footbed. This DATES a pair and is not an authenticity test."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Converse item authentic. Flag inconsistencies in condition notes only."},{"tell":"CHUCK 70 IS NOT A STANDARD CHUCK — AND BOTH ARE IN PRODUCTION NOW","detail":"THE Converse call. The Chuck 70 is a premium reissue of the 1970s spec at a materially higher price band than the standard Chuck Taylor All Star, and the two are near-identical in a photo. It is NOT an era: both are on sale side by side today, so the pair cannot be dated OR priced by the silhouette. The separators are details and they are legible when photographed: the Chuck 70 has a HEAVIER canvas, a GLOSSY off-white ('egret') midsole rather than a bright white one, the VINTAGE star-chevron heel patch, and a BLACK license-plate tag at the heel. Check the heel and the midsole before pricing; if the photos do not show them, say the model is unconfirmed rather than assuming the cheaper one."},{"tell":"CONVERSE AND VANS DO NOT SIZE THE SAME — the offset is TWO here","detail":"CRITICAL and this group's quiet trap. Converse dual-tags men's AND women's on one label, and the offset is TWO: a Converse M8 is a W10. Vans — the same kind of black canvas lace-up, the same price band, the same shelf — uses an offset of ONE AND A HALF (a Vans M8 is a W9.5). The two brands are adjacent enough that a reading learned on one gets applied to the other, and there is no way to catch it from a photo. Read BOTH numbers off the actual tag and never compute one brand's offset with the other's."},{"tell":"Converse RUNS LARGE","detail":"The classic Chuck Taylor runs LARGE — the brand's own long-standing guidance is to size DOWN a half size from a normal sneaker size. Note the dual-tagged label already prints both a men's and a women's number, so it is the SYSTEM that needs reading, not the fit: read the stamped numbers and report them, and mention the brand's size-down guidance rather than silently adjusting the size."},{"tell":"NIKE OWNS CONVERSE — and it does not fold","detail":"CROSS-BRAND, informational: Nike acquired Converse in 2003, so a Nike corporate mark inside a Chuck Taylor is ORDINARY provenance and is NOT a counterfeit signal. It is also NOT a reason to fold the brands: Converse is separately branded, separately searched and sits in its own band, so it keeps its own canonical. The parent company is never what decides a fold."},{"tell":"'All Star' and 'Chuck Taylor' are not brand tokens on their own","detail":"CROSS-BRAND: 'All Star' is an ordinary English phrase (and a mark other sports brands use), and 'Chuck Taylor' is a person's name. Both identify the PIECE on an actual Converse and neither should mint the brand from surrounding text."}]$j$::jsonb,
  'US sizing, DUAL-TAGGED men''s and women''s on one label with an OFFSET OF TWO: a Converse M8 is a W10. VANS IS NOT THE SAME — the same kind of black canvas lace-up at the same band uses an offset of ONE AND A HALF (M8 = W9.5), and a reading learned on one brand gets silently applied to the other. Read BOTH numbers off the tag. RUNS LARGE (the brand''s own guidance is to size down a half size) — report the stamped numbers plus that guidance, never silently adjust. CHUCK 70 IS NOT A STANDARD CHUCK and BOTH ARE IN PRODUCTION NOW (so the silhouette cannot date or price the pair): the Chuck 70 is a premium 1970s-spec reissue at a higher band, separated only by details — HEAVIER canvas, a GLOSSY egret midsole, the VINTAGE star-chevron heel patch, a BLACK license-plate tag. Check the heel and midsole before pricing; if unphotographed, say unconfirmed. Pre-2001 US-made Chucks are a vintage collectible. Owned by NIKE since 2003 — a Nike corporate mark inside a Chuck is ORDINARY and not a counterfeit signal, and not a reason to fold. NEVER auto-authenticate.',
  'https://www.converse.com/', 0.70, false, 'migration:00459')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Vans (row EXISTS from 00389, alias-only). The other half of the offset trap, and
-- the pack's ordinary-word token: "vans" is an English plural.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('vans', 'Vans',
  ARRAY['vans','vansoffthewall','vaultbyvans']::text[],
  ARRAY['footwear','sneakers','skate','canvas','suede']::text[],
  $j$[{"era":"Vault by Vans / OG line","years":"2004-present","description":"Vault by Vans is the brand's premium line — OG-spec reissues and collaborations built to a higher standard (marked 'OG', 'LX' or 'Vault' on the label and the box) at a materially higher band than the mainline shoe. It is NOT an era: mainline and Vault are in production side by side, and the silhouettes are near-identical. This is the same shape as Converse's Chuck 70 in this same pack, and it is separated the same way — by the label, never by the photo."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Vans item authentic. Flag inconsistencies in condition notes only."},{"tell":"'VANS' IS AN ORDINARY ENGLISH PLURAL","detail":"THE Vans token problem, and it is 00458's 'Gap' shape: the brand name is a common English word (the plural of 'van') AND a real canonical brand that MUST resolve. It cannot be removed, only contained. Read it as this BRAND only when it appears as the garment's BRAND — on the label or the brand field — and never from the word appearing in a description or a title about vehicles. A brand detector must never be fed free text on this token."},{"tell":"VANS AND CONVERSE DO NOT SIZE THE SAME — the offset is ONE AND A HALF here","detail":"CRITICAL, and the mirror of the Converse tell in this same pack. Vans dual-tags men's AND women's on one label with an offset of ONE AND A HALF: a Vans M8 is a W9.5. CONVERSE — the same kind of black canvas lace-up, the same price band, the same shelf — uses an offset of TWO (a Converse M8 is a W10). The brands are adjacent enough that a reading learned on one gets applied to the other, and a photo cannot catch it. Read BOTH numbers off the actual tag; never compute one brand's offset with the other's."},{"tell":"VAULT / OG IS A DIFFERENT PRODUCT AT A DIFFERENT PRICE","detail":"Vault by Vans is the premium OG-spec line (marked 'OG', 'LX' or 'Vault' on the label and box) at a materially higher band than the mainline shoe, and the silhouettes are near-identical. It is NOT an era — both are in production now, so the photo can neither date nor price it. This is exactly Converse's Chuck 70 problem in the same pack and it is separated the same way: by the LABEL. It folds onto the brand 'Vans' (there is no separate eBay catalogue brand), so the style is the only place the distinction survives into a listing."},{"tell":"THE MODEL IS THE SILHOUETTE AND IT IS LEGIBLE","detail":"Unlike most of this knowledge base, Vans' models genuinely ARE distinguishable in a photo, and the distinction is worth real money: Old Skool (the side stripe, low), Sk8-Hi (the side stripe, high top), Authentic (low, NO stripe), Era (low, no stripe, padded collar), Slip-On (no laces). The side stripe — Vans' own registered 'Jazz Stripe' — is the primary separator and the Authentic/Era pair is the one most often collapsed. Identify the model precisely rather than listing 'Vans sneakers'; note Authentic vs Era differ mainly by the PADDED COLLAR, which needs a side-on photo."},{"tell":"VF Corp is The North Face's parent too","detail":"Informational: Vans is owned by VF Corporation, which also owns The North Face. Ordinary corporate provenance; not a tag tell and not a counterfeit signal."}]$j$::jsonb,
  'US sizing, DUAL-TAGGED men''s and women''s on one label with an OFFSET OF ONE AND A HALF: a Vans M8 is a W9.5. CONVERSE IS NOT THE SAME — the same kind of black canvas lace-up at the same band uses an offset of TWO (M8 = W10), and a reading learned on one brand gets silently applied to the other. Read BOTH numbers off the tag. NOTE "vans" is an ORDINARY ENGLISH PLURAL (the plural of "van") as well as a real canonical brand — the 00458 "Gap" shape: read it as the brand ONLY from the label or the brand field, NEVER from free text. VAULT BY VANS / OG is the premium OG-spec LINE (marked "OG"/"LX"/"Vault" on the label and box) at a materially higher band, near-identical in silhouette and in production ALONGSIDE the mainline — Converse''s Chuck 70 problem in the same pack, separated by the LABEL and never the photo; it folds but MUST be disclosed. THE MODEL IS LEGIBLE, unusually for this KB: Old Skool (side stripe, low), Sk8-Hi (side stripe, high), Authentic (low, NO stripe), Era (low, no stripe, PADDED COLLAR — needs a side-on photo), Slip-On. The side stripe is Vans'' registered Jazz Stripe. Owned by VF Corp (The North Face''s parent). NEVER auto-authenticate.',
  'https://www.vans.com/', 0.70, false, 'migration:00459')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Cole Haan (NEW row — passthrough-only before this). The pack's dress-shoe brand:
-- the one place where a CONSTRUCTION fact (resoleable or not) sets the value.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('colehaan', 'Cole Haan',
  ARRAY['colehaan','colehaans']::text[],
  ARRAY['footwear','dress shoes','loafers','leather','business casual']::text[],
  $j$[{"era":"Nike ownership / Lunarlon era","years":"1988-2012 (Nike-owned); Grand.OS from 2012","description":"Nike owned Cole Haan from 1988 to 2012 and shoes from the later part of that period carry NIKE AIR or LUNARLON sole technology, branded on the shoe and the sole. After the 2012 sale Cole Haan replaced it with its own Grand.OS platform. A NIKE AIR mark inside a Cole Haan dress shoe is therefore GENUINE and ORDINARY for its period — it dates the shoe and is emphatically not a counterfeit signal or a mismatched sole. This is the brand's most misread tell."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Cole Haan item authentic. Flag inconsistencies in condition notes only."},{"tell":"A 'NIKE AIR' MARK INSIDE A COLE HAAN IS GENUINE AND ORDINARY","detail":"THE Cole Haan call and the brand's most misread tell — because it looks exactly like a counterfeiter's mistake and is not one. NIKE OWNED COLE HAAN from 1988 to 2012, and shoes from the later part of that period genuinely carry NIKE AIR or LUNARLON sole technology, branded on the shoe and the sole. A Nike mark in a dress shoe is a period-correct FACT: it dates the pair and is NOT evidence of a fake, a franken-shoe or a replaced sole. After the 2012 sale the brand moved to its own Grand.OS platform. Read the sole tech as a DATE, never as a defect."},{"tell":"THE CONSTRUCTION SETS THE VALUE, AND IT IS NOT LEGIBLE FROM THE UPPER","detail":"The dress-shoe fact with no equivalent in this knowledge base's apparel groups. A GOODYEAR-WELTED shoe can be resoled and re-lasted indefinitely and holds real resale value even worn; a CEMENTED (glued) shoe cannot be economically resoled and is worth substantially less once the sole is gone. Cole Haan sells both, and the uppers look ALIKE — the tell is the WELT at the sole edge (a visible stitch line running around the sole perimeter means welted; a clean glued seam means cemented), which requires a SOLE-EDGE photo. This is also the grading rule for the brand: sole wear on a welted shoe is a repairable, disclosable condition; sole wear on a cemented shoe is closer to end-of-life. If the sole edge is not photographed, say the construction is unconfirmed rather than assuming welted."},{"tell":"THE SOLE AND HEEL ARE THE GRADE ON A DRESS SHOE","detail":"GRADING-RELEVANT and specific to this category. On a dress shoe the condition that decides the price is the SOLE and the HEEL — heel-cap wear, sole thinning at the ball, and a broken-down heel counter — plus creasing across the vamp. None of that is visible in the standard three-quarter product photo every seller takes. REQUIRE a sole photo and a heel-on photo before grading, and say the sole is unseen rather than grading the upper and calling it the shoe."},{"tell":"'Cole' and 'Haan' are surnames","detail":"CROSS-BRAND: Cole Haan is named for its founders (Trafton Cole and Eddie Haan). Neither half is decisive on its own and the full name is what identifies the brand."}]$j$::jsonb,
  'US sizing (men''s 7-13 with B/C/D/E/EEE widths; women''s 5-11) — dress and business-casual footwear. A "NIKE AIR" OR "LUNARLON" MARK INSIDE A COLE HAAN IS GENUINE AND ORDINARY: NIKE OWNED THE BRAND 1988-2012 and shoes from the later part of that period really do carry Nike sole tech, branded on the shoe. It DATES the pair and is NOT a fake, a franken-shoe or a replaced sole — the brand''s most misread tell. Post-2012 the platform is Cole Haan''s own Grand.OS. THE CONSTRUCTION SETS THE VALUE AND THE UPPER DOES NOT SHOW IT: a GOODYEAR-WELTED shoe is resoleable and holds value worn; a CEMENTED (glued) shoe is not economically resoleable and is worth much less once the sole is gone. The tell is the WELT STITCH at the sole EDGE, so it needs a SOLE-EDGE photo — if unphotographed, say unconfirmed rather than assuming welted. THE SOLE AND HEEL ARE THE GRADE on a dress shoe (heel-cap wear, sole thinning at the ball, a broken-down heel counter, vamp creasing) and NONE of it shows in the three-quarter product photo every seller takes — require a sole photo and a heel-on photo, and say the sole is unseen rather than grading the upper and calling it the shoe. NEVER auto-authenticate.',
  'https://www.colehaan.com/', 0.68, false, 'migration:00459')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- Footwear inverts the fingerprint problem: unlike a $12 crewneck (00458), a shoe's
-- MODEL genuinely IS legible from a photo — an Old Skool is not a Slip-On and an
-- Arizona is not a Boston. So these carry real visual fingerprints again. What is
-- NOT legible is the LINE (Chuck 70 vs Chuck, Made in USA vs imported, Vault vs
-- mainline) — the premium reissues are near-identical BY DESIGN and are in
-- production alongside the mainline shoe, so the photo can neither date nor price
-- them. Every one of those is seeded as a style so the distinction survives into
-- the listing rather than being silently comped at the wrong band.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values

  -- New Balance.
  ('newbalance', '990 series', 'Unisex', 'sneaker', '990',
   'The brand''s flagship runner and the shoe the Made in USA line is built around — a chunky suede-and-mesh runner in heritage grey, with the "990" numeral on the side panel. The NUMBER is on the shoe, but the VERSION (v1-v6) and the ORIGIN are not reliably readable from it: check the tongue label and the box. A Made in USA 990 and an imported 990-family shoe are not the same money.',
   ARRAY['ENCAP','FuelCell']::text[], '1982-present (v1-v6)', '$175-250 Made in USA',
   ARRAY['990','990v5','990v6','new balance 990','made in usa','grey']::text[],
   'https://www.newbalance.com/', 0.68, false, 'migration:00459'),

  ('newbalance', '574', 'Unisex', 'sneaker', '574',
   'The brand''s highest-volume lifestyle sneaker — a suede-and-mesh low with the "574" numeral on the side panel. Imported and priced well below the Made in USA lines; it is the model most likely to be mistaken for a 990 in a photo, since the silhouettes rhyme. Read the numeral.',
   ARRAY['ENCAP']::text[], '1988-present', '$80-110',
   ARRAY['574','new balance 574','encap','suede']::text[],
   'https://www.newbalance.com/', 0.62, false, 'migration:00459'),

  ('newbalance', '550', 'Unisex', 'sneaker', '550',
   'A retro basketball silhouette in leather — a low-top court shoe, visually unlike the 574/990 runners. Revived in 2020 and carried a period of heavy resale demand well above its retail band; that demand is volatile and the model is now widely available, so comp it rather than assuming the hype price.',
   ARRAY[]::text[], '1989 original; revived 2020', '$110-130 retail',
   ARRAY['550','bb550','new balance 550','basketball','retro']::text[],
   'https://www.newbalance.com/', 0.60, false, 'migration:00459'),

  ('newbalance', '2002R', 'Unisex', 'sneaker', '2002R',
   'A dad-shoe runner with a distinctive segmented midsole; the "Protection Pack" treatments carry a premium. Imported, but priced above the 574 band.',
   ARRAY['N-ergy','ABZORB']::text[], '2010 original; revived 2020', '$140-160 retail',
   ARRAY['2002r','protection pack','new balance 2002','dad shoe']::text[],
   'https://www.newbalance.com/', 0.58, false, 'migration:00459'),

  ('newbalance', 'Made in USA / Made in England', 'Unisex', 'line', 'Made in USA',
   'NOT A SILHOUETTE — a LINE, seeded as a style so it is DISCLOSED on the listing. The domestic Made in USA (990/993/992) and Made in England (1500/577) lines are built to a higher spec and sell in a materially higher band than the same-numbered imported product. The origin is printed on the TONGUE LABEL, the box and the shoe — it is NOT visible in the silhouette. The brand folds (there is no separate eBay catalogue brand), so this is the only place the distinction can survive. NOTE the US "Made in USA" claim is a domestic-value claim, not a 100%-domestic one; report what the label says and nothing more.',
   ARRAY[]::text[], 'ongoing', 'well above the imported equivalent',
   ARRAY['made in usa','made in england','mie','usa 990','domestic']::text[],
   'https://www.newbalance.com/', 0.62, false, 'migration:00459'),

  -- Dr. Martens. The article numbers name the PIECE — never the brand (see the
  -- brand_style_codes section for why this brand gets no decoder).
  ('drmartens', '1460 (8-eye boot)', 'Unisex', 'boot', '1460',
   'THE Dr. Martens — the 8-eyelet ankle boot, in continuous production since 1 April 1960 (the article number encodes that date). The tells are the yellow welt stitch, the grooved sole edge and the AirWair heel loop. CRITICAL: the silhouette has barely changed in 65 years, so a photo CANNOT date the boot — only the heel loop, the footbed stamp and the construction can. The article number identifies THIS PIECE and must never be read as the brand: "1460" is four digits.',
   ARRAY['AirWair']::text[], '1960-present', '$150-180 standard; MIE well above',
   ARRAY['1460','8 eye','8-eyelet','dr martens boot','docs','airwair']::text[],
   'https://www.drmartens.com/', 0.68, false, 'migration:00459'),

  ('drmartens', '1461 (3-eye shoe)', 'Unisex', 'shoe', '1461',
   'The 3-eyelet Gibson-style low shoe — the 1460''s low-cut sibling, sharing the yellow welt stitch and grooved sole edge. Same rule as the 1460: the number names the piece, never the brand.',
   ARRAY['AirWair']::text[], '1961-present', '$130-160 standard',
   ARRAY['1461','3 eye','3-eyelet','dr martens shoe','gibson']::text[],
   'https://www.drmartens.com/', 0.65, false, 'migration:00459'),

  ('drmartens', '2976 (Chelsea boot)', 'Unisex', 'boot', '2976',
   'The elastic-gusset Chelsea boot with a pull tab — no laces, which makes it the most photo-distinguishable DM silhouette. Same rule: the number names the piece, never the brand.',
   ARRAY['AirWair']::text[], '1970s-present', '$150-180 standard',
   ARRAY['2976','chelsea','pull on','dr martens chelsea','gusset']::text[],
   'https://www.drmartens.com/', 0.62, false, 'migration:00459'),

  ('drmartens', 'Made in England (Vintage line)', 'Unisex', 'line', 'Made in England',
   'NOT A SILHOUETTE — a LINE, seeded as a style so it is DISCLOSED on the listing. Dr. Martens moved most production offshore around 2003 and kept a MADE IN ENGLAND line (marketed as "Vintage", built at Cobbs Lane, Wollaston) at a materially higher band. The origin is printed on the HEEL LOOP and the footbed and is INVISIBLE in the silhouette — an MIE 1460 and an imported 1460 look identical. The brand folds (no separate eBay catalogue brand), so this is the only place the distinction survives. Pre-2003 English-made pairs are collectible in their own right.',
   ARRAY['AirWair']::text[], 'pre-2003 general; "Vintage" line ongoing', 'well above the imported equivalent',
   ARRAY['made in england','mie','vintage','cobbs lane','wollaston']::text[],
   'https://www.drmartens.com/', 0.62, false, 'migration:00459'),

  -- UGG. The SLIPPERS are the volume product — not the tall boot that made the name.
  ('ugg', 'Classic Tall', 'Women', 'boot', 'Classic',
   'The tall sheepskin pull-on boot that made the brand — shaft to mid-calf. Clearly distinguishable from the Short/Mini silhouettes in a photo, and that distinction is real money: the tall boot is NOT the brand''s strongest resale silhouette any more. Sheepskin packs down with wear — normal, not a defect.',
   ARRAY['Twinface sheepskin','UGGplush']::text[], '~1995-present', '$180-220 retail',
   ARRAY['classic tall','ugg tall','sheepskin boot','tall boot']::text[],
   'https://www.ugg.com/', 0.62, false, 'migration:00459'),

  ('ugg', 'Classic Short', 'Women', 'boot', 'Classic',
   'The mid-shaft sheepskin pull-on — the Classic silhouette at ankle-to-lower-calf height, between the Tall and the Mini. Legible from a photo; identify the height precisely rather than listing "UGG boots".',
   ARRAY['Twinface sheepskin','UGGplush']::text[], '~1995-present', '$160-180 retail',
   ARRAY['classic short','ugg short','sheepskin boot','short boot']::text[],
   'https://www.ugg.com/', 0.62, false, 'migration:00459'),

  ('ugg', 'Classic Mini / Ultra Mini', 'Women', 'boot', 'Classic',
   'The ankle-height sheepskin pull-on, and one of the brand''s current resale drivers — frequently ABOVE the tall Classic that made the name. The Ultra Mini is the shorter, more recent cut of the same idea and the two are separate products at separate prices; the shaft height distinguishes them and both are legible from a photo. Do not collapse them into each other or into "UGG boots".',
   ARRAY['Twinface sheepskin','UGGplush']::text[], 'Mini ongoing; Ultra Mini ~2021-present', '$150-180 retail',
   ARRAY['classic mini','ultra mini','ugg mini','ankle boot']::text[],
   'https://www.ugg.com/', 0.62, false, 'migration:00459'),

  ('ugg', 'Tasman', 'Unisex', 'slipper', 'Tasman',
   'THE UGG resale story of recent years and the counter to the obvious assumption that the boots carry this brand. A sheepskin-lined slip-on SLIPPER with the distinctive embroidered braid trim across the collar — that braid is the fingerprint and it is unmistakable in a photo. It has repeatedly out-resold the tall Classic boot. Note "Tasman" is a place name (the Tasman Sea) and names the piece only on an actual UGG.',
   ARRAY['Twinface sheepskin','UGGplush']::text[], 'ongoing', '$110-140 retail',
   ARRAY['tasman','ugg slipper','braid','slip on','tasman slipper']::text[],
   'https://www.ugg.com/', 0.62, false, 'migration:00459'),

  -- Birkenstock. The BOSTON is the volume product — not the Arizona.
  ('birkenstock', 'Arizona', 'Unisex', 'sandal', 'Arizona',
   'The two-strap open sandal that made the brand — twin adjustable buckled straps across the foot, open toe and heel, on the cork-latex footbed. Unmistakable in a photo. NOTE "Arizona" is a PLACE NAME and Birkenstock is GERMAN — it names the piece, never an origin.',
   ARRAY['cork-latex footbed','EVA']::text[], 'ongoing', '$110-145 retail',
   ARRAY['arizona','two strap','birkenstock sandal','buckle','cork']::text[],
   'https://www.birkenstock.com/', 0.65, false, 'migration:00459'),

  ('birkenstock', 'Boston', 'Unisex', 'clog', 'Boston',
   'THE Birkenstock resale story, and the counter to assuming the Arizona carries this brand. A CLOSED-TOE clog with a single buckled strap over the instep and an open back — clearly distinct from the open-toe Arizona in any photo. It has carried demand well above the Arizona. The suede ("Taupe") and oiled-leather ("Habana") versions are the searched ones. NOTE "Boston" is a PLACE NAME on a GERMAN shoe.',
   ARRAY['cork-latex footbed','suede','oiled leather']::text[], 'ongoing', '$155-175 retail',
   ARRAY['boston','clog','birkenstock boston','closed toe','suede']::text[],
   'https://www.birkenstock.com/', 0.65, false, 'migration:00459'),

  ('birkenstock', 'Gizeh', 'Women', 'sandal', 'Gizeh',
   'The THONG sandal — a toe-post between the first and second toes with a single buckled strap across the foot, on the same cork-latex footbed. The toe post is the fingerprint and separates it unambiguously from the Arizona. "Gizeh" is a place name (Giza).',
   ARRAY['cork-latex footbed']::text[], 'ongoing', '$100-130 retail',
   ARRAY['gizeh','thong','toe post','birkenstock gizeh']::text[],
   'https://www.birkenstock.com/', 0.60, false, 'migration:00459'),

  ('birkenstock', 'Madrid', 'Women', 'sandal', 'Madrid',
   'The SINGLE-strap slide — one buckled strap across the forefoot, open toe and heel. The slimmest Birkenstock silhouette and the easiest to confuse with the two-strap Arizona at a glance: count the straps.',
   ARRAY['cork-latex footbed']::text[], 'ongoing', '$100-120 retail',
   ARRAY['madrid','single strap','slide','birkenstock madrid']::text[],
   'https://www.birkenstock.com/', 0.58, false, 'migration:00459'),

  -- Converse. Chuck 70 vs Chuck is THE trap — near-identical, both in production.
  ('converse', 'Chuck Taylor All Star', 'Unisex', 'sneaker', 'All Star',
   'The canvas high- or low-top with the rubber toe cap and the circular ankle patch — one of the most recognizable shoes ever made. CRITICAL: this is the STANDARD model and it is near-identical to the premium Chuck 70, which is in production RIGHT NOW alongside it. Check the midsole (a BRIGHT WHITE midsole and a standard heel patch = this shoe; a GLOSSY off-white "egret" midsole, the VINTAGE star-chevron patch and a BLACK license-plate heel tag = a Chuck 70 at a higher band). If the heel and midsole are not photographed, say the model is unconfirmed rather than assuming.',
   ARRAY['canvas','vulcanized rubber']::text[], '1917-present', '$60-70 retail',
   ARRAY['chuck taylor','all star','chucks','converse hi','ox','low top']::text[],
   'https://www.converse.com/', 0.65, false, 'migration:00459'),

  ('converse', 'Chuck 70', 'Unisex', 'sneaker', 'Chuck 70',
   'The premium reissue of the 1970s All Star spec, at a materially higher band than the standard Chuck — and NOT an era: both are in production side by side today, so the photo can neither date nor price the pair. The separators are details and ARE legible when photographed: HEAVIER canvas, a GLOSSY off-white ("egret") midsole rather than a bright white one, the VINTAGE star-chevron heel patch, and a BLACK license-plate tag at the heel. This is the brand''s most common mis-comp in BOTH directions.',
   ARRAY['heavier canvas','vulcanized rubber']::text[], '2013-present (1970s spec)', '$85-110 retail',
   ARRAY['chuck 70','chuck taylor 70','egret','license plate','star chevron']::text[],
   'https://www.converse.com/', 0.65, false, 'migration:00459'),

  ('converse', 'One Star', 'Unisex', 'sneaker', 'One Star',
   'A low-profile suede court shoe with a single star on the side panel — a completely different silhouette from the Chuck, with no ankle patch and no canvas upper. Easily distinguished in a photo.',
   ARRAY['suede']::text[], '1974-present', '$70-90 retail',
   ARRAY['one star','onestar','suede','converse one star']::text[],
   'https://www.converse.com/', 0.58, false, 'migration:00459'),

  ('converse', 'Jack Purcell', 'Unisex', 'sneaker', 'Jack Purcell',
   'The low canvas court shoe with the "smile" — the distinctive dark rubber stripe across the toe cap, which is the whole fingerprint and is unmistakable. Named for the badminton champion; a person''s name, so it identifies the piece and never the brand.',
   ARRAY['canvas','vulcanized rubber']::text[], '1935-present', '$65-85 retail',
   ARRAY['jack purcell','smile','toe stripe','converse jack purcell']::text[],
   'https://www.converse.com/', 0.58, false, 'migration:00459'),

  -- Vans. The models genuinely ARE legible — the LINE is not.
  ('vans', 'Old Skool', 'Unisex', 'sneaker', 'Old Skool',
   'The brand''s signature low-top: the "Jazz Stripe" side stripe over a canvas-and-suede upper, with a padded collar and the waffle outsole. The SIDE STRIPE is the primary separator from the Authentic/Era and is unmistakable in a photo.',
   ARRAY['canvas','suede','waffle outsole']::text[], '1977-present', '$65-75 retail',
   ARRAY['old skool','side stripe','jazz stripe','vans low','waffle']::text[],
   'https://www.vans.com/', 0.65, false, 'migration:00459'),

  ('vans', 'Sk8-Hi', 'Unisex', 'sneaker', 'Sk8-Hi',
   'The high-top with the side stripe and a padded collar — the Old Skool''s high-cut sibling, sharing the stripe and the waffle outsole. The shaft height is the separator and it is obvious in a photo.',
   ARRAY['canvas','suede','waffle outsole']::text[], '1978-present', '$75-85 retail',
   ARRAY['sk8-hi','sk8 hi','high top','side stripe','vans hi']::text[],
   'https://www.vans.com/', 0.62, false, 'migration:00459'),

  ('vans', 'Authentic', 'Unisex', 'sneaker', 'Authentic',
   'The brand''s original silhouette (1966) — a simple low-top canvas lace-up with NO side stripe and NO padded collar, on the waffle outsole. The Era is its near-twin and the ONLY reliable separator is the Era''s PADDED COLLAR, which needs a SIDE-ON photo: this is the pair most often collapsed in listings. If the collar is not clearly visible, say the model is unconfirmed.',
   ARRAY['canvas','waffle outsole']::text[], '1966-present', '$55-65 retail',
   ARRAY['authentic','no stripe','vans authentic','canvas low']::text[],
   'https://www.vans.com/', 0.60, false, 'migration:00459'),

  ('vans', 'Era', 'Unisex', 'sneaker', 'Era',
   'A low-top canvas lace-up with no side stripe and a PADDED COLLAR — the padding is the only reliable separator from the Authentic, which is otherwise its twin, and it requires a side-on photo. Do not distinguish these two from a three-quarter product shot.',
   ARRAY['canvas','waffle outsole']::text[], '1976-present', '$60-70 retail',
   ARRAY['era','padded collar','vans era','no stripe']::text[],
   'https://www.vans.com/', 0.58, false, 'migration:00459'),

  ('vans', 'Vault by Vans (OG / LX line)', 'Unisex', 'line', 'Vault',
   'NOT A SILHOUETTE — a LINE, seeded as a style so it is DISCLOSED on the listing. Vault by Vans is the premium OG-spec line (marked "OG", "LX" or "Vault" on the label and the box) at a materially higher band than the mainline shoe, near-identical in silhouette and in production ALONGSIDE it — so the photo can neither date nor price it. This is exactly Converse''s Chuck 70 problem in the same pack and it is separated the same way: by the LABEL. The brand folds (no separate eBay catalogue brand), so this is the only place the distinction survives.',
   ARRAY[]::text[], '2004-present', 'well above mainline Vans',
   ARRAY['vault','vault by vans','og','lx','vans og']::text[],
   'https://www.vans.com/', 0.58, false, 'migration:00459'),

  -- Cole Haan.
  ('colehaan', 'ZeroGrand', 'Unisex', 'shoe', 'ZeroGrand',
   'The brand''s signature lightweight hybrid — a dress-shoe upper (frequently a wingtip/oxford) on a thick, visibly sculpted foam sole, which is the fingerprint: the silhouette reads as a dress shoe from the ankle up and a sneaker from the sole down. CEMENTED construction, so it is NOT resoleable — sole wear on this model is closer to end-of-life than to a repairable condition, unlike a welted dress shoe.',
   ARRAY['Grand.OS','EVA']::text[], '2014-present', '$170-220 retail',
   ARRAY['zerogrand','zero grand','wingtip','oxford','grandos']::text[],
   'https://www.colehaan.com/', 0.60, false, 'migration:00459'),

  ('colehaan', 'GrandPrø', 'Unisex', 'sneaker', 'GrandPrø',
   'The brand''s leather court/tennis sneaker on the Grand.OS platform — a clean leather low-top. Cemented; not resoleable.',
   ARRAY['Grand.OS','EVA']::text[], '2016-present', '$130-180 retail',
   ARRAY['grandpro','grand pro','tennis','court','leather sneaker']::text[],
   'https://www.colehaan.com/', 0.55, false, 'migration:00459'),

  ('colehaan', 'Original Grand', 'Men', 'shoe', 'Original Grand',
   'The wingtip oxford on the lightweight Grand.OS sole — the brand''s highest-volume dress-casual shoe. Cemented, so sole wear is not economically repairable. Pairs from the Nike era (pre-2012) may carry a genuine NIKE AIR or LUNARLON sole mark: that is period-correct and dates the shoe, and is NOT a fake or a replaced sole.',
   ARRAY['Grand.OS','Nike Air (pre-2012)','Lunarlon (pre-2012)']::text[], '2012-present', '$150-200 retail',
   ARRAY['original grand','wingtip','oxford','grand os','lunargrand']::text[],
   'https://www.colehaan.com/', 0.55, false, 'migration:00459')

on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: ONE — New Balance's model number. ─────────────────────
--
-- The story note asks for this decoder by name ("New Balance model numbers;
-- coordinate with resolveStyleCode()"). It passes all three tests, and the reason
-- is the PREFIX LETTER:
--
--   printed?      YES — on the tongue label and the box, as the product's name.
--   regular?      YES — [MWU] + 3-4 digits + an optional colour/version suffix.
--   brand-unique? YES — BECAUSE OF THE PREFIX. A bare "990" is three digits and
--                 is nothing at all; "M990" can only be a New Balance model
--                 number. The prefix is the entire argument for this decoder.
--
-- IT CAPTURES TWO FIELDS — the first in this epic to do so. The prefix encodes the
-- DEPARTMENT as well as identifying the brand, so M990GL6 yields gender=Men AND
-- styleCode=M990GL6 from one match. That is real added recovery, not a flourish:
-- department is a required eBay aspect on footwear.
--
-- "U" MATCHES BUT DOES NOT CAPTURE, deliberately. U is New Balance's UNISEX
-- prefix, and unisex is not a gender — writing "U" into the gender field would be
-- worse than leaving it empty, and the genderCode transform (brand-decoders.ts)
-- only maps M->Men and W->Women, so a "U" would pass through RAW. So U sits in a
-- NON-CAPTURING alternative: "U574" still matches and still recovers the brand,
-- and gender stays unset. runDecoderSpec skips undefined groups (`value == null`),
-- which is what makes the alternation safe.
--
-- `style` maps to styleCode SPECIFICALLY because brand recovery in
-- enrichExtractionWithBrandKnowledge keys off a decoder hit HAVING a styleCode
-- (`decoderHits.find((h) => h.styleCode)`) — a decoder that captured only gender
-- would match and recover NOTHING. It captures the WHOLE code (M990GL6, not 990)
-- via a nested named group, because the full code is the comp key: the suffix
-- carries the colourway and the version.
--
-- THE PATTERN COLLIDES WITH CONVERSE'S CLASSIC M-PREFIXED CODES (M9160 is a Chuck
-- Taylor, not a New Balance) AND THAT IS SAFE HERE — but only because of a
-- property worth stating out loud, since it is the thing a future change could
-- break. DB decoders are PACK-SCOPED: decodeTagCode is called with the resolved
-- brand's key and specs, so New Balance's decoder is only ever run against a shoe
-- already resolved to New Balance. It is never offered a Converse code.
--
-- The UNSCOPED path had no such protection, and it was a real live bug:
-- brandFromStyleFormat (brand-normalize.ts) inferred "New Balance" from the FORMAT
-- of any M+4-digit code and OVERRODE the tag's own brand, so a Converse M9160 was
-- silently relisted as a New Balance. Fixed in this story by making an explicit
-- canonical brand beat a mere format GUESS. See brand-normalize.ts.
--
-- DR. MARTENS GETS NO DECODER — the pack's hardest refusal, and it is this same
-- prefix argument read backwards. 1460/1461/2976 are the most famous numbers in
-- footwear, they are printed on the tag, and they are a regular closed set. They
-- are also FOUR DIGITS WITH NO PREFIX, and four digits is not a brand: it is a
-- year, a lot number, a price, another brand's cut code. A decoder that recovered
-- a cut-tag DM boot would rebrand anything with a 4-digit number on it. The
-- numbers ship as brand_styles, where they name the PIECE and never the brand.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by)
values ('newbalance', 'style_number',
  'Tongue-label / box model number. New Balance model numbers are [M|W|U] + 3-4 digits + an optional colour/version suffix. The PREFIX LETTER is what makes the token brand-unique (a bare "990" is nothing; "M990" can only be New Balance) and it also encodes the department, so one match recovers both the brand and the gender. The unisex "U" prefix matches but deliberately does NOT capture a gender — unisex is not a gender.',
  '^(?<style>(?:(?<gender>[MW])|U)\d{3,4}[A-Z]{0,3}\d?)$',
  $j${"fieldMap": {"style": "styleCode", "gender": "gender"}, "transforms": {"style": "upper", "gender": "genderCode"}, "confidence": 0.7}$j$::jsonb,
  $j$[{"input":"M990GL6","note":"men's 990v6 in grey — recovers brand New Balance AND gender Men"},{"input":"W574","note":"women's 574 — recovers gender Women from the prefix"},{"input":"U327","note":"unisex 327 — matches and recovers the brand; gender deliberately NOT captured"},{"input":"m990gl6","note":"case-insensitive; the tongue label prints uppercase but OCR may not"}]$j$::jsonb,
  'https://www.newbalance.com/', 0.70, false, 'migration:00459')
on conflict (brand_key, decoder_kind) do update set
  description = excluded.description, pattern = excluded.pattern,
  extraction_rules = excluded.extraction_rules, examples = excluded.examples,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_colorways ─────────────────────────────────────────────────────────
--
-- THE FIRST COLORWAYS IN FOUR GROUPS, and the drought breaking exactly here is not
-- a coincidence — it is what the category is. 00456/00457/00458 seeded none
-- because their colours are seasonal English words ("Ivory", "Sage", "Heather
-- Grey"): descriptive, re-invented every season, nothing to seed. Footwear is the
-- structural opposite. A shoe ships in a SMALL, STABLE, NAMED palette that is
-- reissued for decades and that buyers search BY NAME — "UGG Chestnut" is a real
-- search and "Anthropologie Sage" is not.
--
-- WHY THESE CAN SHIP WHERE UNIQLO'S COLOUR NUMBER COULD NOT (00458): a mis-decoded
-- NUMBER is silent and uncheckable — nothing on the garment contradicts it. A
-- NAMED colourway is checkable BY EYE against the photo: if the pack says Chestnut
-- is a mid-brown and the boot is black, the error is visible immediately. So a
-- named colourway can ship at modest confidence for the US-1715 queue to confirm,
-- where a number mapping could not. That is the rule, not a softening of it.
--
-- SCOPE IS NARROW ON PURPOSE. Only PROPRIETARY names are seeded. Converse, Vans,
-- New Balance and Cole Haan are omitted entirely: their colours are ordinary
-- descriptive words ("Black", "Optical White", "True Navy") and seeding those
-- would add nothing and invite a false match on the word.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values

  -- UGG — Chestnut is the colour the brand is known by.
  ('ugg', 'Chestnut', ARRAY['chestnut']::text[], '#9F6B4A', 'ongoing',
   'https://www.ugg.com/', 0.68, false, 'migration:00459'),
  ('ugg', 'Chocolate', ARRAY['chocolate']::text[], '#5A3A28', 'ongoing',
   'https://www.ugg.com/', 0.60, false, 'migration:00459'),
  ('ugg', 'Sand', ARRAY['sand']::text[], '#C6A88A', 'ongoing',
   'https://www.ugg.com/', 0.58, false, 'migration:00459'),

  -- Dr. Martens — Cherry Red is an OXBLOOD and is not a red. That is the point of
  -- seeding it: the NAME actively misleads a model reading the photo.
  ('drmartens', 'Cherry Red', ARRAY['cherry red','cherry']::text[], '#6E1F23', 'ongoing',
   'https://www.drmartens.com/', 0.68, false, 'migration:00459'),

  -- Birkenstock — Habana is a dark brown and is NOT a Spanish word to translate.
  ('birkenstock', 'Habana', ARRAY['habana']::text[], '#4B2E20', 'ongoing',
   'https://www.birkenstock.com/', 0.62, false, 'migration:00459'),
  ('birkenstock', 'Mocha', ARRAY['mocha']::text[], '#6B4A38', 'ongoing',
   'https://www.birkenstock.com/', 0.58, false, 'migration:00459'),
  ('birkenstock', 'Taupe', ARRAY['taupe']::text[], '#8B7D6B', 'ongoing',
   'https://www.birkenstock.com/', 0.58, false, 'migration:00459'),
  ('birkenstock', 'Stone', ARRAY['stone']::text[], '#A9A296', 'ongoing',
   'https://www.birkenstock.com/', 0.55, false, 'migration:00459')

on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts ───────────────────────────────────────────────────────
--
-- THE STORY'S STATED PRIORITY ("US/UK/EU cross-maps are the priority"), and the
-- reason these charts are shaped unlike every other chart in this table.
--
-- A garment chart is an ESTIMATOR: measure the bust, double it, read off the size.
-- A shoe chart CANNOT be that, because a shoe's size is not measurable from a
-- photo — it is STAMPED on the tongue label, the insole or the footbed and must be
-- READ. So these charts are TRANSLATORS: they turn the brand's own number into
-- every other system's number. The foot-length inches are included as a sanity
-- check (and for a shoe in hand), not as the primary path.
--
-- WHICH MAKES THE SIZE LABEL THE PRODUCT HERE. The 00455 lesson — write the
-- cross-map INSIDE the size label where the model actually reads it, not in a note
-- alone — is not a nicety in this pack, it is the entire deliverable. Every row's
-- label carries the full US/UK/EU triple.
--
--     Dr. Martens  UK  — a boot stamped "7" is a UK 7 = US M8 = US W9. No halves.
--     Birkenstock  EU  — a footbed stamped "38" is an EU 38 = US W7-7.5. No halves.
--     Converse     US  — dual-tagged M/W, offset TWO,          runs LARGE.
--     Vans         US  — dual-tagged M/W, offset ONE AND A HALF.
--     UGG          US  — runs LARGE; classics are whole sizes.
--     New Balance  US  — plus a WIDTH letter whose meaning FLIPS by department.
--     Cole Haan    US  — plus widths.
--
-- These are body-equivalent approximations in INCHES against the nominal grade,
-- not brand-published specs — hence the modest confidence. The CROSS-MAPS are the
-- high-value content; the inch figures ground a shoe in hand.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values

  -- Dr. Martens — UK-SIZED. The most important chart in this pack.
  ('drmartens', 'Dr. Martens', ARRAY['dr. martens','dr martens','drmartens','doc martens','docmartens','airwair']::text[], 'Unisex', 'Footwear (UK-SIZED — the stamped number is a UK size)',
   ARRAY['footwear','shoe','shoes','boot','boots','chelsea','sneaker','1460','1461','2976','sandal']::text[],
   $json$[{"size":"UK 3 = US M4 / US W5 = EU 36","measurements":{"footLength":"8.7"}},{"size":"UK 4 = US M5 / US W6 = EU 37","measurements":{"footLength":"9.05"}},{"size":"UK 5 = US M6 / US W7 = EU 38","measurements":{"footLength":"9.4"}},{"size":"UK 6 = US M7 / US W8 = EU 39","measurements":{"footLength":"9.75"}},{"size":"UK 7 = US M8 / US W9 = EU 41","measurements":{"footLength":"10.1"}},{"size":"UK 8 = US M9 / US W10 = EU 42","measurements":{"footLength":"10.4"}},{"size":"UK 9 = US M10 / US W11 = EU 43","measurements":{"footLength":"10.75"}},{"size":"UK 10 = US M11 / US W12 = EU 45","measurements":{"footLength":"11.1"}},{"size":"UK 11 = US M12 = EU 46","measurements":{"footLength":"11.4"}},{"size":"UK 12 = US M13 = EU 47","measurements":{"footLength":"11.75"}}]$json$::jsonb,
   'THE NUMBER STAMPED ON A DR. MARTENS IS A UK SIZE AND THE BOOT DOES NOT SAY SO — the highest-value fact in this brand group. A boot stamped "7" is a UK 7 = US MEN''S 8 = US WOMEN''S 9 = EU 41. A seller who reads "7" and lists a US 7 is a FULL SIZE wrong, and the photo will not contradict them because the boot really does say 7. ALWAYS convert from UK, and state the UK number in the listing so the buyer can check. THE BRAND IS UNISEX-SIZED: one UK run maps to BOTH a US men''s and a US women''s size, and both belong in the listing — that is why every row here carries both. THERE ARE NO HALF SIZES in the standard run (whole UK sizes only), so a "US 8.5 Dr. Martens" is a size the brand does not make; a stamped half size is a signal to look harder, not to round. THE SIZE IS STAMPED, NOT MEASURED — read it off the boot (the tongue/insole stamp), never infer it from a photo. Foot-length inches are a sanity check for a boot in hand, not the primary path. Body-equivalent approximations, not brand-published specs.',
   'https://www.drmartens.com/', 0.55, false, 'migration:00459'),

  -- Birkenstock — EU-SIZED ONLY. The other half of the "unnamed system" problem.
  ('birkenstock', 'Birkenstock', ARRAY['birkenstock','birkenstocks']::text[], 'Unisex', 'Footwear (EU-SIZED ONLY — no US run exists)',
   ARRAY['footwear','shoe','shoes','sandal','sandals','clog','clogs','slide','arizona','boston','gizeh','madrid']::text[],
   $json$[{"size":"EU 36 = US W5-5.5 = UK 3.5","measurements":{"footLength":"8.85"}},{"size":"EU 37 = US W6-6.5 = UK 4.5","measurements":{"footLength":"9.2"}},{"size":"EU 38 = US W7-7.5 = UK 5.5","measurements":{"footLength":"9.5"}},{"size":"EU 39 = US W8-8.5 / US M6-6.5 = UK 6","measurements":{"footLength":"9.85"}},{"size":"EU 40 = US W9-9.5 / US M7-7.5 = UK 7","measurements":{"footLength":"10.2"}},{"size":"EU 41 = US W10-10.5 / US M8-8.5 = UK 7.5","measurements":{"footLength":"10.5"}},{"size":"EU 42 = US M9-9.5 = UK 8","measurements":{"footLength":"10.85"}},{"size":"EU 43 = US M10-10.5 = UK 9","measurements":{"footLength":"11.2"}},{"size":"EU 44 = US M11-11.5 = UK 9.5","measurements":{"footLength":"11.5"}},{"size":"EU 45 = US M12-12.5 = UK 10.5","measurements":{"footLength":"11.85"}},{"size":"EU 46 = US M13-13.5 = UK 11.5","measurements":{"footLength":"12.2"}}]$json$::jsonb,
   'BIRKENSTOCK IS EU-SIZED ONLY — there is NO US-numbered run at all, and the number stamped in the footbed carries no system marking. A sandal stamped "38" is an EU 38 = US WOMEN''S 7-7.5, NOT a US 8. THERE ARE NO HALF SIZES (whole EU sizes only), which is exactly why every US equivalent here is a RANGE rather than a single number — the brand''s grade is coarser than the US one, so one EU size covers two US halves. State the EU number in the listing so the buyer can check the conversion themselves. THE WIDTH IS A FOOT ICON, NOT A LETTER: regular vs narrow is marked by a small foot-shaped icon on the footbed beside the size (a wide-looking icon = REGULAR, a narrow-looking icon = NARROW) — there is no D/B letter to read, and if the footbed is not photographed say the width is UNCONFIRMED rather than assuming regular. THE FOOTBED IS THE PRODUCT AND ITS WEAR IS THE GRADE: the cork-latex footbed MOULDS to its wearer by design, so a visible FOOT IMPRESSION on a used pair is NORMAL and expected, not damage — but cork CRUMBLING at the exposed edge, a SEPARATED sole and a darkened/compressed liner ARE defects. Do not conflate them. THE SIZE IS STAMPED, NOT MEASURED. Body-equivalent approximations, not brand-published specs.',
   'https://www.birkenstock.com/', 0.55, false, 'migration:00459'),

  -- New Balance — US + WIDTH, and the width letter FLIPS meaning by department.
  ('newbalance', 'New Balance', ARRAY['new balance','newbalance']::text[], 'Men', 'Footwear (US/UK/EU + WIDTH — D is STANDARD here)',
   ARRAY['footwear','shoe','shoes','sneaker','sneakers','trainer','running','990','574','550','2002r']::text[],
   $json$[{"size":"US M7 = UK 6.5 = EU 40","measurements":{"footLength":"9.6"}},{"size":"US M8 = UK 7.5 = EU 41.5","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8.5 = EU 42.5","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9.5 = EU 43.5","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10.5 = EU 45","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11.5 = EU 46","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12.5 = EU 47.5","measurements":{"footLength":"11.6"}}]$json$::jsonb,
   'US sizing PLUS a WIDTH LETTER that is part of the product. ON MEN''S NEW BALANCE, "D" IS THE STANDARD WIDTH (B = narrow, D = standard, 2E = wide, 4E = extra wide). THAT IS THE OPPOSITE OF THE WOMEN''S READING IN THIS SAME BRAND, where B is standard and D is WIDE — the same character is correct in both and ONLY the department decides which. Never carry one department''s width reading onto the other. The width is stamped on the tongue label beside the size and it is what a buyer with a wide foot searches; it must be in the listing. THE SIZE IS STAMPED, NOT MEASURED — read the size, the width and the department off the tongue label; a shoe size cannot be inferred from a photo''s proportions. The MODEL NUMBER''S PREFIX also encodes the department (M990 = men''s, W990 = women''s, U327 = unisex), so it cross-checks the stamp. MADE IN USA (990/993/992) and MADE IN ENGLAND (1500/577) are higher-spec LINES at a materially higher band — the sizing is comparable, the value is not. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.newbalance.com/', 0.55, false, 'migration:00459'),

  ('newbalance', 'New Balance', ARRAY['new balance','newbalance']::text[], 'Women', 'Footwear (US/UK/EU + WIDTH — D is WIDE here)',
   ARRAY['footwear','shoe','shoes','sneaker','sneakers','trainer','running','990','574','550','2002r']::text[],
   $json$[{"size":"US W6 = UK 4 = EU 36.5","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 5 = EU 37.5","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 6 = EU 39","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 7 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 8 = EU 41.5","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 9 = EU 42.5","measurements":{"footLength":"10.5"}},{"size":"US W12 = UK 10 = EU 44","measurements":{"footLength":"10.85"}}]$json$::jsonb,
   'US sizing PLUS a WIDTH LETTER that is part of the product. ON WOMEN''S NEW BALANCE, "B" IS THE STANDARD WIDTH AND "D" IS WIDE (2A = narrow, B = standard, D = wide, 2E = extra wide). THAT IS THE OPPOSITE OF THE MEN''S READING IN THIS SAME BRAND, where D is the STANDARD width — the same character is correct in both readings and ONLY the department decides which. A women''s D-width listed as a plain 990 is a WIDE shoe sold as a regular one, which is a return; and it is a genuinely valuable listing token to the buyer who needs it. Never carry one department''s width reading onto the other. THE SIZE IS STAMPED, NOT MEASURED — read the size, the width and the department off the tongue label. The MODEL NUMBER''S PREFIX cross-checks the department (W574 = women''s, M990 = men''s, U327 = unisex). MADE IN USA / MADE IN ENGLAND are higher-spec LINES at a higher band. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.newbalance.com/', 0.55, false, 'migration:00459'),

  -- Converse — dual-tagged, offset TWO, runs LARGE.
  ('converse', 'Converse', ARRAY['converse','chuck taylor','chuck 70','all star']::text[], 'Unisex', 'Footwear (dual-tagged US M/W — offset TWO, RUNS LARGE)',
   ARRAY['footwear','shoe','shoes','sneaker','sneakers','canvas','chuck','all star','high top','low top']::text[],
   $json$[{"size":"US M5 = US W7 = UK 5 = EU 37.5","measurements":{"footLength":"9.25"}},{"size":"US M6 = US W8 = UK 6 = EU 39","measurements":{"footLength":"9.6"}},{"size":"US M7 = US W9 = UK 7 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US M8 = US W10 = UK 8 = EU 41.5","measurements":{"footLength":"10.2"}},{"size":"US M9 = US W11 = UK 9 = EU 42.5","measurements":{"footLength":"10.6"}},{"size":"US M10 = US W12 = UK 10 = EU 44","measurements":{"footLength":"10.9"}},{"size":"US M11 = US W13 = UK 11 = EU 45","measurements":{"footLength":"11.25"}},{"size":"US M12 = UK 12 = EU 46.5","measurements":{"footLength":"11.6"}}]$json$::jsonb,
   'CONVERSE DUAL-TAGS men''s AND women''s on ONE label, and THE OFFSET IS TWO: a Converse M8 is a W10. VANS IS NOT THE SAME — the same kind of black canvas lace-up, the same price band, the same shelf, and an offset of ONE AND A HALF (a Vans M8 is a W9.5). The two brands are adjacent enough that an offset learned on one gets silently applied to the other, and NO PHOTO CAN CATCH IT. That is why both numbers are written into every size label here. Read BOTH off the actual tag; never compute one brand''s offset with the other''s. CONVERSE RUNS LARGE — the brand''s own long-standing guidance is to size DOWN a half size. Report the STAMPED numbers plus that guidance; never silently adjust the size you list. THE SIZE IS STAMPED, NOT MEASURED. CHUCK 70 IS NOT A STANDARD CHUCK and both are in production NOW: the sizing is comparable but the value is not — check the midsole (glossy egret) and the heel (black license plate, vintage star-chevron patch) before pricing. Body-equivalent approximations, not brand-published specs.',
   'https://www.converse.com/', 0.55, false, 'migration:00459'),

  -- Vans — dual-tagged, offset ONE AND A HALF.
  ('vans', 'Vans', ARRAY['vans','old skool','sk8-hi','vault by vans']::text[], 'Unisex', 'Footwear (dual-tagged US M/W — offset ONE AND A HALF)',
   ARRAY['footwear','shoe','shoes','sneaker','sneakers','skate','canvas','old skool','sk8-hi','slip-on','authentic','era']::text[],
   $json$[{"size":"US M5 = US W6.5 = UK 4.5 = EU 37","measurements":{"footLength":"9.25"}},{"size":"US M6 = US W7.5 = UK 5.5 = EU 38.5","measurements":{"footLength":"9.6"}},{"size":"US M7 = US W8.5 = UK 6.5 = EU 39.5","measurements":{"footLength":"9.9"}},{"size":"US M8 = US W9.5 = UK 7.5 = EU 41","measurements":{"footLength":"10.2"}},{"size":"US M9 = US W10.5 = UK 8.5 = EU 42.5","measurements":{"footLength":"10.6"}},{"size":"US M10 = US W11.5 = UK 9.5 = EU 43.5","measurements":{"footLength":"10.9"}},{"size":"US M11 = US W12.5 = UK 10.5 = EU 45","measurements":{"footLength":"11.25"}},{"size":"US M12 = UK 11.5 = EU 46.5","measurements":{"footLength":"11.6"}}]$json$::jsonb,
   'VANS DUAL-TAGS men''s AND women''s on ONE label, and THE OFFSET IS ONE AND A HALF: a Vans M8 is a W9.5. CONVERSE IS NOT THE SAME — the same kind of black canvas lace-up, the same price band, the same shelf, and an offset of TWO (a Converse M8 is a W10). The two brands are adjacent enough that an offset learned on one gets silently applied to the other, and NO PHOTO CAN CATCH IT. That is why both numbers are written into every size label here. Read BOTH off the actual tag; never compute one brand''s offset with the other''s. THE SIZE IS STAMPED, NOT MEASURED — read it off the tongue/insole label, never infer it from a photo. VAULT BY VANS / OG is the premium LINE at a materially higher band and is near-identical in silhouette: the sizing is comparable, the value is not — check the label for "OG"/"LX"/"Vault". Note the MODEL is genuinely legible here (Old Skool = side stripe; Authentic = no stripe, no padding; Era = no stripe, PADDED collar — needs a side-on photo). Body-equivalent approximations, not brand-published specs.',
   'https://www.vans.com/', 0.55, false, 'migration:00459'),

  -- UGG — RUNS LARGE, and the sheepskin packs down.
  ('ugg', 'UGG', ARRAY['ugg','uggs','ugg australia']::text[], 'Women', 'Footwear (US/UK/EU — RUNS LARGE, whole sizes)',
   ARRAY['footwear','shoe','shoes','boot','boots','slipper','slippers','sheepskin','classic','mini','tasman']::text[],
   $json$[{"size":"US W5 = UK 3.5 = EU 36","measurements":{"footLength":"8.55"}},{"size":"US W6 = UK 4.5 = EU 37","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 5.5 = EU 38","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 6.5 = EU 39","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 7.5 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 8.5 = EU 41","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 9.5 = EU 42","measurements":{"footLength":"10.5"}}]$json$::jsonb,
   'UGG RUNS LARGE — the brand''s own guidance is to size DOWN, and the classic sheepskin boots are WHOLE SIZES ONLY (there is no half-size run on the Classics). AND THE SHEEPSKIN PACKS DOWN: the lining COMPRESSES and moulds to its wearer''s foot with use, so a worn pair fits LARGER than a new pair of the same stamped size. The two effects compound, and BOTH are the material behaving as designed. That flattening is NORMAL WEAR — worth DISCLOSING as wear, but it is NOT a defect of manufacture, the boot is not "stretched out", and it must not be graded as damage. THE SIZE IS STAMPED, NOT MEASURED — read it off the label; never infer a shoe size from a photo, and never silently adjust the stamped number for the size-down guidance (report the stamp AND the guidance). "UGG AUSTRALIA" on the label DATES a pair (the branding until ~2016) and does NOT mean made in Australia — never turn it into a provenance claim. Note the SLIPPERS (Tasman, Mini/Ultra Mini) often out-resell the tall Classic. Body-equivalent approximations, not brand-published specs.',
   'https://www.ugg.com/', 0.55, false, 'migration:00459'),

  ('ugg', 'UGG', ARRAY['ugg','uggs','ugg australia']::text[], 'Men', 'Footwear (US/UK/EU — RUNS LARGE, whole sizes)',
   ARRAY['footwear','shoe','shoes','boot','boots','slipper','slippers','sheepskin','classic','tasman','neumel']::text[],
   $json$[{"size":"US M7 = UK 6 = EU 39.5","measurements":{"footLength":"9.6"}},{"size":"US M8 = UK 7 = EU 40.5","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8 = EU 42","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9 = EU 43","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10 = EU 44.5","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11 = EU 45.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12 = EU 47","measurements":{"footLength":"11.6"}}]$json$::jsonb,
   'UGG menswear RUNS LARGE on the same guidance as the women''s line — size DOWN, and the classics are WHOLE SIZES ONLY. THE SHEEPSKIN PACKS DOWN with wear (it moulds to the foot), so a worn pair fits larger than a new pair of the same stamped size: that is NORMAL WEAR and the material behaving as designed — disclose it, never grade it as a defect or call the boot "stretched out". THE SIZE IS STAMPED, NOT MEASURED — report the stamped number plus the brand''s size-down guidance rather than silently adjusting the size you list. The Tasman slipper is dual-listed across departments and is a high-demand resale silhouette. Body-equivalent approximations, not brand-published specs.',
   'https://www.ugg.com/', 0.55, false, 'migration:00459'),

  -- Cole Haan — US dress sizing + widths.
  ('colehaan', 'Cole Haan', ARRAY['cole haan','colehaan']::text[], 'Men', 'Footwear (US/UK/EU + width)',
   ARRAY['footwear','shoe','shoes','dress shoe','loafer','oxford','wingtip','sneaker','zerogrand','grandpro']::text[],
   $json$[{"size":"US M7 = UK 6.5 = EU 40","measurements":{"footLength":"9.6"}},{"size":"US M8 = UK 7.5 = EU 41","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8.5 = EU 42","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9.5 = EU 43","measurements":{"footLength":"10.6"}},{"size":"US M10.5 = UK 10 = EU 44","measurements":{"footLength":"10.8"}},{"size":"US M11 = UK 10.5 = EU 44.5","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11.5 = EU 45.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12.5 = EU 47","measurements":{"footLength":"11.6"}}]$json$::jsonb,
   'US dress sizing with WIDTHS (B narrow, C, D standard, E, EEE extra wide) — the width is stamped beside the size and belongs in the listing. NOTE the width letters read as they do on MEN''S New Balance (D = standard), but do NOT carry that reading onto a WOMEN''S shoe of any brand: on women''s New Balance in this same pack, D means WIDE. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole; a dress-shoe size cannot be inferred from a photo. THE CONSTRUCTION SETS THE VALUE AND THE UPPER DOES NOT SHOW IT: a GOODYEAR-WELTED shoe is resoleable and holds value worn, a CEMENTED (glued) shoe is not economically resoleable and is worth far less once the sole is gone — the tell is the WELT STITCH at the sole EDGE and it needs a SOLE-EDGE photo. If it is not photographed, say the construction is UNCONFIRMED rather than assuming welted. THE SOLE AND HEEL ARE THE GRADE on a dress shoe (heel-cap wear, sole thinning at the ball, a broken-down heel counter, vamp creasing) and none of it appears in the three-quarter product shot every seller takes — require a sole photo and a heel-on photo, and say the sole is UNSEEN rather than grading the upper and calling it the shoe. A NIKE AIR / LUNARLON mark inside a pre-2012 pair is GENUINE and period-correct, not a fake. Body-equivalent approximations, not brand-published specs.',
   'https://www.colehaan.com/', 0.55, false, 'migration:00459'),

  ('colehaan', 'Cole Haan', ARRAY['cole haan','colehaan']::text[], 'Women', 'Footwear (US/UK/EU)',
   ARRAY['footwear','shoe','shoes','dress shoe','loafer','flat','pump','heel','sneaker','zerogrand','grandpro']::text[],
   $json$[{"size":"US W5 = UK 2.5 = EU 35","measurements":{"footLength":"8.55"}},{"size":"US W6 = UK 3.5 = EU 36.5","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 4.5 = EU 37.5","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 5.5 = EU 38.5","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 6.5 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 7.5 = EU 41","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 8.5 = EU 42","measurements":{"footLength":"10.5"}}]$json$::jsonb,
   'US women''s dress sizing; widths (A narrow, B standard, C/D wide) are stamped beside the size where the shoe carries them. NOTE the width letters mean what they mean HERE and must not be carried across brands or departments: on women''s New Balance in this same pack, D means WIDE while on men''s New Balance D means STANDARD. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole. THE CONSTRUCTION SETS THE VALUE: a GOODYEAR-WELTED shoe is resoleable and holds value worn, a CEMENTED (glued) shoe is not economically resoleable — the tell is the WELT STITCH at the SOLE EDGE and it needs a sole-edge photo; if unphotographed, say the construction is UNCONFIRMED. THE SOLE AND HEEL ARE THE GRADE (heel-cap wear, sole thinning at the ball, a broken-down heel counter) and none of it shows in the standard three-quarter photo — require a sole photo and say the sole is UNSEEN rather than grading the upper and calling it the shoe. A NIKE AIR / LUNARLON mark inside a pre-2012 pair is GENUINE and period-correct. Body-equivalent approximations, not brand-published specs.',
   'https://www.colehaan.com/', 0.55, false, 'migration:00459')

on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00459') on conflict do nothing;
