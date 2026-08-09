-- US-2221: Headwear brand knowledge (4 brands) — New Era, Stetson, Kangol,
-- Goorin Bros. ALL FOUR WERE ABSENT FROM THE KB ENTIRELY, which is a weaker
-- starting state than the "passthrough-only" every pack since 00443 began from:
-- brandKey('New Era') found no brand_knowledge row, no alias in
-- brand-normalize.ts, and no size chart. The KB was apparel-and-footwear shaped
-- while item_category (00230) already carried accessories and GARMENT_CATEGORIES
-- already listed `hat`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY HEADWEAR IS A CATEGORY SHIFT AND NOT FOUR MORE ROWS
--
--   A HAT IS SIZED IN A UNIT THE REST OF THIS KB DOES NOT CARRY.
--
-- Every chart in brand_size_charts before this one measures a GARMENT: chest,
-- waist, bust, hip. A hat is measured by HEAD CIRCUMFERENCE and labelled in
-- EIGHTHS OF AN INCH (7 1/4, 7 3/8) — which is not an apparel size at all, it is
-- the circumference divided by pi and rounded. Forcing that into an alpha chart
-- is the lossy re-encoding this story's AC2 exists to refuse, so all four charts
-- below are seeded in their OWN units with their OWN labels: eighth-inch fitted
-- for New Era, US hat sizes for Stetson, alpha for Kangol and Goorin Bros.
--
-- ⚠ AND THE UNITS DO NOT AGREE ACROSS BRANDS. MEASURED, NOT ASSUMED. Both
-- charts below are the brands' OWN published ones, and they give DIFFERENT
-- inches for the SAME printed size:
--
--     printed 7 1/4    New Era: 22 3/4 in      Stetson: 23 in
--     printed 7 1/2    New Era: 23 1/2 in      Stetson: 23 3/4 in
--
-- The arithmetic settles which is literal: 7.25 x pi = 22.78 in, so New Era's
-- chart states the circumference and Stetson's rounds UP. That is consistent
-- with Stetson's own instruction to order a size up when between sizes — theirs
-- is a FIT chart, not a conversion table. So converting a printed hat size from
-- one maker into another's label is lossy BY UP TO A QUARTER INCH, and nothing
-- may do it. Each chart is seeded under its own brand_key for that reason, and
-- the note on each says so where a reader will actually hit it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO DECODERS IN THIS PACK, AND NEW ERA IS THE INTERESTING REFUSAL.
-- The bar (00460): tag-printed AND regular AND brand-unique IN FORMAT.
--
-- This story's notes name New Era 59FIFTY as one of the two strongest decoder
-- candidates in the whole grading-KB review. It is REFUSED, on two independent
-- grounds, and the second is the one worth carrying forward:
--
--   1. `5950` NAMES THE SILHOUETTE, NOT THE ITEM. It is tag-printed (on the main
--      tag since 1993) and perfectly regular. But EVERY 59FIFTY EVER MADE carries
--      it, so decoding it recovers "this is a New Era 59FIFTY" — which the tag
--      already says in words — and never a style. It also fails the third test on
--      its face: a bare four-digit run is the Chanel-serial / Lee-`101` refusal
--      (US-1736), and a pattern over it would mint New Era off any tag carrying
--      four digits. This is also the fourth question (00457/US-1986) in a new
--      costume: ask WHICH ENTITY the identifier names. `5950` names a MODEL LINE.
--   2. THE PER-CAP CODE LEFT WITH THE STICKER. The size and style live on the
--      VISOR STICKER, which is removable by design — New Era's own FAQ states it
--      does not offer replacement stickers, and loose stickers are sold on the
--      resale market, so a sticker is not evidence about the cap beneath it. That
--      is 00468's hangtag rule exactly: the mark identifying the UNIT is on the
--      part that comes off before resale. 00468 could test that claim against the
--      KB's own Coach row, which SEWS its creed patch in; the same test applies
--      here and New Era fails it.
--
-- Stetson, Kangol and Goorin Bros carry no tag-printed style code that research
-- could source at all. Nothing is seeded rather than guessed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PACK'S HEADLINE ALIAS REFUSAL: **"New Era" IS AN ORDINARY ENGLISH
-- PHRASE.** "a new era of comfort" is routine marketing copy, and
-- detectBrandInText scans CANONICAL_BRANDS longest-first, so "New Era" (7) would
-- BEAT a real "Nike" (4) in the same title. It joins Express, LOFT, Fossil,
-- Red Wing and KEEN in DETECT_EXCLUDED_FROM_TEXT. The brand stays fully
-- reachable BY TAG — canonicalizeBrand and isKnownBrand still resolve it, which
-- is what the eBay Brand aspect and the comp filter read.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE MOST USEFUL FACT HERE IS NOT A CODE: **STETSON'S X RATING IS
-- BRAND-INTERNAL.** 4X / 6X / 10X / 100X is stamped like a grade and reads like
-- one, and it is not an industry standard: each maker sets its own scale, and
-- the ratings inflated from the 1970s as fur costs rose, so an X number fixes
-- neither a beaver content nor a quality ACROSS makers. Seeded as an
-- informational tell at low confidence. It must never be converted between
-- brands or read as a material claim — the same discipline the decoder bar
-- applies to codes, applied to a number stamped on a sweatband.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'newera', 'New Era',
    ARRAY['newera','neweracap','neweracapcompany','newerahats']::text[],
    ARRAY['headwear','fitted caps','licensed sports','streetwear']::text[],
    $json$[
      {"era":"Leather sweatband","years":"pre-1987","description":"Leather sweatbands were widely available through about the 1984-1987 tags; fabric sweatbands take over after. Sweatband material dates a cap, it does not grade one.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.55},
      {"era":"5950 model logo on the main tag","years":"1993","description":"Tags become fully embroidered and the main tag carries the official 5950 cap-model logo. This is where the 5950 mark becomes tag-borne — and it names the silhouette, not the style.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.6},
      {"era":"Flag logo debuts on the main tag","years":"1996-1997","description":"The main tag is overhauled and the flag logo appears ON THE TAG. Not to be confused with the flag embroidered on the cap's side panel, which is twenty years later.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.6},
      {"era":"Authentic Diamond Collection tag","years":"1998-2000","description":"Authentic Diamond Collection tag in use; size tags shift from red/black to teal/maroon around 1998.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.6},
      {"era":"Diamond dropped: Authentic Collection","years":"2000-2001","description":"Tag overhauled and the word Diamond is removed, leaving Authentic Collection.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.6},
      {"era":"Made in USA text moves to the tag back","years":"2002-2005","description":"Made in USA moves to the reverse of the New Era tag as overseas production rises. A Made in USA cap is not automatically vintage and an imported one is not automatically fake.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.6},
      {"era":"Blue Box tags; last 100% wool with white sweatband","years":"2005-2006","description":"Blue Box tags debut during the 2005 season; 2006 is the last season of standard 100% wool caps with white sweatbands. Polyester caps with black sweatbands follow.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.6},
      {"era":"Fly Your Own Flag slogan on the tag","years":"2012-2016","description":"Cool Base logo removed and replaced by the Fly Your Own Flag slogan; the size tag loses its box and the numerals grow.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.6},
      {"era":"Side flag logo on the cap itself","years":"2016","description":"The New Era flag logo was added to the bottom left side of the cap in 2016. A cap sold as 1990s that carries a side flag is mis-dated. Its presence dates a cap; it does not authenticate one.","source_url":"https://en.wikipedia.org/wiki/59Fifty","confidence":0.8},
      {"era":"Derby NY closes; assembly moves to Hialeah FL","years":"2019","description":"The Derby, New York plant closes in 2019 and assembly moves to a new Hialeah, Florida facility. Domestic assembly did not end with the Derby closure.","source_url":"http://ballcapblog.blogspot.com/2010/08/chronology-of-new-era-cap-tags.html","confidence":0.55}
    ]$json$::jsonb,
    $json$[
      {"tell":"The visor sticker is not evidence","detail":"The gold size/style sticker is removable by design and New Era does not sell replacements, so loose stickers circulate on the resale market. A sticker says nothing about the cap under it. Read the SEWN size tag instead."},
      {"tell":"The side flag dates a cap, it does not authenticate it","detail":"The flag logo on the wearer's left panel was added in 2016. Its ABSENCE on a cap sold as current is a flag; its PRESENCE on a cap sold as 1990s is a contradiction. Neither direction proves genuineness on its own."},
      {"tell":"MLB Batterman on the back","detail":"The MLB Batterman logo was added to the back of on-field caps in 1992, and the 59FIFTY became the official on-field cap in 1993. An on-field claim on an earlier-dated cap needs a second signal."},
      {"tell":"Sweatband material is an era marker, not a quality grade","detail":"Leather through roughly the mid-1980s tags, fabric after, and black sweatbands with the polyester caps from 2006. A fabric sweatband on a cap sold as 1970s is wrong; a polyester cap is not a defect."},
      {"tell":"5950 is the silhouette","detail":"The 5950 mark on the main tag identifies the 59FIFTY model line, which every 59FIFTY carries. It is never a style code and must never be captured into a style-code field."}
    ]$json$::jsonb,
    'Headwear, founded in Buffalo NY. The 59FIFTY came out in 1954 and became the official MLB on-field cap in 1993. NO DECODER IS SEEDED — see the pack header: 5950 names the silhouette (a bare four-digit run, the Chanel/Lee refusal) and the per-cap code lives on a removable visor sticker. ⚠ "New Era" is an ordinary English phrase and is in DETECT_EXCLUDED_FROM_TEXT; the brand stays reachable by tag.',
    'https://en.wikipedia.org/wiki/59Fifty', 0.70, true, 'migration:00574'
  ),
  (
    'stetson', 'Stetson',
    ARRAY['stetson','johnbstetson','stetsonhats']::text[],
    ARRAY['headwear','western hats','fur felt','dress hats']::text[],
    $json$[
      {"era":"John B. Stetson Company, Philadelphia","years":"1865-1971","description":"Founded by John B. Stetson in Philadelphia in 1865. The Boss of the Plains dates from about the same year and is still in production. Original hats carried John B. Stetson's name in the sweatband.","source_url":"https://en.wikipedia.org/wiki/Stetson","confidence":0.75},
      {"era":"Production ceases in-house; the brand is licensed","years":"1968-1971","description":"The Stetson Hat Co. ceased production in 1968 and licensed another hat company; the Philadelphia factory closed in 1971. From here on a Stetson hat is made by a licensee, which is normal and not a counterfeit signal.","source_url":"https://en.wikipedia.org/wiki/Stetson","confidence":0.7},
      {"era":"Hatco makes and distributes Stetson hats","years":"1987","description":"Hatco became the manufacturer and distributor for the Stetson hat brand in 1987; the operation moved to its Garland, Texas facility in 2004. A Garland-made Stetson is the genuine article.","source_url":"https://en.wikipedia.org/wiki/John_B._Stetson_Company","confidence":0.55}
    ]$json$::jsonb,
    $json$[
      {"tell":"The X rating is BRAND-INTERNAL and inflated","detail":"4X / 6X / 10X / 100X once tracked beaver content in the felt. It is not an industry standard — each maker sets its own scale — and ratings inflated from the 1970s as fur costs rose. Never convert an X across brands, never read a beaver percentage off one, and never treat a higher X from another maker as the better hat."},
      {"tell":"The sweatband carries the maker's name","detail":"Original Stetsons bore John B. Stetson's name in the sweatband. On a modern hat the sweatband and liner are where the brand, the size and the X rating are printed, so a hat with a replaced sweatband has lost its identity marks — that is a condition fact, not an authenticity verdict."},
      {"tell":"A licensee mark is not a fake","detail":"Stetson hats have been made under licence since 1968, latterly by Hatco in Garland, Texas. A licensee's name inside a genuine Stetson is expected."}
    ]$json$::jsonb,
    'Western and dress headwear. Sizing is US hat sizes in eighths. ⚠ Stetson''s own chart ROUNDS UP relative to circumference (7 1/4 = 23 in, where the arithmetic gives 22.78) because it is a fit chart — do not convert its labels into another maker''s. No decoder: no tag-printed, brand-unique style code could be sourced.',
    'https://stetson.com/pages/size-guide', 0.70, true, 'migration:00574'
  ),
  (
    'kangol', 'Kangol',
    ARRAY['kangol','kangolheadwear']::text[],
    ARRAY['headwear','flat caps','berets','bucket hats']::text[],
    $json$[
      {"era":"Cleator, Cumbria — Made in England","years":"1938","description":"The first Kangol factory opened at Cleator, Cumbria in 1938. Early hats are English-made; later production moved to Eastern Europe, the United States and elsewhere. A non-English origin label is an era marker, not a defect or a fake.","source_url":"https://en.wikipedia.org/wiki/Kangol","confidence":0.7},
      {"era":"Kangaroo logo adopted","years":"1983","description":"Kangol adopted the kangaroo mark in 1983, after Americans kept asking for the kangaroo hat. A kangaroo logo cannot appear on a genuine pre-1983 piece, and its absence on a hat sold as modern is a red flag.","source_url":"https://kangol.com/pages/our-story","confidence":0.8},
      {"era":"Bollman Hat Company holds global rights","years":"2002","description":"Bollman Hat Company has held global rights to Kangol hats since 2002.","source_url":"https://en.wikipedia.org/wiki/Kangol","confidence":0.7},
      {"era":"Frasers Group ownership","years":"2006","description":"Kangol has been owned by Frasers Group since 2006.","source_url":"https://en.wikipedia.org/wiki/Kangol","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"No kangaroo means pre-1983, or not Kangol","detail":"The kangaroo mark was adopted in 1983 (Kangol's own account). It dates a hat as 1983-or-later; it does not date one earlier, and it does not by itself prove authenticity."},
      {"tell":"Made in England is an era, not a grade","detail":"Production left the Cleator factory; later hats are made in Eastern Europe, the US and elsewhere. An imported Kangol is genuine and must not be graded down for its origin label."}
    ]$json$::jsonb,
    'British headwear house, founded 1938 at Cleator, Cumbria. Sized ALPHA S–XXL against head circumference, not in hat-size fractions. ⚠ The name etymology is CONTESTED and deliberately not seeded: Kangol''s own page says knitting/angora/wool while Wikipedia says silk/angora/wool and calls the knitting reading incorrect. Two sources disagreeing is not a fact. No decoder.',
    'https://kangol.com/pages/our-story', 0.70, true, 'migration:00574'
  ),
  (
    'goorinbros', 'Goorin Bros.',
    ARRAY['goorin','goorinbros','goorinbrothers']::text[],
    ARRAY['headwear','flat caps','fedoras','trucker caps']::text[],
    $json$[
      {"era":"Cassel Goorin sells his first hat, Pittsburgh","years":"1895","description":"The house dates itself to 1895, when Cassel Goorin sold hats from a horse cart in Pittsburgh. The 1895 mark appears in the brand's own marks and packaging.","source_url":"https://goorin.com/pages/our-story","confidence":0.75},
      {"era":"Renamed Goorin Brothers","years":"1921","description":"Cassel's sons Alfred and Ted took over in 1921 and renamed the business Goorin Brothers.","source_url":"https://goorin.com/pages/our-story","confidence":0.7},
      {"era":"Relocated to San Francisco","years":"1949","description":"The business relocated to San Francisco in 1949 and opened its first storefront there.","source_url":"https://goorin.com/pages/our-story","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"1895 on the label is a founding date, not a production date","detail":"Goorin Bros. prints its 1895 founding year on labels and packaging. It dates the HOUSE, never the hat, and a listing that reads it as an era claim is wrong."}
    ]$json$::jsonb,
    'American hat house, founded 1895. Sized ALPHA XS–XXL plus a One Size adjustable range on trucker styles. No decoder: no tag-printed, brand-unique style code could be sourced.',
    'https://goorin.com/pages/size-chart', 0.65, true, 'migration:00574'
  )
on conflict (brand_key) do nothing;

-- ── brand_size_charts — each in ITS OWN UNITS (AC2) ─────────────────────────
-- head_circumference is in INCHES, matching the column contract. The printed
-- label is the `size`, because the label is what a seller reads off the hat.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match,
   rows, note, source_url, confidence, verified, updated_by)
values
  (
    'newera', 'New Era', ARRAY['new era','newera']::text[], 'Unisex',
    'Caps (fitted 59FIFTY, eighth-inch sizes)',
    ARRAY['hat','cap','fitted','headwear','baseball cap','59fifty','5950']::text[],
    $json$[
      {"size":"7","measurements":{"head_circumference":"22"}},
      {"size":"7 1/8","measurements":{"head_circumference":"22.375"}},
      {"size":"7 1/4","measurements":{"head_circumference":"22.75"}},
      {"size":"7 3/8","measurements":{"head_circumference":"23.125"}},
      {"size":"7 1/2","measurements":{"head_circumference":"23.5"}},
      {"size":"7 5/8","measurements":{"head_circumference":"23.875"}},
      {"size":"7 3/4","measurements":{"head_circumference":"24.25"}},
      {"size":"7 7/8","measurements":{"head_circumference":"24.625"}},
      {"size":"8","measurements":{"head_circumference":"25"}}
    ]$json$::jsonb,
    'New Era''s own 59FIFTY chart, which also covers Low Profile 59FIFTY and the 9TWENTY strapback. The label IS the circumference in inches divided by pi, so these inches are literal (7 1/4 x pi = 22.78). ⚠ DO NOT convert these labels to another maker''s — Stetson prints 23 in for the same 7 1/4 because its chart rounds up for fit. Measure about half an inch above the eyebrows and ears. Smaller sizes exist on some models and are not in this published chart.',
    'https://www.neweracap.com/pages/sizing-chart', 0.85, true, 'migration:00574'
  ),
  (
    'newera', 'New Era', ARRAY['new era','newera']::text[], 'Unisex',
    'Caps (stretch-fit 39THIRTY / adjustable 9FIFTY)',
    ARRAY['hat','cap','snapback','stretch fit','headwear','39thirty','9fifty']::text[],
    $json$[
      {"size":"39THIRTY XS/S–L/XL (stretch fit)","measurements":{"head_circumference":"21.625-25"}},
      {"size":"9FIFTY S-M / M-L (adjustable snapback)","measurements":{"head_circumference":"21.625-24.25"}}
    ]$json$::jsonb,
    'Deliberately SPANS, not per-size rows: New Era publishes only the overall range for these fits, so per-size ranges would be invented. A stretch-fit or snapback size is not comparable to a 59FIFTY fitted size and must never be converted into one.',
    'https://www.neweracap.com/pages/sizing-chart', 0.75, true, 'migration:00574'
  ),
  (
    'stetson', 'Stetson', ARRAY['stetson']::text[], 'Unisex',
    'Hats (US hat sizes)',
    ARRAY['hat','headwear','cowboy hat','western hat','fedora','felt hat']::text[],
    $json$[
      {"size":"6 3/8","measurements":{"head_circumference":"20.25"}},
      {"size":"6 1/2","measurements":{"head_circumference":"20.625"}},
      {"size":"6 5/8","measurements":{"head_circumference":"21"}},
      {"size":"6 3/4","measurements":{"head_circumference":"21.5"}},
      {"size":"6 7/8","measurements":{"head_circumference":"21.875"}},
      {"size":"7","measurements":{"head_circumference":"22.25"}},
      {"size":"7 1/8","measurements":{"head_circumference":"22.625"}},
      {"size":"7 1/4","measurements":{"head_circumference":"23"}},
      {"size":"7 3/8","measurements":{"head_circumference":"23.375"}},
      {"size":"7 1/2","measurements":{"head_circumference":"23.75"}},
      {"size":"7 5/8","measurements":{"head_circumference":"24"}},
      {"size":"7 3/4","measurements":{"head_circumference":"24.5"}},
      {"size":"7 7/8","measurements":{"head_circumference":"25"}},
      {"size":"8","measurements":{"head_circumference":"25.5"}}
    ]$json$::jsonb,
    'Stetson''s own chart. Its alpha groupings are X-Small 6 3/8–6 1/2, Small 6 5/8–6 7/8, Medium 7–7 1/4, Large 7 3/8–7 5/8, X-Large 7 3/4–7 7/8, 2XL 8. ⚠ IT ROUNDS UP: 7 1/4 is listed at 23 in where the arithmetic gives 22.78, which matches Stetson''s instruction to size up when between sizes. It is a FIT chart, so these inches are not interchangeable with New Era''s.',
    'https://stetson.com/pages/size-guide', 0.80, true, 'migration:00574'
  ),
  (
    'kangol', 'Kangol', ARRAY['kangol']::text[], 'Unisex',
    'Hats (alpha S–XXL)',
    ARRAY['hat','cap','headwear','beret','bucket hat','flat cap','504']::text[],
    $json$[
      {"size":"S","measurements":{"head_circumference":"21-21.5"}},
      {"size":"M","measurements":{"head_circumference":"22-22.5"}},
      {"size":"L","measurements":{"head_circumference":"22.75-23"}},
      {"size":"XL","measurements":{"head_circumference":"23.5-24"}},
      {"size":"XXL","measurements":{"head_circumference":"24.375-24.875"}}
    ]$json$::jsonb,
    'Kangol''s own adult chart. Its US hat-size equivalents are S 6 3/4–6 7/8, M 7–7 1/8, L 7 1/4–7 3/8, XL 7 1/2–7 5/8, XXL 7 3/4–7 7/8 (54-55, 56-57, 58-59, 60-61, 62-63 cm). Alpha here is a RANGE of two hat sizes, so a Kangol L is not one number and must not be written into a chart that expects one.',
    'https://kangol.com/pages/hat-size-chart', 0.80, true, 'migration:00574'
  ),
  (
    'goorinbros', 'Goorin Bros.', ARRAY['goorin','goorin bros']::text[], 'Unisex',
    'Hats (alpha XS–XXL)',
    ARRAY['hat','cap','headwear','fedora','flat cap','trucker']::text[],
    $json$[
      {"size":"XS","measurements":{"head_circumference":"21.25"}},
      {"size":"S","measurements":{"head_circumference":"21.625"}},
      {"size":"M","measurements":{"head_circumference":"22.5"}},
      {"size":"L","measurements":{"head_circumference":"23.25"}},
      {"size":"XL","measurements":{"head_circumference":"24"}},
      {"size":"XXL","measurements":{"head_circumference":"24.875"}},
      {"size":"OS (adjustable)","measurements":{"head_circumference":"21.625-24"}}
    ]$json$::jsonb,
    'Goorin Bros.'' own conversion chart. Alpha maps to a SINGLE hat size here, unlike Kangol''s two-size bands: XS 6 3/4, S 6 7/8, M 7 1/8, L 7 3/8, XL 7 5/8, XXL 7 7/8 (54, 55.5, 57, 59, 61, 63 cm). OS is the adjustable trucker range, 6 7/8–7 5/8.',
    'https://goorin.com/pages/size-chart', 0.80, true, 'migration:00574'
  )
on conflict (brand_key, department, garment) do nothing;

-- ── brand_styles — silhouettes that are genuinely model-level identity ───────
-- Only styles a source names. Nothing invented, which is why Goorin Bros. gets
-- no rows: research surfaced product pages, not a documented model line.
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('newera', '59FIFTY', ARRAY['5950','59 fifty']::text[], 'Fitted', 'Unisex', 'hat',
   'Structured six-panel fitted cap with a flat brim and no closure — the size is the cap. Official MLB on-field cap since 1993.',
   '1954-present', ARRAY['fitted','59fifty','5950','on-field']::text[],
   'https://en.wikipedia.org/wiki/59Fifty', 0.80, true, 'migration:00574'),
  ('newera', 'Low Profile 59FIFTY', ARRAY['lp 59fifty','low crown 59fifty']::text[], 'Fitted', 'Unisex', 'hat',
   'The 59FIFTY with a shallower crown and a pre-curved brim. Same eighth-inch fitted sizing as the standard 59FIFTY.',
   null, ARRAY['fitted','low profile','59fifty']::text[],
   'https://www.neweracap.com/pages/sizing-chart', 0.70, true, 'migration:00574'),
  ('newera', '9FIFTY', ARRAY['9 fifty','950']::text[], 'Adjustable', 'Unisex', 'hat',
   'Adjustable snapback, sized One Size in S-M and M-L rather than in hat sizes.',
   null, ARRAY['snapback','adjustable','9fifty']::text[],
   'https://www.neweracap.com/pages/sizing-chart', 0.70, true, 'migration:00574'),
  ('newera', '39THIRTY', ARRAY['39 thirty','3930']::text[], 'Stretch Fit', 'Unisex', 'hat',
   'Stretch-fit cap with no closure, sized XS/S through L/XL. Not a fitted cap and not comparable to a 59FIFTY size.',
   null, ARRAY['stretch fit','39thirty']::text[],
   'https://www.neweracap.com/pages/sizing-chart', 0.70, true, 'migration:00574'),
  ('newera', '9TWENTY', ARRAY['9 twenty','920']::text[], 'Adjustable', 'Unisex', 'hat',
   'Unstructured adjustable cap. New Era lists it under the 59FIFTY sizing scale on its own chart while the styleguide calls it adjustable — recorded as published rather than reconciled.',
   null, ARRAY['strapback','dad hat','9twenty']::text[],
   'https://www.neweracap.com/pages/styleguide', 0.60, true, 'migration:00574'),
  ('newera', '9FORTY', ARRAY['9 forty','940']::text[], 'Adjustable', 'Unisex', 'hat',
   'Adjustable cap silhouette listed in New Era''s own styleguide.',
   null, ARRAY['adjustable','9forty']::text[],
   'https://www.neweracap.com/pages/styleguide', 0.60, true, 'migration:00574'),
  ('stetson', 'Boss of the Plains', ARRAY['boss of the plains']::text[], 'Western', 'Unisex', 'hat',
   'Flat brim, straight-sided crown with rounded corners, roughly four-inch crown and brim. Created around 1865 and still in production.',
   '1865-present', ARRAY['western','cowboy hat','boss of the plains']::text[],
   'https://en.wikipedia.org/wiki/Stetson', 0.75, true, 'migration:00574'),
  ('goorinbros', 'The Farm', ARRAY['the farm','farm trucker','animal farm']::text[], 'Trucker', 'Unisex', 'hat',
   'Foam-and-mesh trucker with an embroidered animal patch on the front panel. Started in 2003 when Ben Goorin was experimenting with trucker patch designs, and now runs to hundreds of individual animal designs. The PATCH is the model — a Farm trucker resells on which animal it carries, not on the blank underneath it, so the animal name belongs in the title.',
   '2003-present', ARRAY['trucker','the farm','animal patch','mesh back']::text[],
   'https://goorin.com/pages/the-farm', 0.70, true, 'migration:00574'),
  ('kangol', '504', ARRAY['504 cap','kangol 504']::text[], 'Flat cap', 'Unisex', 'hat',
   'Seamless flat cap. Kangol''s own account puts the peaked-cap redesign at 1954; the 504 name is widely reported to come from the number of the wooden hat block it was shaped on — recorded at low confidence because Kangol''s own page does not say so.',
   '1950s-present', ARRAY['flat cap','504','seamless']::text[],
   'https://kangol.com/pages/our-story', 0.55, true, 'migration:00574')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes ROWS, DELIBERATELY. See the pack header: New Era's 5950
-- names the silhouette and its per-cap code leaves with the visor sticker, and
-- no tag-printed brand-unique code could be sourced for Stetson, Kangol or
-- Goorin Bros. A refusal that is only a comment is not a refusal, so it is
-- fixtured in services/edge-functions/src/tests/headwear-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00574') on conflict do nothing;
