-- US-1982: Luxury RTW & leather brand knowledge group, tier 2 (8 brands).
--
-- Hermès, Dior, Saint Laurent, Balenciaga, Bottega Veneta, Fendi, Versace,
-- Celine — the high-value ready-to-wear + leather-goods tier. Tier 1 (00455)
-- took Chanel/Prada/Burberry/Michael Kors/Kate Spade/Tory Burch; this is the
-- rest of the top of the market. Seven of the eight were PASSTHROUGH-ONLY
-- (no brand_knowledge row, no alias, no chart), so a "balenciaga" tag rendered
-- the seller's own casing into the prompt block and the eBay Brand aspect on the
-- most expensive garments the KB touches. Versace had only a bare alias-only row
-- from 00389 and is PROMOTED to a full pack here.
--
-- ── FRENCH OR ITALIAN — THE SAME NUMBER IS TWO DIFFERENT SIZES ──────────────
-- The through-line, and the reason this group is worth more than its style
-- fingerprints. Every house here sizes its women's RTW in a European system its
-- tag never names, and the group SPLITS across two of them:
--   * FRENCH (Hermès, Dior, Saint Laurent, Balenciaga, Celine): US = FR - 32.
--   * ITALIAN (Bottega Veneta, Fendi, Versace):                 US = IT - 36.
-- So "42" IS A US 10 ON A DIOR AND A US 6 ON A FENDI — the same two digits, two
-- sizes apart, on two dark designer dresses that photograph identically. This is
-- worse than 00460's unnamed-system trap, which at least broke the same way on
-- every brand in its pack: here the seller who correctly learns "42 = US 6" from
-- a Fendi and applies it to a Dior is WRONG BECAUSE THEY LEARNED THE RULE. So the
-- cross-map is written INTO the size LABEL of every chart, which is the only
-- uncapped channel that reaches the model (the US-1731/US-1740 lesson).
--
-- MENSWEAR IS NOT AFFECTED and the charts say so. French and Italian tailoring
-- both run the same EU numbers (drop 10: a 50 is a US 40 in either), so the
-- collision is a WOMEN'S-ONLY trap. Saying that explicitly is the point — a
-- reader who over-generalizes it to menswear starts "fixing" correct sizes.
--
-- ── AUTHENTICATION TELLS ARE INFORMATIONAL — NEVER AUTO-AUTHENTICATE ────────
-- This is the most counterfeited tier that exists, and the tier where a confident
-- wrong answer costs the most. Every device these houses ship — Hermès's blind
-- stamp, Dior's date code, the serial tabs at Saint Laurent/Balenciaga/Fendi — is
-- a MANUFACTURER-side mark, and none is evidence we can act on: a mark that looks
-- right is exactly what a competent counterfeit reproduces, and the superfakes in
-- this tier are the best in the world. None of these houses authenticates for
-- third parties. Every tell here is seeded as a description/consistency aid that
-- routes to human review. The pack must never emit an authentic/fake verdict.
--
-- ── ONE DECODER — DIOR, AND ONLY IT QUALIFIES ───────────────────────────────
-- The bar (US-1736/US-1740): tag-printed AND regular AND brand-unique in FORMAT.
-- Dior heat-stamps a date code on an interior leather tab as 2 digits + 2 letters
-- + 4 digits, hyphenated (05-BO-0151, 17-BO-0129) — a compound distinctive enough
-- to anchor on, the LV SD1160 precedent (00399) with hyphens on top. It recovers
-- the BRAND off a cut/removed brand tab; it is NOT an authenticity check and the
-- description says so.
--
-- Everything else in the group FAILS a leg and is deliberately decoder-less:
--   * HERMÈS is the instructive refusal. Its blind stamp is a BARE LETTER (a date
--     letter, plus a craftsman's mark) — Hermès ships no serial number at all.
--     A pattern over a single letter would brand every tag in the catalog as the
--     most valuable label in the pack. The Chanel rule (US-1736) at its limit.
--   * SAINT LAURENT / BALENCIAGA / BOTTEGA VENETA / FENDI / CELINE print serial
--     or article numbers on a tab, but they are bare digit runs or catalog SKUs
--     whose format is not brand-unique.
--   * VERSACE prints no regular garment-side code.
-- Those facts live in tag_eras/authentication_tells, which is where they belong.
--
-- Data-only, idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
-- NOTE ON brand_key: it is brandKey(canonical_brand) = lowercase, [^a-z0-9]
-- STRIPPED — accents included. So canonical "Hermès" keys as 'herms' (the exact
-- shape of the 00389 'stssy'/Stüssy precedent), NOT 'hermes'. It looks like a
-- typo and is not; the resolver computes the same key, so a row seeded under
-- 'hermes' would never be found. Both spellings are aliased.
--
-- CELINE is the opposite call and it is deliberate: the house DROPPED the accent
-- in 2018 (the Hedi Slimane rebrand), so the current mark really is "CELINE" and
-- the canonical is unaccented — which also keys cleanly as 'celine'. The accented
-- "Céline" spelling is a genuine DATING tell and is carried as a tag_era, exactly
-- like "Burberrys" with the S in 00455.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  ('herms', 'Hermès', ARRAY['hermes','hermès','hermes paris','hermès paris','hermes sellier']::text[],
   ARRAY['luxury','leather','rtw','silk','accessories','womens','mens']::text[],
   $j$[{"era":"Blind stamp in a SHAPE","years":"c.1945-2014","description":"The date letter was surrounded by a shape that itself encodes the period — a circle (1945-1970), a square (1971-1996), a circle again (1997-2014). The shape is a DATING aid on an older bag, not a verification device."},{"era":"Blind stamp with NO shape","years":"2015-present","description":"From 2015 Hermes dropped the surrounding shape and stamps a bare letter. The ABSENCE of a shape therefore dates a bag to roughly 2015+ and is NOT a fake tell — a common false counterfeit call."},{"era":"Hermes Sellier / Hermes Paris","years":"varies","description":"Older leather goods may read HERMES SELLIER (saddler) rather than HERMES PARIS. Both are house marks; the wording is an era/line read, not a brand difference."}]$j$::jsonb,
   $j$[{"pattern":"Made in France","note":"Hermes leather goods are made in France and Made in France is EXPECTED on the mark — unusually for this KB, its absence is worth a second look rather than its presence. Silk is made in France (Lyon). Still not an authentication verdict on its own: origin text is trivially reproduced."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate — this is the hardest tier on earth and we do not verify","detail":"Hermes is the most valuable and most sophisticatedly counterfeited label in this pack, and the house does NOT authenticate for third parties. Every mark it ships is manufacturer-side and reproducible by the superfakes in this tier. Describe what is present, flag inconsistencies in condition_notes, and route authenticity to human review. Never emit an authentic/fake verdict."},{"tell":"THERE IS NO SERIAL NUMBER — the blind stamp is a DATE letter, not an ID","detail":"The single most misunderstood Hermes fact. Hermes has never used serial numbers. The heat-embossed blind stamp carries a DATE letter plus a craftsman's mark; it identifies a year and an artisan, not a bag. So there is nothing to look up, nothing to decode, and a listing that calls it a serial number is wrong. It is also why this brand gets NO decoder: a pattern over a single letter would brand anything."},{"tell":"THE LEATHER IS THE PRICE — name it, do not guess it","detail":"Togo, Clemence, Epsom, Box, Swift and Chevre are different leathers at materially different prices and they are legible in a photo: Togo has a fine raised pebble grain, Clemence a flatter looser one, Epsom is a stamped rigid cross-hatch that holds its shape, Box is smooth and glossy. This is the highest-value Hermes description fact after the size systems. If the photo does not settle it, say so rather than picking one."},{"tell":"HARDWARE + STITCHING are description facts, not proofs","detail":"Palladium vs gold hardware moves price, and Hermes leather goods are SADDLE-STITCHED by hand (two needles, one thread — the stitches slant and are not machine-uniform). Both are worth describing and neither authenticates: a good fake reproduces the look. Report, never conclude."}]$j$::jsonb,
   'Hermès identity = the leather GRADE (Togo/Clemence/Epsom/Box) and the model (Birkin/Kelly/Constance/Evelyne), with RTW sized in FRENCH numbers the tag never labels as such. Founded 1837 in Paris by Thierry Hermès as a HARNESS AND SADDLE maker — which is why the saddle stitch and the "Sellier" mark exist, and why the equestrian vocabulary is literal rather than a marketing theme. Bags are hand-made by a single artisan whose mark sits beside the date letter. NO SERIAL NUMBER EXISTS and therefore NO DECODER — the blind stamp is a bare letter, and a pattern over one letter would mint the KB''s costliest false positive. RN omitted — not sourceable. NOTE the brand_key is ''herms'': brandKey() strips the accent (the Stüssy/''stssy'' precedent).',
   'https://www.hermes.com/us/en/', 0.70, false, 'migration:00461'),

  ('dior', 'Dior', ARRAY['dior','christian dior','christiandior','dior homme','diorhomme','baby dior','miss dior']::text[],
   ARRAY['luxury','rtw','leather','couture','womens','mens']::text[],
   $j$[{"era":"Christian Dior mainline mark","years":"1946-present","description":"The house mark reads CHRISTIAN DIOR (often CHRISTIAN DIOR PARIS on a heat-stamped leather tab). The formal name and the short DIOR mark are the same house — the wording is not a brand difference."},{"era":"Dior Homme / Dior Men","years":"2001-present","description":"The menswear line was DIOR HOMME under Hedi Slimane and Kris Van Assche, renamed DIOR MEN under Kim Jones in 2018. A DIOR HOMME tag therefore dates a piece to roughly pre-2019 — and the Slimane-era Dior Homme in particular is collectible and comps ABOVE ordinary Dior menswear, so the tag wording is a LADDER read, not just a date."},{"era":"Galliano era","years":"1996-2011","description":"John Galliano's tenure (saddle bags, newspaper print, extreme romanticism) is a collectible era in its own right and its pieces comp above comparable later mainline. An era read, from the design and the tag generation — never a verdict."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy / Made in France / Made in Spain","note":"Dior leather goods and RTW are made across Italy, France and Spain depending on the object and the era. NONE of the three is a fake tell and all are normal — origin is not an authentication signal on this brand."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate — the date code is a DATE, not a certificate","detail":"Dior is heavily counterfeited and the date code is a manufacturer-side mark that fakes reproduce. It encodes when/where a piece was made, not whether it is genuine, and Dior does not authenticate for third parties. Route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE DATE CODE IS ON A LEATHER TAB AND IT RECOVERS THE BRAND","detail":"2 digits + 2 letters + 4 digits, hyphenated (05-BO-0151, 17-BO-0129), heat-stamped on an interior leather tab. It is the only code in this group that is regular AND brand-unique in FORMAT, so it is the only one that gets a decoder — and it survives the brand tab being cut out. It identifies the piece's origin, NOT its authenticity."},{"tell":"CANNAGE IS THE HOUSE PATTERN AND IT NAMES THE BAG","detail":"The quilted Cannage lattice is Dior's signature and is the fastest read on the Lady Dior. It is derived from the Napoleon III chairs at the 1947 debut show — literal house history, not a marketing story. A description aid; the pattern is imitated constantly and does not authenticate."},{"tell":"DIOR HOMME vs DIOR MEN is a ladder, not just a date","detail":"Read the menswear tag wording: DIOR HOMME (pre-2019) and specifically the Hedi Slimane era comps ABOVE ordinary Dior menswear. Titling one as the other under-claims a collectible or over-claims a recent piece. The tag decides, never the silhouette."}]$j$::jsonb,
   'Dior identity = Cannage quilting + the model (Lady Dior/Saddle/Book Tote/30 Montaigne), sized in FRENCH numbers the tag never labels as such. Founded 1946 in Paris by Christian Dior; the 1947 debut collection was christened the "New Look" and Cannage is named for the Napoleon III chairs that seated that show. Now LVMH. The house''s ERAS are a price ladder in themselves — Galliano (1996-2011) and Slimane-era Dior Homme both comp above comparable mainline, so read the tag generation. THE ONLY BRAND IN THIS GROUP WITH A DECODER: the hyphenated date code is regular and brand-unique in format (the LV SD1160 precedent). RN omitted — not sourceable.',
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.65, false, 'migration:00461'),

  ('saintlaurent', 'Saint Laurent', ARRAY['saint laurent','saintlaurent','saint laurent paris','yves saint laurent','yvessaintlaurent','ysl','ysl rive gauche','rive gauche']::text[],
   ARRAY['luxury','rtw','leather','womens','mens']::text[],
   $j$[{"era":"Yves Saint Laurent","years":"1961-2012","description":"The house label read YVES SAINT LAURENT. A piece tagged with the full name is pre-2012 by definition — the cleanest date boundary on the brand."},{"era":"Saint Laurent Paris","years":"2012-present","description":"Hedi Slimane renamed the RTW label SAINT LAURENT PARIS in 2012, dropping YVES. YSL survives only as the interlocking monogram on hardware and accessories. So the tag wording dates the piece outright — and the vintage YSL (Rive Gauche in particular) comps on a different ladder from modern Saint Laurent."},{"era":"YSL Rive Gauche","years":"1966-2000s","description":"The ready-to-wear line — the first of its kind from a couture house, opened 1966. A Rive Gauche tag is a genuine vintage read and is collectible in its own right."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy (mostly) / Made in France","note":"A French house that manufactures largely in Italy — a Made in Italy tag on a Saint Laurent is COMPLETELY NORMAL and is a common false 'fake' call. Origin is not an authentication signal here. Note the size system stays FRENCH regardless of where the piece was sewn: the manufacturing country does NOT tell you the sizing system."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"The serial on the interior leather tab is a manufacturer-side mark that fakes reproduce, and the house does not authenticate for third parties. It is also a bare digit run, which is why this brand gets no decoder (the Chanel rule, US-1736). Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE TAG WORDING DATES THE PIECE — YVES or not","detail":"YVES SAINT LAURENT = pre-2012. SAINT LAURENT PARIS = 2012+. This is the highest-value Saint Laurent listing fact: the two comp on different ladders, and vintage YSL Rive Gauche is collectible in its own right. Read the label wording, never the monogram — the YSL hardware mark is still used on current pieces, so the monogram does NOT mean vintage."},{"tell":"THE YSL MONOGRAM IS NOT A DATE","detail":"The interlocking YSL cassandre survived the 2012 rename and appears on current bags. A seller who reads YSL hardware as 'vintage Yves Saint Laurent' misdates the piece by decades. The woven LABEL decides the era; the hardware never does."},{"tell":"Made in Italy is NORMAL on a French house","detail":"Saint Laurent is French and manufactures largely in Italy. An Italian origin tag does not impugn the garment — and it does not change the sizing system either, which stays FRENCH."}]$j$::jsonb,
   'Saint Laurent identity = the tag WORDING (YVES SAINT LAURENT pre-2012 vs SAINT LAURENT PARIS after) + the model (Sac de Jour/LouLou/Kate/Niki), sized in FRENCH numbers the tag never labels as such. Founded 1961 in Paris by Yves Saint Laurent and Pierre Bergé; Rive Gauche (1966) was the first ready-to-wear line from a couture house. Hedi Slimane dropped YVES from the RTW label in 2012 — the monogram stayed, which is exactly the trap. Now Kering. NO DECODER — the tab serial is a bare digit run. RN omitted — not sourceable.',
   'https://www.ysl.com/en-us', 0.65, false, 'migration:00461'),

  ('balenciaga', 'Balenciaga', ARRAY['balenciaga','cristobal balenciaga','balenciaga paris']::text[],
   ARRAY['luxury','rtw','leather','streetwear','sneakers','womens','mens']::text[],
   $j$[{"era":"Cristóbal Balenciaga couture","years":"1919-1968","description":"The founder's own house, closed on his 1968 retirement. Genuine pieces from this era are museum-tier couture and are not what a normal resale flow encounters — treat an apparent one with heightened scepticism and route it to human review."},{"era":"Ghesquière era","years":"1997-2012","description":"Nicolas Ghesquière revived the house and launched the Motorcycle/City bag (2001) — the era that made the modern brand. Collectible in its own right."},{"era":"Demna era","years":"2015-2024","description":"Demna Gvasalia's tenure turned the house toward streetwear-adjacent design — the Triple S (2017), the Speed Trainer, oversized silhouettes and the Le Cagole revival. Pieces from this era comp on a different, hype-driven ladder from the house's tailored RTW."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy","note":"A French house that manufactures in Italy — a Made in Italy tag on a Balenciaga is normal and is not a fake tell. Origin is not an authentication signal. As with Saint Laurent, the manufacturing country does NOT set the sizing system: it stays FRENCH."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"The serial on the interior tab is a manufacturer-side mark that fakes reproduce, and the house does not authenticate for third parties. It is a bare digit run and therefore gets no decoder. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE CITY BAG'S HARDWARE IS THE CONDITION CALL","detail":"The Motorcycle/City bag's identity is its buckled straps, whipstitched handles and dangling zip tassels — and that is also where it FAILS. Missing tassels, a stripped mirror, cracked handle leather and a missing shoulder strap are the failures that actually move the price, and each is visible in a photo. Count the tassels before listing; they are separate pieces and they go missing."},{"tell":"THE ERA IS THE LADDER — Ghesquière vs Demna are different markets","detail":"A Ghesquière-era City bag and a Demna-era Triple S are the same label serving completely different buyers at different prices. Read the era off the design and the tag generation. This is the highest-value Balenciaga call after the size system."},{"tell":"SNEAKERS COMP AS SNEAKERS, and their sizing is EU","detail":"The Triple S / Speed Trainer are a hype-priced sneaker market with its own comps — do not price them off the RTW ladder. They are EU-sized, unlike the FRENCH RTW numbers on the clothing, so the two size systems live under one brand: read the OBJECT before the number."}]$j$::jsonb,
   'Balenciaga identity = the ERA (Ghesquière''s City bag vs Demna''s Triple S) — two markets under one label — with RTW sized in FRENCH numbers the tag never labels as such. Founded 1919 in San Sebastián by Cristóbal Balenciaga, moved to Paris in 1937; the house CLOSED on his 1968 retirement and was revived in 1986, so there is a real gap in its history. Ghesquière launched the Motorcycle/City bag in 2001; Demna (2015-2024) turned it toward streetwear and the Triple S. Now Kering. NOTE the brand runs TWO size systems: French RTW numbers and EU sneaker sizes. NO DECODER — the tab serial is a bare digit run. RN omitted — not sourceable.',
   'https://www.balenciaga.com/en-us', 0.62, false, 'migration:00461'),

  ('bottegaveneta', 'Bottega Veneta', ARRAY['bottega veneta','bottegaveneta','bottega']::text[],
   ARRAY['luxury','leather','rtw','womens','mens']::text[],
   $j$[{"era":"Intrecciato heritage","years":"1966-present","description":"The woven-leather Intrecciato has run since the house's founding and is not era-bound — it dates nothing on its own."},{"era":"Daniel Lee era","years":"2018-2021","description":"Daniel Lee's tenure produced the Pouch, the Cassette, the padded Intrecciato and the Parakeet green that became the house's signature colour. This era is collectible and comps ABOVE comparable later mainline — an era read from the design and the colour, never a verdict."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy","note":"Bottega Veneta is Italian (Vicenza, in the Veneto — the name means 'Venetian shop') and Made in Italy is EXPECTED. Its absence is worth a second look rather than its presence. Not an authentication verdict on its own."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"No published Bottega Veneta authentication standard we can act on; the tab codes are catalog SKUs that fakes reproduce, and the house does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THERE IS DELIBERATELY NO LOGO — 'When your own initials are enough'","detail":"The house's founding principle and the reason it is the odd one out in this pack: Bottega Veneta does NOT put a visible logo on most pieces. So the ABSENCE of branding is expected and is NOT a fake tell — it is one of the most common false counterfeit calls on the brand. The WEAVE is the mark. A seller looking for a logo to photograph will not find one and should not conclude anything from that."},{"tell":"THE INTRECCIATO WEAVE IS THE BRAND — and it is the condition call","detail":"Hand-woven leather strips in a lattice. It is the fastest read on an unlabelled photo and also where the bag fails: individual strips DRY, CRACK, LIFT and SNAP, and a broken strip is both highly visible and expensive. Inspect the weave corners and the handle join specifically. Describe the weave's condition strip-level, not just 'good'."},{"tell":"THE MODEL NAMES ARE RECENT — Cassette, Pouch, Jodie, Andiamo","detail":"Most of the house's named models come from the Daniel Lee era (2018+) and after. An older Bottega is often simply an Intrecciato bag with no model name at all, which is normal — do not invent a model name to fill the field."}]$j$::jsonb,
   'Bottega Veneta identity = the INTRECCIATO woven leather and the deliberate ABSENCE of a logo, with RTW sized in ITALIAN numbers the tag never labels as such. Founded 1966 in Vicenza, Italy — the name means "Venetian shop" — with the house motto "When your own initials are enough", which is why there is no visible branding to look for. The Daniel Lee era (2018-2021) produced the Pouch, the Cassette and the Parakeet green, and comps above comparable later mainline. Now Kering. The one brand in this pack where MISSING branding is expected rather than suspicious. NO DECODER — the tab code is a catalog SKU. RN omitted — not sourceable.',
   'https://www.bottegaveneta.com/en-us', 0.62, false, 'migration:00461'),

  ('fendi', 'Fendi', ARRAY['fendi','fendi roma','fendiroma','fendi casa']::text[],
   ARRAY['luxury','rtw','leather','fur','womens','mens']::text[],
   $j$[{"era":"Karl Lagerfeld tenure","years":"1965-2019","description":"Lagerfeld designed for Fendi for 54 years — the longest such tenure in fashion — and created the double-F mark in 1965. His era therefore spans essentially the whole modern brand and does NOT narrow a date on its own; do not treat 'Lagerfeld-era' as a dating tell here the way it would be at another house."},{"era":"Zucca vs Zucchino monogram","years":"1990s-present","description":"The double-F monogram runs in two scales that are separately named: ZUCCA is the larger print, ZUCCHINO the smaller. They are different fabrics and comp differently — the scale is legible in a photo and is worth reading rather than calling both 'FF monogram'."},{"era":"Baguette","years":"1997-present","description":"Silvia Venturini Fendi's 1997 Baguette is credited with inventing the 'It bag' and had a major revival from 2019. An original-era Baguette and a modern reissue are different markets under one model name."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy","note":"Fendi is Roman and Made in Italy is EXPECTED — its absence is worth a second look rather than its presence. Not an authentication verdict on its own."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"The serial on the interior tab is a manufacturer-side mark that fakes reproduce; it is a catalog-style code, not a brand-unique format, which is why this brand gets no decoder. Fendi does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"FUR IS A LISTING-COMPLIANCE FACT — Fendi is a fur house","detail":"Fendi's couture heritage is FUR, and real fur is restricted or banned in some jurisdictions and on some marketplaces. So the material is not merely a description detail: it decides whether the item can be listed at all. State whether a trim or garment is real fur, faux, or shearling — never assume from the silhouette, and route an uncertain call to human review rather than guessing."},{"tell":"ZUCCA vs ZUCCHINO — the monogram SCALE is named and it prices","detail":"The larger Zucca and the smaller Zucchino are distinct, separately-named monogram fabrics that comp differently. The scale is legible in a photo relative to the bag's hardware. Read it rather than writing 'FF monogram'."},{"tell":"THE DOUBLE-F IS 'FUN FURS', not the founder's initials","detail":"Lagerfeld drew the FF mark in 1965 to stand for Fun Furs. It is a description/provenance aid with no dating power — it has run for essentially the brand's whole modern life."}]$j$::jsonb,
   'Fendi identity = the double-F monogram at its named SCALE (Zucca large / Zucchino small) + the model (Baguette/Peekaboo), sized in ITALIAN numbers the tag never labels as such. Founded 1925 in Rome as a fur and leather shop by Adele and Edoardo Fendi; run for decades by their five daughters. Karl Lagerfeld designed for the house 1965-2019 — 54 years, the longest tenure in fashion — and drew the FF ("Fun Furs") mark in 1965, which is why it dates nothing. Silvia Venturini Fendi''s 1997 Baguette is credited with inventing the It bag. Now LVMH. FUR is a marketplace-compliance fact on this brand, not a flourish. NO DECODER — the tab code is a catalog SKU. RN omitted — not sourceable.',
   'https://www.fendi.com/us', 0.62, false, 'migration:00461'),

  -- PROMOTED from the bare alias-only row seeded by 00389 (which carried nothing
  -- but the canonical + one alias). This is the story's named promotion.
  ('versace', 'Versace', ARRAY['versace','gianni versace','versace atelier','atelier versace']::text[],
   ARRAY['luxury','rtw','leather','womens','mens']::text[],
   $j$[{"era":"Gianni Versace","years":"1978-1997","description":"The founder's own era, ended by his 1997 murder. A GIANNI VERSACE tag (rather than a bare VERSACE one) is pre-1997 by definition and is genuinely collectible — the cleanest date boundary on the brand and a real price ladder, not just a date."},{"era":"Donatella era","years":"1997-present","description":"Donatella Versace took over in 1997. The label reads VERSACE. This covers the bulk of what a normal resale flow encounters."},{"era":"Diffusion labels print their OWN names","years":"1989-present","description":"Versus Versace (1989), Versace Collection (discontinued c.2018) and Versace Jeans Couture each print their own name on the tag and are NOT mainline. Read the label wording exactly — this is the brand's defining trap."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy","note":"Versace is Italian (Milan) and Made in Italy is expected on mainline. The diffusion labels are also largely Italian-made, so origin does NOT separate the ladders — only the tag wording does."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"No published Versace authentication standard, serial or date code that could prove authenticity programmatically — the brand prints no regular garment-side code, which is why it gets no decoder. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"READ THE FULL LABEL — VERSACE JEANS COUTURE IS NOT VERSACE","detail":"THE defining Versace trap and the most expensive mistake on the brand. Versace Jeans Couture, Versus Versace and Versace Collection are DIFFUSION labels that print their own names and sell an ORDER OF MAGNITUDE below mainline Versace. They are the most common Versace items in resale by a wide margin. Titling a VJC piece as 'Versace' over-claims it enormously and is a misrepresentation, not a shortcut. The tag wording is the entire call — the Medusa head appears on all of them, so the logo settles nothing."},{"tell":"GIANNI VERSACE on the tag = pre-1997, and it is a LADDER","detail":"A GIANNI VERSACE label predates the founder's 1997 death and is collectible in its own right, comping above comparable Donatella-era mainline. The single most valuable dating fact on the brand — read the wording, never the Medusa."},{"tell":"MEDUSA / GRECA / BAROCCO are the house marks — and they authenticate NOTHING","detail":"The Medusa head, the Greca key border and the Barocco print are the fastest Versace reads on an unlabelled photo, and they are among the most imitated marks in fashion — both by counterfeits and by the brand's own diffusion lines. They identify the HOUSE, never the ladder and never the authenticity. The label decides."}]$j$::jsonb,
   'Versace identity = READING THE FULL LABEL — mainline Versace vs the Versus/Collection/Jeans Couture diffusion lines, which print their own names and sell an order of magnitude below — plus the era (GIANNI VERSACE = pre-1997, collectible). Sized in ITALIAN numbers the tag never labels as such. Founded 1978 in Milan by Gianni Versace; Donatella took over after his 1997 murder; acquired by Capri Holdings in 2018. The Medusa/Greca/Barocco marks appear across EVERY ladder, which is exactly why they cannot be used to place a piece. Promoted here from the bare alias-only row in 00389. NO DECODER — the brand prints no regular garment-side code. RN omitted — not sourceable.',
   'https://www.versace.com/us/en/', 0.62, false, 'migration:00461'),

  -- CELINE, not Céline — see the brand_key note in this block's header. The
  -- accent is a genuine dating tell and is carried as a tag_era below.
  ('celine', 'Celine', ARRAY['celine','céline','celine paris','céline paris']::text[],
   ARRAY['luxury','rtw','leather','womens','mens']::text[],
   $j$[{"era":"Céline — WITH the accent (Phoebe Philo era)","years":"c.2008-2018","description":"THE brand's defining tell. Under Phoebe Philo the label was accented: CÉLINE. Her tenure (2008-2018) produced the Luggage tote, the Box bag, the Trapeze and a minimalist RTW that is now genuinely collectible — Philo-era Céline comps ABOVE comparable later mainline. The accent therefore dates AND ladders the piece in one mark."},{"era":"CELINE — WITHOUT the accent (Slimane era)","years":"2018-present","description":"Hedi Slimane REMOVED the accent in 2018, and the current mark is CELINE. So an unaccented tag is 2018+ by definition. The missing accent is NOT a fake tell — it is the single most common false counterfeit call on the brand, and it is exactly backwards: it is the modern house's own mark."},{"era":"Vintage Celine","years":"1945-2008","description":"The pre-Philo house (founded 1945 as a children's shoe shop, later the Sulky/carriage logo and the Triomphe chain). A different market again from either modern era."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy (mostly) / Made in France","note":"A French house that manufactures largely in Italy — a Made in Italy tag on a Celine is normal and is not a fake tell. As with Saint Laurent and Balenciaga, the manufacturing country does NOT set the size system: it stays FRENCH."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"The tab code is a manufacturer-side mark that fakes reproduce and it is not a brand-unique format, which is why this brand gets no decoder. Celine does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE ACCENT IS THE DATE AND THE LADDER — CÉLINE vs CELINE","detail":"The highest-value Celine fact by a wide margin, and it is two characters long. CÉLINE (accented) = the Phoebe Philo era, roughly 2008-2018, and it is COLLECTIBLE — it comps above comparable modern mainline. CELINE (no accent) = Hedi Slimane's 2018 rebrand onward. A missing accent is the house's OWN current mark, not a counterfeit tell — calling it one is the most common false fake call on the brand, and reading a Philo-era piece as modern under-prices a collectible. Read the accent."},{"tell":"THE PHILO-ERA MODELS ARE THE MARKET — Luggage, Box, Trapeze","detail":"The Luggage tote (the 'face' bag, with its winged flaps and top zip), the Box bag and the Trapeze are Philo-era designs and are what the collectible market wants. The Triomphe (the interlocking chain clasp) spans the vintage house and the Slimane revival. Naming the model correctly is most of the pricing on this brand."},{"tell":"There is no logo to look for on much of the RTW","detail":"Philo-era Celine RTW is deliberately unbranded on the exterior. As with Bottega Veneta, the ABSENCE of visible branding is expected and concludes nothing — the woven label decides."}]$j$::jsonb,
   'Celine identity = THE ACCENT — CÉLINE (Phoebe Philo, c.2008-2018, collectible) vs CELINE (Hedi Slimane''s 2018 rebrand onward) — plus the model (Luggage/Box/Trapeze/Triomphe). Sized in FRENCH numbers the tag never labels as such. Founded 1945 in Paris by Céline Vipiana as a made-to-measure CHILDREN''S SHOE shop; the Triomphe mark derives from the Arc de Triomphe chains. Now LVMH. The canonical is deliberately UNACCENTED because the house itself dropped the accent in 2018 (which also keys cleanly as ''celine''); the accented spelling is carried as a tag_era dating tell, exactly like "Burberrys" with the S in 00455. NO DECODER — the tab code is a catalog SKU. RN omitted — not sourceable.',
   'https://www.celine.com/en-us/', 0.62, false, 'migration:00461')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- The confusable pairs in this group are ERA-vs-ERA and LADDER-vs-LADDER far more
-- than silhouette-vs-silhouette: Philo Céline vs Slimane CELINE, Gianni vs
-- Donatella Versace, mainline Versace vs Versace Jeans Couture, YVES SAINT
-- LAURENT vs SAINT LAURENT PARIS. These pieces photograph identically and comp
-- an order of magnitude apart, so each fingerprint leads with what the TAG says.
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('herms', 'Birkin', ARRAY['birkin','birkin bag','birkin 30','birkin 35']::text[], 'Women', 'bag', 'Hermès',
   'The structured top-handle tote: a trapezoidal body, two rolled handles, a flap closing under a metal touret (turn-lock) with two straps, and a padlock + clochette (the leather key pouch) hanging from a handle. vs KELLY: this is the tell — the BIRKIN HAS TWO HANDLES AND NO SHOULDER STRAP as standard; the Kelly has ONE handle and a detachable strap. Nothing else separates them reliably in a photo, so count the handles. Size is named in centimetres (25/30/35/40). CONFIRM the clochette, padlock and both keys are present — they are separate pieces, they go missing, and they materially move the price.',
   ARRAY['Togo leather','Clemence leather','Epsom leather','Box calf']::text[], '1984-present', '$10,000+', ARRAY['birkin','top handle','clochette','padlock','togo']::text[],
   'https://www.hermes.com/us/en/', 0.65, false, 'migration:00461'),
  ('herms', 'Kelly', ARRAY['kelly','kelly bag','kelly 28','sac a depeches']::text[], 'Women', 'bag', 'Hermès',
   'The single-handle trapezoidal bag with a flap, a touret closure and a DETACHABLE SHOULDER STRAP — named for Grace Kelly, who used one to shield her pregnancy from photographers in 1956. vs BIRKIN: ONE handle (the Birkin has two) and a strap (the Birkin has none) — count the handles, since the leathers, the hardware and the clochette are shared and settle nothing. Sellier (rigid, stitched outside, sharp edges) vs Retourné (softer, stitched inside, rounded) are different constructions at different prices — say which. Confirm the strap, clochette, padlock and keys are present.',
   ARRAY['Togo leather','Epsom leather','Box calf']::text[], '1930s-present', '$9,000+', ARRAY['kelly','sellier','retourne','shoulder strap','clochette']::text[],
   'https://www.hermes.com/us/en/', 0.62, false, 'migration:00461'),
  ('herms', 'Constance', ARRAY['constance','constance 18','constance 24']::text[], 'Women', 'bag', 'Hermès',
   'The shoulder bag whose closure IS the logo: a large metal H clasp spanning the front flap, on a thin adjustable strap that can be doubled. The H clasp is unmistakable and is the fastest Constance read in a photo — no other Hermès model uses it. Sized 18/24 in centimetres.',
   ARRAY['Epsom leather','Box calf','Swift leather']::text[], '1959-present', '$9,000+', ARRAY['constance','h clasp','shoulder bag','epsom']::text[],
   'https://www.hermes.com/us/en/', 0.60, false, 'migration:00461'),
  ('herms', 'Evelyne', ARRAY['evelyne','evelyne pm','evelyne tpm']::text[], 'Unisex', 'bag', 'Hermès',
   'The entry-tier crossbody: a soft unstructured bucket-ish body with a PERFORATED H punched THROUGH the front panel and a wide canvas strap. Designed in 1978 to carry horse brushes, which is why the perforation exists at all — it is ventilation, not decoration. The punched H (rather than an applied metal one) separates it instantly from the Constance. Comps FAR below the Birkin/Kelly ladder — it is the one Hermès bag a normal resale flow actually sees.',
   ARRAY['Clemence leather','Epsom leather']::text[], '1978-present', '$3,000-$5,000', ARRAY['evelyne','crossbody','perforated h','clemence']::text[],
   'https://www.hermes.com/us/en/', 0.60, false, 'migration:00461'),
  ('herms', 'Carré Scarf', ARRAY['carre','carré','scarf','90cm scarf','silk scarf']::text[], 'Women', 'accessory', 'Hermès',
   'The 90cm silk twill square — the volume Hermès item in resale by a wide margin, and the one a photo can grade properly. Hand-rolled EDGES are the construction fact worth stating (the hem is rolled and stitched by hand, so it is plump and slightly irregular, never flat and machine-uniform). Design names and the copyright text are printed in the selvedge. Condition is everything here: pulls, snags, watermarks and fading decide the price, and they are all photographable.',
   ARRAY['silk twill']::text[], 'long-running core', '$400-$700', ARRAY['carre','scarf','silk twill','hand rolled','90cm']::text[],
   'https://www.hermes.com/us/en/', 0.60, false, 'migration:00461'),

  ('dior', 'Lady Dior', ARRAY['lady dior','lady di','ladydior']::text[], 'Women', 'bag', 'Dior',
   'The rectangular top-handle bag in quilted CANNAGE leather with two handles and four dangling D-I-O-R letter charms. COUNT THE CHARMS — all four letters must be present; a missing charm is a visible, price-moving defect and they detach. Named for Diana, Princess of Wales, who was given one in 1995. The Cannage quilt plus the charms make it unmistakable — no other Dior model combines them.',
   ARRAY['lambskin','patent calfskin','Cannage quilting']::text[], '1995-present', '$5,000-$7,000', ARRAY['lady dior','cannage','charms','top handle']::text[],
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.62, false, 'migration:00461'),
  ('dior', 'Saddle Bag', ARRAY['saddle','saddle bag','saddlebag']::text[], 'Women', 'bag', 'Dior',
   'The Galliano-era icon: an asymmetric bag shaped like an actual SADDLE, with a curved flap, a stirrup-shaped D hardware clasp and a hanging strap. The silhouette is the entire tell — nothing else in the house is shaped like it. NOTE THE ERA LADDER: an original Galliano-era (2000) Saddle and the 2018 Maria Grazia Chiuri revival are the same model name serving different markets, so read the tag generation rather than the shape.',
   ARRAY['oblique jacquard','calfskin']::text[], '2000-2000s; revived 2018', '$3,500-$4,500', ARRAY['saddle','galliano','oblique','stirrup']::text[],
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.60, false, 'migration:00461'),
  ('dior', 'Book Tote', ARRAY['book tote','booktote']::text[], 'Women', 'bag', 'Dior',
   'The large unstructured open-top tote in embroidered canvas — flat, rectangular, no closure at all and no metal hardware. The ABSENCE of a clasp and the all-over embroidery separate it from every other Dior bag in a photo. A Maria Grazia Chiuri design (2018), so it cannot be older; it is frequently personalised with embroidered initials, which narrows the buyer and is worth stating.',
   ARRAY['embroidered canvas','Oblique jacquard']::text[], '2018-present', '$3,000-$3,700', ARRAY['book tote','embroidered','canvas','tote']::text[],
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.58, false, 'migration:00461'),
  ('dior', 'Dior Homme', ARRAY['dior homme','diorhomme','dior men']::text[], 'Men', 'jacket', 'Dior Homme',
   'A LINE, not a single garment — and the tag wordmark is the whole call. DIOR HOMME (pre-2019, and the Hedi Slimane years especially) comps ABOVE ordinary Dior menswear and is collectible; DIOR MEN is the Kim Jones renaming from 2018. The Slimane-era pieces are cut extremely slim, which corroborates but does not decide. No photo separates the lines reliably — read the label wording.',
   ARRAY['wool','leather']::text[], 'Homme 2001-2018; Men 2018-present', '$1,500-$4,000', ARRAY['dior homme','slimane','dior men','menswear']::text[],
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.58, false, 'migration:00461'),

  ('saintlaurent', 'Sac de Jour', ARRAY['sac de jour','sacdejour']::text[], 'Women', 'bag', 'Saint Laurent',
   'The rigid structured top-handle tote: a sharply architectural trapezoid in smooth calfskin with two handles, side wings that fold in accordion-style, and an embossed SAINT LAURENT PARIS mark on the front panel. The RIGIDITY is the tell — it stands unaided, where the LouLou slouches. The embossed wordmark dates it 2012+ by definition.',
   ARRAY['grained calfskin','smooth calfskin']::text[], '2013-present', '$3,000-$3,800', ARRAY['sac de jour','structured','top handle','calfskin']::text[],
   'https://www.ysl.com/en-us', 0.60, false, 'migration:00461'),
  ('saintlaurent', 'LouLou', ARRAY['loulou','lou lou','loulou puffer']::text[], 'Women', 'bag', 'Saint Laurent',
   'The SOFT quilted chain-strap shoulder bag with a large interlocking YSL cassandre on the flap — Y-quilted (chevron), not diamond-quilted, which is the fast separator from a Chanel-style flap in a photo. It slouches, where the Sac de Jour stands rigid. CAUTION: the YSL monogram here does NOT mean vintage Yves Saint Laurent — the mark survived the 2012 rename and this is a modern bag.',
   ARRAY['quilted lambskin']::text[], '2017-present', '$2,000-$2,800', ARRAY['loulou','quilted','ysl','chain strap']::text[],
   'https://www.ysl.com/en-us', 0.58, false, 'migration:00461'),
  ('saintlaurent', 'Kate', ARRAY['kate','kate bag','kate tassel']::text[], 'Women', 'bag', 'Saint Laurent',
   'The slim rectangular flap-over shoulder bag with a chain strap and a large YSL cassandre — often with a hanging tassel. The flat, structured, envelope-like profile separates it from the slouchy LouLou. Same caution: the monogram is not a date.',
   ARRAY['grained calfskin','suede']::text[], '2016-present', '$2,000-$2,500', ARRAY['kate','tassel','chain','cassandre']::text[],
   'https://www.ysl.com/en-us', 0.55, false, 'migration:00461'),
  ('saintlaurent', 'Rive Gauche', ARRAY['rive gauche','ysl rive gauche','rivegauche']::text[], 'Unisex', 'top', 'YSL Rive Gauche',
   'A LINE, not a garment — the ready-to-wear label opened in 1966, the first from a couture house. A RIVE GAUCHE tag is genuine vintage YSL and comps on a collector ladder entirely apart from modern Saint Laurent. The tag wording is the whole call and no photo substitutes for it.',
   ARRAY['wool','silk']::text[], '1966-2000s', 'varies (collector)', ARRAY['rive gauche','vintage','ysl','yves saint laurent']::text[],
   'https://www.ysl.com/en-us', 0.55, false, 'migration:00461'),

  ('balenciaga', 'City Bag', ARRAY['city','city bag','motorcycle bag','moto bag','first','part time']::text[], 'Women', 'bag', 'Balenciaga',
   'The Ghesquière-era icon (2001): a slouchy distressed-lambskin bag with buckled straps across the top, WHIPSTITCHED rolled handles, a front zip pocket, a mirror, and dangling leather ZIP TASSELS. COUNT THE TASSELS and confirm the mirror and shoulder strap are present — they are separate pieces, they go missing, and each is price-moving. The whipstitching plus the tassels are unmistakable. The "Motorcycle bag" family (First / City / Part Time / Work) differ only in SIZE, so the model name is a size call, not a shape one.',
   ARRAY['distressed lambskin']::text[], '2001-present', '$1,500-$2,300', ARRAY['city','motorcycle','tassel','whipstitch','ghesquiere']::text[],
   'https://www.balenciaga.com/en-us', 0.60, false, 'migration:00461'),
  ('balenciaga', 'Triple S', ARRAY['triple s','triples','triple-s']::text[], 'Unisex', 'sneaker', 'Balenciaga',
   'The Demna-era chunky sneaker (2017) that launched the "dad shoe" market: a grotesquely stacked triple-layer sole (hence the name), a multi-material patchwork upper and deliberate pre-yellowed/distressed midsoles — THE PRE-YELLOWING IS FACTORY-APPLIED AND IS NOT AGE OR DAMAGE, which is the single most common false condition call on this shoe. Do not grade the yellowing as a defect. EU-sized, unlike the FRENCH numbers on the brand''s RTW. Comps as a hype sneaker, not off the RTW ladder.',
   ARRAY['leather','mesh','rubber']::text[], '2017-present', '$1,000-$1,200', ARRAY['triple s','dad shoe','chunky','demna','sneaker']::text[],
   'https://www.balenciaga.com/en-us', 0.58, false, 'migration:00461'),
  ('balenciaga', 'Hourglass', ARRAY['hourglass','hourglass bag']::text[], 'Women', 'bag', 'Balenciaga',
   'The Demna-era structured top-handle bag with a pinched, curved base and a large metal B forming the front foot — the concave waist gives the model its name and is the fastest read in a photo. Rigid, where the City slouches: the two eras produce visibly opposite bags under one label.',
   ARRAY['shiny box calfskin','crocodile-embossed calfskin']::text[], '2019-present', '$2,500-$3,000', ARRAY['hourglass','structured','b logo','demna']::text[],
   'https://www.balenciaga.com/en-us', 0.55, false, 'migration:00461'),
  ('balenciaga', 'Le Cagole', ARRAY['le cagole','cagole']::text[], 'Women', 'bag', 'Balenciaga',
   'The Demna-era revival of the moto vocabulary, pushed to excess: a slouchy crescent shoulder bag COVERED in studs, buckles and oversized zip tassels, usually in bright distressed lambskin. The stud density separates it from the older City in a photo — the City is comparatively restrained. Confirm the studs are all present and the tassels intact.',
   ARRAY['distressed lambskin']::text[], '2021-present', '$2,300-$2,900', ARRAY['cagole','studs','moto','crescent','demna']::text[],
   'https://www.balenciaga.com/en-us', 0.55, false, 'migration:00461'),

  ('bottegaveneta', 'Cassette', ARRAY['cassette','cassette bag','padded cassette']::text[], 'Women', 'bag', 'Bottega Veneta',
   'The Daniel Lee-era icon: a rectangular quilted crossbody in EXAGGERATEDLY PADDED, oversized Intrecciato — the weave strips are inflated and puffy, unlike the flat classic Intrecciato, which is the whole separator in a photo. Often on a chunky chain or a wide woven strap. No visible logo, as with most of the house.',
   ARRAY['padded Intrecciato lambskin']::text[], '2019-present', '$3,000-$3,800', ARRAY['cassette','padded','intrecciato','crossbody']::text[],
   'https://www.bottegaveneta.com/en-us', 0.58, false, 'migration:00461'),
  ('bottegaveneta', 'Jodie', ARRAY['jodie','the jodie','mini jodie']::text[], 'Women', 'bag', 'Bottega Veneta',
   'The soft slouchy hobo with a distinctive KNOTTED top handle — the knot is the entire tell and no other model in the house has it. Named for Jodie Foster. Usually in Intrecciato. Check the knot''s leather for cracking at the twist: it is the stress point and it is photographable.',
   ARRAY['Intrecciato nappa']::text[], '2020-present', '$2,800-$3,500', ARRAY['jodie','knot','hobo','intrecciato']::text[],
   'https://www.bottegaveneta.com/en-us', 0.58, false, 'migration:00461'),
  ('bottegaveneta', 'Pouch', ARRAY['pouch','the pouch','mini pouch']::text[], 'Women', 'bag', 'Bottega Veneta',
   'The Daniel Lee clutch (2019): a soft, gathered, pillow-like envelope with no hardware, no handle and no visible logo — its entire identity is the slouch and the ruched top. The complete ABSENCE of hardware is what identifies it, which is the house''s no-logo principle taken to its limit. Often in smooth nappa rather than Intrecciato.',
   ARRAY['nappa leather']::text[], '2019-present', '$2,500-$3,200', ARRAY['pouch','clutch','ruched','daniel lee']::text[],
   'https://www.bottegaveneta.com/en-us', 0.55, false, 'migration:00461'),
  ('bottegaveneta', 'Intrecciato Classic', ARRAY['intrecciato','woven','classic intrecciato']::text[], 'Unisex', 'bag', 'Bottega Veneta',
   'NOT a single model — the house''s hand-woven leather technique, which most older Bottega pieces carry with NO model name at all. That is normal and expected: do not invent a model name to fill the field. The flat, fine, even lattice separates it from the Lee-era padded weave. Condition is strip-level: look for dried, cracked, lifted or SNAPPED strips at the corners and the handle joins — the defect that actually prices the bag.',
   ARRAY['woven nappa leather']::text[], '1966-present', '$1,500-$3,500', ARRAY['intrecciato','woven leather','no logo','classic']::text[],
   'https://www.bottegaveneta.com/en-us', 0.60, false, 'migration:00461'),

  ('fendi', 'Baguette', ARRAY['baguette','baguette bag']::text[], 'Women', 'bag', 'Fendi',
   'The 1997 Silvia Venturini Fendi design credited with inventing the "It bag": a small flat rectangular shoulder bag with a SHORT strap meant to tuck under the arm like a baguette — hence the name. The front is dominated by a large FF turn-lock clasp. Note the era ladder: an original-run 1990s/2000s Baguette and the 2019+ revival are different markets under one model name, so read the tag generation. It exists in hundreds of fabrications (sequin, beaded, embroidered, Zucca), and the FABRIC is most of the price.',
   ARRAY['Zucca jacquard','sequin','nappa leather']::text[], '1997-present', '$3,000-$4,500', ARRAY['baguette','it bag','ff clasp','zucca']::text[],
   'https://www.fendi.com/us', 0.60, false, 'migration:00461'),
  ('fendi', 'Peekaboo', ARRAY['peekaboo','peek a boo','peekaboo iseeu']::text[], 'Women', 'bag', 'Fendi',
   'The structured top-handle bag whose defining feature is a twist-lock CENTRE DIVIDER that lets the bag gape open to show a contrasting interior — the name is literal, and the contrasting inside is the tell. Photograph it open; the interior colour is a listed attribute buyers search on and it is invisible when closed.',
   ARRAY['nappa leather','selleria leather']::text[], '2009-present', '$5,000-$7,000', ARRAY['peekaboo','twist lock','divider','top handle']::text[],
   'https://www.fendi.com/us', 0.58, false, 'migration:00461'),
  ('fendi', 'Zucca Monogram', ARRAY['zucca','zucchino','ff monogram','ff logo']::text[], 'Unisex', 'bag', 'Fendi',
   'NOT a model — the double-F monogram FABRIC, and the SCALE is separately named and separately priced: ZUCCA is the larger print, ZUCCHINO the smaller. Read the scale against the bag''s hardware in the photo rather than writing "FF monogram" and losing the distinction. The FF mark (Lagerfeld, 1965, for "Fun Furs") dates nothing — it has run essentially the whole modern life of the brand.',
   ARRAY['coated canvas jacquard']::text[], '1990s-present', 'varies', ARRAY['zucca','zucchino','ff','monogram']::text[],
   'https://www.fendi.com/us', 0.58, false, 'migration:00461'),
  ('fendi', 'Fur & Shearling', ARRAY['fur','shearling','fun furs','fur coat']::text[], 'Women', 'coat', 'Fendi',
   'NOT a single model — the house''s couture heritage and a LISTING-COMPLIANCE category, which is why it is carried as a style at all. Real fur is restricted or banned in some jurisdictions and on some marketplaces, so whether a coat or trim is real fur, faux, or shearling decides whether it can be listed, not merely how it is described. State which; never infer it from the silhouette; route an uncertain call to human review.',
   ARRAY['fur','shearling']::text[], '1925-present', 'varies (high)', ARRAY['fur','shearling','fun furs','compliance']::text[],
   'https://www.fendi.com/us', 0.55, false, 'migration:00461'),

  ('versace', 'Versace Jeans Couture', ARRAY['versace jeans couture','vjc','versace jeans','versus','versus versace','versace collection']::text[], 'Unisex', 'top', 'Versace Jeans Couture',
   'A DIFFUSION LADDER, not a garment — and the highest-value call on the whole brand. Versace Jeans Couture, Versus Versace and Versace Collection print THEIR OWN NAMES on the tag and sell an ORDER OF MAGNITUDE below mainline Versace. They are also the most common Versace items in resale by a wide margin. The Medusa head appears on all of them, so the logo settles NOTHING — read the full label wording. Titling one of these as plain "Versace" is a misrepresentation, not a shortcut, and it is the mistake this entry exists to prevent.',
   ARRAY['cotton','denim']::text[], '1989-present', '$100-$400', ARRAY['versace jeans couture','vjc','versus','diffusion','medusa']::text[],
   'https://www.versace.com/us/en/', 0.65, false, 'migration:00461'),
  ('versace', 'Barocco Print', ARRAY['barocco','baroque','baroque print','barocco print']::text[], 'Unisex', 'shirt', 'Versace',
   'NOT a model — the house''s ornate gold-scrollwork print, most valuable on the silk camp/dress shirts. The print is the fastest Versace read in a photo AND is imitated relentlessly by counterfeits and by the brand''s own diffusion lines alike, so it identifies the HOUSE and never the ladder. Read the label to place the piece. A GIANNI VERSACE-tagged Barocco silk shirt is the collectible version.',
   ARRAY['silk twill']::text[], '1990s-present', '$800-$1,500', ARRAY['barocco','baroque','silk shirt','print','gold']::text[],
   'https://www.versace.com/us/en/', 0.60, false, 'migration:00461'),
  ('versace', 'Medusa', ARRAY['medusa','medusa head','la medusa']::text[], 'Unisex', 'accessory', 'Versace',
   'NOT a model — the house''s Gorgon-head mark, used since 1978 on hardware, buttons, belts and bags (the La Medusa bag family carries it as the front clasp). It appears across EVERY ladder including the diffusion lines, and it is among the most imitated marks in fashion. It identifies the house only: it dates nothing, places nothing and authenticates nothing.',
   ARRAY['metal hardware']::text[], '1978-present', 'varies', ARRAY['medusa','gorgon','hardware','clasp']::text[],
   'https://www.versace.com/us/en/', 0.58, false, 'migration:00461'),
  ('versace', 'Greca', ARRAY['greca','greek key','greca border']::text[], 'Unisex', 'top', 'Versace',
   'NOT a model — the Greek-key meander border, drawn from the classical Greco-Roman vocabulary the founder built the house on. Like the Medusa it runs across every ladder and is heavily imitated: a house read, never a ladder or authenticity one.',
   ARRAY['knit','silk']::text[], 'long-running', 'varies', ARRAY['greca','greek key','meander','border']::text[],
   'https://www.versace.com/us/en/', 0.55, false, 'migration:00461'),

  ('celine', 'Luggage Tote', ARRAY['luggage','luggage tote','face bag','mini luggage']::text[], 'Women', 'bag', 'Celine',
   'THE Phoebe Philo icon (2010) and the reason the accent matters: a structured trapezoidal tote with WINGED side flaps, a top zip and a contrasting central panel that reads as a face — hence its nickname, the "face bag". The wings are unmistakable. A Philo-era CÉLINE-tagged Luggage is collectible and comps ABOVE modern mainline: READ THE ACCENT on the interior stamp, because the silhouette alone cannot date it.',
   ARRAY['drummed calfskin','smooth calfskin']::text[], '2010-present', '$2,900-$3,500', ARRAY['luggage','face bag','wings','philo']::text[],
   'https://www.celine.com/en-us/', 0.60, false, 'migration:00461'),
  ('celine', 'Box Bag', ARRAY['box','box bag','classic box']::text[], 'Women', 'bag', 'Celine',
   'The Philo-era minimalist shoulder bag: a rigid rectangular box in smooth glossy calfskin with a long flap and a simple metal CLASP TONGUE closure, on a thin adjustable strap. Deliberately unbranded on the exterior — the ABSENCE of a logo is expected and concludes nothing. Read the accent on the interior stamp to place the era: CÉLINE = Philo, collectible.',
   ARRAY['box calfskin']::text[], '2010s-present', '$3,900-$4,500', ARRAY['box bag','classic box','philo','minimalist']::text[],
   'https://www.celine.com/en-us/', 0.58, false, 'migration:00461'),
  ('celine', 'Triomphe', ARRAY['triomphe','triomphe bag','triomphe canvas']::text[], 'Unisex', 'bag', 'Celine',
   'The interlocking chain-link clasp derived from the Arc de Triomphe chains — the house''s oldest mark, revived hard by Hedi Slimane from 2018 as both a metal clasp and an all-over canvas monogram. It spans the vintage house AND the Slimane era, so unlike the Luggage/Box it does NOT imply Philo: it is the one Celine mark that dates nothing on its own. Read the accent.',
   ARRAY['calfskin','coated canvas']::text[], '1970s; revived 2018-present', '$2,500-$4,000', ARRAY['triomphe','chain','clasp','slimane','canvas']::text[],
   'https://www.celine.com/en-us/', 0.58, false, 'migration:00461'),
  ('celine', 'Trapeze', ARRAY['trapeze','trapeze bag']::text[], 'Women', 'bag', 'Celine',
   'The Philo-era structured bag with a narrow top and WIDE FLARED winged sides that splay outward — trapezoidal in front elevation, hence the name. vs LUGGAGE: both are winged Philo totes and the photo does not reliably separate them — the Trapeze FLARES outward to a wide base and has a front flap, where the Luggage is a squarer top-zip tote. If the photo does not settle it, say so rather than picking one.',
   ARRAY['calfskin','suede']::text[], '2011-present', '$2,500-$3,000', ARRAY['trapeze','wings','philo','flap']::text[],
   'https://www.celine.com/en-us/', 0.55, false, 'migration:00461')
on conflict (brand_key, style_name, department) do update set
  aliases = excluded.aliases, product_line = excluded.product_line,
  category = excluded.category, visual_fingerprint = excluded.visual_fingerprint,
  fabric_tech = excluded.fabric_tech, era = excluded.era, msrp_band = excluded.msrp_band,
  keywords = excluded.keywords, source_url = excluded.source_url,
  confidence = excluded.confidence, verified = excluded.verified,
  updated_by = excluded.updated_by;

-- ── brand_style_codes: DIOR ONLY ────────────────────────────────────────────
-- The only code in this group that clears all three bars (tag-printed, regular,
-- brand-unique FORMAT). 2 digits + 2 letters + 4 digits, HYPHENATED, is a
-- compound distinctive enough to anchor on — the LV SD1160 precedent (00399)
-- with separators on top, which makes it strictly more distinctive than the
-- precedent that justified it.
--
-- Everything else in the group is deliberately decoder-less. HERMÈS is the
-- instructive refusal and it is the Chanel rule (US-1736) at its limit: its blind
-- stamp is a BARE LETTER, and a pattern over one letter would recover "the most
-- valuable label in the pack" from essentially any tag. Hermès ships no serial
-- number at all, so there is nothing else to decode either.
--
-- The code is a DATE code, not a style code — it identifies where/when a piece was
-- made, not which model it is. That is fine for the job it does here (brand
-- recovery off a cut tab, which is what enrichExtractionWithBrandKnowledge keys
-- off styleCode for) and the description says so plainly, so the verifier and any
-- surface that renders it are not misled into reading it as a model identifier.
-- It is emphatically NOT an authenticity check.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by)
values
  ('dior', 'date_code',
   'Dior date code heat-stamped on an interior leather tab: 2 digits + 2 letters + 4 digits, hyphenated (05-BO-0151, 17-BO-0129). Encodes the manufacturing origin/date, NOT the model and NOT authenticity. Recovers the BRAND off a cut or removed brand tab — the group''s cut-tag case.',
   '^(?<code>\d{2}-[A-Z]{2}-\d{4})$',
   $j${"fieldMap": {"code": "styleCode"}, "confidence": 0.6}$j$::jsonb,
   $j$[{"code":"05-BO-0151","expected":{"styleCode":"05-BO-0151"}},{"code":"17-BO-0129","expected":{"styleCode":"17-BO-0129"}}]$j$::jsonb,
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.55, false, 'migration:00461')
on conflict (brand_key, decoder_kind) do update set
  description = excluded.description, pattern = excluded.pattern,
  extraction_rules = excluded.extraction_rules, examples = excluded.examples,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Only where the brand genuinely uses PROPRIETARY named colors (AC3) — the same
-- bar 00453/00460 applied. HERMÈS is the strongest case the KB has ever had: its
-- colour names are house vocabulary a seller cannot derive from a photo, they
-- persist across decades rather than rotating per season, and the colour is a
-- real price input on a Birkin/Kelly. Bottega Veneta's Parakeet is the other
-- clear case — a Daniel Lee-era house colour so identified with the brand that
-- the name carries independently of the season.
--
-- Deliberately NOT seeded for the other six. Dior/Saint Laurent/Balenciaga/Fendi/
-- Versace/Celine ship ordinary colour words (black, tan, navy) that rotate per
-- season and form no stable dictionary; inventing one would be worse than the gap.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('herms', 'Etoupe', ARRAY['etoupe','étoupe']::text[], '#8B7D6F', 'long-running',
   'https://www.hermes.com/us/en/', 0.55, false, 'migration:00461'),
  ('herms', 'Gold', ARRAY['gold','or']::text[], '#9C6644', 'long-running',
   'https://www.hermes.com/us/en/', 0.55, false, 'migration:00461'),
  ('herms', 'Rouge H', ARRAY['rouge h','rougeh']::text[], '#6E1F26', 'long-running',
   'https://www.hermes.com/us/en/', 0.55, false, 'migration:00461'),
  ('herms', 'Bleu Jean', ARRAY['bleu jean','bleujean']::text[], '#5B7C99', 'c.2000s',
   'https://www.hermes.com/us/en/', 0.50, false, 'migration:00461'),
  ('herms', 'Craie', ARRAY['craie']::text[], '#E8E1D5', 'long-running',
   'https://www.hermes.com/us/en/', 0.50, false, 'migration:00461'),
  ('herms', 'Etain', ARRAY['etain','étain']::text[], '#6E6A65', 'long-running',
   'https://www.hermes.com/us/en/', 0.50, false, 'migration:00461'),
  ('herms', 'Noir', ARRAY['noir','black']::text[], '#000000', 'long-running',
   'https://www.hermes.com/us/en/', 0.70, false, 'migration:00461'),
  ('bottegaveneta', 'Parakeet', ARRAY['parakeet','parakeet green']::text[], '#7FBF3F', 'c.2019-present',
   'https://www.bottegaveneta.com/en-us', 0.55, false, 'migration:00461'),
  ('bottegaveneta', 'Fondant', ARRAY['fondant']::text[], '#6B4E3D', 'c.2019-present',
   'https://www.bottegaveneta.com/en-us', 0.50, false, 'migration:00461')
on conflict (brand_key, color_name) do update set
  aliases = excluded.aliases, hex = excluded.hex, years = excluded.years,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_size_charts (INCHES, BODY measurements) ───────────────────────────
-- THE CROSS-MAP IS WRITTEN INTO THE SIZE LABEL, not just the note (US-1731/1740).
-- Every house here sizes women's RTW in a European system its tag never names, and
-- the group splits FRENCH vs ITALIAN — so "42" is a US 10 on a Dior and a US 6 on
-- a Fendi. The label is the only place a translation reliably reaches the model.
--
-- MENSWEAR IS UNAFFECTED and every men's note says so: French and Italian
-- tailoring both run the same EU numbers (drop 10). The collision is WOMEN'S-ONLY,
-- and saying that explicitly is the point — a reader who over-generalizes starts
-- "correcting" menswear sizes that were already right.
--
-- Mirrored 1:1 into the sizing-charts.ts in-code fallback.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by)
values
  -- ── FRENCH houses: US = FR - 32 ──
  ('herms', 'Hermès', ARRAY['hermès','hermes']::text[], 'Women', 'RTW (FRENCH-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"34 (= FR 34 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"36 (= FR 36 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"38 (= FR 38 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"40 (= FR 40 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"42 (= FR 42 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"44 (= FR 44 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON AN HERMÈS IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO. SUBTRACT 32 to reach the US number (FR 38 - 32 = US 6). ALWAYS state both. ⚠ AND MIND THE OTHER HALF OF THIS PACK: the same number means something DIFFERENT on the Italian houses beside it — a "42" is a US 10 here and a US 6 on a Fendi/Versace/Bottega Veneta. A seller who learns one rule and applies it to the whole luxury tier is wrong half the time. BODY measurement — NOT flat-garment. Standard FR-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.hermes.com/us/en/', 0.55, false, 'migration:00461'),
  ('herms', 'Hermès', ARRAY['hermès','hermes']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= FR 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= FR 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= FR 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= FR 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= FR 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= FR 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on an Hermès men''s piece is a EUROPEAN size and the garment does not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK: French and Italian tailoring run the SAME numbers, so unlike the women''s charts there is no FR-vs-IT collision here — a men''s 50 is a US 40 on every brand in this group. Do NOT apply the women''s FR/IT distinction to menswear. BODY measurement — NOT flat-garment; the cut is TRIM. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.hermes.com/us/en/', 0.55, false, 'migration:00461'),

  ('dior', 'Dior', ARRAY['dior']::text[], 'Women', 'RTW (FRENCH-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"34 (= FR 34 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"36 (= FR 36 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"38 (= FR 38 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"40 (= FR 40 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"42 (= FR 42 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"44 (= FR 44 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A DIOR IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO — and this is the chart that names the pack''s headline collision. A DIOR TAGGED "42" IS A US 10. A FENDI TAGGED "42" IS A US 6. Same two digits, two sizes apart, on two dark designer dresses that photograph identically — and the seller who correctly learned "42 = US 6" from an Italian house is wrong here BECAUSE they learned the rule. SUBTRACT 32 for French (FR 42 - 32 = US 10); it is 36 for the Italian houses. ALWAYS state both the tag number and the US equivalent. BODY measurement — NOT flat-garment. Standard FR-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.55, false, 'migration:00461'),
  ('dior', 'Dior', ARRAY['dior']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= EU 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= EU 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= EU 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= EU 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= EU 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= EU 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on a Dior men''s piece is a EUROPEAN size and the garment does not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK: French and Italian tailoring run the SAME numbers, so the women''s FR-vs-IT collision does NOT apply here — do not "correct" a men''s size for it. BODY measurement — NOT flat-garment; Dior Homme in particular is cut EXTREMELY SLIM (the Slimane lineage), so it wears well below its nominal size — the most common Dior menswear fit complaint. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.dior.com/en_us/fashion/la-maison-dior', 0.55, false, 'migration:00461'),

  ('saintlaurent', 'Saint Laurent', ARRAY['saint laurent','yves saint laurent']::text[], 'Women', 'RTW (FRENCH-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"34 (= FR 34 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"36 (= FR 36 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"38 (= FR 38 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"40 (= FR 40 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"42 (= FR 42 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"44 (= FR 44 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A SAINT LAURENT IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO — and the MADE IN ITALY tag does NOT change that. This is the brand where the trap bites hardest: Saint Laurent is a FRENCH house that manufactures in ITALY, so the origin tag actively points at the wrong size system. The manufacturing country never sets the sizing. SUBTRACT 32 (FR 38 - 32 = US 6); an Italian HOUSE would be 36, but this is not one. ALWAYS state both. BODY measurement — NOT flat-garment; the cut is famously SLIM (the Slimane lineage), so it wears below its nominal size. Standard FR-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.ysl.com/en-us', 0.55, false, 'migration:00461'),
  ('saintlaurent', 'Saint Laurent', ARRAY['saint laurent','yves saint laurent']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= EU 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= EU 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= EU 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= EU 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= EU 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= EU 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on a Saint Laurent men''s piece is a EUROPEAN size and the garment does not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK — French and Italian tailoring run the SAME numbers, so the women''s FR-vs-IT collision does not apply. BODY measurement — NOT flat-garment; the Slimane-lineage cut is EXTREMELY SLIM and wears well below its nominal size, which is this brand''s most common menswear fit complaint. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.ysl.com/en-us', 0.55, false, 'migration:00461'),

  ('balenciaga', 'Balenciaga', ARRAY['balenciaga']::text[], 'Women', 'RTW (FRENCH-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"34 (= FR 34 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"36 (= FR 36 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"38 (= FR 38 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"40 (= FR 40 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"42 (= FR 42 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"44 (= FR 44 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A BALENCIAGA IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO — and as with Saint Laurent, the MADE IN ITALY tag does not change it: a French house that manufactures in Italy still sizes French. SUBTRACT 32 (FR 40 - 32 = US 8). ALWAYS state both. ⚠ THIS BRAND RUNS TWO SIZE SYSTEMS: the RTW is French, but the SNEAKERS (Triple S, Speed Trainer) are EU shoe sizes — read the OBJECT before the number, since this chart does not apply to footwear. Demna-era RTW is also deliberately OVERSIZED, so its flat measurements run far above the body chart. BODY measurement — NOT flat-garment. Standard FR-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.balenciaga.com/en-us', 0.55, false, 'migration:00461'),
  ('balenciaga', 'Balenciaga', ARRAY['balenciaga']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= EU 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= EU 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= EU 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= EU 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= EU 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= EU 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on a Balenciaga men''s piece is a EUROPEAN size and the garment does not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK — French and Italian tailoring run the SAME numbers, so the women''s FR-vs-IT collision does not apply. ⚠ This chart does NOT cover the brand''s sneakers, which are EU shoe-sized. Demna-era pieces are deliberately OVERSIZED — their flat measurements run far above this body chart, and that is the design, not a mis-tag. BODY measurement — NOT flat-garment. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.balenciaga.com/en-us', 0.55, false, 'migration:00461'),

  ('celine', 'Celine', ARRAY['celine','céline']::text[], 'Women', 'RTW (FRENCH-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"34 (= FR 34 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"36 (= FR 36 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"38 (= FR 38 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"40 (= FR 40 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"42 (= FR 42 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"44 (= FR 44 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A CELINE IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO — and the Made in Italy tag does not change it (French house, Italian manufacture). SUBTRACT 32 (FR 38 - 32 = US 6); the Italian houses in this same pack subtract 36, which is the collision this group exists to prevent. ALWAYS state both. ⚠ ALSO READ THE ACCENT while you are at the label: CÉLINE (accented) is the Phoebe Philo era and comps ABOVE modern CELINE — the size and the era are on the same tag, so read both in one pass. BODY measurement — NOT flat-garment. Standard FR-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.celine.com/en-us/', 0.55, false, 'migration:00461'),
  ('celine', 'Celine', ARRAY['celine','céline']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= EU 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= EU 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= EU 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= EU 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= EU 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= EU 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on a Celine men''s piece is a EUROPEAN size and the garment does not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK — French and Italian tailoring run the SAME numbers, so the women''s FR-vs-IT collision does not apply. BODY measurement — NOT flat-garment; the Slimane-era menswear is cut EXTREMELY SLIM and wears below its nominal size. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.celine.com/en-us/', 0.55, false, 'migration:00461'),

  -- ── ITALIAN houses: US = IT - 36 ──
  ('bottegaveneta', 'Bottega Veneta', ARRAY['bottega veneta']::text[], 'Women', 'RTW (ITALIAN-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"38 (= IT 38 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"40 (= IT 40 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"42 (= IT 42 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"44 (= IT 44 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"46 (= IT 46 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"48 (= IT 48 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A BOTTEGA VENETA IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO. SUBTRACT 36 to reach the US number (IT 42 - 36 = US 6). ALWAYS state both. ⚠ AND MIND THE OTHER HALF OF THIS PACK: the FRENCH houses beside it (Hermès, Dior, Saint Laurent, Balenciaga, Celine) subtract 32, so a "42" is a US 6 HERE and a US 10 THERE. Same two digits, two sizes apart. Do not carry one rule across the luxury tier — read the HOUSE first, then the number. BODY measurement — NOT flat-garment; the cut is TRIM. Standard IT-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.bottegaveneta.com/en-us', 0.55, false, 'migration:00461'),
  ('bottegaveneta', 'Bottega Veneta', ARRAY['bottega veneta']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= IT 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= IT 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= IT 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= IT 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= IT 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= IT 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on a Bottega Veneta men''s piece is an ITALIAN size and the garment does not say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK: Italian and French tailoring run the SAME numbers, so unlike the women''s charts there is no IT-vs-FR collision here — a men''s 50 is a US 40 on every brand in this group. Do NOT apply the women''s distinction to menswear. BODY measurement — NOT flat-garment; Italian tailoring is cut TRIM. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.bottegaveneta.com/en-us', 0.55, false, 'migration:00461'),

  ('fendi', 'Fendi', ARRAY['fendi']::text[], 'Women', 'RTW (ITALIAN-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"38 (= IT 38 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"40 (= IT 40 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"42 (= IT 42 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"44 (= IT 44 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"46 (= IT 46 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"48 (= IT 48 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A FENDI IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO — and this is the other half of the pack''s headline collision. A FENDI TAGGED "42" IS A US 6. A DIOR TAGGED "42" IS A US 10. Same two digits, two sizes apart, and the seller who learns the rule from one house and carries it to the other is wrong BECAUSE they learned it. SUBTRACT 36 for Italian (IT 42 - 36 = US 6); it is 32 for the French houses. ALWAYS state both. BODY measurement — NOT flat-garment; the cut is TRIM. Standard IT-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.fendi.com/us', 0.55, false, 'migration:00461'),
  ('fendi', 'Fendi', ARRAY['fendi']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= IT 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= IT 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= IT 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= IT 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= IT 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= IT 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on a Fendi men''s piece is an ITALIAN size and the garment does not say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK — Italian and French tailoring run the SAME numbers, so the women''s IT-vs-FR collision does not apply here. BODY measurement — NOT flat-garment; Italian tailoring is cut TRIM. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.fendi.com/us', 0.55, false, 'migration:00461'),

  ('versace', 'Versace', ARRAY['versace']::text[], 'Women', 'RTW (ITALIAN-SIZED)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','outerwear','pant']::text[],
   $json$[{"size":"38 (= IT 38 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"40 (= IT 40 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"42 (= IT 42 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"44 (= IT 44 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"46 (= IT 46 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"48 (= IT 48 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A VERSACE IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO. SUBTRACT 36 to reach the US number (IT 42 - 36 = US 6). ⚠ MIND THE OTHER HALF OF THIS PACK: the FRENCH houses beside it (Hermès, Dior, Saint Laurent, Balenciaga, Celine) subtract 32, so a "42" is a US 6 here and a US 10 there. ALWAYS state both. ⚠ AND READ THE FULL LABEL WHILE YOU ARE THERE: this chart covers mainline Versace AND the Versus/Collection/Jeans Couture diffusion labels — they share the Italian size system but sell an ORDER OF MAGNITUDE apart, so the size does NOT tell you the ladder. Versace RTW also runs SMALL/tight by design (body-conscious cut), which compounds the number misread. BODY measurement — NOT flat-garment. Standard IT-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.versace.com/us/en/', 0.55, false, 'migration:00461'),
  ('versace', 'Versace', ARRAY['versace']::text[], 'Men', 'RTW (EU-SIZED)',
   ARRAY['jacket','coat','shirt','blazer','knit','top','outerwear','pant','suit']::text[],
   $json$[{"size":"46 (= IT 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= IT 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= IT 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= IT 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= IT 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= IT 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on a Versace men''s piece is an ITALIAN size and the garment does not say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). ✅ MENSWEAR IS THE EASY HALF OF THIS PACK — Italian and French tailoring run the SAME numbers, so the women''s IT-vs-FR collision does not apply. ⚠ This chart serves mainline Versace AND the Versus/Collection/Jeans Couture diffusion labels: same size system, ORDER-OF-MAGNITUDE different price, so read the LINE off the tag separately — the size never tells you the ladder. The cut is body-conscious and runs SMALL. BODY measurement — NOT flat-garment. Standard EU-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.versace.com/us/en/', 0.55, false, 'migration:00461')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00461') on conflict do nothing;
