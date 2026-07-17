-- US-1987: Preppy & contemporary men's brand knowledge (9 brands).
--
-- Vineyard Vines, Brooks Brothers, Bonobos, Faherty, Peter Millar, Todd Snyder,
-- Buck Mason, UNTUCKit, Johnnie-O. The menswear counterpart to 00466's
-- fast-fashion/mall tier and 00458's basics tier, neither re-touched.
--
-- ALL NINE WERE PASSTHROUGH-ONLY. A "peter millar" tag rendered the seller's own
-- casing into the prompt block and the eBay Brand aspect on some of the highest
-- sell-through menswear in resale.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MAKES THIS GROUP DIFFERENT FROM EVERY PACK BEFORE IT
--
--   1. THE FIT NAME IS THE GARMENT-DEFINING FACT, AND IT IS TAG-ONLY. 00466's
--      pack was about the SIZE SYSTEM (a Zara "38" is an EU size, a Lucky "38"
--      is inches). This is one axis over: here the size grade is NOT in dispute
--      — a Bonobos 32x32 is a 32x32 in every fit, a Slim UNTUCKit L and a
--      Relaxed L are both "L", a Brooks Brothers 16-34 Milano and a 16-34
--      Madison are both 16-34. What changes is the CUT, by up to 5 INCHES of
--      chest and waist, and the ONLY thing that says which is a WORD PRINTED ON
--      THE TAG. It is not in the photo, it is not in the number, and it is not
--      recoverable by measuring the size label. This pack exists to make the
--      model read the fit word instead of inferring a fit from a silhouette.
--
--   2. AND THE LADDER'S ORDER IS COUNTERINTUITIVE — IN TWO BRANDS, THE OPEN WEB
--      HAS IT BACKWARDS, AND BOTH ARE REFUTED BY THE BRAND'S OWN PUBLISHED
--      CHART. This is the finding that shaped the pack:
--        * BONOBOS: **Tailored is TRIMMER than Slim.** Bonobos' own fit guide
--          calls Tailored "trimmest in the hips and thighs" while Slim merely
--          removes "billowing". Aggregators SPLIT on this — one states the
--          inversion correctly, another states the opposite outright — so
--          retrieval does not save a model here.
--        * BROOKS BROTHERS: **Madison is the ROOMIEST suit fit** (+3" chest,
--          +5" waist over Regent), not a trim one. SEO fit-guides say the
--          reverse. BB's own size chart, which expresses every fit as a delta
--          against Regent, refutes them.
--      Two independent brands, same shape of error, both caught only by reading
--      the brand's own numbers. Seeding the popular version would have inverted
--      both ladders.
--
--   3. THE LADDERS ARE NOT SHARED, EVEN INSIDE ONE BRAND. Brooks Brothers runs
--      FIVE rungs for shirts (Soho / Milano / Regent / Madison / Traditional)
--      and THREE for suits (Milano / Regent / Madison) — so "Madison" is 4th of
--      5 in one category and the roomiest of 3 in the other. Same word, two
--      positions. BB ALSO runs a second, overlapping vocabulary (Slim /
--      Classic / Traditional) and publishes NO crosswalk between the two.
--
--   4. MENSWEAR RUNS FOUR SIZE SYSTEMS AT ONCE, OFTEN ON ONE BRAND. Brooks
--      Brothers alone sells dress shirts by NECK x SLEEVE (16-34), sport shirts
--      by ALPHA, suits by CHEST + a LENGTH LETTER (42R/42L/42S), and trousers by
--      WAIST IN INCHES. UNTUCKit is the same trap in miniature: its button-downs
--      are alpha and its DRESS shirts are neck x sleeve, so "UNTUCKit is
--      alpha-sized" is only half true. Every chart below names its SYSTEM in the
--      `garment` string because of it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE DECODER — the first in several packs, and it is BRAND-SOURCED.
-- The bar, from 00460: tag-printed AND regular AND brand-unique in FORMAT.
--
--   * PETER MILLAR `ME0EK01` / `LE0B46` — CLEARS ALL THREE. Peter Millar's OWN
--     help centre says the style number "can be found, together with care
--     instructions, on the inside of the garment... typically starts with 'M'
--     for men's products. eg. ME0EK01 or an 'L' for ladies. eg. LE0B46". That is
--     the brand stating the code is on the physical garment — not a web SKU
--     inferred from a URL, which is what killed every other candidate here. The
--     format ([ML] + a line letter + digits + alphanumerics) is not a bare digit
--     run, so it is brand-unique enough to carry decoder authority. It is also
--     the pack's CUT-TAG case: the code sits with the care instructions, which
--     survive the brand tag being cut out of the collar.
--     Like Canada Goose (00460), whose codes use the SAME M/L department letter,
--     it captures ONLY `styleCode` and does not map gender: the shared
--     `genderCode` transform maps W/M and Peter Millar's ladies' letter is L, so
--     capturing it would emit a raw "L" as a gender, and teaching the shared
--     table that L=Women would break every brand where L means Large.
--
--     ⚠ WHAT THE DECODER DELIBERATELY DOES **NOT** READ: THE SEASON. The
--     `MS24…`/`MF24…` forms look like Spring/Fall + year, and retailer titles
--     corroborate it ("Suffolk Coat FW24" = MF24Z02). It is NOT seeded, for two
--     reasons: Peter Millar publishes no decoder for it, and the reading is
--     DEMONSTRABLY AMBIGUOUS — `ME0S24` is an evergreen Crown Soft sweater whose
--     body merely CONTAINS "S24", and a naive parse calls it Spring 2024. A
--     field that is right most of the time and silently wrong the rest is worse
--     than an absent one, because nothing downstream can tell the two apart.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE REFUSALS ARE THE REST OF THE DELIVERABLE (all fixtured as negatives in
-- brand-knowledge-golden_test.ts — a refusal that isn't tested is a comment).
-- Every one of these codes is REAL; each fails a different clause of the bar:
--
--   * BUCK MASON `B007` / `D018` — REFUSED ON EVIDENCE, NOT ON PRINCIPLE, and it
--     is the most instructive refusal in the pack because it was TESTED rather
--     than argued: `B007` appears on BOTH a Ford Standard Jean AND a Maverick
--     Slim Jean; `D018` on BOTH a Full Saddle AND a Cowboy Cut. A code constant
--     across DIFFERENT fits is not identifying the style — it identifies the
--     DENIM FABRIC LOT. The separate `BM11001.102` string is an IMAGE FILENAME.
--   * BROOKS BROTHERS `ME04455` / `MK01081` — a current-site Demandware SKU. Not
--     sourced to any tag, and its era coverage is near-zero where it matters: BB
--     resale is dominated by decades of pre-2020 garments across six ownership
--     regimes. A decoder that works on 2025 stock and fails silently on 1985
--     stock fails CONFIDENTLY, which is worse than not existing.
--   * VINEYARD VINES `1P1291` / `1G013219` — the closest call among the
--     refusals. The format is arguably brand-unique and the 1/2/3 gender prefix
--     is tempting, but every sighting is a web/catalog SKU echoed by wholesalers
--     and resellers, and the brand's OWN catalogue addresses many products by a
--     bare 12-digit UPC instead — so a parser cannot know which it is looking at.
--   * BONOBOS `19112-GYK52-28X30`, TODD SNYDER, FAHERTY `MKH2406-NUR-L`,
--     UNTUCKit `03046GRY`, JOHNNIE-O `JMPO3000` — all web/Shopify SKUs harvested
--     from URLs and JSON, none sourced to a tag. Faherty's and Johnnie-O's are
--     the most decoder-SHAPED of the group and are refused anyway: shape is not
--     provenance. Bonobos' `-28X30` suffix only restates the size already on the
--     size tag; a decoder that recovers what you can already read is not one.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE COLORWAY ROW, AND THE RULE THAT PICKED IT. Eight of these brands name
-- colours evocatively (Bonobos alone ships "Brownstones", "Clean Slates",
-- "Bluechippers") and NONE of that is seeded: those are per-season, per-SKU
-- marketing copy interleaved with plain descriptors ("Deep Navy") on the SAME
-- product, and a seeded list both rots and licenses a model to confirm any
-- plausible invention. The single exception is a CONVENTION rather than a LIST:
-- Bonobos' Stretch Weekday Warrior colourways ARE the weekdays, and the day is
-- EMBROIDERED INSIDE THE WAISTBAND — a rule-shaped fact tied to a physical
-- garment feature. That is the only colour fact in this pack that a garment can
-- still prove after its hangtag is gone.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY **NOT** RECORDED. This list is part of the deliverable:
-- the next person here should not re-derive these and quietly guess.
--
--   * RN NUMBERS FOR EIGHT OF THE NINE. The FTC RN database is a JS/ServiceNow
--     shell that returns nothing to automated lookup, so no RN could be verified
--     — EXCEPT Peter Millar's 100308, which is seeded because it came from
--     PETER MILLAR'S OWN help centre (an aside in a shipping FAQ), not from the
--     registry. Vineyard Vines' "RN 134578" and Brooks Brothers' "RN 93986"
--     circulate widely and trace ONLY to eBay sellers' free-text fields; both
--     are refused. Brooks Brothers is the reason this matters most: its
--     registrant entity almost certainly CHANGED across six owners, so a single
--     RN->brand mapping would be wrong for some eras even with the right digits.
--   * TAG/LABEL ERA TELLS FOR SEVEN OF THE NINE. Not one source was found that
--     reaches the physical tag of Bonobos, Faherty, Todd Snyder, Buck Mason,
--     UNTUCKit or Johnnie-O. Corporate dates are well sourced and are NOT tag
--     tells: a transaction only dates a tag if someone verified the tag changed,
--     and Walmart said outright that Bonobos' product "will not change".
--   * BROOKS BROTHERS' DECADE-BY-DECADE TAG CHART. A confident 1960s->2010s tag
--     timeline circulates; it cites nothing and is SEO content. The one genuinely
--     curated BB label archive (the Vintage Fashion Guild) 403s to automation and
--     is flagged for a human pass instead.
--   * "MAKERS = TOP TIER" (Brooks Brothers). Forum-only, and entangled with BB's
--     own 1818 motto "Makers and Merchants in One" — so the word is ALSO a brand
--     phrase, not purely a tier. Seeded as unresolved, not as a rule.
--   * THE YEAR BB's "346" FLIPPED from near-mainline to outlet-only. The
--     inversion is real and sourced-ish; the date is not, so the row says
--     era-gate it and refuses to name a year.
--   * BUCK MASON'S NAME ORIGIN. Two stories circulate (founders' fathers vs a
--     grandfather stone mason) and they contradict each other; neither is
--     primary-sourced. The satisfying one is exactly what a model will confirm.
--   * UNTUCKit's HEM LENGTH IN INCHES. The brand's own CMO gives the rule as
--     "around mid-zipper" and the brand publishes NO body length in ANY chart —
--     so the shorter hem, which is the entire brand, has no number to check
--     against. The widely-quoted "1-2.5 inches shorter" is generic menswear
--     blog guidance, NOT UNTUCKit's spec, and the "contoured hemline" language
--     comes from a COMPETITOR's blog.
--   * BONOBOS FIT RENAME HISTORY. help.bonobos.com is unreadable to every
--     fetcher including the Wayback Machine, so no rename can be confirmed —
--     and "Standard" is CURRENT (shirts/blazers), so using it to date a garment
--     would be actively harmful.
--   * PETER MILLAR'S CROWN / CROWN SPORT LABEL APPEARANCE. Only Crown Crafted's
--     label is described by the brand. The others are said to differ from it and
--     never shown.
--   * NINE INVENTED STYLE NAMES that research killed: Vineyard Vines "Harbor
--     pants" (Gray Harbor is a COLOUR), Faherty "Surf Stretch" (no such fabric)
--     and "All Day Shirt" (All Day is a SHORT), Buck Mason "Draft Flannel" and
--     "Vintage Sweatshirt" (neither exists), Johnnie-O "hangover collar" (does
--     not exist) and "Baja hoodie" ("Baja" is a COLOUR on the Talon), Todd
--     Snyder "Dylan jeans" (Dylan is a jacket, and a Timex watch), UNTUCKit
--     "Mercer" (unconfirmed) and its "Athletic" fit (does not exist).
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00466
-- convention). Confidence is DELIBERATELY UNEVEN and honest: a chart recovered
-- from the brand's OWN archived page is 0.85; a brand whose size guide 403s
-- everywhere is 0.4 and says so in its note.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('vineyardvines', 'Vineyard Vines',
   ARRAY['vineyardvines','vineyardvine','vinyardvines','vineyardvinesfortarget','shepshirt']::text[],
   ARRAY['preppy','menswear','womenswear','polo','quarter-zip','necktie']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"vineyard vines for Target\" tag","years":"2019","description":"THE BRAND'S ONE CLEAN DATING TELL. A limited-edition Target collaboration announced 28 Feb 2019 and on sale 18 May 2019, 300+ items, most under $35. If the tag reads \"for Target\", it is that drop — and it is a DISTINCT QUALITY TIER, specified far below mainline, not a mainline garment sold at Target."},{"era":"The smiling-whale logo","years":"not before ~2003-2004","description":"A SOFT FLOOR ONLY. The whale design mark declares first use 1 Sep 2003 / first use in commerce 1 Feb 2004, so a garment carrying the whale should not predate late 2003. ⚠ CAVEAT THAT MATTERS: that registration is in class 035 (RETAIL STORE SERVICES), not class 025 (clothing) — the sworn dates attach to the retail services, not to apparel. Treat as a floor for orientation, never as a hard rule, and never as a ceiling."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists for Vineyard Vines. Grade condition only; route any authenticity question to human review."},{"tell":"The circulating \"spot the fake\" tells are SEO fabrication","detail":"⚠ NOT SOURCED, and repeated everywhere: \"authentic whale embroidery is dense with no frayed threads\", \"real cotton is thick and exceptionally soft\", \"the neck tag is perfectly straight-stitched with error-free care labels\". All trace to content farms with no citation, all are generic boilerplate applicable to any brand, and all INVERT trivially — a genuine garment with a snagged logo fails them. The only defensible comparison is the logo's shape against the registered drawing."},{"tell":"The realistic risk is a whale-ADJACENT garment, not a counterfeit","detail":"Vineyard Vines' sourced litigation is against OTHER apparel companies over whale-themed lookalikes (MacBeth Collection: stipulated injunction, $300K, then $500K liquidated damages; also Mountain Tops / Lakeshirts). So the common resale error is mistaking a third-party whale garment for Vineyard Vines — not a high-fidelity fake."}]$j$::jsonb,
   'Founded 1998 by brothers Shep and Ian Murray, starting with NECKTIES on Martha''s Vineyard — corroborated independently by the USPTO record (serial 75532085, filed 6 Aug 1998, first use 20 Jun 1998, IC 025 incl. ties), which is a SWORN date rather than folklore. Still privately held by the Murrays: a 2016 minority-stake process via Goldman Sachs stalled with no reported completed transaction, and no later deal surfaced. ⚠ The c.2016-2018 outside-executive era (Roger Farah, John Mehas) is a LEADERSHIP change, NOT an ownership or trim discontinuity — do not convert it into one. NO RN IS SEEDED: "RN 134578" circulates but traces only to an eBay listing title. The brand styles itself lowercase ("vineyard vines"); the canonical here is the eBay/title-case form.',
   'https://www.vineyardvines.com/', 0.75, false, 'migration:00467'),

  ('brooksbrothers', 'Brooks Brothers',
   ARRAY['brooksbrothers','brooksbros','brooksbrother','brookbrothers','goldenfleece','blackfleece','redfleece','brooksgate','brooksease','southwick']::text[],
   ARRAY['traditional menswear','ivy/trad','dress shirts','suits','tailoring','ties','knitwear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"346\" label","years":"MEANING INVERTED — era-gate or do not use","description":"⚠ THE SINGLE MOST DANGEROUS LABEL IN THIS PACK, because its meaning REVERSED. Named for the 346 Madison Avenue flagship (occupied 1915). MID-CENTURY: a NEAR-MAINLINE line, \"only a half-step below\" BB mainline, aimed at younger professionals, with \"346\" brass buttons on blazers. MODERN (roughly 2000s-2010s): relegated to FACTORY-OUTLET-EXCLUSIVE merchandise at lesser construction and lesser fabrics. So the same three digits mean near-premium on an old garment and outlet-budget on a recent one. NO TRANSITION YEAR IS SOURCED — both readings are forum-sourced. Any rule keyed on \"346\" MUST be era-gated, or it systematically misprices one era. Also: outlet \"original\" prices are the subject of a fictitious-pricing class action, so do NOT anchor MSRP on a 346 garment."},{"era":"\"Golden Fleece\" — the WORDS, not the sheep","years":"tier is current; the fleece mark dates to 1850 or 1851","description":"TWO DIFFERENT THINGS THAT SELLERS CONFLATE. (a) The suspended-lamb LOGO is BB's corporate mark and appears BRAND-WIDE, on ALL tiers — \"has the sheep therefore Golden Fleece\" is FALSE. (b) Golden Fleece is ALSO BB's TOP TIER (full canvas, Bemberg lining, pick-stitched lapels, Loro Piana fabric, ~$1,700-2,500), and the tier requires the WORDS \"Golden Fleece\" on the label. ⚠ BB'S OWN SOURCES DISAGREE on the mark's adoption: its Heritage page says 1851, its own archive post says 1850. Record the disagreement; do not pick."},{"era":"Black Fleece / Red Fleece","years":"Black Fleece 2007-2015; Red Fleece from 2013","description":"Black Fleece was the Thom Browne-designed fashion line (debut 2007 per BB's own Heritage page; end date 2015 is secondary). Red Fleece is the youth-targeted line below mainline, launched 2013 (secondary). ⚠ NEITHER IS A COLOUR: \"Red Fleece\" does not mean the garment is red — they are LINE names that look exactly like colourways."},{"era":"Brooksgate / BrooksEase / Country Club","years":"Brooksgate early-to-mid 1970s (BB says 1976, forums say early 70s); others unsourced","description":"Sub-lines, all FORUM-SOURCED and weak. Brooksgate = entry-level for younger men, the \"gateway\" into lifelong BB custom, blazer buttons bearing the gates of Buckingham Palace; it supplanted the earlier \"BB University\" line. BrooksEase = entry-level suit separates. Country Club = softer twill-woven wool (single-thread sourced — the weakest item here). Treat all as hints for a human, not as attributions."},{"era":"\"Makers\" on the label","years":"UNRESOLVED — do not treat as a tier","description":"⚠ PLAUSIBLE BUT NOT PRIMARY-SOURCED, and it is a trap. Forum consensus says \"Makers\" marked BB's OWN-WORKROOM production (the related documented term is \"Own Make\" — shirts at Garland, ties in Long Island City, tailoring in Brooklyn) and was the top or near-top tier. BUT BB's own 1818 motto is \"Makers and Merchants in One\", so the word is ALSO a brand-identity phrase and the two are routinely conflated by sellers. Do not price a garment up on the word alone."},{"era":"\"Made in USA\"","years":"NOT AN ERA TELL — the rule is FALSE","description":"⚠ \"Made in USA therefore vintage\" is FALSE for Brooks Brothers and is a high-frequency seller error. BB sells a Made-in-USA oxford RIGHT NOW ($198) alongside Imported shirts in the same catalogue. Country of origin dates NOTHING here. What IS real: BB acquired the Southwick (Haverhill MA) factory in 2008 and announced the closure of all three US factories around the 2020 bankruptcy — so US production is not continuous, but its presence or absence does not date a garment."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists — BB publishes no authenticity guide, no verification portal, no serial system. Grade condition only; route authenticity to human review."},{"tell":"The real risk here is TIER and ERA misattribution, not counterfeiting","detail":"Brooks Brothers is not meaningfully counterfeited in the resale sense; the documented fraud pattern is fake e-commerce STOREFRONTS impersonating the brand, which is a different problem. Grading effort belongs on the tier labels (Golden Fleece / 346 / Red Fleece) and the era, not on fake-spotting."},{"tell":"\"Brooks Brothers trademark infringement\" is NOT evidence of counterfeiting","detail":"⚠ A naive text scrape inverts this. Brooks Sports (Brooks Running, a Berkshire Hathaway unit) sued Brooks Brothers in Feb 2020 over their 1980 coexistence agreement. That is a dispute between TWO LEGITIMATE COMPANIES over a shared name — it says nothing about fakes, and it is the reason a bare \"Brooks\" must never resolve to Brooks Brothers."}]$j$::jsonb,
   'Founded 7 April 1818 by Henry Sands Brooks as H. & D. H. Brooks & Co. — the oldest brand in this KB. Ownership, and every handoff is a potential trim/quality break: Brooks family (1818-1946) -> Julius Garfinckel (1946) -> Allied Stores (1981) -> Marks & Spencer (1988) -> Retail Brand Alliance / Claudio Del Vecchio (2001) -> CHAPTER 11 on 8 July 2020 -> SPARC Group (Simon + Authentic Brands JV, $325M, Sep 2020; ABG holds the IP, SPARC operates) -> CATALYST BRANDS (Jan 2025, the SPARC/JCPenney merger) — the SAME parent that now runs Lucky Brand (00466). THE 2020 BANKRUPTCY IS THE BIGGEST QUALITY BREAK: the Del Vecchio era re-shored manufacturing (Southwick, 2008) and the bankruptcy closed the US factories. ⚠ BB CONTRADICTS ITSELF on several dates (Golden Fleece 1850 vs 1851; the button-down collar 1896 vs 1900; the rename to "Brooks Brothers" 1833 vs 1850) — where the primary source disagrees with itself, no source preference resolves it, so the ranges are recorded as disputed. ⚠ A BARE "brooks" IS DELIBERATELY NOT AN ALIAS: Brooks Running (Ghost/Adrenaline) is a DIFFERENT COMPANY and is not in this KB, so aliasing the short token would silently retitle its shoes as Brooks Brothers — the AG Jeans / Lucky Brand play. No RN is seeded: "RN 93986" traces only to an eBay seller''s free-text field, and BB''s registrant entity almost certainly changed across six owners.',
   'https://www.brooksbrothers.com/', 0.80, false, 'migration:00467'),

  ('bonobos', 'Bonobos',
   ARRAY['bonobos','bonobo','bonobosguideshop','maide','maidebybonobos']::text[],
   ARRAY['menswear','chinos','dress pants','better-fitting bottoms','shirts','suits']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"Maide by Bonobos\" label","years":"~2014-2010s","description":"Bonobos' golf line, launched around 2014. Golf is now sold as plain \"Bonobos Golf\", so a Maide tag indicates the earlier era. Secondary-sourced — treat the years as approximate and do NOT pin a discontinuation date."},{"era":"Ownership handoffs are NOT tag tells","years":"2017 / 2023 / 2024","description":"⚠ SEEDED AS A REFUSAL, because the corporate chain is well sourced and the temptation to date tags from it is strong. NO source was found describing what ANY Bonobos tag says, in any era, so it is UNVERIFIED that any handoff reached the physical tag — and Walmart said outright that the customer-facing product \"will not change\", so a tag change is not even the default assumption. Do not date a Bonobos garment from a transaction date."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists, and no Bonobos-specific counterfeit literature exists at all. A $79-99 DTC chino is a poor counterfeit target — there is no resale premium to arbitrage. Grade condition only. The realistic risks are MISIDENTIFICATION (a generic chino labelled Bonobos) and FIT-NAME error, not fakes."}]$j$::jsonb,
   'Launched online 2007 by Andy Dunn and Brian Spaly; built on ONE idea — a better-fitting pant with a CURVED WAISTBAND. ⚠ THE OWNERSHIP CHAIN IS WRONG IN ITS POPULAR FORM, AND THE ERROR IS AT THE IP LAYER. It is NOT "Walmart -> Express -> PHOENIX". Walmart acquired Bonobos in 2017 ($310M). In 2023 the brand and the business FORKED and never rejoined: WHP GLOBAL BOUGHT THE **BRAND** ($50M) and EXPRESS BOUGHT ONLY THE **OPERATING ASSETS** ($25M), running it under an exclusive long-term LICENCE from WHP. So when Express filed Chapter 11 in April 2024, THE BONOBOS TRADEMARK WAS NEVER IN THE ESTATE — it was already WHP''s, and the PHOENIX JV that bought the operations is itself WHP-led. WHP Global has owned the Bonobos brand continuously since May 2023. Consequence: there are TWO operator handoffs but only ONE brand handoff, and 2024 is the WEAKEST candidate for a quality discontinuity (same brand owner, same licence, 49 Guideshops kept open). Express (00466) is the sibling pack this connects to. The current operating entity is "Express BNBS Fashion, LLC" — note it still says Express post-PHOENIX. ⚠ AYR is DELIBERATELY NOT AN ALIAS: it launched under Bonobos in 2014 and later became INDEPENDENT, so folding it would mis-brand every later AYR garment (the Modern Amusement rule, 00466). Bonobos also briefly sold WOMEN''S under its own name (2019) — a women''s Bonobos garment is not automatically wrong. No RN could be sourced (the FTC database hard-401s).',
   'https://bonobos.com/', 0.75, false, 'migration:00467'),

  ('faherty', 'Faherty',
   ARRAY['faherty','fahertybrand','sunsessions','cloudcashmere']::text[],
   ARRAY['coastal casual','surf','menswear','womenswear','knits','boardshorts']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists, and no \"how to spot a fake Faherty\" literature exists — consistent with a $70-230 price point, below the counterfeit-economics threshold. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Founded 2013 by twin brothers Mike and Alex Faherty (Mike ex-Ralph Lauren); "Family-Owned Since 2013" is the brand''s own line, and the first USPTO filings (31 Oct 2013) corroborate it independently. A Certified B Corporation. Ownership: a MINORITY-stake sale process was REPORTED in Nov 2023 — explored, not closed. Aggregators list "Ancient Management" as an investor; that could NOT be confirmed from any primary source and is deliberately NOT recorded. ⚠ TAG ERAS ARE EMPTY ON PURPOSE: the brand is ~13 years old and NO dated label change exists in any source. The trademark filing waves (2013/2019/2021/2023-24) are FILING dates and must not be laundered into tag tells. ⚠ "Faherty" IS A COMMON IRISH SURNAME and the trademark register carries unrelated Faherty owners (J.W. Faherty Inc. and several individuals) — so brand-matching on the bare surname will false-positive on non-apparel goods. No RN could be sourced.',
   'https://fahertybrand.com/', 0.75, false, 'migration:00467'),

  ('petermillar', 'Peter Millar',
   ARRAY['petermillar','petermiller','crowncrafted','crownsport','petermillarcollection']::text[],
   ARRAY['golf','luxury sportswear','menswear','polo','quarter-zip','tailoring']::text[],
   ARRAY['RN 100308']::text[],
   $j$[{"era":"\"Crown Crafted\" dark navy label + metallic Crown Seal","years":"~2019 or later","description":"THE BRAND'S BEST TAG TELL, and it is brand-authored. Peter Millar's own press release: \"Crown Crafted products are differentiated from Crown & Crown Sport products with a dark navy label featuring the Crown Crafted logo\", and \"most Crown Crafted styles feature a metallic Crown Seal logo that is exclusive to the styles within this capsule\" — on second-layer pieces the branding sits on the BACK YOKE, and on the Performance Soft Jacket inside an INTERIOR CELL PHONE POCKET. ⚠ The launch date is soft: the 2019 release frames itself as an EXPANSION, so Crown Crafted may predate Feb 2019. Treat as a floor."},{"era":"Style number on the interior care label","years":"current","description":"The style number sits WITH THE CARE INSTRUCTIONS on the inside of the garment and starts with M (men's) or L (ladies') — see the seeded decoder. It is also the live catalogue's own key, so a legible code looks the garment up. It confirms the BRAND but resolves NO era on its own."}]$j$::jsonb,
   $j$[{"pattern":"Peru (Pima cotton), Turkey, Vietnam, China, Thailand, Portugal, Italy","note":"⚠ A MIX THAT ROTATES BY SEASON. Country of origin is NOT an era tell and NOT an authenticity tell for Peter Millar. A forum claim that authentic PM is \"made in Thailand\" and that a Vietnam-made shirt is fake is FALSE and would generate false accusations against genuine goods."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No published authentication standard exists — Peter Millar's complete 48-article help centre was enumerated and NOT ONE article mentions counterfeit, fake, authentic or verification. No third-party authenticator covers the brand either (eBay Authenticity Guarantee, Entrupy, LegitGrails and Posh Authenticate all exclude it; PM polos resell ~$25-50, below every service's economic floor). There is nothing to authenticate against. Grade condition only."},{"tell":"⚠ \"Made in Vietnam means fake\" is an ACTIVE FALSE TELL — suppress it","detail":"A GolfWRX post claims authentic PM is Thailand-made and that Vietnamese production is counterfeit. Peter Millar sources across Peru, Turkey, Vietnam, China, Thailand, Portugal and Italy and rotates factories by season. Encoding this would accuse genuine garments. The \"spot fake Peter Millar\" video content is AI-generated SEO slop with no methodology."},{"tell":"The real vector is fake STOREFRONTS, not replica garments","detail":"Peter Millar won a WIPO transfer of petermillarstore.com (D2025-2166, 2025), which cloned its logotype and photography. Note the honest limit: PM's OWN counsel pleaded the goods were \"counterfeit OR AT LEAST parallel import or grey market\", and the panel found only a \"reasonable apprehension\" — so even the brand did not assert confirmed counterfeits. It won on impersonation."}]$j$::jsonb,
   'Founded 2001 in Raleigh NC; the origin product was a CASHMERE SWEATER, not golf. ⚠ THERE IS NO PERSON NAMED PETER MILLAR — a model will confabulate a founder biography here. Founder Chris Knott took the name off an antique LAWN-BOWLING BALL of his mother''s while looking for an aristocratic-sounding name; who the ball''s Peter Millar was is unknown. (Sources disagree on whether Knott founded it alone or with Greg Oakley and Chet Sikorski — unresolved.) Acquired by RICHEMONT, announced 21 Sep 2012, closed Oct 2012, and still Richemont-owned as of FY26. That is genuinely unusual and explains the pricing: a North Carolina golf-polo brand sits inside the CARTIER holding company, in the same segment as Alaïa, Chloé, dunhill and Montblanc. RN 100308 IS THE ONLY SOURCED RN IN THIS PACK, and it came from PETER MILLAR''S OWN help centre rather than the FTC register — an aside in a shipping FAQ noting that the number by the country of origin "is not the style number. eg. rn100308". The FTC registrant name could not be confirmed, so treat 100308 as "the RN that appears on PM tags". ⚠ G/FORE IS NOT A PETER MILLAR SUB-LINE AND NEVER WAS — see the styles.',
   'https://www.petermillar.com/', 0.85, false, 'migration:00467'),

  ('toddsnyder', 'Todd Snyder',
   ARRAY['toddsnyder','toddsnydernewyork','toddsnyderchampion','toddsnyderxchampion','toddsnyderwhitelabel']::text[],
   ARRAY['premium menswear','tailoring','sweatshirts','denim','outerwear','cashmere']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists, and a targeted search for Todd Snyder counterfeits returns nothing at all — for a meaningfully faked brand, legit-check content is abundant, so the total absence is real if soft evidence. Premium but not hype-priced, sold mainly DTC, with no logo-driven silhouette to counterfeit. Grade condition only."}]$j$::jsonb,
   'Founded 2011 in NYC by Todd Snyder, a real living designer (ex-Polo Ralph Lauren, ex-Gap, ex-SVP menswear at J.Crew, where he designed the Ludlow suit). ACQUIRED BY AMERICAN EAGLE OUTFITTERS in Nov 2015 (~$11M, via Tailgate Clothing Company); Snyder became an AEO EVP and stayed creative director. ⚠ IT MUST NOT FOLD ONTO AMERICAN EAGLE (00458), and AEO''s own 10-K supports the split: Todd Snyder is a SEPARATE OPERATING SEGMENT described as a "premium menswear brand", with 23 stores. Be honest about the size of the gap, though — it is ~3-4x on jeans ($198 selvedge vs AE''s $49.95-69.95), NOT an order of magnitude across the board; the real distance is the CATEGORY MIX (~$1,200 suits and a $1,498 cashmere chore coat in categories AE does not compete in). State it as a different price band and category mix. ⚠ A PARENT-WIDE AEO RN COULD NEVER ATTRIBUTE THIS BRAND: AEO owns AE, Aerie, Todd Snyder, Tailgate and Unsubscribed, so a shared RN would resolve a $1,498 chore coat onto a mall canonical (the URBN RN 66170 rule, 00466). No RN could be sourced anyway. ⚠ TAG ERAS ARE EMPTY ON PURPOSE: no source reaches a Todd Snyder tag, so the 2011/2014/2015 corporate dates are NOT tag tells. Todd Snyder is also a country musician — bare-name text matching will pull non-apparel noise.',
   'https://www.toddsnyder.com/', 0.75, false, 'migration:00467'),

  ('buckmason', 'Buck Mason',
   ARRAY['buckmason','buckmasonknittingmills']::text[],
   ARRAY['american basics','tees','denim','workwear-adjacent','menswear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"Mohnton, PA\" / \"BM Knitting Mills\" on a tee tag","years":"2022 or later","description":"THE BRAND'S ONLY DATING TELL, and it is a FLOOR, NOT A CEILING. Buck Mason acquired the ~150-year-old Mohnton Knitting Mills (Mohnton, Pennsylvania), so a tee marked with that mill cannot predate the acquisition. ⚠ The year itself is contested — trade press says 2023, a deal database says Dec 2022 (signing vs close would explain both), so do NOT pin a year. It says nothing about any non-tee garment, and it is an inference from the acquisition date rather than a published tag guide."}]$j$::jsonb,
   $j$[{"pattern":"MIXED, AND IT VARIES **WITHIN** A SINGLE PRODUCT LINE — read the tag","note":"⚠ THE MOST IMPORTANT FACT ABOUT THIS BRAND. See the notes and the \"Made in USA\" style row: two jeans on the SAME collection page differ, and the brand's own Our Story page admits partner factories abroad including Tuscany."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists, and there is NO counterfeit market — every counterfeit-directed search returns Buck KNIVES instead. A $48 unbranded tee is below the floor where counterfeiting pays: the brand's proposition is unbranded plainness, so there is no logo to steal. Grade condition only. The real risk is MISATTRIBUTION — a blank tee from any brand looks identical, and Buck Mason's own tee is effectively a blank."}]$j$::jsonb,
   'Founded 2013 in Venice, California by Sasha Koehn and Erik Allen Ford, out of a 350-square-foot garage. ⚠ ERIK ALLEN FORD AND ERIK SCHNAKENBERG ARE THE SAME PERSON — pre-~2016 press uses the older name, so a naive reader sees two founders where there is one. ⚠ THE NAME ORIGIN IS DELIBERATELY NOT RECORDED: two stories circulate (invented to honour the founders'' fathers, vs named for a grandfather who was a stone mason) and they contradict each other; NEITHER is primary-sourced, and the satisfying one is exactly what a model will confirm on demand. Buck Mason''s own journal does profile Sasha''s father Norbert Koehn, a SCULPTOR, as "the original blueprint" for the brand''s ethos — but never says the name came from him, which is probably how the "grandfather stone mason" garble started. ⚠ OWNERSHIP IS UNRESOLVED: aggregator funding data ($300K total) is implausible for a company running 33 stores and its own mill, so do NOT assert the brand is still independent. ⚠ A BARE "buck" IS NOT AN ALIAS — Buck Knives collides hard. "Buck Mason Knitting Mills" is a real registered mark (serial 98136280); whether it appears as a distinct TAG label rather than a facility name could not be sourced. No RN could be sourced.',
   'https://www.buckmason.com/', 0.75, false, 'migration:00467'),

  ('untuckit', 'UNTUCKit',
   ARRAY['untuckit','untuckedit','untuckitllc']::text[],
   ARRAY['menswear','shirts','untucked shirts','casual button-downs','womenswear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists. No evidence UNTUCKit is meaningfully counterfeited — a mid-market $80-130 shirt with weak logo signalling has poor counterfeit economics. Grade condition only; route authenticity to human review."},{"tell":"The one \"how to spot a fake UNTUCKit\" page is a content farm — reject it","detail":"⚠ NOT SOURCED: an SEO page asserts tells like \"signature patterns exclusive to UNTUCKit\", \"reinforced collar stays\", \"fabric shouldn't feel plasticky\" and \"check for spelling errors\". It cites nothing, none of it could be corroborated, and the tells are generic filler applicable to any shirt. This is exactly the fabrication-that-reads-as-confirmation risk."}]$j$::jsonb,
   'Founded 2011 by Chris Riccobono and Aaron Sanandres; HQ SoHo. THE WHOLE BRAND IS ONE IDEA: a shirt cut SHORTER so it is designed to be worn UNTUCKED. ⚠ THE INVESTOR IS KLEINER PERKINS, NOT KOHLBERG — $30M in 2017, sole investor, confirmed by the deal counsel; "Kohlberg" is a plausible phonetic conflation and must not be seeded. Current ownership is genuinely unknown (a "Lancer Capital 2025" claim appears to be an Iconix conflation and is rejected). ⚠ THE HEM RULE HAS NO NUMBER: the brand''s own Chief Merchandising Officer gives it as hitting "around mid-zipper", and UNTUCKit publishes NO body length in ANY of its size charts — so the shorter hem, which is the entire brand, has nothing to check against. The widely-quoted "1-2.5 inches shorter than a standard dress shirt" is generic menswear-blog guidance, NOT UNTUCKit''s spec, and the "contoured/curved hemline" language traces to a COMPETITOR''s blog. Treat hem length as corroborating, never identifying. Started shirts-only, then polos/tees/sweatshirts (2015), outerwear + the Performance line (2016), and chinos/sweaters/boys''/women''s (2017). ⚠ Expect LOGO''D CORPORATE-SWAG UNTUCKits in the supply (there is a B2B channel) — they suppress value. No RN could be sourced; no tag era tells exist.',
   'https://www.untuckit.com/', 0.80, false, 'migration:00467'),

  ('johnnieo', 'Johnnie-O',
   ARRAY['johnnieo','johnnyo','johnnieogolf','tweenerbutton','prepformance']::text[],
   ARRAY['california prep','menswear','polo','golf','outerwear','womenswear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard exists, and no authentication guide or legit-check entry could be found for the brand. Searches for Johnnie-O counterfeits return Johnnie WALKER whisky, which is itself weak evidence the phenomenon is not discussed. A mid-market $89-178 garment is a poor counterfeit target, and the only distinctive feature (the Tweener Button) is invisible in photos — so there is no basis for a photo-driven authentication call in either direction. Grade condition only."}]$j$::jsonb,
   'Founded 2005 in Santa Monica CA by John O''Donnell, a former UCLA golfer who sold the first polos out of his car — corroborated by the trademark record (serial 78673872, filed July 2005, originally owned by "O''Donnell, John"). Ownership: a $108M MINORITY investment from Ares Management and Wasatch Global (April 2022, the first institutional money); the founders retained control. CEO is Dave Gatto, not the founder. ⚠ PUNCTUATION IS TIME-DEPENDENT AND MUST BE MATCHED CASE-INSENSITIVELY: the current site uses "Johnnie-O" with a capital J, but the brand''s own older press releases use a lowercase "johnnie-O". The registered mark is JOHNNIE-O (a standard character mark, so legally case-agnostic — it settles nothing). Conveniently, brandKey() strips the hyphen, so "Johnnie-O", "Johnnie O" and "JohnnieO" ALL key to `johnnieo` and one alias covers every spelling; "Johnny O" is a common phonetic misspelling and gets its own key. ⚠ THERE IS NO "HANGOVER COLLAR" AND NO SNAP COLLAR — see the Tweener Button style row; the brand''s only "snap" product is an unrelated Ransel Hidden Snap Pullover, which is probably where that folklore started. An official NFL licensee with heavy collegiate/club co-branding, so expect logo''d variants. No RN could be sourced; no tag era tells exist.',
   'https://www.johnnie-o.com/', 0.80, false, 'migration:00467')
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
-- WHAT A "STYLE" IS IN THIS PACK. brandPackPromptBlock renders visual_fingerprint
-- VERBATIM into the extract prompt and collapses every authentication tell to ONE
-- GENERIC LINE — so a fact that must reach IDENTIFICATION belongs here or in a
-- chart note, never in a tell (US-1740). That is why the FIT VOCABULARIES are
-- seeded as first-class style rows: the fit word is the single most
-- decision-relevant thing on these garments, and the extract prompt is the only
-- place it can do any work.
--
-- These rows also carry an unusual amount of NOT-photo-separable prose, and that
-- is deliberate. This is a group of conservative, logo-light menswear brands, and
-- for most of them the honest finding is that the style is NOT recoverable from a
-- photo. Saying so plainly is the whole value: an un-warned model will produce a
-- confident style name for any plain polo, because the names are in its weights.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- Bonobos — THE FIT VOCABULARY IS THE HEADLINE ROW OF THE WHOLE PACK.
  ('bonobos', 'Fit vocabulary (Tailored / Slim Taper / Slim / Straight / Athletic / Classic)', 'Men', 'fit', 'Fit system',
   'NOT a garment — BONOBOS'' FIT SYSTEM, and the most important row in this pack. ⚠ **TAILORED IS TRIMMER THAN SLIM.** That inverts the industry-normal assumption and it is the brand''s OWN wording: Tailored is "trimmest in the hips and thighs, distinct taper from the thigh down", while Slim is merely "trim in the hips and thighs to remove billowing, with a subtle leg taper". Aggregators SPLIT on this — one states it correctly, another states the opposite outright — so a model cannot be rescued by retrieval and must be told. SIX pant fits, not four: Tailored (trimmest) / Slim Taper (Slim''s seat, more leg taper) / Slim / Straight (Slim''s seat, straight leg) / Athletic (looks like Slim but cut for larger builds, room in hips and thighs) / Classic (easy hips and thighs, longer rise, full leg). SHIRTS have their own four: Tailored (narrowest chest/shoulders, pronounced waist taper) / Slim / Standard / Athletic (roomiest shoulders, biceps and chest). BLAZERS have three: Slim / Standard / Athletic. ⚠ THE FIT DOES NOT CHANGE THE SIZE GRADE, only the cut — Bonobos'' own product pages show the SAME 6''2" model in a 32x32 in BOTH Athletic and Slim. So the fit is an ORTHOGONAL axis, not part of the size string. ⚠ "STANDARD" IS CURRENT, NOT HISTORICAL (shirts and blazers) — using it to date a garment would be actively harmful; it is simply not a PANT fit. "ONE FIT" is not a fit at all: it marks styles that opt OUT of the fit range entirely. THE FIT WORD IS TAG/LISTING-ONLY — it is not measurable off a photo.',
   ARRAY[]::text[], 'current', null,
   ARRAY['tailored','slim taper','slim','straight','athletic','classic','standard','one fit','fit']::text[],
   'https://bonobos.com/', 0.85, false, 'migration:00467'),
  ('bonobos', 'Washed Chino', 'Men', 'bottom', 'Signature',
   'The original — "the pants Bonobos was built on". THE TELLS ARE REAL AND PHOTOGRAPHABLE, which makes this one of the few separable styles in the pack: an **ITALIAN SLIDE SNAP at the centre-front closure** (a SLIDE SNAP, not a button, at the fly), the brand''s **signature CURVED WAISTBAND** (it conforms to the natural shape of the waist — the founding idea of the company), and a **CONTRAST POCKET LINER** visible in any pocket-out photo. 100% cotton.',
   ARRAY['100% cotton']::text[], 'current', '$$',
   ARRAY['washed chino','original chino','curved waistband','slide snap']::text[],
   'https://bonobos.com/', 0.85, false, 'migration:00467'),
  ('bonobos', 'Stretch Washed Chino 2.0', 'Men', 'bottom', 'Signature',
   'The Washed Chino''s successor, and it IS separable from it: the 2.0 adds a **SECURE ZIP POCKET AT THE HIP** which the original does not have, plus **LOGO BUTTONS**. Same curved waistband and contrast pocket liners. Fabric is the brand''s "exclusive 2.0 fabric" — ultra-soft cotton with 4-way stretch, wrinkle resistance and wicking. So: slide snap and no hip zip = the original; hip zip and logo buttons = the 2.0.',
   ARRAY['4-way stretch cotton']::text[], 'current (postdates the original Washed Chino)', '$$',
   ARRAY['stretch washed chino','2.0','hip zip pocket','4-way stretch']::text[],
   'https://bonobos.com/', 0.85, false, 'migration:00467'),
  ('bonobos', 'Stretch Weekday Warrior Dress Pant', 'Men', 'bottom', 'Signature',
   'THE BEST FINGERPRINT IN THIS ENTIRE PACK, and the only one identifiable from a SINGLE photo of a waistband: **THE DAY OF THE WEEK IS EMBROIDERED INSIDE THE WAISTBAND**, alongside a branded interior button — the brand''s own spec. The colourway IS a weekday (Monday Steel Blue, Tuesday Black, Wednesday Micro Olive Houndstooth, Thursday True Khaki, Friday Steel / Friday Grey), so the colour name and the embroidery corroborate each other. Stretch cotton with elastane, wrinkle-resistant; lightweight and wool variants exist.',
   ARRAY['stretch cotton/elastane','wrinkle-resistant']::text[], 'current', '$$',
   ARRAY['weekday warrior','day of week waistband','dress pant','monday','friday']::text[],
   'https://bonobos.com/', 0.90, false, 'migration:00467'),
  ('bonobos', 'Riviera Shirt', 'Men', 'top', 'Signature',
   '⚠ SEEDED AS A NEVER-GUESS ROW. Bonobos'' ENTIRE published spec for the Stretch Riviera Short Sleeve is "Short-sleeve body | Point collar" — that is a GENERIC GARMENT. There is NO construction tell that separates a Riviera from any other camp/sport shirt in a photo; its selling point is the PRINT, which is seasonal and unenumerable. A model WILL guess "Riviera" for any Bonobos short-sleeve shirt because the name is in its weights. Read the tag or the listing text, or decline — never infer Riviera from a photo.',
   ARRAY['stretch woven']::text[], 'current', '$$',
   ARRAY['riviera','short sleeve','point collar','never guess']::text[],
   'https://bonobos.com/', 0.75, false, 'migration:00467'),
  ('bonobos', 'Jetsetter Blazer / Suit', 'Men', 'tailoring', 'Signature',
   'Bonobos'' travel tailoring. Tells, per the brand''s own spec: NON-FUNCTIONAL CUFF BUTTONS, a DOUBLE VENT, FELT AT THE UNDERCOLLAR and light construction; the Knit & Wool variant is unlined with bound seams and adds a LOCKER LOOP. ⚠ NONE OF THESE IS UNIQUE TO BONOBOS — many mall-tier blazers share every one of them, so the combination is SUGGESTIVE, NOT CONCLUSIVE. Stretch Italian wool; the mills named on-page are Reda and Marzotto.',
   ARRAY['stretch italian wool','Reda','Marzotto']::text[], 'current', '$$$',
   ARRAY['jetsetter','travel blazer','italian wool','double vent']::text[],
   'https://bonobos.com/', 0.70, false, 'migration:00467'),

  -- Brooks Brothers — the two fit ladders, and the sheep-is-not-the-tier rule.
  ('brooksbrothers', 'Dress shirt fit ladder (Soho / Milano / Regent / Madison / Traditional)', 'Men', 'fit', 'Fit system',
   'NOT a garment — BROOKS BROTHERS'' SHIRT FIT LADDER, expressed as the brand''s own DELTAS against Regent (the baseline), which is what proves the ordering: **Soho -5" chest / -5" waist (extra slim) -> Milano -2.75" / -1.5" (slim) -> REGENT = baseline (regular) -> Madison +2.5" / +3.25" (relaxed) -> Traditional +5" / +5" (extra relaxed)**. ⚠ THE FIT DOES NOT CHANGE THE SIZE GRADE, only the cut: BB''s own product pages expose fit and size as two INDEPENDENT selectors, so a 16-34 Milano and a 16-34 Madison are both 16-34. ⚠ BB ALSO RUNS A SECOND, OVERLAPPING VOCABULARY on the same garments (Slim / Regular / Traditional; also Classic) and publishes NO crosswalk between the two — do not assume a mapping. THE FIT WORD IS TAG-ONLY.',
   ARRAY[]::text[], 'current', null,
   ARRAY['soho','milano','regent','madison','traditional','fit','dress shirt']::text[],
   'https://www.brooksbrothers.com/', 0.80, false, 'migration:00467'),
  ('brooksbrothers', 'Suit fit ladder (Milano / Regent / Madison)', 'Men', 'fit', 'Fit system',
   'NOT a garment — BROOKS BROTHERS'' SUIT FIT LADDER, and it is a DIFFERENT LADDER FROM THE SHIRTS despite sharing words. ⚠ **MADISON IS THE ROOMIEST SUIT FIT, NOT A TRIM ONE** — this is the correction that matters, because SEO fit-guides state the reverse and a model will repeat them. BB''s own size chart, in BB''s own wording: Milano "slim and tailored through the chest, body and sleeves" (-1.5" chest / -1" waist vs Regent); Regent "fitted through the chest, body and sleeves" (baseline); **Madison "OUR CLASSIC CUT, RELAXED through the chest, body and sleeves" (+3" chest / +5" waist)**. So: Milano = slimmest, Regent = middle, MADISON = ROOMIEST. ⚠ AND THE WORD MOVES BETWEEN CATEGORIES: Madison is 4th of 5 rungs on the shirt ladder but the roomiest of 3 here. Same word, two positions — never share one enum between shirts and suits.',
   ARRAY[]::text[], 'current', null,
   ARRAY['milano','regent','madison','fit','suit','sport coat']::text[],
   'https://www.brooksbrothers.com/', 0.85, false, 'migration:00467'),
  ('brooksbrothers', 'Original Polo® Button-Down Oxford (the OCBD)', 'Men', 'top', 'Signature',
   'BB''s defining shirt. The strongest single photo tell is **`6-Pleat Shirring®`** — BB''s REGISTERED six-pleat gather where the sleeve meets the cuff; it is brand-specific and it survives on vintage. Combine it with the **UNLINED, UNFUSED SOFT COLLAR WITH A PRONOUNCED ROLL** (the collar bows outward in a convex arc rather than lying flat), a CENTRE BACK PLEAT, a chest pocket and single-needle tailored side seams. ⚠ THE COLLAR ROLL ALONE IS NOT DISAMBIGUATING — J. Press, Mercer, Kamakura and Ralph Lauren all make rolled OCBDs; it is the shirring that is BB''s. ⚠ Do not over-claim Supima: the current American-Made page says only "100% Cotton". BB''s own sources disagree on the button-down collar''s origin (1896 on its Heritage page vs 1900 in its own press release) — do not state a year.',
   ARRAY['oxford cotton']::text[], 'collar origin disputed 1896-1900; style current', '$$',
   ARRAY['ocbd','original polo','oxford cloth button down','6-pleat shirring','unlined collar','collar roll']::text[],
   'https://www.brooksbrothers.com/', 0.85, false, 'migration:00467'),
  ('brooksbrothers', 'No. 1 Sack Suit', 'Men', 'tailoring', 'Signature',
   'THE BEST VISUAL FINGERPRINT BROOKS BROTHERS HAS, and one of the few genuinely photo-separable garments in this pack: a **3/2 LAPEL ROLL** (three buttons with the top one rolled under, so only two show), an **UNDARTED FRONT**, a **SOFT NATURAL SHOULDER**, a **CENTRE-BACK HOOK VENT** and a straight tubular hang. That combination — undarted front + 3/2 roll + hook vent — is distinctive against a generic darted two-button suit. Created 1901 per BB''s own Heritage page; still in production; the Ivy/Trad archetype.',
   ARRAY['wool']::text[], '1901-present', '$$$',
   ARRAY['no. 1 sack','sack suit','3/2 roll','undarted','natural shoulder','hook vent','ivy','trad']::text[],
   'https://www.brooksbrothers.com/', 0.80, false, 'migration:00467'),
  ('brooksbrothers', 'Golden Fleece® (top tier)', 'Men', 'tailoring', 'Tier',
   '⚠ **THE TIER IS THE WORDS, NOT THE SHEEP.** The suspended-lamb Golden Fleece LOGO is BB''s corporate mark and appears on ORDINARY MAINLINE GOODS TOO — "has the sheep therefore Golden Fleece tier" is FALSE and is the most common Brooks Brothers pricing error. The tier requires the WORDS "Golden Fleece" on the label. Construction: full canvas, half-lined with Bemberg, pick-stitched lapels, side vents, Super 150s wool from Loro Piana mills (Loro Piana is confirmed on BB''s own site; ZEGNA IS NOT — no BB source pairs them, do not seed it). ⚠ HONEST LIMIT: Golden Fleece is NOT reliably separable from mainline 1818 tailoring by a photo of the garment''s exterior — full canvas does not photograph. It needs a LABEL SHOT. Do not let a visual classifier claim this tier.',
   ARRAY['full canvas','Super 150s wool','Loro Piana','Bemberg lining']::text[], 'current', '$$$',
   ARRAY['golden fleece','full canvas','super 150s','loro piana','pick stitch','tier']::text[],
   'https://www.brooksbrothers.com/', 0.75, false, 'migration:00467'),
  ('brooksbrothers', '"346" label', 'Unisex', 'label', 'Tier',
   'NOT a garment — the label whose MEANING INVERTED, seeded as a first-class row because a rule keyed on it without an era gate will systematically misprice one era. Named for the 346 Madison Avenue flagship (occupied 1915). MID-CENTURY: a NEAR-MAINLINE line, "only a half-step below" mainline, for younger professionals, with "346" brass buttons on blazers. MODERN (roughly 2000s-2010s): FACTORY-OUTLET-EXCLUSIVE merchandise at lesser construction and lesser fabric. ⚠ NO TRANSITION YEAR IS SOURCED — both readings are forum-sourced and the date is not. So "346" alone tells you NOTHING until you have dated the garment by other means. ⚠ It is NOT a style code and encodes no size, style or date. ⚠ Do not anchor MSRP on a 346 garment: BB''s outlet pricing is the subject of a fictitious-"original"-price class action.',
   ARRAY[]::text[], 'meaning inverted — era-gate; no transition year sourced', null,
   ARRAY['346','outlet','factory','tier','era-gate']::text[],
   'https://www.brooksbrothers.com/', 0.55, false, 'migration:00467'),

  -- Peter Millar — the tier structure, and the correction to how much it is worth.
  ('petermillar', 'Crown / Crown Sport / Crown Crafted (line tiers)', 'Men', 'line', 'Tier system',
   'NOT a garment — PETER MILLAR''S TIER STRUCTURE, per its PARENT COMPANY (Richemont names exactly three menswear lines). **CROWN** = everyday, "casual but polished", Classic Fit; its seasonal sub-collections are Seaside (S/S) and Mountainside (A/W). **CROWN SPORT** = performance ("meant to improve every aspect of your wardrobe''s performance" — wicking, quick-dry, odour control, UPF, easy care), Classic Fit. **CROWN CRAFTED** = the premium tier: "luxury performance sportswear defined by tailored silhouettes featuring the finest Italian yarns and hardware", TAILORED ("Tour") Fit — and it is the one tier the brand tells you how to SEE: a **DARK NAVY LABEL** with the Crown Crafted logo, plus a **METALLIC CROWN SEAL** exclusive to the capsule (on second layers it sits on the BACK YOKE; on the Performance Soft Jacket, inside an INTERIOR CELL PHONE POCKET). ⚠ **THE TIER IS WORTH LESS THAN IT LOOKS — ~20%, NOT A MULTIPLE.** Like-for-like: a Crown Sport jersey polo is ~$95 and a Crown Crafted jersey polo ~$115. Meanwhile a CROWN Perth quarter-zip is $145 — MORE than a Crown Crafted polo. **CATEGORY DOMINATES PRICE, NOT TIER** (polo $95-125 -> quarter-zip $145-198 -> Excursionist Flex blazer $1,295). Weighting tier heavily in a pricing model will misprice badly. Crown Comfort, Crown Soft and Summer Comfort are NOT tiers (see their own rows). ⚠ THE CROWN AND CROWN SPORT LABELS ARE NOT DESCRIBED BY ANY SOURCE — only Crown Crafted''s is; do not invent the others.',
   ARRAY[]::text[], 'Crown Crafted ~2019 or earlier; tiers current', '$$-$$$',
   ARRAY['crown','crown sport','crown crafted','tier','crown seal','tour fit','back yoke']::text[],
   'https://www.richemont.com/our-maisons/peter-millar/', 0.85, false, 'migration:00467'),
  ('petermillar', 'Crown Comfort / Crown Soft / Summer Comfort (NOT tiers)', 'Men', 'line', 'Sub-collection',
   'NOT a garment and NOT a tier — seeded because all three LOOK like tiers and are not, which would corrupt a tier-based pricing model. **SUMMER COMFORT** is a shirt family INSIDE Crown Sport — Peter Millar''s own help centre: "Our Summer Comfort shirts can be found under our Crown Sport Collection". **CROWN COMFORT** is a sub-collection within Crown (soft, drapey, cotton-forward layering pieces), filed under the brand''s "Icons" signature families rather than the hierarchy. **CROWN SOFT** is a SWEATER FABRIC FAMILY (Crown Soft Merino-Silk: 80% merino / 14% silk / 6% nylon; V-neck, crew, quarter-zip). None of the three is a level in the Crown / Crown Sport / Crown Crafted ladder.',
   ARRAY['merino-silk']::text[], 'current', '$$',
   ARRAY['crown comfort','crown soft','summer comfort','icons','not a tier']::text[],
   'https://help.petermillar.com/', 0.80, false, 'migration:00467'),
  ('petermillar', 'G/FORE is NOT a Peter Millar line', 'Unisex', 'label', 'Sibling brand',
   'NOT a garment — a REFUSAL seeded as a row, because the correct answer CHANGED and both common beliefs are now stale. Peter Millar ACQUIRED G/FORE in Jan 2018, so from 2018 to 2025 G/FORE was a SUBSIDIARY of Peter Millar. In **February 2025** Richemont moved it OUT: in Richemont''s own words, "G/FORE, previously under Peter Millar''s umbrella since its acquisition in 2018, was added to Richemont''s F&A portfolio as a DISTINCT MAISON in February 2025". It is now listed SEPARATELY from Peter Millar. ⚠ EITHER WAY — subsidiary then, sibling now — **G/FORE IS A DIFFERENT BRAND AND MUST NEVER FOLD ONTO PETER MILLAR**: its garments carry G/FORE branding, not Crown labels. Note the residue that will mislead you: Peter Millar LLC still HOLDS the G/FORE trademark for digital collectibles — trademark ownership lags the org chart, so do not infer current structure from it.',
   ARRAY[]::text[], 'PM subsidiary 2018-2025; distinct Richemont Maison from Feb 2025', null,
   ARRAY['g/fore','gfore','sibling','do not fold','richemont']::text[],
   'https://www.richemont.com/our-maisons/peter-millar/', 0.90, false, 'migration:00467'),
  ('petermillar', 'Perth Performance Quarter-Zip', 'Men', 'top', 'Signature',
   'Peter Millar''s signature layer and one of its highest-volume resale garments. ⚠ WEAK PHOTO FINGERPRINT — banded cuffs and hem, contrast trim, and a **HEAT-SEALED CROWN LOGO ON THE BACK NECK YOKE** (the logo placement is the reliable part; on polos and hoodies the crown is embroidered on the LEFT CHEST). "Perth" is a FABRIC/MODEL name, not a silhouette, so it is NOT reliably separable from Peter Millar''s other quarter-zips by photo — read the tag. 89% polyester / 11% spandex stretch French terry; 4-way stretch, wicking, UPF 50+.',
   ARRAY['stretch french terry','4-way stretch','UPF 50+']::text[], 'current', '$$',
   ARRAY['perth','quarter zip','1/4 zip','pullover','back neck yoke']::text[],
   'https://www.petermillar.com/', 0.80, false, 'migration:00467'),
  ('petermillar', 'Excursionist Flex Blazer', 'Men', 'tailoring', 'Signature',
   'The top of Peter Millar''s range and a STRONG photo fingerprint, unusually for this pack: SMOKED MOTHER-OF-PEARL BUTTONS, a notched lapel, a BARCHETTA (curved boat-shaped) CHEST POCKET, half-lined, with a hand-tacked lapel pin. 93% merino / 6% silk / 1% elastane from an Italian mill, with a water-resistant finish. ~$1,295 — this single garment is why tier must not dominate a Peter Millar pricing model: it is ten times a Crown Sport polo. ⚠ The Excursionist Flex KNIT versions (polo/hoodie) have a WEAK fingerprint by contrast — the blazer is the separable one.',
   ARRAY['merino-silk-elastane','water-resistant finish']::text[], 'current', '$$$',
   ARRAY['excursionist flex','blazer','wool silk','travel blazer','barchetta']::text[],
   'https://www.petermillar.com/', 0.80, false, 'migration:00467'),

  -- UNTUCKit — the fit vocabulary and the tag-only wine names.
  ('untuckit', 'Fit vocabulary (Regular / Slim / Relaxed / Regular Tall / Slim Tall)', 'Men', 'fit', 'Fit system',
   'NOT a garment — UNTUCKit''s FIVE fits, in the brand''s own words: **Regular** "our classic cut with the perfect untucked length; runs slightly smaller than traditional shirts" / **Slim** "two inches less fabric in the body and a half inch less in the sleeve" / **Relaxed** "three extra inches of room in the body WITHOUT ANY EXTRA LENGTH" / **Regular Tall** "two extra inches of length in the body and sleeves" / **Slim Tall** "two inches slimmer in the body and one inch slimmer in the sleeve, plus two inches of length in the hem and sleeves". ⚠ **THERE IS NO "ATHLETIC" FIT** — it is a plausible invention and does not exist. ⚠ THE FIT DOES NOT CHANGE THE SIZE GRADE, only the cut: all five share ONE alpha run, Relaxed adds room "without any extra length", and Tall adds length without changing the letter — so a Slim L and a Relaxed L are BOTH "L". The fit is an item specific, not part of the size string. ⚠ The brand''s own guidance is that its shirts RUN SMALL against mainstream brands ("if you are right on the border or between sizes, order one size up") — so an UNTUCKit L flat-measures smaller than a mainstream L.',
   ARRAY[]::text[], 'current', null,
   ARRAY['regular','slim','relaxed','regular tall','slim tall','fit','runs small']::text[],
   'https://www.untuckit.com/', 0.85, false, 'migration:00467'),
  ('untuckit', 'The untucked hem (the brand''s entire premise)', 'Men', 'design', 'Brand premise',
   'NOT a garment — THE IDEA THE COMPANY IS BUILT ON, seeded with its number REFUSED. UNTUCKit shirts are cut SHORTER so they are designed to be worn UNTUCKED, and the brand''s own Chief Merchandising Officer gives the rule as hitting **"around mid-zipper"**. ⚠ **THERE IS NO PUBLISHED INCH THRESHOLD, AND NO BODY LENGTH IN ANY UNTUCKit SIZE CHART** — chest, waist, sleeve and neck only. So the shorter hem, which is the whole brand, has NOTHING to measure against. A flat-measured body length is meaningful only COMPARATIVELY (against a same-size conventional dress shirt), never against a spec. ⚠ REFUSED, because both are widely repeated and neither is UNTUCKit''s: the "1-2.5 inches shorter than a standard dress shirt" figure is generic menswear-blog guidance, and the "contoured/curved hemline" language comes from a COMPETITOR''s blog — UNTUCKit''s own guide never claims a contoured hem. TREAT HEM LENGTH AS CORROBORATING, NEVER IDENTIFYING.',
   ARRAY[]::text[], 'current', null,
   ARRAY['untucked','hem','mid-zipper','shorter hem','no published length']::text[],
   'https://www.untuckit.com/', 0.80, false, 'migration:00467'),
  ('untuckit', 'Wine-named shirt styles (tag-only)', 'Men', 'top', 'Naming convention',
   'NOT a garment — UNTUCKit''s STYLE-NAMING CONVENTION, seeded as a NEVER-GUESS row because it is the pack''s clearest hallucination hazard. UNTUCKit names shirts after GRAPE VARIETALS, WINE REGIONS AND WINERIES (verified: Sangiovese, Gironde; the founder''s wine obsession is corroborated — the SoHo conference rooms are named for wineries). The company has run ~500 styles and has "pretty much expired every known grape type and wine region". ⚠ **THE WINE NAME IS NOT RECOVERABLE FROM A PHOTO — ONLY FROM THE TAG OR THE ORIGINAL LISTING.** The names are ARBITRARY LABELS, not designs: "Sangiovese" is a grey wrinkle-free shirt and nothing about it depicts Sangiovese. With ~500 styles cycling through a tiny design space (solid/check/plaid button-downs in a few collar and pocket configs), dozens are PAIRWISE INDISTINGUISHABLE in a photo. A model WILL produce a confident wine name on demand because the names are in its weights — that is guessing, not vision. If the tag is not legible, the correct output is UNKNOWN STYLE. ⚠ The brand-wide "signature sail detail" identifies THE BRAND, NOT THE STYLE. Sub-lines Wrinkle-Free / Performance (2016) / Wrinkle-Free Performance are three DISTINCT lines, not synonyms — but whether they appear on the neck/care LABEL (rather than only the listing title) could not be sourced.',
   ARRAY['long-staple cotton','wrinkle-free finish']::text[], 'current', '$$',
   ARRAY['sangiovese','gironde','gibson','wine','tag only','never guess','sail detail']::text[],
   'https://www.untuckit.com/', 0.80, false, 'migration:00467'),

  -- Johnnie-O — the Tweener Button, and why it is not a fingerprint.
  ('johnnieo', 'Tweener Button®', 'Men', 'design', 'Brand detail',
   'NOT a garment — Johnnie-O''s signature mechanism, and the pack''s sharpest "brand fact that is NOT a fingerprint". ⚠ **THERE IS NO "HANGOVER COLLAR" AND IT IS NOT A SNAP AND IT IS NOT ON THE COLLAR** — all three are folklore. What is REAL is patented and trademarked: **US PATENT 9,538,791B2 "Shirt garment with hidden button"** (inventor John O''Donnell, assignee Johnnie O Inc, filed 2013, granted 2017) and **registered mark TWEENER BUTTON (reg. 4633112)**. The mechanism is a small INTERMEDIATE BUTTON, of SMALLER DIAMETER than its neighbours, CONCEALED INSIDE A FLY-FRONT SEGMENT of the placket — and only that segment is fly-front ("a remaining portion of the placket is not a fly front placket"). It sits between the 2nd and 3rd buttons counting the collar button as the 1st. Origin ~2009, which PREDATES the patent filing. ⚠ **IT IS INVISIBLE IN A PHOTO BY DESIGN — concealment is literally the patent''s purpose.** So it must be POSITIVE-EVIDENCE-ONLY: seeing it is weak-positive, NOT seeing it means NOTHING. Seeding it as a visual fingerprint would produce confident FALSE NEGATIVES on genuine garments. ⚠ AND IT IS ABSENT FROM THE ORIGINAL 4-BUTTON POLO — the very product it is assumed to define; it appears on Top Shelf polos and woven button-ups. An SEO blog claiming the Original has one contradicts the brand''s own page and is rejected.',
   ARRAY[]::text[], 'c.2009-present (patent filed 2013, granted 2017)', null,
   ARRAY['tweener button','hidden button','fly front placket','patent','positive evidence only']::text[],
   'https://www.johnnie-o.com/', 0.85, false, 'migration:00467'),
  ('johnnieo', 'Original 4-Button Polo', 'Men', 'top', 'Signature',
   'Johnnie-O''s defining garment. Real tells, per the brand''s own page: a **4-BUTTON APPLIED PLACKET**, a **CHEST POCKET WITH THE EMBROIDERED SURFER LOGO** (the brand describes its mark as "a surfer in a moment of thought" — this is the brand''s reliable visual anchor, not the Tweener), **SPLIT SIDE VENTS WITH CONTRAST INSIDE VENTS**, and a hem cut ~2" shorter ("Hangin'' Out" is a CUT, not a quality tier). ⚠ **IT DOES NOT HAVE A TWEENER BUTTON** — see that row. ⚠ Original vs Stretch Cotton vs Performance vs Top Shelf polos are LARGELY NOT PHOTO-SEPARABLE: they differ by fabric hand and tier, which a photo does not carry. The Original''s CHEST POCKET is the one partial discriminator (other tiers are commonly pocketless — INFERRED, not sourced; verify before relying). Do not build a photo-based tier classifier for Johnnie-O polos.',
   ARRAY['cotton']::text[], '2005-present', '$$',
   ARRAY['original polo','4-button','surfer logo','chest pocket','split side vents','hangin out']::text[],
   'https://www.johnnie-o.com/', 0.85, false, 'migration:00467'),
  ('johnnieo', 'Prep-Formance (being retired)', 'Men', 'line', 'Fabric line',
   'NOT a garment — Johnnie-O''s performance FABRIC LINE, seeded because it appears to be MID-RETIREMENT and that makes it a soft era marker. The brand''s current polo tiers are Performance / Stretch Cotton / Original / Top Shelf — **"Prep-Formance" is ABSENT from them**, and although the /mens-prep-formance-gear URL persists, its on-page heading now reads "Men''s Performance Gear". Legacy product names still carry it (Birdie PREP-FORMANCE, Talon PREP-FORMANCE). ⚠ SO "Prep-Formance" ON A TAG OR LISTING IS A SOFT OLDER MARKER AND "Performance" IS CURRENT — but this is REASONED, NOT DIRECTLY SOURCED, so do NOT convert it into a date. Spelling is hyphenated; no ® or ™ is used on the brand''s pages. ⚠ "Original Cotton" IS NOT A REAL LINE NAME (the real ones are "Original Polos" and, separately, "Stretch Cotton Polos"); "Baja" is a COLOURWAY on the Talon hoodie, NOT a style.',
   ARRAY['moisture-wicking','wrinkle-resistant','UPF 50']::text[], 'legacy — being replaced by "Performance"', '$$',
   ARRAY['prep-formance','performance','talon','birdie','soft era marker']::text[],
   'https://www.johnnie-o.com/', 0.60, false, 'migration:00467'),

  -- Vineyard Vines — the Shep Shirt and the separability problem.
  ('vineyardvines', 'Shep Shirt™', 'Unisex', 'top', 'Signature',
   'Vineyard Vines'' signature and its highest-volume resale garment: a **QUARTER-ZIP PULLOVER SWEATSHIRT** — long sleeve, ribbed cuffs and hem, a short zip placket at the neck, chest whale. The brand''s own fit guide calls it "a roomier, more comfortable fit through the sleeves and body", made for layering; sold XS-6X across Regular and Big & Tall. ⚠ **SEPARABILITY IS THE PROBLEM AND IT IS TWO-LAYERED.** (a) A Shep Shirt is not distinguishable from a generic quarter-zip pullover EXCEPT by the whale/wordmark. (b) Worse, its own sub-variants — Classic / Heathered Pouch Pocket / Madras / Collegiate / Dreamcloth / Performance / Slub Hoodie — are separable ONLY when the distinguishing feature is visible: a POUCH POCKET, MADRAS PLAID or a HOOD are photographable, but **a solid Classic vs a solid Dreamcloth vs a solid Performance Shep Shirt are NOT photo-separable.** Read the tag or the listing. ⚠ No introduction date is sourced (the brand says "for decades") — do not state a year.',
   ARRAY[]::text[], 'no introduction date sourced', '$$',
   ARRAY['shep shirt','quarter zip','1/4 zip pullover','dreamcloth','pouch pocket','madras']::text[],
   'https://www.vineyardvines.com/', 0.80, false, 'migration:00467'),
  ('vineyardvines', 'Sankaty vs Edgartown polo', 'Men', 'top', 'Signature',
   'The brand''s two polo families, seeded as ONE row because THE PAIR IS THE FACT. **SANKATY** is the performance bestseller — a polo in a SMOOTH TECHNICAL KNIT with wicking, UPF 50 and stretch, named for Sankaty Head Lighthouse Golf Club. **EDGARTOWN** is the CLASSIC COTTON PIQUE polo ("classic pique look with secret performance features"). ⚠ **THEY ARE NOT PHOTO-SEPARABLE IN SOLID COLOURWAYS**: the difference is fabric hand — technical knit vs pique — which a listing photo does not reliably resolve. Pique''s texture is SOMETIMES visible in a macro/detail shot, so treat this as a detail-shot-only distinction and otherwise read the tag. Neither has a sourced introduction date.',
   ARRAY['wicking technical knit','cotton pique','UPF 50']::text[], 'no introduction date sourced', '$$',
   ARRAY['sankaty','edgartown','performance polo','pique polo','detail shot only']::text[],
   'https://www.vineyardvines.com/', 0.70, false, 'migration:00467'),
  ('vineyardvines', 'Breaker Pant', 'Men', 'bottom', 'Signature',
   'Vineyard Vines'' chino, and a **ZERO-FINGERPRINT** row: a Breaker is visually a plain flat-front chino with no visible tech features, and **Original vs Stretch vs Slim Breaker are NOT separable by photo at all** — Slim differs only in cut, which a flat-lay will not reliably show. Requires the tag. Original Breaker is reported 98% cotton / 2% spandex. ⚠ THE SUB-VARIANTS THAT **ARE** PHOTO-IDENTIFIABLE are the fabric ones: SEERSUCKER Breaker (puckered stripe), MADRAS Breaker (plaid), Glen Plaid cotton/linen, and Embroidered Breaker (all-over motif). Identify the FABRIC, not the fit. ⚠ "HARBOR PANTS" IS NOT A VINEYARD VINES STYLE — "Gray Harbor" is a COLOUR NAME (and a "Harbor Shirt" exists separately); the conflation is a common invention and must not be seeded.',
   ARRAY['98% cotton / 2% spandex']::text[], 'no introduction date sourced', '$$',
   ARRAY['breaker','chino','seersucker','madras','not harbor pants']::text[],
   'https://www.vineyardvines.com/', 0.70, false, 'migration:00467'),
  ('vineyardvines', 'Silk necktie (the origin product)', 'Men', 'accessory', 'Heritage',
   'THE ONE VINEYARD VINES STYLE WITH A GENUINELY STRONG PHOTO FINGERPRINT, and the company''s origin product: a silk necktie in a whimsical ALL-OVER NOVELTY PRINT (lobsters, boats, whales, sport and school motifs). Ties are explicitly in the 1998 trademark''s goods recitation, so the tie-only era (1998-early 2000s) is the collectible one. ⚠ An early tie CANNOT be dated from its tag by any sourced rule — the only orientation is the whale''s ~2003-2004 soft floor, and a whale-FREE early tie has no sourced dating rule at all.',
   ARRAY['silk']::text[], '1998-present (the origin category)', '$$',
   ARRAY['necktie','tie','silk','novelty print','lobster','whale']::text[],
   'https://www.vineyardvines.com/', 0.80, false, 'migration:00467'),

  -- Faherty — the signature, and the ™-vs-® fabric rule.
  ('faherty', 'Legend™ Sweater Shirt', 'Unisex', 'top', 'Signature',
   'Faherty''s signature and the one style here with a real photographic idea behind it: a garment with **SHIRT ARCHITECTURE** (full button placket, real collar, chest pocket, shirttail hem) rendered in a **BRUSHED, NAPPED SWEATER-KNIT** rather than woven shirting — the brand''s own line is "looks like a button-down, feels like a sweater". In a photo: shirt structure plus a visibly fuzzy/lofty knit surface, no crisp weave or pressed creases, and a collar that DRAPES rather than stands. Usually plaid or heathered solid. ⚠ SEPARABILITY, HONESTLY: the Legend Sweater CREW and HOODIE are separable from the Shirt (only the Shirt has the full placket), but **a Legend Sweater Shirt vs a Faherty FLANNEL is often NOT reliably separable in a low-res photo** — the tell is nap and drape, which compresses away.',
   ARRAY['organic cotton','REPREVE® recycled polyester','viscose','elastane']::text[], 'current', '$$',
   ARRAY['legend','sweater shirt','brushed','napped knit','plaid']::text[],
   'https://fahertybrand.com/', 0.85, false, 'migration:00467'),
  ('faherty', 'Fabric names: Legend™ / Movement™ / All Day™ are ™, NOT ®', 'Unisex', 'fabric', 'Fabric system',
   'NOT a garment — THE FABRIC-ATTRIBUTION RULE, and it cuts in a direction a model will get backwards. **FAHERTY''S OWN NAMES ARE UNREGISTERED ™, NEVER ®**: the brand renders Legend™, Movement™ and All Day™ with a ™ everywhere (its own site uses "Movement™" hundreds of times and "Movement®" zero times), which is the brand''s own admission of a common-law claim, and its trademark portfolio contains no LEGEND/MOVEMENT/ALL DAY registration. CLOUD CASHMERE is the one fabric-ish name with an actual filing. ⚠ **AND THE ® MARKS ON A FAHERTY TAG BELONG TO OTHER COMPANIES**: REPREVE® is Unifi''s, Supima® is the Supima growers'' association''s, LENZING™ ECOVERO™ is Lenzing''s. They are LICENSED INPUTS used by dozens of brands and carry **ZERO brand-identifying signal** — "Faherty''s proprietary REPREVE fabric" is a wrong fact waiting to be generated. ⚠ **MOVEMENT™ IS A FABRIC PLATFORM, NOT A SILHOUETTE**: the Movement 5-Pocket Pant is a conventional 5-pocket in a Supima-blend stretch twill and is NOT separable by photo from a generic chino — identify it from the tag. ⚠ "SURF STRETCH" IS NOT A FAHERTY FABRIC (zero site hits; likely a garble of "Surf Stripe"), and the "All Day Shirt" does not exist — **All Day™ is a SHORT/BOARDSHORT line**.',
   ARRAY['REPREVE®','Supima®','LENZING™ ECOVERO™']::text[], 'current', null,
   ARRAY['legend','movement','all day','cloud cashmere','repreve','supima','not surf stretch']::text[],
   'https://fahertybrand.com/', 0.85, false, 'migration:00467'),
  ('faherty', 'Doug Good Feather collaboration', 'Unisex', 'apparel', 'Collaboration',
   'THE STRONGEST VISUAL SIGNATURE IN FAHERTY''S CATALOGUE — an ALL-OVER INDIGENOUS-DESIGNED MOTIF PRINT, most notably on the Canyon Overshirt (100% organic cotton) and the Adirondack Blanket. THE PRINT ITSELF IS THE IDENTIFIER. Doug Good Feather is of the Standing Rock Lakota/Dakota Nation and founder of the Lakota Way Healing Center; the partnership funded 160+ acres of land purchase. ⚠ **CULTURAL-SENSITIVITY RULE FOR GENERATED LISTING COPY**: these are LICENSED COLLABORATIONS WITH A NAMED INDIGENOUS DESIGNER. Never describe them as generic "tribal", "aztec" or "southwestern" print — name the collaboration.',
   ARRAY['organic cotton']::text[], 'current', '$$',
   ARRAY['doug good feather','canyon overshirt','indigenous design','collaboration','named print']::text[],
   'https://fahertybrand.com/', 0.85, false, 'migration:00467'),

  -- Buck Mason — the origin rule and the two indistinguishable tees.
  ('buckmason', 'Made in USA VARIES BY PRODUCT — read the tag', 'Unisex', 'origin', 'Origin rule',
   'NOT a garment — **THE MOST IMPORTANT FACT ABOUT THIS BRAND**, and it is proven on a SINGLE collection page. Buck Mason markets American manufacturing heavily, but origin is a **PRODUCT-level fact, never a brand-level one**. On the brand''s own men''s-jeans page: the Japanese Loomstate Selvedge **Full Saddle** and **Cowboy Cut** jeans ($278) ARE badged Made in USA (LA-sewn) — while the **Ford Standard** and **Maverick Slim** jeans ($198-228), same page, same denim story, are **NOT**. So the brand''s HIGHER-VOLUME jeans are not US-made and a "Buck Mason therefore Made in USA" inference is wrong on exactly the garments that arrive most. ⚠ **"JAPANESE DENIM" NAMES THE MILL, NOT THE SEWING COUNTRY** — an easy and dangerous conflation. What IS US-made, per the brand: the Slub, Pima and Tough-Knit TEES, sewn at its own Mohnton, Pennsylvania knitting mill from American-grown cotton (women''s knits carry a "Grown + Sewn USA" badge), and the Loomstate denim, made in Los Angeles. What is NOT: the brand''s own Our Story page admits partner factories abroad "including Tuscany". Because FTC rules require "all or virtually all" US content for an unqualified claim, the TAG is meaningful evidence — and it is the ONLY authority. Never infer origin from the brand, the mill name, or the marketing.',
   ARRAY[]::text[], 'current', null,
   ARRAY['made in usa','mohnton','grown + sewn','origin','read the tag','japanese denim']::text[],
   'https://www.buckmason.com/', 0.85, false, 'migration:00467'),
  ('buckmason', 'Slub vs Pima Curved Hem Tee', 'Unisex', 'top', 'Signature',
   'THE BRAND''S SIGNATURE AND ITS WORST IDENTIFICATION PROBLEM, seeded as one row because the PAIR is the fact. Both are $48, XS-XXL, sewn at Mohnton PA, with the same curved (elongated, scooped) hem and OVERLAPPING COLOURWAYS. ⚠ **THEY ARE NOT PHOTOGRAPHICALLY SEPARABLE FROM EACH OTHER.** The ONLY difference is YARN TEXTURE — slub is nubby and irregular, pima is smooth and uniform — which is visible only in a macro/detail shot, never in a standard listing photo. Resolve from the tag or the seller''s title, or collapse them into one node; a classifier claiming to separate them from an image is guessing. ⚠ AND THE STYLE HAS ALMOST NO FINGERPRINT AT ALL: the curved hem is real and is the brand''s signature detail, but **curved hems are ubiquitous and not proprietary**; there is no chest logo, no distinguishing stitch, no colour-blocking. ⚠ "SLUB" AND "PIMA" ARE **GENERIC TEXTILE TERMS**, not Buck Mason technology — slub is irregular yarn, pima is an extra-long-staple cotton varietal, and any competitor may sell a "slub tee". **The word "slub" in a listing title is NOT brand evidence for Buck Mason.** (Supima® IS a registered mark — but it belongs to the Supima growers'' association, not to Buck Mason.) "Venice Wash" is a real brand-specific GARMENT-DYE/ENZYME-RINSE process name, but NO registration could be verified — call it brand-specific, never trademarked.',
   ARRAY['slub cotton','pima cotton','Venice Wash']::text[], 'Mohnton marking is post-2022', '$-$$',
   ARRAY['slub','pima','curved hem tee','venice wash','not photo separable','generic terms']::text[],
   'https://www.buckmason.com/', 0.85, false, 'migration:00467'),

  -- Todd Snyder — the collab attribution rule.
  ('toddsnyder', 'Todd Snyder + Champion', 'Unisex', 'top', 'Collaboration',
   'Todd Snyder''s longest-running collaboration (launched 2013, still producing) and its most common resale garment — the POCKET SWEATSHIRT/HOODIE. Canadian-milled cotton fleece/French terry (WS & Company), cut on the CROSS GRAIN, with flatlock seams, chunky ~4" cuffs and waistband, and a ribbed V-insert under the front collar; ~$138-168. ⚠ **NOT PHOTO-SEPARABLE FROM A STANDARD CHAMPION SWEATSHIRT**: the V-insert and the sleeve patch are CHAMPION REVERSE WEAVE HERITAGE CUES, not Todd Snyder-unique — plain Champion has them too. Route on the TAG, never the silhouette. ⚠ **THE ATTRIBUTION RULE (reasoned, not a sourced standard): a tag reading "Todd Snyder + Champion" resolves to TODD SNYDER**, carrying Champion as a collab attribute — Todd Snyder owns the design, sells it through its own channels, and prices it at ~3x a standard Reverse Weave, so Champion is the manufacturing/heritage input and Todd Snyder is the commercial identity. Resolving it the other way drags a $168 garment onto a mass-market canonical. ⚠ NEVER resolve this pair by a shared-owner heuristic: Todd Snyder is American Eagle Outfitters and CHAMPION WAS SOLD BY HANESBRANDS TO AUTHENTIC BRANDS GROUP in Sep 2024 — the collab spans two unrelated parents.',
   ARRAY['canadian cotton fleece','french terry']::text[], '2013-present', '$$',
   ARRAY['todd snyder champion','pocket sweatshirt','reverse weave','collab','tag only']::text[],
   'https://www.toddsnyder.com/', 0.75, false, 'migration:00467'),
  ('toddsnyder', 'White Label (a LOWER-priced line, not a premium tier)', 'Men', 'line', 'Diffusion line',
   'NOT a garment — a CORRECTION seeded as a row, because the plausible-sounding version is BACKWARDS and a model will confirm it. ⚠ **TODD SNYDER WHITE LABEL IS A *LOWER*-PRICED DIFFUSION LINE, NOT A PREMIUM TIER.** WWD''s headline is literally "Todd Snyder to Launch LOWER-PRICED Line". Launched Fall 2014, EXCLUSIVELY at Nordstrom (~25 doors); suits $795-995, sport coats $695. It PRE-DATES the American Eagle acquisition (2014 vs 2015), so a White Label garment is from the independent era. ⚠ Sources CONFLICT on the manufacturer (Hart Schaffner Marx vs Peerless) — unresolved, so none is recorded. ⚠ How it is MARKED on the garment could not be sourced. Likely discontinued; a decade-old single-retailer line, so resale relevance is marginal — but the inverted premium claim is the thing to prevent.',
   ARRAY[]::text[], 'Fall 2014; likely discontinued', '$$$',
   ARRAY['white label','nordstrom','diffusion','lower priced','not premium']::text[],
   'https://www.toddsnyder.com/', 0.65, false, 'migration:00467')
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

-- ── brand_style_codes ──────────────────────────────────────────────────────
-- ONE DECODER. See the migration header for why the other eight brands' codes
-- are refused — every one is a web SKU inferred from a URL, and Buck Mason's is
-- disproven outright (its "style code" is constant across two different fits, so
-- it identifies the denim lot, not the style).
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples,
   source_url, confidence, verified, updated_by)
values
  ('petermillar', 'style_number',
   'Peter Millar style number, printed WITH THE CARE INSTRUCTIONS on the inside of the garment — the brand''s own help centre states it "can be found, together with care instructions, on the inside of the garment" and "typically starts with ''M'' for men''s products. eg. ME0EK01 or an ''L'' for ladies. eg. LE0B46". [ML] + a line letter (E = evergreen/carryover, S/F = seasonal) + digits + alphanumerics. ME0EK01 = Solid Performance Jersey Polo. Recovers the BRAND off a cut brand tag — the group''s cut-tag case, since the care label survives the collar tag being cut out. The same string is the live catalogue''s own key, so a legible code also looks the garment up. Like Canada Goose (00460), whose codes use the SAME M/L department letter, this captures ONLY styleCode: the shared genderCode transform maps W/M, and Peter Millar''s ladies'' letter is L, so capturing it would emit a raw "L" as a gender. ⚠ THE SEASON IS DELIBERATELY NOT DECODED — see the migration header: ME0S24 is an EVERGREEN sweater whose body merely contains "S24", so a naive Spring-2024 parse is silently wrong, and the brand publishes no decoder for the field at all.',
   '^(?<style>[ML][EFS]\d{1,2}[A-Z0-9]{2,6})$',
   $j${"fieldMap": {"style": "styleCode"}, "transforms": {"style": "upper"}, "confidence": 0.7}$j$::jsonb,
   $j$[{"code":"ME0EK01","expected":{"styleCode":"ME0EK01"}},{"code":"LE0B46","expected":{"styleCode":"LE0B46"}},{"code":"MF24Z02","expected":{"styleCode":"MF24Z02"}},{"code":"MS25XK70","expected":{"styleCode":"MS25XK70"}}]$j$::jsonb,
   'https://help.petermillar.com/', 0.70, false, 'migration:00467')
on conflict (brand_key, decoder_kind) do update set
  description      = excluded.description,
  pattern          = excluded.pattern,
  extraction_rules = excluded.extraction_rules,
  examples         = excluded.examples,
  source_url       = excluded.source_url,
  confidence       = excluded.confidence,
  updated_by       = excluded.updated_by;

-- ── brand_colorways ────────────────────────────────────────────────────────
-- FIVE ROWS, ALL ONE CONVENTION. See the migration header: eight of these nine
-- brands name colours evocatively and NONE of it is seeded, because per-season
-- per-SKU marketing copy both rots and licenses a model to confirm any plausible
-- invention. Bonobos' Weekday Warrior is the sole exception because it is a RULE
-- tied to a PHYSICAL GARMENT FEATURE — the day is embroidered inside the
-- waistband — so unlike every other colour name in this pack, the garment can
-- still prove it after the hangtag is gone.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('bonobos', 'Monday', ARRAY['monday steel blue','monday steel blue yarn dye']::text[], null,
   'current', 'https://bonobos.com/', 0.80, false, 'migration:00467'),
  ('bonobos', 'Tuesday', ARRAY['tuesday black']::text[], null,
   'current', 'https://bonobos.com/', 0.80, false, 'migration:00467'),
  ('bonobos', 'Wednesday', ARRAY['wednesday micro olive houndstooth']::text[], null,
   'current', 'https://bonobos.com/', 0.80, false, 'migration:00467'),
  ('bonobos', 'Thursday', ARRAY['thursday true khaki']::text[], null,
   'current', 'https://bonobos.com/', 0.80, false, 'migration:00467'),
  ('bonobos', 'Friday', ARRAY['friday steel','friday grey','friday grey yarn dye']::text[], null,
   'current', 'https://bonobos.com/', 0.80, false, 'migration:00467')
on conflict (brand_key, color_name) do update set
  aliases    = excluded.aliases,
  hex        = excluded.hex,
  years      = excluded.years,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  updated_by = excluded.updated_by;

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- Mirrored 1:1 into the sizing-charts.ts in-code fallback (the DB rows win when
-- the pack loads; the TS table is the offline path). Measurements are INCHES.
--
-- MENSWEAR RUNS FOUR SYSTEMS AT ONCE, so every chart names its SYSTEM in the
-- `garment` string: ALPHA tops, NECK x SLEEVE dress shirts, CHEST + a LENGTH
-- LETTER for tailoring, and WAIST IN INCHES for bottoms. Brooks Brothers sells
-- all four; UNTUCKit sells two and is the reason "UNTUCKit is alpha-sized" is
-- only half true.
--
-- THE CONFIDENCE COLUMN IS DOING REAL WORK AND IS DELIBERATELY UNEVEN:
--   0.85  Peter Millar, UNTUCKit, Johnnie-O, Vineyard Vines, Brooks Brothers —
--         the brand's OWN published chart (Peter Millar's recovered from its own
--         archived page; its live site serves a bot wall that returns HTTP 200,
--         so a status-code check does NOT detect the block — content-sniff it).
--   0.70  Faherty — the brand's own numbers, but the published assets are dated
--         2019 and the live fit may have drifted. Says so in the note.
--   0.55  Bonobos — the SYSTEM is confirmed three independent ways; the numeric
--         grid is NOT published anywhere reachable, so the chart carries the
--         system and the meaning, not invented measurements.
--   0.40  Todd Snyder, Buck Mason — NO brand-published numbers could be
--         obtained at all (toddsnyder.com 403s on every size-guide path; Buck
--         Mason's charts are JS-rendered modals). These rows carry the SIZE
--         SYSTEM ONLY and say outright that the numbers are not the brand's.
-- An honest 0.4 is worth more than a fabricated 0.9 — the Brandy Melville rule
-- from 00466: a chart is a suggestion to a model, and one that lies about its
-- provenance cannot be corrected later.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  -- Peter Millar — the brand's own chart, plus the re-cut warning.
  ('petermillar', 'Peter Millar', ARRAY['peter millar','petermillar']::text[], 'Men',
   'Tops (ALPHA S-3XL + numeric — body measurements)',
   ARRAY['top','tee','shirt','polo','sweater','quarter zip','pullover','hoodie','jacket','outerwear','blazer']::text[],
   $j$[{"size":"S (38)","measurements":{"chest":"37-39","neck":"14.5-15","sleeve":"33-33.5"}},{"size":"M (40)","measurements":{"chest":"40-42","neck":"15.5-16","sleeve":"34-35"}},{"size":"L (42-44)","measurements":{"chest":"43-45","neck":"16.5-17","sleeve":"35.5-36"}},{"size":"XL (46)","measurements":{"chest":"46-48","neck":"17.5-18","sleeve":"36.5-37"}},{"size":"XXL (48)","measurements":{"chest":"49-51","neck":"18.5-19","sleeve":"37.5"}},{"size":"3XL (50)","measurements":{"chest":"52-54","neck":"19.5-20","sleeve":"37.5"}}]$j$::jsonb,
   '⚠ PETER MILLAR RE-CUT THIS CHART BETWEEN 2023 AND 2025 — "Peter Millar M" MEANS A DIFFERENT BODY DEPENDING ON THE ERA. The rows above are the CURRENT (2025) grade. The prior generation ran ~1in smaller and carried a waist column since dropped: S chest 36-38 / M 39-41 / L 42-44 / XL 45-47 / XXL 48-50 / 3XL 51-53. THIS IS WHY THE AGGREGATORS DISAGREE and neither is "wrong": some mirror the current chart and some still mirror the 2023 one. Prefer the garment''s measurements over any conversion on a garment of unknown age. These are BODY measurements, not flat-garment. SPORT AND DRESS SHIRTS HAVE NO SEPARATE CHART — Peter Millar sizes them ALPHA against this table, NOT neck x sleeve, so there is no 16/34-style system for this brand. Outerwear also falls back here. CLASSIC vs TAILORED ("Tour") FIT DOES NOT CHANGE THIS GRADE: Peter Millar publishes ONE chart for both fits — Classic = "standard sleeve length with wider sleeve openings, relaxed in the shoulder, chest and waist, with longer body length" (Crown, Crown Sport, Seaside, Mountainside); Tailored = "shorter sleeve length with narrower sleeve openings, narrower in the shoulder, slimmer in the chest and waist, with shorter body length" (Crown Crafted, Peter Millar Collection). THE COLLECTION NAME IS THE FIT TELL. Big & tall is NOT offered in-house: PM tops out at 3XL and refers beyond that to a partner.',
   'https://www.petermillar.com/', 0.85, false, 'migration:00467'),

  ('petermillar', 'Peter Millar', ARRAY['peter millar','petermillar']::text[], 'Men',
   'Bottoms (numeric WAIST IN INCHES 28-46)',
   ARRAY['pant','bottom','short','trouser','chino','jean','denim','swim']::text[],
   $j$[{"size":"28 (S)","measurements":{"waist":"29.5","hips":"35.5"}},{"size":"30 (S)","measurements":{"waist":"31.5","hips":"37.5"}},{"size":"32 (M)","measurements":{"waist":"33.5","hips":"39.5"}},{"size":"34 (M)","measurements":{"waist":"35.5","hips":"41.5"}},{"size":"36 (L)","measurements":{"waist":"37.5","hips":"43.5"}},{"size":"38 (L)","measurements":{"waist":"39.5","hips":"45.5"}},{"size":"40 (XL)","measurements":{"waist":"41.5","hips":"47.5"}},{"size":"42 (XL)","measurements":{"waist":"43.5","hips":"49.5"}},{"size":"44 (XXL)","measurements":{"waist":"45.5","hips":"51.5"}},{"size":"46 (XXL)","measurements":{"waist":"47.5","hips":"53.5"}}]$j$::jsonb,
   'THE TAG NUMBER IS A WAIST IN INCHES — contrast Zara and H&M in 00466, where the same two digits are an EU size. VANITY SIZING, AND IT IS EXACTLY REGULAR: **the body waist is the tag size + 1.5in**, consistently across the whole run — usable as a validation rule. Alpha mapping: S = 28-30, M = 31-34, L = 35-38, XL = 40-42, XXL = 44-46. ⚠ THERE IS NO INSEAM GRID — Peter Millar sells men''s pants at a SINGLE 34in inseam and hems to order (shorts/swim run 8-10in; women''s pants 27.5in, skorts 18in). SO A USED PETER MILLAR PANT''S INSEAM MAY BE A CUSTOM HEM RATHER THAN A CATALOGUE LENGTH — measure it, never assume it. SUITING is a different system again: bare jacket numerics (38/40/42-44/46/48) with an optional LONG for sizes 42-48 and no SHORT; the brand''s older chart carried a drop rule it has since dropped from the page — "all pants will be six sizes below selected jacket size" (jacket 38 -> 32in waist).',
   'https://www.petermillar.com/', 0.85, false, 'migration:00467'),

  ('petermillar', 'Peter Millar', ARRAY['peter millar','petermillar']::text[], 'Women',
   'Tops & dresses (numeric 0-18 + alpha XS-XXL)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','polo','skort','jacket']::text[],
   $j$[{"size":"XS (0-2)","measurements":{"bust":"32.5-33.5","waist":"26-27","hip":"35-36"}},{"size":"S (4-6)","measurements":{"bust":"34.5-35.5","waist":"28-29","hip":"37-38"}},{"size":"M (8-10)","measurements":{"bust":"36.5-37.5","waist":"30-31","hip":"39-40"}},{"size":"L (12-14)","measurements":{"bust":"39-40.5","waist":"32-35","hip":"42-43"}},{"size":"XL (16)","measurements":{"bust":"42-43.5","waist":"36-37","hip":"45-46"}},{"size":"XXL (18)","measurements":{"bust":"45-46.5","waist":"39-40","hip":"48-50"}}]$j$::jsonb,
   'Peter Millar women''s runs a DUAL system — US numeric 0-18 AND alpha XS-XXL — and it runs to 18/XXL, past where many peers stop. Brand-published. ⚠ THE SAME 2023->2025 RE-CUT APPLIES: the 2023 chart gave XXL a 38-40in waist against the current 39-40. Prefer the garment on anything of unknown age. Women''s pants are a single 27.5in inseam and skorts 18in, hemmed to order — so a used inseam may be a custom hem.',
   'https://www.petermillar.com/', 0.85, false, 'migration:00467'),

  -- Brooks Brothers — the brand that sells all four menswear systems at once.
  ('brooksbrothers', 'Brooks Brothers', ARRAY['brooks brothers','brooksbrothers']::text[], 'Men',
   'Dress shirts (NECK x SLEEVE in inches — two independent measurements)',
   ARRAY['dress shirt','shirt','ocbd','oxford','button down']::text[],
   $j$[{"size":"XS (neck 14.5-15)","measurements":{"neck":"14.5-15","chest":"34.5-36","waist":"28.5-30.5"}},{"size":"S (neck 15-15.5)","measurements":{"neck":"15-15.5","chest":"37-38.5","waist":"31.5-32.5"}},{"size":"M (neck 15.5-16)","measurements":{"neck":"15.5-16","chest":"39-41.5","waist":"33.5-35.5"}},{"size":"L (neck 16-16.5)","measurements":{"neck":"16-16.5","chest":"42-44.5","waist":"36.5-38.5"}},{"size":"XL (neck 17-17.5)","measurements":{"neck":"17-17.5","chest":"45-47.5","waist":"39.5-41.5"}},{"size":"XXL (neck 18)","measurements":{"neck":"18","chest":"48-50","waist":"42.5-44.5"}}]$j$::jsonb,
   'BROOKS BROTHERS SELLS FOUR SIZE SYSTEMS AT ONCE AND THIS IS THE FIRST: DRESS SHIRTS ARE **NECK x SLEEVE IN INCHES**, selected independently and written "16-34/35" or "16 x 34" — neck 14.5 to 18.5, sleeve 32/33/34/35/36. ⚠ BUT ALPHA RUNS IN PARALLEL: BB''s sport/casual oxfords (including Original Polo oxfords) sell in XS-XXL, so a parser must accept BOTH — "BB dress shirts are neck x sleeve" is only ~true. The alpha-to-inch mapping above is BB''s own. ⚠ THE PUBLISHED CHART IS INCOMPLETE ON ITS OWN TERMS: L ends at neck 16.5 and XL starts at 17, so neck 16.75 is unrepresented, and the chart PUBLISHES NO SLEEVE LENGTHS at all (they exist only as product selectors). Reproduced faithfully — do not silently interpolate. ⚠ **THE FIT DOES NOT CHANGE THIS GRADE**: a 16-34 Milano and a 16-34 Madison are both 16-34. The shirt ladder is Soho (-5in chest) / Milano (-2.75) / REGENT (baseline) / Madison (+2.5) / Traditional (+5) — see the fit-ladder style rows, and note MADISON IS RELAXED, NOT TRIM. Big & tall: neck 16-24, chest 50-76.',
   'https://www.brooksbrothers.com/', 0.85, false, 'migration:00467'),

  ('brooksbrothers', 'Brooks Brothers', ARRAY['brooks brothers','brooksbrothers']::text[], 'Men',
   'Suits & sport coats (CHEST in inches + a LENGTH LETTER: 42R / 42L / 42S)',
   ARRAY['suit','sport coat','blazer','jacket','tailoring']::text[],
   $j$[{"size":"Chest 34-56 in half-inch increments","measurements":{"chest":"34-56","note":"the NUMBER is the chest in inches"}},{"size":"Suffix S / R / L","measurements":{"note":"Short / Regular / Long — a BODY AND SLEEVE LENGTH adjustment, not a girth change"}},{"size":"Suit trousers (sold separately)","measurements":{"waist":"28-50","seat":"36-58"}}]$j$::jsonb,
   'BB''S SECOND AND THIRD SYSTEMS. TAILORING = **CHEST IN INCHES (34-56, half-inch increments) + A LENGTH LETTER** — 42R is a 42in chest in a Regular length; S/R/L adjust the jacket body and sleeve (i.e. HEIGHT), never the chest. TROUSERS = **WAIST IN INCHES** (28-50, seat 36-58), listed SEPARATELY from the jacket. ⚠ **NO DROP IS SEEDED** — BB publishes none, and the fact that it lists suit trousers separately suggests suits may be sold with independent trouser sizing. The conventional US 6in drop (42 jacket -> 36 waist) is NOT stated by Brooks Brothers, so do not assume it. ⚠ **NO S/R/L HEIGHT RANGES ARE SEEDED** — BB publishes none across four of its own pages; the familiar figures (S under ~5''8", R 5''8"-6''2", L over ~6''2") come from third-party retailer blogs and must NOT be attributed to BB. ⚠ THE SUIT FIT LADDER IS ONLY THREE RUNGS AND IS **NOT** THE SHIRT LADDER: Milano (-1.5in chest) / REGENT (baseline) / **Madison (+3in chest, +5in waist — THE ROOMIEST)**. SEO fit-guides state Madison is trim; BB''s own chart refutes them. The fit does not change the size number.',
   'https://www.brooksbrothers.com/', 0.80, false, 'migration:00467'),

  -- UNTUCKit — the category-conditional system.
  ('untuckit', 'UNTUCKit', ARRAY['untuckit']::text[], 'Men',
   'Button-down shirts (ALPHA S-XXXL) — but dress shirts are NECK x SLEEVE, see note',
   ARRAY['shirt','button down','casual shirt','top','polo','tee','henley']::text[],
   $j$[{"size":"S","measurements":{"chest":"36-38","waist":"29-31","sleeve":"33-34"}},{"size":"M","measurements":{"chest":"39-41","waist":"32-34","sleeve":"33.5-34.5"}},{"size":"L","measurements":{"chest":"42-44","waist":"35-37","sleeve":"34.5-35.5"}},{"size":"XL","measurements":{"chest":"45-47","waist":"38-40","sleeve":"35-36"}},{"size":"XXL","measurements":{"chest":"48-50","waist":"41-43","sleeve":"35.5-36.5"}},{"size":"XXXL","measurements":{"waist":"44-46","sleeve":"36.5-37.5"}}]$j$::jsonb,
   '⚠ **"UNTUCKit IS ALPHA-SIZED" IS ONLY HALF TRUE — THE SYSTEM IS CATEGORY-CONDITIONAL.** Its BUTTON-DOWN shirts run ALPHA S-XXXL (above); its **DRESS SHIRTS RUN NECK x SLEEVE** (neck 15-17.5 against sleeve 32-33 / 34-35 / 36-37) — and eBay independently keeps "UNTUCKit Dress Shirts" as a category separate from "Casual Button-Down Shirts", so the split is real and consequential. Do not encode a flat alpha rule. ⚠ THE XXXL CHEST CELL IS DELIBERATELY OMITTED: the brand''s published chart shows XXL and XXXL BOTH at chest 48-50, which is almost certainly an upstream error since chest must grow with size — the waist and sleeve are seeded, the suspect chest is not. ⚠ **THE BRAND''S OWN GUIDANCE IS THAT IT RUNS SMALL**: "UNTUCKit''s men''s shirts run smaller than traditional large well-known brands, and if you are right on the border or between sizes, order one size up" — so an UNTUCKit L flat-measures SMALLER than a mainstream L. ⚠ **NO BODY LENGTH APPEARS IN ANY UNTUCKit CHART**, which matters more here than anywhere: the shorter untucked hem is the entire brand and there is NOTHING published to measure it against (the brand''s rule is qualitative — "around mid-zipper"). ⚠ THE FIT DOES NOT CHANGE THIS GRADE — Regular / Slim / Relaxed / Regular Tall / Slim Tall all share this run, and there is NO "Athletic" fit. The shorts chart is NOT seeded: the brand''s published one is internally incoherent (it labels itself alpha while listing numerics).',
   'https://www.untuckit.com/', 0.85, false, 'migration:00467'),

  ('untuckit', 'UNTUCKit', ARRAY['untuckit']::text[], 'Women',
   'Tops & dresses (ALPHA XS-XL)',
   ARRAY['top','shirt','blouse','dress','shirtdress','tee','sweater']::text[],
   $j$[{"size":"XS","measurements":{"bust":"32.5-34.5","waist":"25.5-26.5","hip":"36-39"}},{"size":"S","measurements":{"bust":"34.5-36.5","waist":"27.5-29.5","hip":"38-41"}},{"size":"M","measurements":{"bust":"36.5-38.5","waist":"29.5-31.5","hip":"40-43"}},{"size":"L","measurements":{"bust":"38.5-40.5","waist":"31.5-33.5","hip":"42-45"}},{"size":"XL","measurements":{"bust":"40.5-42.5","waist":"34.5-36.5","hip":"44-47"}}]$j$::jsonb,
   'UNTUCKit''s women''s line (launched 2017, driven by the fact that ~45% of the brand''s customers were women buying for men) runs ALPHA XS-XL; the waist column is the brand''s NATURAL waist. Brand-published. As with the men''s chart, NO BODY LENGTH is published, so the untucked-hem premise has no number to check against here either.',
   'https://www.untuckit.com/', 0.85, false, 'migration:00467'),

  -- Johnnie-O — brand-published, faithfully including its own discontinuity.
  ('johnnieo', 'Johnnie-O', ARRAY['johnnie-o','johnnieo','johnnie o']::text[], 'Men',
   'Tops (ALPHA S-XXXL — body measurements)',
   ARRAY['top','tee','shirt','polo','sweater','hoodie','quarter zip','pullover','jacket','outerwear']::text[],
   $j$[{"size":"S","measurements":{"neck":"14-14.5","chest":"38-40","waist":"28-32","sleeve":"32-33"}},{"size":"M","measurements":{"neck":"15-15.5","chest":"40-42","waist":"32-36","sleeve":"33-34"}},{"size":"L","measurements":{"neck":"16-16.5","chest":"42-44","waist":"36-40","sleeve":"34-35"}},{"size":"XL","measurements":{"neck":"17-17.5","chest":"44-46","waist":"40-44","sleeve":"35-36"}},{"size":"XXL","measurements":{"neck":"18-18.5","chest":"46-48","waist":"44-48","sleeve":"36-37"}},{"size":"XXXL","measurements":{"neck":"18.5-19","chest":"50-52","waist":"49-52","sleeve":"37-38"}}]$j$::jsonb,
   'Johnnie-O''s own published chart — BODY measurements, not flat-garment. ⚠ NOTE THE DISCONTINUITY, REPRODUCED FAITHFULLY: XXL chest ends at 48 and XXXL starts at 50 (and the waist jumps 48 to 49), so there is a gap in the brand''s own grade. It may be a brand-side typo — do NOT silently "fix" it; prefer the garment. Brand fit guidance is "true to size", and to "size up for comfort and better movement" if between sizes. THE STANDARD (non-big-&-tall) BOTTOMS CHART COULD NOT BE SOURCED and is deliberately absent; the big & tall bottoms run 42R-56R (waist = tag size - 1, e.g. 42R = 41-42in waist; seat 50-51 at 42R rising ~2in per size).',
   'https://www.johnnie-o.com/', 0.85, false, 'migration:00467'),

  -- Vineyard Vines — brand-published, with its own chart's oddity flagged.
  ('vineyardvines', 'Vineyard Vines', ARRAY['vineyard vines','vineyardvines']::text[], 'Men',
   'Tops (ALPHA XS-XXL — body measurements)',
   ARRAY['top','tee','shirt','polo','sweater','quarter zip','pullover','shep shirt','jacket','tie','necktie']::text[],
   $j$[{"size":"XS","measurements":{"neck":"13.5-14","chest":"36-38","sleeve":"32.5","waist":"28-30"}},{"size":"S","measurements":{"neck":"14-14.5","chest":"38-40","sleeve":"33.5","waist":"30-32"}},{"size":"M","measurements":{"neck":"15-15.5","chest":"40-42","sleeve":"34.5","waist":"32-34"}},{"size":"L","measurements":{"neck":"16-16.5","chest":"42-44","sleeve":"35.5","waist":"36-38"}},{"size":"XL","measurements":{"neck":"17-17.5","chest":"44-46","sleeve":"36.5","waist":"40-42"}},{"size":"XXL","measurements":{"neck":"18-18.5","chest":"46-48","sleeve":"37.5","waist":"42-44"}}]$j$::jsonb,
   'Vineyard Vines'' own published men''s chart. ⚠ FLAGGED FOR HUMAN VERIFICATION, REPRODUCED AS PUBLISHED: the WAIST progression is DISCONTINUOUS — S is 30-32 and M is 32-34, but L jumps to 36-38, leaving 34-36 unassigned. Chest and neck grade evenly, so this is either a genuine quirk of the brand''s chart or a transcription artifact. Do not interpolate it away; prefer the garment. BIG & TALL is a separate grade: "Big" 1X-6X (1X = 47.5-49.5 chest) and "Tall" XL-5X at the SAME GIRTH as Big but +2in of sleeve — so the Big/Tall distinction is a SLEEVE-LENGTH fact, a real and usable discriminator. MEN''S BOTTOMS are sold as WAIST x INSEAM IN INCHES, but no brand-published numeric men''s-pant chart exists — the waist column above is per alpha size only.',
   'https://www.vineyardvines.com/', 0.85, false, 'migration:00467'),

  ('vineyardvines', 'Vineyard Vines', ARRAY['vineyard vines','vineyardvines']::text[], 'Women',
   'Tops & dresses (US numeric 00-24 + alpha XXS-3X)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','shep shirt','jacket','skirt']::text[],
   $j$[{"size":"00 / XXS","measurements":{"chest":"32","waist":"24","hip":"34"}},{"size":"0 / XS","measurements":{"chest":"33","waist":"25","hip":"35"}},{"size":"2 / S","measurements":{"chest":"34","waist":"26","hip":"36"}},{"size":"4 / S","measurements":{"chest":"35","waist":"27","hip":"37"}},{"size":"6 / M","measurements":{"chest":"36","waist":"28","hip":"38"}},{"size":"8 / M","measurements":{"chest":"37","waist":"29","hip":"39"}},{"size":"10 / L","measurements":{"chest":"38.5","waist":"30.5","hip":"40.5"}},{"size":"12 / L","measurements":{"chest":"40","waist":"32","hip":"42"}},{"size":"14 / XL","measurements":{"chest":"41.5","waist":"33.5","hip":"43.5"}},{"size":"16 / XL","measurements":{"chest":"43.5","waist":"35","hip":"45"}},{"size":"18 / XXL","measurements":{"chest":"45.5","waist":"39","hip":"48.5"}},{"size":"20 / 2X","measurements":{"chest":"47","waist":"40.5","hip":"50"}},{"size":"24 / 3X","measurements":{"chest":"51.5","waist":"45","hip":"54.5"}}]$j$::jsonb,
   'Vineyard Vines publishes ONE unified women''s chart (no separate tops/bottoms/dresses), running US numeric 00-24 mapped to alpha XXS-3X. ⚠ **THE ALPHA MAPPING IS NOT SETTLED AND THE NUMERIC IS THE RELIABLE PART.** Two problems, both flagged rather than smoothed: (a) the published mapping is NON-MONOTONIC — 18 maps to XXL, 20 to 2X, and 22 back to XXL — which is almost certainly an upstream or transcription error, so size 22 is deliberately OMITTED here rather than guessed; (b) a second rendering of the same brand chart returns RANGE-based values (S = chest 35-36) instead of the single-value-per-numeric-size table above, so the brand may serve two variants. PREFER THE NUMERIC SIZE AND THE GARMENT''S MEASUREMENTS over the alpha conversion. Women''s DENIM: the brand publishes only a numeric-to-alpha conversion (24-37 -> 00-24) with NO waist/hip/inseam measurements at all.',
   'https://www.vineyardvines.com/', 0.75, false, 'migration:00467'),

  -- Faherty — the brand's own numbers, but the assets are 2019.
  ('faherty', 'Faherty', ARRAY['faherty']::text[], 'Men',
   'Tops (ALPHA XS-XXXL — body measurements)',
   ARRAY['top','tee','shirt','polo','sweater','sweatshirt','flannel','overshirt','blazer','jacket']::text[],
   $j$[{"size":"XS","measurements":{"neck":"14","chest":"34-36","waist":"26-28","sleeve":"32.5-33"}},{"size":"S","measurements":{"neck":"14-14.5","chest":"37-39","waist":"28-30","sleeve":"32.5-34"}},{"size":"M","measurements":{"neck":"15-15.5","chest":"40-41","waist":"31-33","sleeve":"34-35"}},{"size":"L","measurements":{"neck":"16-16.5","chest":"42-44","waist":"34-36","sleeve":"35-36"}},{"size":"XL","measurements":{"neck":"17-17.5","chest":"45-47","waist":"37-39","sleeve":"36-36.5"}},{"size":"XXL","measurements":{"neck":"18-18.5","chest":"48-51","waist":"40-43","sleeve":"36.5-37"}},{"size":"XXXL","measurements":{"neck":"19-19.5","chest":"52-54","waist":"44-47","sleeve":"37.5-38"}}]$j$::jsonb,
   'Faherty''s OWN published chart — but ⚠ **THE PUBLISHED ASSETS ARE DATED 2019**, so the live fit may have drifted in the years since; the chart''s own header says "ALL SIZES ARE APPROXIMATE". Brand-published-but-stale: capped confidence, prefer the garment. Faherty''s fabric names are ™ and NOT ® and the ® marks on its tags (REPREVE®, Supima®) belong to OTHER companies — see the fabric style row.',
   'https://fahertybrand.com/', 0.70, false, 'migration:00467'),

  ('faherty', 'Faherty', ARRAY['faherty']::text[], 'Men',
   'Bottoms (WAIST IN INCHES 28-42 + alpha — the tag runs ~2in SMALL, see note)',
   ARRAY['pant','bottom','short','trouser','chino','jean','denim','boardshort','swim']::text[],
   $j$[{"size":"28 (XS)","measurements":{"waist":"30.5"}},{"size":"30 (XS-S)","measurements":{"waist":"32.5"}},{"size":"32 (S-M)","measurements":{"waist":"34.5"}},{"size":"34 (M)","measurements":{"waist":"36.5"}},{"size":"36 (L)","measurements":{"waist":"39.5"}},{"size":"38 (L-XL)","measurements":{"waist":"41.5"}},{"size":"40 (XL)","measurements":{"waist":"42.5"}},{"size":"42 (XXL)","measurements":{"waist":"43.5"}}]$j$::jsonb,
   '⚠ **VANITY SIZING, QUANTIFIED: THE TAGGED WAIST RUNS ~2-2.5in SMALLER THAN THE BODY IT FITS** — a Faherty "32" fits a ~34.5in waist. And THE OFFSET COMPRESSES AT THE TOP OF THE RANGE: a tagged 42 is only 43.5in, so the error is ~2.5in at 28-34 and ~1.5in by 42. This is the same shape as BDG''s and Bullhead''s label-is-not-the-waist rule (00466), one axis larger. Faherty runs a DUAL system — alpha AND waist-in-inches. ⚠ THERE IS A GAP IN FAHERTY''S OWN ALPHA MAP: L ends at 37.5 and XL starts at 40, leaving 37.5-40in unassigned. That is the brand''s error, reproduced rather than papered over. 2019 assets — capped confidence, prefer the garment.',
   'https://fahertybrand.com/', 0.70, false, 'migration:00467'),

  ('faherty', 'Faherty', ARRAY['faherty']::text[], 'Women',
   'Tops & dresses (ALPHA XS-XL + US numeric 0-16)',
   ARRAY['top','tee','shirt','blouse','dress','sweater','legend','jacket','skirt']::text[],
   $j$[{"size":"XS (0-2)","measurements":{"bust":"31.5-33","waist":"24-25","hips":"33.5-35"}},{"size":"S (4-6)","measurements":{"bust":"33.5-34.5","waist":"26-27","hips":"36-37"}},{"size":"M (8-10)","measurements":{"bust":"35-37.5","waist":"28-29","hips":"38-39"}},{"size":"L (12-14)","measurements":{"bust":"38-39.5","waist":"30-31","hips":"40-42"}},{"size":"XL (16)","measurements":{"bust":"40-42","waist":"32-34","hips":"42.5-44.5"}}]$j$::jsonb,
   'Faherty women''s runs a DUAL system: alpha XS-XL mapped to US numeric 0-16. ⚠ **THIS CHART STOPS AT XL/16 AND IS A 2019 ASSET** — if Faherty now sells extended sizes, this chart does not cover them; do NOT extrapolate past XL. Women''s dresses launched spring 2020 and are ~40% of women''s sales, so a Faherty dress is a common resale garment sized against this table. Prefer the garment.',
   'https://fahertybrand.com/', 0.70, false, 'migration:00467'),

  -- Bonobos — the SYSTEM is confirmed; the grid is not published.
  ('bonobos', 'Bonobos', ARRAY['bonobos']::text[], 'Men',
   'Bottoms (WAIST x INSEAM in INCHES — the number IS the waist)',
   ARRAY['pant','bottom','chino','trouser','short','jean','denim','dress pant']::text[],
   $j$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}},{"size":"W40","measurements":{"waist":"40"}}]$j$::jsonb,
   'BONOBOS BOTTOMS ARE SOLD AS **WAIST x INSEAM IN INCHES** ("32x32") — the SYSTEM is confirmed three independent ways (the brand''s own model copy, its variant SKUs, and retailer listings), and a Bonobos "32" IS a 32in waist, not an EU size (contrast Zara/H&M in 00466). ⚠ **THE SYSTEM IS ALL THAT IS SEEDED HERE: BONOBOS PUBLISHES NO REACHABLE NUMERIC GRID.** Its size charts live on help.bonobos.com, which is unreadable to every automated fetcher INCLUDING the Wayback Machine, so no body-measurement table could be obtained and NONE IS INVENTED — the rows above simply restate that the label is the waist. PREFER THE GARMENT''S MEASUREMENTS. Aggregator "Bonobos size charts" are undated, uncited retailer reproductions — do not prefer them. ⚠ **BONOBOS HEMS PANTS TO THE ORDERED INSEAM BEFORE SHIPPING**, so A USED BONOBOS PANT''S INSEAM MAY BE A CUSTOM HEM RATHER THAN A CATALOGUE LENGTH — measure it, never assume it. The brand is reported to offer inseams 26-36 (well above the mall 30/32/34 norm), but that is snippet-sourced and unverified. ⚠ THE FIT NAME DOES NOT CHANGE THIS GRADE — a 32x32 is a 32x32 in Tailored, Slim, Straight, Athletic and Classic alike; the fit is a separate axis and **TAILORED IS TRIMMER THAN SLIM** (see the fit-vocabulary style row). SHIRTS are a different system again: ALPHA x FIT x LENGTH (the brand sells a "long" shirt length as its own axis), not neck x sleeve — though DRESS shirts were not verified. BLAZERS are numeric chest + fit; NO R/L/S length grade could be found for Bonobos and none is asserted.',
   'https://bonobos.com/', 0.55, false, 'migration:00467'),

  -- Todd Snyder / Buck Mason — system-only rows. The numbers do not exist.
  ('toddsnyder', 'Todd Snyder', ARRAY['todd snyder','toddsnyder']::text[], 'Men',
   'Size SYSTEMS only (alpha tops / waist-inches bottoms / chest+R-L-S tailoring)',
   ARRAY['top','tee','shirt','sweater','sweatshirt','hoodie','pant','bottom','chino','jean','denim','suit','blazer','sport coat','tailoring','chore coat','outerwear']::text[],
   $j$[{"size":"Tops: ALPHA S/M/L/XL","measurements":{"note":"alpha; the brand measures chest 1in below the armhole, pit to pit"}},{"size":"Bottoms: numeric WAIST IN INCHES (selvedge denim 28-38)","measurements":{"note":"the number is the waist in inches"}},{"size":"Tailoring: CHEST + R/L/S (e.g. 40R)","measurements":{"note":"US standard: the number is the chest in inches, the letter is a length"}}]$j$::jsonb,
   '⚠ **NO BRAND-PUBLISHED MEASUREMENTS ARE SEEDED FOR TODD SNYDER, AND THAT IS DELIBERATE: toddsnyder.com RETURNS HTTP 403 TO AUTOMATED FETCHING ON EVERY SIZE-GUIDE PATH**, so no chart could be obtained and none is invented. This row carries THE SIZE SYSTEM ONLY, which is the honestly sourceable part; every number below the system level would be a fabrication. THE NUMBERS HERE ARE NOT THE BRAND''S OWN — MEASURE THE GARMENT. Todd Snyder runs the standard menswear systems: alpha tops, waist-in-inches bottoms, and chest + R/L/S tailoring (a consignment listing reads "Size 40 Regular"). ⚠ ONE GENUINE COMPLICATION: the brand ALSO runs a LETTER-SIZED bottoms line alongside the numeric one, so do not assume waist-only for bottoms. Named tailoring fits (Sutton / Madison / Wythe / Hollywood) are a real signal IN TEXT, not in photos — and note "Madison" here is a TODD SNYDER fit name that has NOTHING to do with Brooks Brothers'' Madison in this same pack. Getting a real chart requires a browser session — flagged as owed work for the US-1715 queue.',
   'https://www.toddsnyder.com/', 0.40, false, 'migration:00467'),

  ('buckmason', 'Buck Mason', ARRAY['buck mason','buckmason']::text[], 'Men',
   'Size SYSTEMS only (alpha tops XS-XXL / denim waist-inches 28-38)',
   ARRAY['top','tee','shirt','flannel','sweatshirt','hoodie','pant','bottom','jean','denim','field pant','chino']::text[],
   $j$[{"size":"Tops: ALPHA XS/S/M/L/XL/XXL","measurements":{"note":"alpha; SHORT and TALL variants ship as separate SKUs"}},{"size":"Denim: numeric WAIST IN INCHES 28-38","measurements":{"note":"28,29,30,31,32,33,34,36,38 — the run is NOT continuous above 34 (no 35, no 37)"}}]$j$::jsonb,
   '⚠ **NO BRAND-PUBLISHED MEASUREMENTS ARE SEEDED FOR BUCK MASON, AND THE REASON IS NOT AN ACCESS PROBLEM: buckmason.com fetches cleanly, but its numeric charts live in JS-RENDERED PRODUCT MODALS and its two official fit guides (tee and denim) are PROSE WITH NO MEASUREMENT TABLES AT ALL.** So no inch-level table could be obtained, and none is invented — this row carries THE SIZE SYSTEM ONLY. THE NUMBERS HERE ARE NOT THE BRAND''S OWN — MEASURE THE GARMENT. The one aggregator chart found is an undated, uncited flat JPEG on a retailer''s page: the worst possible source for numbers a grader would treat as authoritative, and deliberately not ingested. ⚠ **DENIM: BUCK MASON OFFERS FREE HEMMING ON ALL JEANS AND SHIPS NO INSEAM AXIS**, which strongly implies jeans ship at a single long inseam and are hemmed to order — SO A LARGE SHARE OF SECONDHAND BUCK MASON JEANS WILL HAVE A CUSTOM, NON-FACTORY INSEAM AND HEM. Measure, never assume. Tops add SHORT and TALL as separate SKUs. Women''s runs alpha XS-XXL with numeric (24-30) on some bottoms.',
   'https://www.buckmason.com/', 0.40, false, 'migration:00467')
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
insert into public.applied_migrations (version) values ('00467') on conflict do nothing;
