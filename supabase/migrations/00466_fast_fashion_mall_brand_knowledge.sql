-- US-1986: Fast-fashion & mall brand knowledge, tier 2 (10 brands).
--
-- Zara, H&M, Urban Outfitters, Express, LOFT, Ann Taylor, Talbots, Lucky Brand,
-- Brandy Melville, PacSun. The high-VOLUME staples tier beside 00458
-- (Gap / Old Navy / Banana Republic / A&F / American Eagle / Uniqlo / Tommy /
-- Hollister) and 00457 (the contemporary women's pack), neither re-touched.
--
-- ALL TEN WERE PASSTHROUGH-ONLY — not even the bare alias-only shells 00389 left
-- for the activewear group. So a "brandy melville" tag rendered the seller's own
-- casing into the prompt block and the eBay Brand aspect, on garments that arrive
-- more often than anything else in the catalogue.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MAKES THIS GROUP DIFFERENT FROM EVERY PACK BEFORE IT
--
--   1. THE SAME NUMBER IS TWO DIFFERENT SIZE SYSTEMS, AND ONLY THE BRAND SAYS
--      WHICH. 00458's pack was about the SPREAD — every tag says the same letters
--      and they mean different bodies (a Uniqlo M vs an Old Navy M). This is one
--      level up and an order of magnitude more expensive: a Zara or H&M "38" is
--      an EU size (a ~27.5in waist, ≈US 6-8); a Levi's, Lucky Brand or Express
--      "38" is a WAIST IN INCHES. Two digits, ~10 inches apart, and NOTHING on
--      either tag distinguishes them. The European brands here label in the EU
--      grade; the American ones label US. That is the pack's headline fact and
--      every chart states its SYSTEM in the `garment` string because of it.
--
--   2. AND THE CONVERSION ITSELF IS DISPUTED — BY A FULL SIZE. This is the fact
--      the research turned up that changed the design. The sources do not agree:
--      Zara's grade runs through the UK (EU 38 = UK 10 = US 6), while H&M's
--      aggregators use EU = US + 30 (EU 38 = US 8). Both conventions are in live
--      circulation, and NEITHER brand's own size guide is machine-reachable
--      (zara.com and hm.com both serve 403 to automated fetches). So the pack
--      seeds the DISAGREEMENT: every EU label carries a RANGE ("≈US 6-8") and
--      says the EU number is the only certain part. A model told "EU 38 = US 6"
--      would state a precision the evidence does not support.
--
--   3. MOST OF THIS GROUP ARE RETAILERS, NOT MAKERS — and the pack's structure
--      follows from it. PacSun's OWN 10-K puts ~70% of its sales in third-party
--      brands ("Offer Popular Name Brands Supplemented by Proprietary Brands"),
--      so a garment "from PacSun" is more often NOT a PacSun garment. Urban
--      Outfitters is the same shape (URBN distinguishes "Ownbrand" from "market"
--      vendors). Seeded as a first-class `brand_styles` row on both — the
--      00457 Anthropologie precedent — because brandPackPromptBlock renders
--      fingerprints VERBATIM, which is the only way a fact this important is
--      guaranteed to reach the extract prompt. The corollary is the HOUSE LABELS:
--      a BDG or Bullhead tag never says the store's name, so the house label is
--      the only string a seller can read, and every one of them needed an alias.
--
--   4. TWO OF THE TEN BRANDS ARE ORDINARY WORDS THAT THIS PRODUCT'S OWN TEXT
--      EMITS. "express shipping" is boilerplate in the eBay titles
--      detectBrandInText scans, and "loft" is the standard term for a down
--      garment's fill — emitted constantly by the KB's OWN outdoor and
--      luxury-outerwear packs (00453, 00460). Both are in
--      DETECT_EXCLUDED_FROM_TEXT and both are verified by MUTATION in
--      fast-fashion-mall-content_test.ts, not argued.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ZERO DECODERS, AND THE REFUSALS ARE THE DELIVERABLE (all fixtured as negatives
-- in brand-knowledge-golden_test.ts — a refusal that isn't tested is a comment).
-- The bar, from 00460: tag-printed AND regular AND brand-unique in FORMAT.
--
--   * URBAN OUTFITTERS `OB######` — THE HARD ONE, and the closest call in the
--     epic. It is REAL and primary-sourced: URBN's own vendor manual says "All
--     Ownbrand style numbers start with OB, followed by 6 digits", and it is
--     printed on the care tag, so it clears tag-printed AND regular. It fails
--     brand-unique — the code is **URBN-WIDE**, and URBN is Urban Outfitters AND
--     Anthropologie AND Free People. The latter two already own their own packs
--     (00457, 00449) and their own customers (URBN's 10-K: UO 18-28, Free People
--     25-30, Anthropologie 28-45). A decoder here would spell "Urban Outfitters"
--     onto a sibling's garment with DECODER authority, which outranks the AI on
--     conflict. This is US-1985's Reebok refusal exactly: the code was tag-printed
--     and regular and still refused, because the format was adidas's.
--   * ZARA's slash reference (5644/128/800) — the most TEMPTING, because unlike
--     the others it IS on the sewn-in care label and survives the tags being cut.
--     Refused on format certainty: the sources disagree on what the format even
--     is (4/3 vs a third group), and a slash-separated digit run is not
--     brand-unique. Second, independent reason: Zara's lookup only resolves
--     CURRENTLY-SOLD items, so on a years-old resale garment it decodes nothing.
--   * EXPRESS's 8-digit style number — the Lee-101 / PUMA-six-digit rule: a bare
--     digit run is not a brand. Also unreconciled with Express's own 7-digit web
--     product code, and sourced only to a reseller blog.
--   * H&M's "Art. No." — format sourced only to content farms; no evidence it
--     decodes to anything.
--
-- ZERO COLORWAYS, for a duller reason: fast fashion does not use proprietary
-- colorway NAMES the way Nike ("Bred") or Patagonia does. These brands ship
-- "Black", "Ecru", "Camel". There is nothing to seed, and inventing a colorway
-- vocabulary would be pure fabrication.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY **NOT** RECORDED, because it could not be sourced. This
-- list is part of the deliverable: the next person to touch this pack should not
-- re-derive these and quietly guess.
--
--   * RN numbers for H&M, Brandy Melville, Express, PacSun, Ann Taylor, LOFT,
--     Talbots and Lucky Brand. The FTC RN database is auth-gated and returns 401
--     to automated lookups, so NONE of these could be verified. Only two RNs are
--     recorded below, and both are sourced: URBN's 66170 (its own vendor manual)
--     and Zara's 77302 (corroborated across many independent listings of physical
--     garments, but NOT FTC-confirmed — hence the hedge in its note).
--   * "Zara Basic was retired in YEAR" — no such date exists in any source. Zara
--     Basic is still discussed as current.
--   * ZARA'S TAG SYMBOLS (square / circle / triangle). The single most tempting
--     thing to seed here and it is NOT SHIPPED: the sources contradict each other
--     on both the MEANING (fit vs collection) and on which shape maps to which
--     line, and the fit reading is a debunked viral myth. A KB fact that is
--     confidently wrong is worse than an absent one.
--   * "Zara/H&M run small" — folk knowledge. The only real measurement test found
--     cuts BOTH ways (H&M's 14 measured smaller than Zara's 12). Seeded as a
--     hedge in the chart notes, never as an assertion.
--   * A date for Brandy Melville's "One Size" -> "XS/S" switch. The switch is
--     real and sourced; the date is not.
--   * L.O.G.G. / Divided era ranges.
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00465 convention).
-- Confidence is DELIBERATELY UNEVEN and honest: a chart transcribed from an
-- aggregator because the brand serves 403 is 0.55, not 0.9.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('zara', 'Zara',
   ARRAY['zara','zarabasic','zarawoman','zaratrf','trf','trafaluc','zaratrafaluc','zaraman','zarakids','inditex']::text[],
   ARRAY['fast fashion','womenswear','menswear','trend-led basics']::text[],
   ARRAY['RN 77302']::text[],
   $j$[{"era":"Zara Basic / Zara Woman / TRF (Trafaluc) sub-line labels","years":"2000s-present","description":"LINES, not separate brands or size systems, and NOT reliable dating tells: all are still in circulation and no retirement date is sourced for any of them. TRF = Trafaluc, the youth line. The line does not change the size grade."}]$j$::jsonb,
   $j$[{"pattern":"Inditex (Spain) sourcing; garments manufactured across Europe, Turkey, Morocco, Asia","note":"Country of manufacture varies widely and is NOT a Zara authenticity or era signal."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists for Zara, and it is not a meaningfully counterfeited brand. Grade condition only; route any authenticity question to human review."},{"tell":"The tag SYMBOLS (square / circle / triangle) are NOT a usable signal","detail":"Widely-shared readings of Zara's label symbols contradict each other on both meaning (fit vs collection) and on which shape maps to which line, and the 'fit' reading is a debunked viral myth. Do not infer fit or line from a symbol. Read the printed text instead."}]$j$::jsonb,
   'RN 77302 is corroborated across many independent listings of physical Zara garments but is NOT FTC-confirmed (the FTC RN database is auth-gated) — treat as a supporting signal, never as proof. Zara is Europe''s highest-volume fast-fashion label and the single most common EU-sized garment in US resale, which is why the EU-vs-inches rule matters more here than anywhere else in the KB.',
   'https://www.zara.com/', 0.65, false, 'migration:00466'),

  ('hm', 'H&M',
   ARRAY['hm','handm','hennesmauritz','hennesandmauritz','divided','hmdivided','logg','hmlogg','hmstudio','hmman']::text[],
   ARRAY['fast fashion','basics','womenswear','menswear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Conscious / Conscious Choice","years":"~2010-2022","description":"The ONE decent dating tell on an H&M garment: the Conscious sustainability line ran roughly a decade and was discontinued around 2022 following a greenwashing reprimand. A Conscious tag therefore indicates a garment from ~2022 or earlier. The exact end date wobbles between sources — treat the year as approximate."},{"era":"Divided / L.O.G.G. / H&M Studio / MAMA in-store labels","years":"unsourced","description":"H&M's own in-store LINES (L.O.G.G. = 'Label of Graded Goods', the leisure/casual line; Divided = the youth line). They fold onto H&M and share its size grade. NO start/end years are sourced for any of them — do NOT date a garment from these labels."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'brand_key is ''hm'' because brandKey() strips the ampersand from "H&M" — the sizing chart must match on the punctuated "h&m", never a bare "hm". ⚠ COS, Arket, & Other Stories, Weekday and Monki are H&M GROUP brands and are DELIBERATELY NOT folded onto H&M: they are separately branded at distinct tiers (COS sells ABOVE H&M), so folding would price a COS coat off an H&M ladder. The parent company never decides a fold — the Hollister rule (00458). No RN could be sourced for H&M.',
   'https://www2.hm.com/', 0.60, false, 'migration:00466'),

  ('urbanoutfitters', 'Urban Outfitters',
   ARRAY['urbanoutfitters','urbanoutfitterinc','uo','urban','bdg','outfromunder','silencenoise','silenceandnoise','ecote','kimchiblue','urbanrenewal','ietsfrans','lightbeforedark']::text[],
   ARRAY['fast fashion','youth','denim','house labels','multi-brand retailer']::text[],
   ARRAY['RN 66170','CA 32054']::text[],
   $j$[{"era":"House-label woven tags (BDG, Out From Under, Silence + Noise, Ecote, Kimchi Blue, Urban Renewal, iets frans, Light Before Dark)","years":"current","description":"URBN specs a SEPARATE woven label per house brand with no Urban Outfitters cross-branding, so the sewn-in tag names the house label and NOT the store. That is why each house label needs its own alias: it is the only string a seller can read off the garment."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."},{"tell":"RN 66170 identifies URBN, NOT Urban Outfitters","detail":"The RN is shared across URBN — Urban Outfitters, Anthropologie AND Free People — so it CANNOT disambiguate the three sibling brands. Pair it with the brand label; never attribute on the RN alone. It also only appears when the vendor lacks its own RN, so its absence rules nothing out."}]$j$::jsonb,
   'RN 66170 / CA 32054 are primary-sourced from URBN''s own vendor manual. ⚠ Anthropologie and Free People are SIBLING brands with their own packs (00457, 00449) and their own target customers (URBN''s 10-K: UO 18-28, Free People 25-30, Anthropologie 28-45) — never fold them onto Urban Outfitters. Note URBN is the PARENT; Urban Outfitters is a sibling, not the parent (a common web error). The URBN-wide `OB######` style number is the reason this pack seeds no decoder — see the migration header.',
   'https://www.urbanoutfitters.com/', 0.75, false, 'migration:00466'),

  ('express', 'Express',
   ARRAY['express','expressinc','expressmen','expresswomen','limitedexpress']::text[],
   ARRAY['mall','wear-to-work','womenswear','menswear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"Limited Express\" label","years":"1980-1982 (possibly lingering to ~1985)","description":"The brand opened in 1980 as Limited Express under The Limited and dropped \"Limited\" from the name in 1982. A \"Limited Express\" tag is therefore an early-1980s garment — the cleanest dating tell Express has."},{"era":"\"Structure\" label","years":"1989-2001","description":"Structure was Express's menswear label, spun off in 1989 and reabsorbed as \"Express Men\" in 2001. ⚠ Express SOLD the Structure name to Sears in 2003, so a Structure tag is an Express garment ONLY in the 1989-2001 window — a later one is Sears'. This is why \"structure\" is deliberately NOT a brand alias: an alias cannot express \"only when pre-2003\"."},{"era":"PHOENIX / licensee-produced Express","years":"mid-2024-present","description":"Express filed Chapter 11 in April 2024 and its assets were acquired by PHOENIX (WHP Global / Simon / Brookfield) in June 2024. Post-2024 goods are licensee-produced, so expect a discontinuity in trim, tag stock and construction quality — do not assume tag/quality consistency across that boundary when dating or grading."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'The canonical "Express" is an ORDINARY WORD and is in DETECT_EXCLUDED_FROM_TEXT: "express shipping" is boilerplate in the eBay titles detectBrandInText scans, and longest-first ordering would make "Express" (7 chars) BEAT a real "Nike" (4) in the same string. The brand stays fully reachable by TAG. No RN could be sourced.',
   'https://www.express.com/', 0.70, false, 'migration:00466'),

  ('brandymelville', 'Brandy Melville',
   ARRAY['brandymelville','brandymelvilleusa','brandy']::text[],
   ARRAY['fast fashion','youth','womenswear','one size']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"One Size\" / \"One Size Fits All\" / \"One Size Fits Most\" tag","years":"earlier (no reliable switch date)","description":"The brand historically tagged nearly everything \"One Size Fits All\", later softened to \"One Size Fits Most\". CURRENT tags say \"XS/S\" instead. So the tag TEXT is a rough dating tell — a \"One Size\" tag is the older generation. ⚠ NO reliable date for the switch is sourced: do not state a year, and handle BOTH tag texts."}]$j$::jsonb,
   $j$[{"pattern":"Made in China is common on current product","note":"⚠ Italian-FOUNDED does not mean Made in Italy — Brandy's own product pages list China. Do not treat \"Made in Italy\" as a Brandy tell, and do not infer Italian manufacture from the brand's origin."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Founded by the Marsan family in Italy in the early 1980s; the US debut was Westwood (Los Angeles) in 2009, after which the brand pivoted to a California aesthetic for the US market. THE SIZING IS THE WHOLE PACK: "One Size" here means SMALL (≈US 00-4 / XS-S), not universal — see the size chart. Brandy publishes NO global size chart, only per-garment measurements, so every "Brandy Melville size chart" circulating on the web is SEO fabrication and must never be recalled as fact. No RN could be sourced.',
   'https://us.brandymelville.com/', 0.70, false, 'migration:00466'),

  ('pacsun', 'PacSun',
   ARRAY['pacsun','pacificsunwear','pacificsunwearofcalifornia','bullhead','bullheaddenim','bullheaddenimco','bullheadblack','pacsundenim','kirra','lahearts','onthebyas','blackpoppy','nollie']::text[],
   ARRAY['multi-brand retailer','youth','surf/skate','denim','house labels']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"Bullhead Denim Co.\" tag","years":"pre-2016","description":"PacSun's house denim label was rebranded to \"PacSun Denim\" around 2016, so a \"Bullhead Denim Co.\" tag indicates a pre-2016 garment. Its own predecessor label was \"Tilt\" (earliest era). Trade-press sourced — treat the year as approximate."},{"era":"Modern Amusement at PacSun","years":"fiscal 2010+","description":"PacSun began LICENSING Modern Amusement from a third party (Dirty Bird Productions) in fiscal 2010. ⚠ It is NOT a PacSun house brand — do not attribute it to PacSun."},{"era":"Kendall + Kylie at PacSun","years":"early fiscal 2013+","description":"Launched as a PacSun-EXCLUSIVE line. ⚠ It later sold well beyond PacSun, so a Kendall + Kylie tag does NOT imply PacSun provenance for later years. Exclusivity of a line is not ownership of a mark."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'PACSUN IS PRIMARILY A MULTI-BRAND RETAILER, and this is the most important fact in the row: by its own 10-K, proprietary brands were only ~28-31% of net sales — so roughly 70% of what it sells carries ANOTHER company''s tag. "From PacSun" is therefore not a brand claim. The house brands (named in the 10-K: Bullhead, Kirra, LA Hearts, On the Byas, Black Poppy, Nollie) are the only ones that make a garment a PacSun garment. Seeded as a first-class brand_styles row below. No RN could be sourced.',
   'https://www.pacsun.com/', 0.70, false, 'migration:00466'),

  -- ── The KnitWell three: Ann Taylor, LOFT, Talbots ────────────────────────
  -- ONE PARENT, THREE CANONICALS, AND THAT IS THE POINT. KnitWell Group owns all
  -- three, and they still must not merge: different price bands, separate eBay
  -- brand nodes, separate buyers. The parent COMPANY never decides a fold —
  -- 00458's Hollister rule, and this is the epic's clearest instance of it since
  -- all three sit under one roof.
  ('anntaylor', 'Ann Taylor',
   ARRAY['anntaylor','anntaylorfactory']::text[],
   ARRAY['mall','wear-to-work','womenswear','classic']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Ann Taylor Factory (made-for-outlet line)","years":"current","description":"A DISTINCT QUALITY TIER, not just a discount: Ann Taylor Factory goods are MADE FOR THE OUTLET rather than being mainline stock marked down, so construction, fabric and trim are specified lower. It folds onto Ann Taylor (eBay has no separate catalogue brand for it) but the tier is a real grading and pricing fact — disclose it, never silently treat a Factory piece as mainline."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Founded 1954 in New Haven CT and named after a bestselling DRESS, not a person — there is no Ann Taylor. Ownership: AnnTaylor Stores -> Ann Inc. (2011) -> Ascena (2015) -> Sycamore/Premium Apparel (Dec 2020) -> KnitWell Group (Aug 2023), which ALSO owns LOFT and Talbots. ⚠ The 2020 Chapter 11 was ASCENA''s, not Ann Taylor''s or LOFT''s own — do not describe either brand as having gone bankrupt. ⚠ ANN TAYLOR AND LOFT PUBLISH THE SAME BODY CHART (identical through size 14, diverging only at 16/18), so their sizes are interchangeable even though LOFT sells ~30-40% cheaper — see the size charts. No RN could be sourced.',
   'https://www.anntaylor.com/', 0.75, false, 'migration:00466'),

  ('loft', 'LOFT',
   ARRAY['loft','anntaylorloft','loftoutlet']::text[],
   ARRAY['mall','womenswear','casual','moderate-price']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"Ann Taylor Loft\" label -> standalone \"LOFT\"","years":"transition ~2007-2009","description":"⚠ A GRADUAL TRANSITION, NOT AN EVENT, and NOT SAFE AS A TAG-DATING RULE. Traced through consecutive SEC 10-Ks the brand name moved \"Ann Taylor Loft\" (2006) -> \"Ann Taylor Loft (LOFT)\" (2007) -> both forms (2008) -> standalone \"LOFT\" (2009). BUT: (a) that is CORPORATE naming, and it was NOT verified when the physical GARMENT TAG changed; (b) the \"AnnTaylor Loft\" trademark and the anntaylorloft.com URL both outlived the rename. So an \"Ann Taylor LOFT\" tag suggests an earlier garment and NOTHING MORE — do not assign it a year."},{"era":"LOFT Plus (sizes 20-26)","years":"Feb 2018 - fall 2021","description":"THE BRAND'S ONE CLEAN DATING TELL. LOFT Plus launched 5 Feb 2018 extending the range to 26, and was discontinued in 2021 with the range returning to 00-18/XXS-XXL. So a LOFT garment in SIZE 20-26 dates to that window. Both endpoints are sourced from LOFT's own press release and contemporaneous trade press."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'LOFT launched in 1996 as outlet-centre conversions; the first non-outlet stores opened 1998. It is Ann Taylor''s SISTER brand under one parent (now KnitWell Group) and DOES NOT FOLD ONTO IT: per the company''s own filings LOFT is the "moderate-price" line for the same customer''s "more relaxed lifestyle" — roughly 30-40% below Ann Taylor — and eBay carries the two as SEPARATE brand nodes. An "Ann Taylor LOFT" tag is a LOFT garment, so it canonicalizes to LOFT and not to the parent whose name it carries (the Burberrys-with-an-S play). LOFT Outlet is a made-for-outlet tier, like Ann Taylor Factory. ⚠ The canonical "LOFT" is an ORDINARY WORD and is in DETECT_EXCLUDED_FROM_TEXT — "loft" is the standard term for a down garment''s fill, emitted constantly by the KB''s own outdoor packs (00453, 00460), and it would BEAT a real "Gap" on length. The brand stays reachable by TAG. No RN could be sourced.',
   'https://www.loft.com/', 0.75, false, 'migration:00466'),

  ('talbots', 'Talbots',
   ARRAY['talbots','thetalbots']::text[],
   ARRAY['mall','classic','womenswear','misses/petite/plus']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Founded 1947 in Hingham MA by Rudolf and Nancy Talbot. Ownership: General Mills (1973-88) -> JUSCO/AEON (1988-2012) -> Sycamore (Aug 2012) -> KnitWell Group (2023), alongside Ann Taylor and LOFT — which it must NOT merge with. THE SIZING IS THE PACK-RELEVANT FACT AND THE COMMONLY-REPEATED RANGES ARE WRONG: misses is 2-18 (NOT 2-20), petite starts at 0P and runs 0P-16P (NOT 2P), and plus is 14W-26W (NOT 14W-24W) — all three verified against Talbots'' own live charts. Talbots'' published chart measures LARGER at the same nominal size than youth-targeted brands (a peer-reviewed study of 54 retailers'' published charts), but that is NOT evidence of vanity sizing: the study compared CHARTS rather than garments, and an older target customer may simply be fitted accurately. No RN could be sourced.',
   'https://www.talbots.com/', 0.75, false, 'migration:00466'),

  ('luckybrand', 'Lucky Brand',
   ARRAY['lucky','luckybrand','luckybrandjeans','luckyjeans','luckybranddungarees']::text[],
   ARRAY['denim','casual','americana','womenswear','menswear']::text[],
   ARRAY['RN 80318']::text[],
   $j$[{"era":"Tags printing \"RN#80318\"","years":"2004 or later","description":"A DATING TELL WITH AN UNUSUAL SOURCE: \"RN#80318\" is not merely Lucky's registered identification number, it is itself a REGISTERED TRADEMARK whose first use in commerce is recorded as 25 Aug 2004. So a tag that prints the RN as a design element implies a 2004-or-later garment. Treat as a soft signal."},{"era":"Ownership eras","years":"1990-present","description":"Founded 1990 in Vernon CA by Gene Montesano and Barry Perlman; Liz Claiborne bought 85% in 1999; Leonard Green & Partners bought it Dec 2013; Chapter 11 on 3 July 2020, after which Authentic Brands Group acquired the IP and SPARC the operations. Since Jan 2025 ABG owns the mark and Catalyst Brands (SPARC + JCPenney) operates it under licence. Expect trim/quality discontinuities across the 2020 boundary."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."},{"tell":"The \"Lucky You\" fly message is REAL but is NOT the version the internet repeats","detail":"SOURCED (Lucky's own company history): co-founder Gene Montesano wanted \"a message in the fly\" and chose the phrase \"Lucky You\" as a deliberate double entendre, c.1990 — and it drove real demand. ⚠ NOT SOURCED, and widely repeated as fact: that it is \"two four-leaf clovers with LUCKY YOU stitched on the outside of the fly shield\" on ALL Lucky jeans. That sentence traces to an UNCITED Wikipedia line and the web has laundered it into confident prose — the clover count, the stitching, the placement and the word \"all\" are all unverified, as is whether current production still does it. A \"LUCKY ME\" variant is folklore. It is also NOT button-fly-only: a fly shield exists on zip flies too. Treat a \"Lucky You\" fly as SUPPORTING evidence, never as a test, and never assert its exact form."}]$j$::jsonb,
   'CANONICAL IS "Lucky Brand", NOT "Lucky" — a bare "Lucky" is an ordinary adjective and canonicals are regex-scanned over free text by detectBrandInText, so the short form survives as an exact-key alias only (the AG Jeans / Hudson Jeans play). The long form is not ordinary prose, so unlike "On Running" (00465) it needs no text exclusion. RN 80318 is FTC-record sourced (LUCKY OPCO LLC) — the only FTC-confirmed RN in this pack. SIZING: jeans are sold by WAIST IN INCHES for BOTH genders (men''s 28-42 x inseam 30-38; women''s 24-35) — this is the direct foil to Zara/H&M in the same pack, where the same two digits are an EU size.',
   'https://www.luckybrand.com/', 0.80, false, 'migration:00466')
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
-- A NOTE ON WHAT A "STYLE" IS IN THIS PACK, because it is not what it was in the
-- others. 00465 could seed a Disruptor II or a Cloud 5 — durable, named products
-- with a shape you can see. FAST FASHION HAS ALMOST NONE OF THAT: Zara's and
-- H&M's catalogues turn over in weeks and carry no continuity styles, so there is
-- no "Editor Pant" equivalent to seed and inventing one would be fabrication.
--
-- What IS durable and identifiable for those two is the LINE (Zara Woman, TRF,
-- Divided, L.O.G.G.), which is printed on the tag and means something. So the
-- lines are seeded as rows, with the fingerprint explaining what the line tells
-- you — and, for Zara and H&M, explicitly saying that a named style is NOT
-- recoverable, which stops the model inventing one. Express, whose signature
-- styles are real and permanent, gets actual styles.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- Zara — lines, plus the no-named-style rule.
  ('zara', 'Zara Woman', 'Women', 'line', 'Line',
   'The mainline women''s label — the broadest and most common Zara tag. A LINE, NOT A STYLE: Zara''s catalogue turns over every few weeks and carries essentially NO continuity styles, so there is usually no named style to recover from a Zara garment and one must NOT be invented. Identify the LINE from the tag and stop there. The line does not change the size grade (all Zara lines use the EU grade).',
   ARRAY[]::text[], '2000s-present', '$$', ARRAY['zara woman','line','eu sizing']::text[],
   'https://www.zara.com/', 0.65, false, 'migration:00466'),
  ('zara', 'Zara TRF (Trafaluc)', 'Women', 'line', 'Line',
   'The YOUTH line — TRF stands for Trafaluc, and both the initials and the full word appear on tags. Trends younger, more casual and more trend-led than Zara Woman; heavy on denim and jersey. A LINE, NOT A STYLE. Same EU size grade as every other Zara line — the line is not a size system.',
   ARRAY[]::text[], '2000s-present', '$-$$', ARRAY['trf','trafaluc','youth line']::text[],
   'https://www.zara.com/', 0.65, false, 'migration:00466'),
  ('zara', 'Zara Basic', 'Women', 'line', 'Line',
   'The staples/basics line. A LINE, NOT A STYLE. ⚠ NOT A RELIABLE DATING TELL: it is widely claimed that Zara Basic marks an older garment, but NO retirement date for the line is sourced and it is still discussed as current — do NOT date a garment from this label.',
   ARRAY[]::text[], 'unsourced — do not date from this label', '$-$$', ARRAY['zara basic','basics','line']::text[],
   'https://www.zara.com/', 0.50, false, 'migration:00466'),
  ('zara', 'Zara Man', 'Men', 'line', 'Line',
   'The mainline menswear label. A LINE, NOT A STYLE — the same no-continuity-styles rule applies. Menswear uses alpha sizing (S/M/L) and EU-graded numerics for tailoring and denim; the EU-vs-inches rule applies to the numbers exactly as it does on the women''s side.',
   ARRAY[]::text[], '2000s-present', '$$', ARRAY['zara man','menswear','line']::text[],
   'https://www.zara.com/', 0.65, false, 'migration:00466'),

  -- H&M — lines, one of which is the group's only good dating tell.
  ('hm', 'Divided', 'Women', 'line', 'Line',
   'H&M''s YOUTH line — trend-led, cheapest tier, heavy on jersey and denim. Its tag frequently says only "Divided" with no "H&M" beside it, which is why it needs its own alias. A LINE, NOT A STYLE, and it shares H&M''s EU size grade. No start/end years are sourced — do NOT date a garment from this label.',
   ARRAY[]::text[], 'unsourced — do not date from this label', '$', ARRAY['divided','youth line','h&m']::text[],
   'https://www2.hm.com/', 0.60, false, 'migration:00466'),
  ('hm', 'L.O.G.G.', 'Unisex', 'line', 'Line',
   'Stands for "Label of Graded Goods" — H&M''s leisure/casual line. Like Divided, the tag often carries only the L.O.G.G. mark and never "H&M". A LINE, NOT A STYLE. No era range is sourced — do NOT date from it.',
   ARRAY[]::text[], 'unsourced — do not date from this label', '$-$$', ARRAY['logg','label of graded goods','casual']::text[],
   'https://www2.hm.com/', 0.60, false, 'migration:00466'),
  ('hm', 'Conscious / Conscious Choice', 'Unisex', 'line', 'Line',
   'THE ONE GOOD DATING TELL ON AN H&M GARMENT. The sustainability line ran roughly 2010-2022 and was discontinued around 2022 following a greenwashing reprimand, so a Conscious / Conscious Choice tag means the garment is from ~2022 OR EARLIER. Typically marked with a green tag. ⚠ The end date wobbles between sources — treat the year as approximate and never state it as exact.',
   ARRAY['recycled polyester','organic cotton']::text[], '~2010-2022 (approximate)', '$-$$',
   ARRAY['conscious','conscious choice','sustainability','dating tell']::text[],
   'https://www2.hm.com/', 0.60, false, 'migration:00466'),

  -- Urban Outfitters — the house labels, plus THE RETAILER TRAP.
  ('urbanoutfitters', 'Third-Party Brand at Urban Outfitters', 'Unisex', 'label', 'Retailer',
   'NOT a garment and NOT a line — THE RETAILER TRAP, seeded as a first-class row because it is a common way this brand is read wrong. Urban Outfitters sells its OWN house labels alongside many THIRD-PARTY brands (URBN distinguishes "Ownbrand" vendors from "market" vendors). A garment BOUGHT at Urban Outfitters is only an Urban Outfitters garment if it carries a HOUSE label (BDG, Out From Under, Silence + Noise, Ecote, Kimchi Blue, Urban Renewal, iets frans, Light Before Dark). If the tag names some other brand, THAT is the brand — the store is not. ⚠ It is ALSO not Anthropologie or Free People: those are URBN SIBLINGS with their own packs, and the shared URBN RN (66170) cannot tell the three apart.',
   ARRAY[]::text[], null, null, ARRAY['retailer','third party','not a house label','urbn']::text[],
   'https://www.urbanoutfitters.com/', 0.70, false, 'migration:00466'),
  ('urbanoutfitters', 'BDG', 'Unisex', 'denim', 'House label',
   'URBN''s house DENIM label and the most common Urban Outfitters garment in resale — named as a UO own-brand in URBN''s 10-K. The tag says BDG and NEVER "Urban Outfitters", so the house label is the only string on the garment. Sized by a numeric waist label 25-31 that is NOT the literal body waist (a tagged 25 fits a 24.5in waist). Broad, casual fits — mom/dad/baggy/carpenter silhouettes rather than performance stretch denim.',
   ARRAY['rigid cotton denim','cotton twill']::text[], 'current', '$$',
   ARRAY['bdg','denim','jeans','house label','mom jean']::text[],
   'https://www.urbanoutfitters.com/', 0.75, false, 'migration:00466'),
  ('urbanoutfitters', 'Out From Under', 'Women', 'intimates', 'House label',
   'UO''s intimates / loungewear / swim house label. Tag carries only the house name. Soft knits, ribbed jersey, seamless and lounge-weight pieces rather than structured garments.',
   ARRAY['ribbed knit','seamless jersey']::text[], 'current', '$-$$',
   ARRAY['out from under','intimates','lounge','house label']::text[],
   'https://www.urbanoutfitters.com/', 0.70, false, 'migration:00466'),
  ('urbanoutfitters', 'Urban Renewal', 'Unisex', 'vintage/remade', 'House label',
   'UO''s VINTAGE and REMADE line — genuinely distinct from the other house labels for grading, and that is why it is seeded. Pieces are either true vintage or reworked from existing garments, so WEAR AND IRREGULARITY MAY BE ORIGINAL TO THE PRODUCT RATHER THAN DAMAGE: an Urban Renewal piece can be sold new with fading, patina, visible repairs or asymmetry BY DESIGN. Do not grade the intended character down as defects; do grade genuine post-sale damage. One-of-one and small-run by nature, so a named style is usually not recoverable.',
   ARRAY['vintage cotton','remade/patchwork']::text[], 'current', '$$',
   ARRAY['urban renewal','vintage','remade','reworked','house label']::text[],
   'https://www.urbanoutfitters.com/', 0.65, false, 'migration:00466'),
  ('urbanoutfitters', 'Silence + Noise', 'Women', 'apparel', 'House label',
   'UO''s trend-led women''s house label — going-out and statement pieces rather than basics. Tag carries only the house name.',
   ARRAY[]::text[], 'current', '$$', ARRAY['silence noise','silence + noise','house label']::text[],
   'https://www.urbanoutfitters.com/', 0.65, false, 'migration:00466'),

  -- Express — the only brand here with REAL, permanent signature styles.
  ('express', 'Portofino Shirt', 'Women', 'top', 'Signature',
   'Express''s signature blouse and the one style in this pack that is genuinely IDENTIFIABLE FROM A PHOTO. The tells, in combination: a CONVERTIBLE ROLL-TAB SLEEVE that buttons up to 3/4 length, a POINT COLLAR WITH A NOTCH neckline, TWO BREAST POCKETS, a shirttail hem and buttoned cuffs. Cut from lightweight, often semi-sheer crepe (frequently 100% polyester). Original Fit and Slim Fit variants exist. The twin chest pockets + notch neck + roll-tab sleeve together are what separate it from any generic blouse.',
   ARRAY['polyester crepe','semi-sheer woven']::text[], 'current', '$$',
   ARRAY['portofino','blouse','roll tab sleeve','notch neck']::text[],
   'https://www.express.com/', 0.75, false, 'migration:00466'),
  ('express', 'Editor Pant', 'Women', 'bottom', 'Signature',
   'Express''s flagship wear-to-work trouser and its most-sold style by a wide margin. Per EXPRESS''S OWN description it "sits just below the waist and is straight through the hip and thigh" for a roomier fit. ⚠ NOT RELIABLY SEPARABLE FROM THE COLUMNIST BY PHOTO — the two differ by RISE and LEG WIDTH only, both are plain trousers, and several third-party sources state the distinction BACKWARDS. Identify it from the TAG text, never from the silhouette; if the tag does not name it, do not guess between Editor and Columnist.',
   ARRAY['stretch woven suiting']::text[], 'current', '$$',
   ARRAY['editor','editor pant','trouser','wear to work']::text[],
   'https://www.express.com/', 0.70, false, 'migration:00466'),
  ('express', 'Columnist Pant', 'Women', 'bottom', 'Signature',
   'Express''s other signature trouser, with its own permanent collection. Per Express''s own description it "sits lower on the waist and is more narrow" through the hip and legs than the Editor. ⚠ Same warning as the Editor: the two are a RISE/WIDTH distinction that a flat photo cannot resolve. Read the tag or decline — this pair is exactly why the never-guess rule exists.',
   ARRAY['stretch woven suiting']::text[], 'current', '$$',
   ARRAY['columnist','trouser','wear to work','slim']::text[],
   'https://www.express.com/', 0.70, false, 'migration:00466'),

  -- Brandy Melville — the sizing model IS the style row.
  ('brandymelville', 'One Size / XS-S', 'Women', 'sizing', 'Sizing model',
   'NOT a garment — THE BRAND''S ENTIRE SIZING MODEL, seeded as a first-class row because it is the most misread fact about this brand and it reads as the OPPOSITE of what it means. ⚠ "ONE SIZE" HERE MEANS SMALL, NOT UNIVERSAL: Brandy Melville sells essentially a single small size, roughly US 00-4 / XS-S. It is not a generous one-size-fits-all and it does not fit most people — a listing that implies otherwise mis-sets buyer expectation every time. CURRENT tags say "XS/S"; older ones say "One Size" / "One Size Fits Most", so the tag text is a rough dating tell (NO switch date is sourced — never state a year). BRANDY PUBLISHES NO SIZE CHART, only per-garment measurements, so MEASURE THE GARMENT: every "Brandy Melville size chart" circulating on the web is SEO fabrication. When reading Brandy''s own product-page numbers, a listed "bust" of ~15in is a FLAT PIT-TO-PIT HALF measurement (≈30in circumference), not a circumference.',
   ARRAY[]::text[], null, '$-$$',
   ARRAY['one size','one size fits most','xs/s','sizing']::text[],
   'https://us.brandymelville.com/', 0.75, false, 'migration:00466'),
  ('brandymelville', 'John Galt', 'Women', 'label', 'House label',
   'A label found on Brandy Melville garments. ⚠ SEEDED AT LOW CONFIDENCE AND DELIBERATELY THIN: the relationship between the John Galt mark and Brandy Melville is widely asserted but was NOT verified against a primary source for this pack, so no claim is made here about ownership, era or exclusivity — only that the mark co-occurs. Do NOT canonicalize a John Galt tag to Brandy Melville on the strength of this row; treat it as a hint for a human, not as an attribution.',
   ARRAY[]::text[], null, null, ARRAY['john galt','label','unverified']::text[],
   'https://us.brandymelville.com/', 0.35, false, 'migration:00466'),

  -- PacSun — THE RETAILER TRAP is the headline row, then the house labels.
  ('pacsun', 'Third-Party Brand at PacSun', 'Unisex', 'label', 'Retailer',
   'NOT a garment and NOT a line — THE RETAILER TRAP, and the single most important row in PacSun''s pack. PacSun is primarily a MULTI-BRAND RETAILER: by its OWN 10-K, proprietary brands were only ~28-31% of net sales, so ROUGHLY 70% OF WHAT IT SELLS CARRIES ANOTHER COMPANY''S TAG (Vans, Nike, Billabong, Quiksilver, Roxy, Volcom, Hurley, RVCA, Element and many more). A garment BOUGHT at PacSun is only a PacSun garment if it carries a HOUSE label (Bullhead, Kirra, LA Hearts, Nollie, On the Byas, Black Poppy). If the tag names some other brand, THAT is the brand — the store is not. Reading the store as the brand mis-comps the piece in both directions. ⚠ Modern Amusement (LICENSED from a third party) and Kendall + Kylie (a PacSun-exclusive collab that later sold far beyond PacSun) look like house labels and are NOT.',
   ARRAY[]::text[], null, null, ARRAY['retailer','third party','not a house label']::text[],
   'https://www.pacsun.com/', 0.75, false, 'migration:00466'),
  ('pacsun', 'Bullhead Denim', 'Unisex', 'denim', 'House label',
   'PacSun''s house DENIM label — named as a proprietary brand in its 10-K — and the most common genuine PacSun garment in resale. The tag says Bullhead, never "PacSun". Sized by a numeric waist label 23-32 that is NOT the literal waist (a tagged 23 fits a 24in waist). "BULLHEAD DENIM CO." ON THE TAG IS A DATING TELL: the label was rebranded to "PacSun Denim" around 2016, so the Bullhead Denim Co. mark indicates a pre-2016 garment (its own predecessor label was "Tilt"). "Bullhead Black" is a sub-label. Year approximate — trade-press sourced.',
   ARRAY['cotton denim','stretch denim']::text[], 'pre-2016 as "Bullhead Denim Co."; rebranded PacSun Denim ~2016', '$-$$',
   ARRAY['bullhead','bullhead black','denim','jeans','house label','tilt']::text[],
   'https://www.pacsun.com/', 0.65, false, 'migration:00466'),
  ('pacsun', 'LA Hearts', 'Women', 'apparel', 'House label',
   'A PacSun women''s house brand named in its 10-K — trend-led tops, swim and casual pieces. Tag carries only the house name.',
   ARRAY[]::text[], 'current', '$', ARRAY['la hearts','house label','womens']::text[],
   'https://www.pacsun.com/', 0.65, false, 'migration:00466'),
  ('pacsun', 'Kirra', 'Unisex', 'apparel', 'House label',
   'A PacSun house brand named in its 10-K — surf/casual basics. Tag carries only the house name.',
   ARRAY[]::text[], 'current', '$', ARRAY['kirra','house label','surf','casual']::text[],
   'https://www.pacsun.com/', 0.60, false, 'migration:00466'),

  -- Ann Taylor / LOFT — the outlet tiers and the one clean dating tell.
  ('anntaylor', 'Ann Taylor Factory', 'Women', 'line', 'Outlet line',
   'A MADE-FOR-OUTLET tier, NOT mainline stock marked down — the distinction matters for grading and pricing. Factory goods are specified to a lower construction/fabric/trim standard from the outset, so a Factory blazer is not a discounted mainline blazer. It FOLDS onto Ann Taylor (eBay has no separate catalogue brand for it, so a split would invent one and mis-map the Brand aspect on every listing — the Gap Factory play from 00458), but the tier must be DISCLOSED rather than dropped.',
   ARRAY[]::text[], 'current', '$-$$', ARRAY['ann taylor factory','outlet','made for outlet']::text[],
   'https://www.anntaylor.com/', 0.70, false, 'migration:00466'),
  ('loft', 'LOFT Outlet', 'Women', 'line', 'Outlet line',
   'LOFT''s MADE-FOR-OUTLET tier — the same fact as Ann Taylor Factory: built to a lower spec from the start rather than marked down from mainline. Folds onto LOFT; disclose the tier.',
   ARRAY[]::text[], 'current', '$', ARRAY['loft outlet','outlet','made for outlet']::text[],
   'https://www.loft.com/', 0.70, false, 'migration:00466'),
  ('loft', 'LOFT Plus (sizes 20-26)', 'Women', 'line', 'Line',
   'THE BRAND''S ONE CLEAN DATING TELL, and the only hard date in this pack. LOFT Plus launched 5 Feb 2018, extending the range to size 26, and was discontinued in 2021 — after which LOFT''s range returned to 00-18 / XXS-XXL. So A LOFT GARMENT IN SIZE 20-26 DATES TO FEB 2018 - FALL 2021. Both endpoints are sourced (LOFT''s own press release and contemporaneous trade press), which is why this one gets a real range while the "Ann Taylor LOFT" rename does not.',
   ARRAY[]::text[], 'Feb 2018 - fall 2021', '$-$$',
   ARRAY['loft plus','plus size','20','22','24','26','dating tell']::text[],
   'https://www.loft.com/', 0.75, false, 'migration:00466'),

  -- Talbots — the sizing systems ARE the identifiable content.
  ('talbots', 'Misses / Petite / Plus size systems', 'Women', 'sizing', 'Sizing model',
   'NOT a garment — Talbots'' THREE SIZE SYSTEMS, seeded as a row because the ranges commonly repeated for this brand are WRONG and a model will reproduce them. Per Talbots'' own live charts: MISSES IS 2-18 (not 2-20), PETITE IS 0P-16P (it starts at 0P, not 2P), PLUS IS 14W-26W (not 14W-24W). The "W" is a vestigial "Woman" marker on a range labelled "Plus" today. TALL is a LENGTH option on select styles, not a size category. A "Curvy" fit axis also exists. Talbots'' published chart measures LARGER at the same nominal size than youth-targeted brands — but do NOT call that vanity sizing: the evidence compares published CHARTS, not garments, and an older target customer may simply be fitted accurately.',
   ARRAY[]::text[], null, '$$',
   ARRAY['misses','petite','plus','0p','14w','26w','sizing']::text[],
   'https://www.talbots.com/', 0.75, false, 'migration:00466'),

  -- Lucky Brand — real named fits, and the fly message with its myth stripped out.
  ('luckybrand', 'The "Lucky You" fly message', 'Unisex', 'tell', 'Brand detail',
   'NOT a garment — the brand''s signature detail, seeded WITH ITS MYTH STRIPPED OUT because the myth is what a model will recall. SOURCED, from Lucky''s own company history: co-founder Gene Montesano wanted "a message in the fly" and chose "Lucky You" as a deliberate double entendre around 1990; it drove real demand. ⚠ NOT SOURCED — and repeated everywhere as fact — is the familiar formulation "two four-leaf clovers with LUCKY YOU stitched onto the outside of the fly shield" on ALL Lucky jeans: that sentence traces to an UNCITED Wikipedia line. The clover count, the stitching, the exact placement and the word "all" are unverified, and so is whether current production still does it. "LUCKY ME" is folklore. It is NOT button-fly-only — zip flies have a fly shield too. USE IT AS SUPPORTING EVIDENCE, NEVER AS A TEST, and never state its exact form.',
   ARRAY[]::text[], 'c.1990-present (currency unverified)', null,
   ARRAY['lucky you','fly','button fly','tell']::text[],
   'https://www.luckybrand.com/', 0.55, false, 'migration:00466'),
  ('luckybrand', '121 Heritage Slim', 'Men', 'denim', 'Named fit',
   'A named men''s FIT (verified on luckybrand.com), not a size and not a style number. ⚠ THE NUMBERING LOGIC IS OPAQUE — do NOT infer a fit from a number (the tempting "4xx = athletic" rule has counterexamples). Read the printed fit NAME. Sized by waist x inseam in INCHES like every Lucky jean.',
   ARRAY['cotton denim','stretch denim']::text[], 'current', '$$',
   ARRAY['121','heritage slim','fit','jeans']::text[],
   'https://www.luckybrand.com/', 0.70, false, 'migration:00466'),
  ('luckybrand', '181 Relaxed Straight', 'Men', 'denim', 'Named fit',
   'A named men''s FIT (verified on luckybrand.com). Same rule as the 121: the number is a fit label with no decodable logic — read the name, never infer.',
   ARRAY['cotton denim']::text[], 'current', '$$',
   ARRAY['181','relaxed straight','fit','jeans']::text[],
   'https://www.luckybrand.com/', 0.70, false, 'migration:00466'),
  ('luckybrand', '410 Athletic', 'Men', 'denim', 'Named fit',
   'A named men''s FIT (verified on luckybrand.com) — cut fuller through the thigh and seat. ⚠ Do not generalise the number: "4xx = athletic" is NOT a rule and has counterexamples. Read the printed fit name.',
   ARRAY['cotton denim','stretch denim']::text[], 'current', '$$',
   ARRAY['410','athletic','fit','jeans']::text[],
   'https://www.luckybrand.com/', 0.70, false, 'migration:00466'),
  ('luckybrand', 'Ava / Sweet / Sienna', 'Women', 'denim', 'Named fit',
   'Lucky''s current named women''s FITS (verified on luckybrand.com); Emma, Charlie and Lolita are historical names found on older garments. These are FITS, not sizes — Lucky women''s jeans are labelled by WAIST IN INCHES (24-35), not by a dress size. ⚠ Which of these are the TOP RESALE styles is UNVERIFIED and deliberately not claimed here.',
   ARRAY['stretch denim']::text[], 'current (Emma/Charlie/Lolita: historical)', '$$',
   ARRAY['ava','sweet','sienna','fit','jeans']::text[],
   'https://www.luckybrand.com/', 0.65, false, 'migration:00466')
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

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- Mirrored 1:1 into the sizing-charts.ts in-code fallback (the DB rows win when
-- the pack loads; the TS table is the offline path). Measurements are INCHES.
--
-- THE CONFIDENCE COLUMN IS DOING REAL WORK HERE AND IS DELIBERATELY UNEVEN:
--   0.85  Urban Outfitters / BDG — brand-published (URBN's own guide).
--   0.60  Zara, Express — the brands serve 403 to automated fetches of their own
--         size guides, so these are transcribed from third-party aggregators.
--   0.55  PacSun — same, and thinner.
--   0.50  H&M, Brandy Melville — NO trustworthy published chart exists for either.
--         H&M's rows are the STANDARD EU GRADE's approximation, not H&M's own
--         numbers; Brandy publishes no chart at all. Both notes say so outright.
-- An honest 0.5 is worth more than a fabricated 0.9: a chart is a suggestion to a
-- model, and one that lies about its provenance cannot be corrected later.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  ('urbanoutfitters', 'Urban Outfitters', ARRAY['urban outfitters','urbanoutfitters','bdg']::text[], 'Women',
   'BDG denim (US numeric waist label — NOT inches, see note)',
   ARRAY['jean','denim','pant','bottom','short','trouser']::text[],
   $j$[{"size":"25 (= US 0)","measurements":{"waist":"24.5","hip":"34"}},{"size":"26 (= US 2)","measurements":{"waist":"25.5","hip":"35"}},{"size":"27 (= US 4)","measurements":{"waist":"26.5","hip":"36"}},{"size":"28 (= US 6)","measurements":{"waist":"27.5","hip":"37"}},{"size":"29 (= US 8)","measurements":{"waist":"28.5","hip":"38"}},{"size":"30 (= US 10)","measurements":{"waist":"29.5","hip":"39"}},{"size":"31 (= US 12)","measurements":{"waist":"30.5","hip":"40"}}]$j$::jsonb,
   'BDG is Urban Outfitters'' house denim label and its tag says BDG, never "Urban Outfitters". Sized by a US numeric waist label 25-31 (= apparel 0-12). THE LABEL IS NOT THE BODY WAIST: a tagged 25 fits a 24.5in waist, so the number runs ~0.5in HIGH. These are BODY measurements per URBN''s own guide, NOT flat-garment measurements — do not compare a doubled flat waistband to them without allowing for ease. A non-US chart (General Pants AU) maps these sizes differently (tag ≈ literal waist); the US mapping here is the one that applies to US resale.',
   'https://www.urbanoutfitters.com/', 0.85, false, 'migration:00466'),

  ('urbanoutfitters', 'Urban Outfitters', ARRAY['urban outfitters','urbanoutfitters','bdg']::text[], 'Women',
   'Tops & dresses (US numeric)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','hoodie','jacket','tank']::text[],
   $j$[{"size":"0","measurements":{"bust":"31","waist":"23.5","hip":"33"}},{"size":"2","measurements":{"bust":"32","waist":"24.5","hip":"34"}},{"size":"4","measurements":{"bust":"33","waist":"25.5","hip":"35"}},{"size":"6","measurements":{"bust":"34","waist":"26.5","hip":"36"}},{"size":"8","measurements":{"bust":"35","waist":"27.5","hip":"37"}},{"size":"10","measurements":{"bust":"36","waist":"28.5","hip":"38"}},{"size":"12","measurements":{"bust":"37","waist":"29.5","hip":"39"}},{"size":"14","measurements":{"bust":"38.5","waist":"31","hip":"40.5"}},{"size":"16","measurements":{"bust":"40","waist":"32.5","hip":"42"}}]$j$::jsonb,
   'Urban Outfitters / BDG apparel runs US numeric 0-16; bust is the primary signal. UO also sells its house labels in ALPHA (XS-XL) — if the tag shows a letter, read it as standard US alpha, not against this table. BODY measurements per URBN''s published guide, not flat-garment.',
   'https://www.urbanoutfitters.com/', 0.85, false, 'migration:00466'),

  ('zara', 'Zara', ARRAY['zara']::text[], 'Women',
   'Bottoms (EU numeric 34-42 — an EU SIZE, never inches)',
   ARRAY['bottom','pant','jean','denim','short','trouser','skirt','legging']::text[],
   $j$[{"size":"EU 34 / XS (≈US 2-4, UK 6)","measurements":{"bust":"32.25","waist":"24.5"}},{"size":"EU 36 / S (≈US 4-6, UK 8)","measurements":{"bust":"34","waist":"26"}},{"size":"EU 38 / M (≈US 6-8, UK 10)","measurements":{"bust":"35.5","waist":"27.5"}},{"size":"EU 40 / L (≈US 8-10, UK 12)","measurements":{"bust":"37.75","waist":"30"}},{"size":"EU 42 / XL (≈US 10-12, UK 14)","measurements":{"bust":"40.25","waist":"32.25"}}]$j$::jsonb,
   '⚠ THE NUMBER ON A ZARA TAG IS AN EU SIZE, NOT A WAIST IN INCHES. A Zara 38 is a ~27.5in waist (≈US 6-8), NOT a 38in waist — reading it as inches is a ~10in error and the tag gives no hint, because a Levi''s or Express 38 in the same photo IS inches. THE EU->US MAP IS DISPUTED BY ONE FULL SIZE across sources (EU 38 = US 6 via the UK grade, or US 8 via EU = US+30), so the US equivalents are RANGES and the EU number is the only certain part — prefer the measurements over the conversion. Zara is widely SAID to run small, but that is folk knowledge, not a sourced fact (measurement tests cut both ways), so do not assert it. Some US-market Zara denim is reported to carry US/inch sizing instead — if a tag shows "U.S. 31" with a 31in waist, believe the tag, not this table. Aggregator-sourced (zara.com is not machine-readable) — capped confidence.',
   'https://www.zara.com/', 0.60, false, 'migration:00466'),

  ('zara', 'Zara', ARRAY['zara']::text[], 'Women',
   'Tops & dresses (EU numeric 34-42 / alpha)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','jacket','coat','tank']::text[],
   $j$[{"size":"EU 34 / XS (≈US 2-4)","measurements":{"bust":"32.25","waist":"24.5"}},{"size":"EU 36 / S (≈US 4-6)","measurements":{"bust":"34","waist":"26"}},{"size":"EU 38 / M (≈US 6-8)","measurements":{"bust":"35.5","waist":"27.5"}},{"size":"EU 40 / L (≈US 8-10)","measurements":{"bust":"37.75","waist":"30"}},{"size":"EU 42 / XL (≈US 10-12)","measurements":{"bust":"40.25","waist":"32.25"}}]$j$::jsonb,
   'Zara tops run the EU grade 34-42 and ALSO alpha (XS-XL); bust is the primary signal. Zara Basic / Zara Woman / TRF (Trafaluc) / Zara Man are LINES of Zara, not separate brands or size systems — the line does not change the grade. Same EU->US caveat as the bottoms chart: the US column is a disputed range, the EU number is the certain part. Aggregator-sourced — capped confidence.',
   'https://www.zara.com/', 0.60, false, 'migration:00466'),

  ('hm', 'H&M', ARRAY['h&m','h & m','handm','hennes','divided']::text[], 'Women',
   'Bottoms (EU numeric 32-44 — an EU SIZE, never inches)',
   ARRAY['bottom','pant','jean','denim','short','trouser','skirt','legging']::text[],
   $j$[{"size":"EU 32 / XS (≈US 0-2)","measurements":{"waist":"24-25","hip":"33.5-34.5"}},{"size":"EU 34 / XS-S (≈US 2-4)","measurements":{"waist":"25-26.5","hip":"34.5-36"}},{"size":"EU 36 / S (≈US 4-6)","measurements":{"waist":"26.5-28","hip":"36-37.5"}},{"size":"EU 38 / M (≈US 6-8)","measurements":{"waist":"28-29.5","hip":"37.5-39"}},{"size":"EU 40 / L (≈US 8-10)","measurements":{"waist":"29.5-31","hip":"39-40.5"}},{"size":"EU 42 / L-XL (≈US 10-12)","measurements":{"waist":"31-33","hip":"40.5-42.5"}},{"size":"EU 44 / XL (≈US 12-14)","measurements":{"waist":"33-35","hip":"42.5-44.5"}}]$j$::jsonb,
   '⚠ THE NUMBER ON AN H&M TAG IS AN EU SIZE, NOT A WAIST IN INCHES — the Zara rule, same trap. EU 32-44. THE MEASUREMENTS HERE ARE THE STANDARD EU GRADE''S APPROXIMATION, NOT H&M''S OWN PUBLISHED NUMBERS: no trustworthy H&M inch chart could be sourced (hm.com is not machine-readable), so treat them as a rough frame and PREFER the garment''s actual measurements. The EU->US map is disputed by a full size (this brand''s aggregators use EU = US+30, giving EU 38 = US 8; Zara''s UK-derived grade gives US 6), hence the ranges. H&M is widely said to run small; the evidence is thin, so hedge rather than assert. Divided / L.O.G.G. / H&M Studio / MAMA are H&M''s own in-store LINES and share this grade. LOW confidence, deliberately.',
   'https://www2.hm.com/', 0.50, false, 'migration:00466'),

  ('hm', 'H&M', ARRAY['h&m','h & m','handm','hennes','divided']::text[], 'Women',
   'Tops & dresses (EU numeric 32-44 / alpha)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','hoodie','jacket','tank']::text[],
   $j$[{"size":"EU 32 / XS (≈US 0-2)","measurements":{"bust":"31-32"}},{"size":"EU 34 / XS-S (≈US 2-4)","measurements":{"bust":"32-33.5"}},{"size":"EU 36 / S (≈US 4-6)","measurements":{"bust":"33.5-35"}},{"size":"EU 38 / M (≈US 6-8)","measurements":{"bust":"35-36.5"}},{"size":"EU 40 / L (≈US 8-10)","measurements":{"bust":"36.5-38.5"}},{"size":"EU 42 / L-XL (≈US 10-12)","measurements":{"bust":"38.5-40.5"}},{"size":"EU 44 / XL (≈US 12-14)","measurements":{"bust":"40.5-43"}}]$j$::jsonb,
   'H&M tops run the EU grade 32-44 and ALSO alpha (XS-XL). AS WITH THE BOTTOMS CHART, THESE ARE STANDARD-EU-GRADE APPROXIMATIONS, NOT H&M''S OWN PUBLISHED NUMBERS — no sourceable H&M inch chart exists. Prefer the garment''s measurements; the EU label is the certain part. LOW confidence.',
   'https://www2.hm.com/', 0.50, false, 'migration:00466'),

  ('express', 'Express', ARRAY['express']::text[], 'Women',
   'Bottoms (US numeric 00-18 — the number is a US SIZE, not inches)',
   ARRAY['pant','jean','denim','bottom','short','trouser','legging','skirt']::text[],
   $j$[{"size":"00","measurements":{"waist":"23","hip":"34","bust":"30.5"}},{"size":"0","measurements":{"waist":"24","hip":"35","bust":"31.5"}},{"size":"2","measurements":{"waist":"25","hip":"36","bust":"32.5"}},{"size":"4","measurements":{"waist":"26","hip":"37","bust":"33.5"}},{"size":"6","measurements":{"waist":"27","hip":"38","bust":"34.5"}},{"size":"8","measurements":{"waist":"28","hip":"39","bust":"35.5"}},{"size":"10","measurements":{"waist":"29.5","hip":"40.5","bust":"37"}},{"size":"12","measurements":{"waist":"31","hip":"42","bust":"38.5"}},{"size":"14","measurements":{"waist":"32.5","hip":"43.5","bust":"40"}},{"size":"16","measurements":{"waist":"34","hip":"45","bust":"41.5"}},{"size":"18","measurements":{"waist":"35.5","hip":"46.5","bust":"43"}}]$j$::jsonb,
   'Express women''s bottoms run US numeric 00-18. CONTRAST ZARA AND H&M IN THIS SAME PACK: their two-digit numbers are EU sizes. Express''s are US sizes — an Express 4 is a US 4 (≈26in waist), not an EU 4. Inseams: Regular 33in, Short 30in, Tall 34-35in, all sharing one waist/hip grade, so a length suffix says nothing about the size. Aggregator-sourced (Express''s own guide is not machine-readable) — capped confidence.',
   'https://www.express.com/', 0.60, false, 'migration:00466'),

  ('express', 'Express', ARRAY['express']::text[], 'Women',
   'Tops (US numeric 00-18 / alpha)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','tank','bodysuit']::text[],
   $j$[{"size":"00 (≈XXS)","measurements":{"bust":"30.5","waist":"23"}},{"size":"0-2 (≈XS)","measurements":{"bust":"31.5-32.5","waist":"24-25"}},{"size":"4-6 (≈S)","measurements":{"bust":"33.5-34.5","waist":"26-27"}},{"size":"8-10 (≈M)","measurements":{"bust":"35.5-37","waist":"28-29.5"}},{"size":"12-14 (≈L)","measurements":{"bust":"38.5-40","waist":"31-32.5"}},{"size":"16-18 (≈XL)","measurements":{"bust":"41.5-43","waist":"34-35.5"}}]$j$::jsonb,
   'Express women''s tops run US numeric 00-18 and ALSO alpha (XS-XL) depending on the line — the Portofino shirt is typically alpha, the wear-to-work tops numeric. Bust is the primary signal. Aggregator-sourced — capped confidence.',
   'https://www.express.com/', 0.60, false, 'migration:00466'),

  ('pacsun', 'PacSun', ARRAY['pacsun','pacific sunwear','bullhead']::text[], 'Women',
   'Bullhead / PacSun denim (US numeric waist label — NOT inches)',
   ARRAY['jean','denim','pant','bottom','short','trouser']::text[],
   $j$[{"size":"23","measurements":{"waist":"24","hip":"34.5"}},{"size":"24","measurements":{"waist":"25","hip":"35.5"}},{"size":"25","measurements":{"waist":"26","hip":"36.5"}},{"size":"26","measurements":{"waist":"27","hip":"37.5"}},{"size":"27","measurements":{"waist":"28","hip":"38.5"}},{"size":"28","measurements":{"waist":"29","hip":"39.5"}},{"size":"29","measurements":{"waist":"30","hip":"40.5"}},{"size":"30","measurements":{"waist":"31.5","hip":"42"}},{"size":"31","measurements":{"waist":"33","hip":"43.5"}},{"size":"32","measurements":{"waist":"34.5","hip":"45"}}]$j$::jsonb,
   'Bullhead is PacSun''s house denim label (renamed PacSun Denim ~2016) and its tag says Bullhead, never "PacSun". US numeric waist label 23-32. LIKE BDG, THE LABEL IS NOT THE LITERAL WAIST — a tagged 23 fits a 24in waist, so the number runs ~1in LOW at the bottom of the range and the offset grows. ONLY use this chart when the tag names a PacSun house label: PacSun is primarily a MULTI-BRAND RETAILER and most garments bought there carry another brand''s tag and another brand''s grade. Aggregator-sourced (pacsun.com''s own guide is not machine-readable) — capped confidence.',
   'https://www.pacsun.com/', 0.55, false, 'migration:00466'),

  ('brandymelville', 'Brandy Melville', ARRAY['brandy melville','brandymelville']::text[], 'Women',
   'One Size / XS-S (a SINGLE small size — the brand has no grade)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','hoodie','tank','bottom','pant','jean','short','skirt']::text[],
   $j$[{"size":"One Size / XS-S (≈US 00-4)","measurements":{"bust":"30-33","waist":"23-26","hip":"33-36"}}]$j$::jsonb,
   '⚠ "ONE SIZE" HERE MEANS SMALL, NOT UNIVERSAL. Brandy Melville sells essentially one size, roughly US 00-4 / XS-S — it is not a generous one-size-fits-all and it does not fit most people. A model that reads "One Size" as universal will mis-set buyer expectation on every listing. CURRENT TAGS SAY "XS/S"; the older ones say "One Size" / "One Size Fits Most", so the tag text is a rough DATING tell (no reliable switch date exists — do not state a year). BRANDY PUBLISHES NO SIZE CHART: it lists per-garment measurements on each product page, so MEASURE THE GARMENT — every circulating "Brandy size chart" on the web is SEO fabrication. When reading Brandy''s own product-page numbers, note a listed "bust" of ~15in is a FLAT PIT-TO-PIT half-measurement (≈30in circumference), not a circumference — do not ingest it as one. The single row here is the US 00-4 equivalent for orientation ONLY, not Brandy''s published grade. Bottoms are XS/S too, NOT an EU numeric grade despite the brand''s Italian origin. LOW confidence, deliberately.',
   'https://us.brandymelville.com/', 0.50, false, 'migration:00466'),

  ('anntaylor', 'Ann Taylor', ARRAY['ann taylor','anntaylor','loft']::text[], 'Women',
   'Tops & dresses (US numeric 00-18 — shared Ann Taylor / LOFT grade)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','jacket','blazer','tank']::text[],
   $j$[{"size":"00","measurements":{"bust":"31.5","waist":"24.5"}},{"size":"2","measurements":{"bust":"33.5","waist":"26.5"}},{"size":"4","measurements":{"bust":"34.5","waist":"27.5"}},{"size":"8","measurements":{"bust":"36.5","waist":"29.5"}},{"size":"12","measurements":{"bust":"39","waist":"32"}},{"size":"16","measurements":{"bust":"42.5 (LOFT 42)","waist":"35.5"}},{"size":"18","measurements":{"bust":"44.5 (LOFT 44)","waist":"37.5"}}]$j$::jsonb,
   'ANN TAYLOR AND LOFT PUBLISH THE SAME BODY CHART — identical through size 14, diverging only at 16/18 (Ann Taylor bust 42.5/44.5; LOFT 42/44). So the two brands'' sizes are interchangeable even though LOFT sits ~30-40% cheaper: the band differs, the grade does not. US numeric 00-18 (also XXS-XXL). A "P" suffix is PETITE and a "T" suffix is TALL — both are LENGTH variants that share this waist/bust grade, so a suffix says nothing about the size. A "Curvy" fit axis also exists. THESE ARE US SIZES, NOT EU — contrast Zara/H&M in this same pack, where the number is an EU size. Rows are a sourced SUBSET of the published chart; 6/10/14 exist and grade evenly between their neighbours.',
   'https://www.anntaylor.com/', 0.70, false, 'migration:00466'),

  ('anntaylor', 'Ann Taylor', ARRAY['ann taylor','anntaylor','loft']::text[], 'Women',
   'Pants & skirts (US numeric 00-18 — shared Ann Taylor / LOFT grade)',
   ARRAY['pant','bottom','skirt','trouser','short','legging']::text[],
   $j$[{"size":"00","measurements":{"waist":"24.5","hip":"34.5"}},{"size":"18","measurements":{"waist":"37.5","hip":"47.5"}}]$j$::jsonb,
   'The shared Ann Taylor / LOFT bottoms grade: US numeric 00-18, NOT inches and NOT EU. "P" = petite and "T" = tall are LENGTH variants sharing this waist/hip grade. ⚠ LOFT''S **DENIM** IS A DIFFERENT SYSTEM — it is labelled in WAIST INCHES (24-34); see LOFT''s denim chart. So a LOFT "8" is a US 8 and a LOFT "28" is a 28in waist, on the same brand. Only the ENDPOINTS here are sourced from the published chart; the sizes between them grade evenly and are NOT published values — prefer the garment''s measurements. Capped confidence.',
   'https://www.anntaylor.com/', 0.60, false, 'migration:00466'),

  ('loft', 'LOFT', ARRAY['loft']::text[], 'Women',
   'Denim (waist in INCHES 24-34 — NOT a US size)',
   ARRAY['jean','denim']::text[],
   $j$[{"size":"24 (≈US 00)","measurements":{"waist":"24"}},{"size":"26 (≈US 2)","measurements":{"waist":"26"}},{"size":"28 (≈US 6)","measurements":{"waist":"28"}},{"size":"30 (≈US 10)","measurements":{"waist":"30"}},{"size":"32 (≈US 14)","measurements":{"waist":"32"}},{"size":"34 (≈US 18)","measurements":{"waist":"34"}}]$j$::jsonb,
   '⚠ LOFT USES TWO SYSTEMS AT ONCE AND ONLY THE GARMENT SAYS WHICH: its DENIM is sized by WAIST IN INCHES (24-34) while its pants run US numeric 00-18. So a LOFT "28" is a 28in waist and a LOFT "8" is a US 8 — one brand, one tag family, two systems. Ann Taylor''s chart has NO inch-denim column, so this is LOFT-only. DATING TELL: a LOFT garment in size 20-26 is from Feb 2018 - fall 2021 — LOFT Plus launched Feb 2018 (sizes 16-26) and was discontinued in 2021, after which the range returned to 00-18. The US equivalents are approximate.',
   'https://www.loft.com/', 0.70, false, 'migration:00466'),

  ('talbots', 'Talbots', ARRAY['talbots']::text[], 'Women',
   'Misses (US numeric 2-18) / Petite (0P-16P) / Plus (14W-26W)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','jacket','blazer','pant','bottom','skirt','trouser']::text[],
   $j$[{"size":"0P (petite)","measurements":{"waist":"24.5","hip":"34.5"}},{"size":"16P (petite)","measurements":{"waist":"34","hip":"44"}},{"size":"2 (misses)","measurements":{"waist":"26","hip":"36"}},{"size":"6 (misses)","measurements":{"waist":"28.5","hip":"38.5"}},{"size":"10 (misses)","measurements":{"waist":"31","hip":"41"}},{"size":"14 (misses)","measurements":{"waist":"34","hip":"44"}},{"size":"18 (misses)","measurements":{"waist":"36.5","hip":"46.5"}},{"size":"14W (plus)","measurements":{"waist":"37","hip":"45"}},{"size":"26W (plus)","measurements":{"waist":"49","hip":"57"}}]$j$::jsonb,
   'THREE SYSTEMS UNDER ONE BRAND, and the published ranges are NOT the ones commonly repeated: MISSES IS 2-18 (not 2-20), PETITE STARTS AT 0P (not 2P) and runs 0P-16P, and PLUS IS 14W-26W (not 14W-24W). The "W" is a vestigial "Woman" marker; the range is labelled "Plus" today. Tall is a LENGTH option on select styles, not a size category. A "Curvy" fit axis also exists. Talbots'' published chart MEASURES LARGER THAN YOUTH-TARGETED BRANDS at the same nominal size (a peer-reviewed study of 54 retailers'' published charts finds brands targeting younger customers measure significantly smaller) — but do NOT call this vanity sizing: the study compared CHARTS, not garments, and Talbots'' customer skews older, so a larger measurement may simply be accurate fitting for the target body. Endpoints are sourced; intermediate sizes are an EVEN INTERPOLATION, not published values — capped confidence, prefer the garment.',
   'https://www.talbots.com/', 0.60, false, 'migration:00466'),

  ('luckybrand', 'Lucky Brand', ARRAY['lucky brand','luckybrand']::text[], 'Men',
   'Jeans (waist x inseam, INCHES — the number IS the waist)',
   ARRAY['jean','denim','pant','bottom','short','trouser','chino']::text[],
   $j$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}},{"size":"W40","measurements":{"waist":"40"}},{"size":"W42","measurements":{"waist":"42"}}]$j$::jsonb,
   'Lucky Brand men''s jeans are sold as WAIST x INSEAM IN INCHES: waist 28-42, inseams 30/32/34/36/38. THIS IS THE FOIL TO ZARA AND H&M IN THE SAME PACK — a Lucky "38" IS a 38in waist, while a Zara "38" is an EU size on a ~27.5in waist. Same two digits, ~10in apart, and only the brand says which. Read the flat waistband and double it. Named men''s fits (121 Heritage Slim, 181 Relaxed Straight, 410 Athletic, 221 Original Straight, 363 Vintage Straight) are FITS, not sizes — and the numbering logic is opaque, so do not infer a fit from a number.',
   'https://www.luckybrand.com/', 0.75, false, 'migration:00466'),

  ('luckybrand', 'Lucky Brand', ARRAY['lucky brand','luckybrand']::text[], 'Women',
   'Jeans (waist in INCHES 24-35) — NOT a dress size',
   ARRAY['jean','denim','pant','bottom','short','trouser']::text[],
   $j$[{"size":"24 (≈US 0)","measurements":{"waist":"24-25","hip":"36"}},{"size":"26 (≈US 2-4)","measurements":{"waist":"26"}},{"size":"28 (≈US 6)","measurements":{"waist":"28"}},{"size":"30 (≈US 10)","measurements":{"waist":"30","hip":"41"}},{"size":"32","measurements":{"waist":"32"}},{"size":"35","measurements":{"waist":"35"}}]$j$::jsonb,
   '⚠ Lucky Brand women''s jeans are sold by WAIST IN INCHES (24-35), NOT by a dress size — the alpha/numeric 0-16 grade is not the jean selector. Inseams 27/29/31. The published BODY chart (a separate thing from the jean label) stops at size 10, so the numeric-to-body map here is only the sourced part: 0 = 24-25in waist / 36in hip, 10 = 30in waist / 41in hip. Named women''s fits (Ava, Sweet, Sienna) are FITS, not sizes.',
   'https://www.luckybrand.com/', 0.70, false, 'migration:00466')
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
insert into public.applied_migrations (version) values ('00466') on conflict do nothing;
