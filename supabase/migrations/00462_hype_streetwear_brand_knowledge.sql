-- US-1983: New-generation streetwear & hype brand knowledge group (9 brands).
--
-- Off-White, Chrome Hearts, Aimé Leon Dore, Gallery Dept., Denim Tears, Rhude,
-- Sp5der, Hellstar, Anti Social Social Club — the current-generation hype tier.
-- 00456 took the established streetwear canon (Supreme/Stüssy/BAPE/Palace/Kith/
-- Fear of God); this is the generation after it. ALL NINE ARE PASSTHROUGH-ONLY
-- today: no brand_knowledge row, no alias, no chart — so a "sp5der" tag renders
-- the seller's own casing into the prompt block and the eBay Brand aspect on some
-- of the fastest-moving garments in resale.
--
-- ── THE GRAPHIC IS THE GARMENT AND THE DROP IS THE PRICE ────────────────────
-- The through-line, and what makes this tier different in KIND from every group
-- the KB has seeded. A Birkin has a leather grade, a construction and a
-- silhouette to read (00461). A Moncler has a down fill (00460). MOST OF THIS
-- TIER IS A BLANK HOODIE WITH A PRINT ON IT. Strip the graphic and a Hellstar, a
-- Sp5der and a bootleg of either are the same cotton hoodie.
--
-- So the price lives almost entirely in WHICH DROP a piece is from — the season
-- and the collaboration — and that is frequently NOT ON THE TAG at all. Two
-- Sp5der hoodies photograph identically and comp multiples apart because one is
-- an early drop. This has a hard consequence the pack states everywhere: THE
-- MODEL MUST NOT GUESS THE DROP. A drop attribution is a claim about scarcity,
-- and inventing one prices a common piece as a rare one. Where the drop is not
-- legible, say it is unconfirmed and route it to human review.
--
-- ── AUTHENTICATION TELLS ARE INFORMATIONAL — NEVER AUTO-AUTHENTICATE ────────
-- This tier is bootlegged harder than any other in the KB, and for a structural
-- reason worth naming: WHEN THE GRAPHIC IS THE WHOLE PRODUCT, THE BOOTLEG
-- REPRODUCES THE WHOLE PRODUCT. There is no hand-saddle-stitch to fall short of
-- and no leather grade to get wrong — a good Sp5der/Hellstar/ASSC bootleg is the
-- same blank with the same print, and it is not separable in a photo. None of
-- these brands authenticates for third parties, and several (Sp5der, Hellstar,
-- Gallery Dept.) publish nothing at all. Every tell here is a description /
-- consistency aid that routes to human review. The pack must never emit an
-- authentic/fake verdict. The "never auto-authenticate" tell is ordered FIRST on
-- all nine so it survives buildTrustedBrandFactsBlock's first-four/900-char cap.
--
-- ── ONE DECODER — OFF-WHITE, AND ONLY IT QUALIFIES ──────────────────────────
-- The bar (US-1736/US-1740): tag-printed AND regular AND brand-unique in FORMAT.
-- Off-White prints a season/style code on the interior care label (OMAA038R21FAB001)
-- whose OM/OW prefix is a gendered brand marker and whose overall shape is a
-- 16-character compound — distinctive in the way the LV SD1160 precedent (00399)
-- and the Dior hyphenated triplet (00461) are. It recovers the BRAND, the GENDER
-- and the SEASON off a cut brand tab. It is NOT an authenticity check: a bootleg
-- copies the care label too, and the seeded description says so.
--
-- Everything else in the group FAILS a leg and is deliberately decoder-less:
--   * CHROME HEARTS, GALLERY DEPT., DENIM TEARS, RHUDE, SP5DER, HELLSTAR and
--     ASSC print NO regular garment-side code whatsoever. There is nothing to
--     decode; a pattern would be invented, not read.
--   * AIMÉ LEON DORE prints an internal SKU that is neither regular across
--     categories nor brand-unique in shape.
-- Those facts live in tag_eras/authentication_tells, which is where they belong.
--
-- ── NO brand_colorways FOR THIS GROUP, DELIBERATELY ─────────────────────────
-- AC3 seeds colorways "where the brand uses proprietary named colors" — a
-- conditional, and in this tier it is simply not met. These brands ship ORDINARY
-- COLOUR WORDS (black, pink, brown) that rotate per drop and form no stable
-- dictionary the way Hermès's Etoupe/Rouge H do (00461). What this tier names is
-- the DROP, not the colour, and a drop name is a scarcity claim — it belongs in
-- the never-guess-the-drop rule above, NOT in a colour table that would license
-- the model to mint it. Inventing a dictionary here would be worse than the gap.
--
-- Data-only, idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
-- NOTE ON brand_key: it is brandKey(canonical_brand) = lowercase, [^a-z0-9]
-- STRIPPED — accents included. So canonical "Aimé Leon Dore" keys as
-- 'aimleondore', NOT 'aimeleondore' (the 00389 Stüssy/'stssy' and 00461
-- Hermès/'herms' precedent). It looks like a typo and is not; the resolver
-- computes the same key at read time, so a row seeded under 'aimeleondore' would
-- never be found. Both spellings are aliased.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  ('offwhite', 'Off-White', ARRAY['off white','off-white','offwhite','off-white c/o virgil abloh','off white c/o virgil abloh','owca']::text[],
   ARRAY['streetwear','luxury','hype','rtw','sneakers','mens','womens']::text[],
   $j$[{"era":"Pyrex Vision","years":"2012-2013","description":"Virgil Abloh's first label, which printed on deadstock Champion/Rugby blanks. It is a SEPARATE brand from Off-White, not an early Off-White tag — a PYREX tag is not an Off-White piece and must not be titled as one, though it is collectible in its own right."},{"era":"Abloh-era Off-White","years":"2013-2021","description":"Off-White c/o Virgil Abloh, founded in Milan 2013. Abloh died in November 2021, which closes this era by definition — and it IS a price ladder: Abloh-era pieces comp above later mainline. An era read from the tag generation and the season code, never a verdict."},{"era":"Post-Abloh Off-White","years":"2022-present","description":"The house continued under new creative direction after Abloh's death (Ib Kamara from 2022). The mark still reads OFF-WHITE. Read the SEASON CODE on the care label rather than the logo to place a piece either side of 2021 — the logo did not change."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy / Made in Portugal / Made in China","note":"Off-White is a MILAN-based house and manufactures across Italy, Portugal and China depending on the object. NONE of the three is a fake tell — a Made in China Off-White is ordinary, and calling it a counterfeit signal is a common false call. Origin is not an authentication signal on this brand."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate — the care-label code is a DATE, not a certificate","detail":"Off-White is among the most counterfeited labels in modern streetwear and the house does not authenticate for third parties. The season/style code is a manufacturer-side mark that bootlegs reproduce along with everything else. Describe what is present, flag inconsistencies in condition_notes, and route authenticity to human review. Never emit an authentic/fake verdict."},{"tell":"THE ZIP TIE IS FACTORY-FITTED — IT IS NOT A SECURITY TAG AND CUTTING IT OFF COSTS MONEY","detail":"THE Off-White condition fact and the most valuable thing in this row. The industrial zip tie (usually red, sometimes other colours) is attached AT THE FACTORY as part of the design — it is not a retail security tag and not a returns tag. Buyers treat an intact, uncut tie as part of a complete piece and it is a real price input; sellers cut it off believing it is packaging, and that is not reversible. State plainly whether the tie is PRESENT and UNCUT. Its absence is not damage and not a fake tell — it is a completeness fact, exactly like a Birkin's clochette."},{"tell":"THE SEASON CODE ON THE CARE LABEL IS THE LADDER — read it, do not read the logo","detail":"Abloh-era pieces (2013-2021) comp above post-2021 mainline, and THE LOGO DID NOT CHANGE when he died — so the diagonals and the Arrows cannot date a piece. The care-label code can: OM/OW + category + style + a season token. This is the only brand in this group with a code worth reading at all."},{"tell":"THE QUOTATION MARKS AND DIAGONALS ARE THE HOUSE MARK — they authenticate NOTHING","detail":"The quoted words (\"SCULPTURE\", \"AIR\"), the diagonal stripes and the Arrows logo are the fastest Off-White reads in a photo and they are the single most imitated set of marks in streetwear. They identify the HOUSE and never the drop, the era or the authenticity. Describe them; conclude nothing from them."},{"tell":"NIKE COLLABS ARE A SEPARATE MARKET — 'The Ten' is not Off-White RTW","detail":"CROSS-BRAND: Abloh's Nike work (The Ten, 2017, and everything after) comps as a hype SNEAKER on the sneaker ladder, with its own drop-level pricing — not off the Off-White clothing ladder. A dual-branded Nike x Off-White shoe is a collab, and BOTH brands belong in the title. Do not price one off the other."}]$j$::jsonb,
   'Off-White identity = the diagonals/quote-marks/Arrows + THE ZIP TIE (factory-fitted, and a completeness fact, not packaging), with the ABLOH ERA (2013-2021) as the price ladder. Founded in Milan in 2013 by Virgil Abloh, out of his earlier Pyrex Vision (2012-2013, a SEPARATE brand). Abloh died in November 2021; the house continued under Ib Kamara from 2022 AND THE LOGO DID NOT CHANGE — so only the care-label season code places a piece either side of that line, which is exactly why this brand gets the group''s only decoder. Nike collabs comp as sneakers on their own ladder. Now majority-owned by LVMH. RN omitted — not sourceable. NOTE the canonical is "Off-White" but it is deliberately EXCLUDED from free-text brand detection (DETECT_EXCLUDED_FROM_TEXT, brand-normalize.ts): "off-white" is an ordinary COLOUR word and would otherwise brand every off-white garment as this label.',
   'https://www.off---white.com/', 0.60, false, 'migration:00462'),

  ('chromehearts', 'Chrome Hearts', ARRAY['chrome hearts','chromehearts','chrome hearts hollywood','ch']::text[],
   ARRAY['streetwear','luxury','hype','jewelry','accessories','mens','womens']::text[],
   $j$[{"era":"Silver-first era","years":"1988-1990s","description":"Founded 1988 in Los Angeles by Richard Stark as a SILVER and leather workshop making pieces for motorcycle riders and rock musicians — the clothing came later. The house is a silversmith first, which is the fact that explains its prices."},{"era":"Apparel + eyewear expansion","years":"2000s-present","description":"The label expanded into cut-and-sew apparel, eyewear and furniture. A hoodie/tee from this era is what a normal resale flow encounters; the sterling jewellery remains the house's core and its own market entirely."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA","note":"Chrome Hearts manufactures in Los Angeles and Made in USA is EXPECTED on the hardware and much of the apparel — unusually for this KB, its absence is worth a second look rather than its presence. Still not an authentication verdict on its own: origin text is trivially reproduced."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"Chrome Hearts is heavily counterfeited, publishes no authentication standard, prints no regular garment-side code, and does not authenticate for third parties. There is nothing here we could act on programmatically. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE HARDWARE IS STERLING SILVER — IT IS A MATERIAL FACT AND IT IS THE PRICE","detail":"THE Chrome Hearts fact and the reason the brand costs what it does: the crosses, daggers, buttons and zip pulls are real .925 STERLING SILVER, not plated base metal. That is why a hoodie with silver hardware sits an order of magnitude above a printed one, and it is why weight is a genuine attribute. Silver TARNISHES — a dark or blackened patina on the hardware is NORMAL AGEING AND IS NOT DAMAGE, and it is not a fake tell either; it polishes out. Do not grade tarnish as a defect. Say which pieces of hardware are present, because they are separate components and they go missing."},{"tell":"THE MOTIFS ARE THE HOUSE MARK — cross, dagger, fleur-de-lis, scroll","detail":"The Gothic cross, the dagger, the fleur-de-lis and the floral scroll lettering are the fastest Chrome Hearts reads in a photo, and they are imitated relentlessly. They identify the house and never the authenticity. Describe them; conclude nothing."},{"tell":"THERE IS NO STYLE CODE AND NO SEASON CODE","detail":"The brand prints no regular garment-side identifier, which is why it gets NO DECODER. There is nothing to look up and nothing to decode — a listing that claims a Chrome Hearts serial is describing something the brand does not ship."}]$j$::jsonb,
   'Chrome Hearts identity = STERLING SILVER hardware (.925, genuinely solid — the material IS the price) + the Gothic cross/dagger/fleur-de-lis motifs. Founded 1988 in Los Angeles by Richard Stark as a silver and leather workshop for motorcycle riders and musicians; the apparel came second, which is why the jewellery is the house''s core and its own market. Made in USA. Famously distribution-controlled (no e-commerce, no wholesale), which is a large part of why it is bootlegged so heavily. Tarnish on the silver is NORMAL AGEING, not a defect and not a fake tell. NO DECODER — the brand prints no regular garment-side code at all. RN omitted — not sourceable.',
   'https://www.chromehearts.com/', 0.58, false, 'migration:00462'),

  -- AIMÉ LEON DORE keys as 'aimleondore' — brandKey() strips the é. See the
  -- brand_key note in this block's header (the Hermès/'herms' precedent, 00461).
  ('aimleondore', 'Aimé Leon Dore', ARRAY['aime leon dore','aimé leon dore','aimeleondore','ald','aime leon dore new york']::text[],
   ARRAY['streetwear','hype','rtw','sneakers','mens','womens']::text[],
   $j$[{"era":"Aimé Leon Dore","years":"2014-present","description":"Founded 2014 in New York by Teddy Santis. A single-era brand — there is no rebrand, no name change and no era ladder to read off the tag, which makes it the odd one out in this pack. Place a piece by its DROP/season, not by its label generation."},{"era":"New Balance partnership","years":"2019-present","description":"The ALD x New Balance collaborations (the 550 above all, whose 2020 ALD revival is credited with returning the model to production) are a hype SNEAKER market with its own comps. Teddy Santis was additionally named creative director of New Balance's Made in USA line in 2021 — which is ORDINARY provenance and does NOT fold the brands together."}]$j$::jsonb,
   $j$[{"pattern":"Made in Portugal / Made in Canada / Made in USA","note":"ALD manufactures across Portugal, Canada and the USA depending on the garment. None is a fake tell and all are normal — origin is not an authentication signal here."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"ALD publishes no authentication standard we can act on and does not authenticate for third parties. Its internal SKU is neither regular across categories nor brand-unique in shape, which is why it gets no decoder. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THIS IS THE PREPPY-HERITAGE END OF THE TIER, NOT A GRAPHIC BRAND","detail":"The most useful ALD description fact: unlike the rest of this pack, ALD is not built on a shock graphic. It is collegiate/heritage — knit polos, cable knits, tailored sweats, subtle embroidered crests and a Queens/New York vocabulary. So the CONSTRUCTION and the FABRIC actually matter here in a way they do not on a printed hoodie, and they are worth describing properly."},{"tell":"NEW BALANCE COLLABS ARE A SEPARATE MARKET","detail":"CROSS-BRAND: ALD x New Balance (the 550 especially) comps as a hype sneaker on the sneaker ladder, not off the ALD clothing ladder. A dual-branded pair is a collab and BOTH brands belong in the title. Teddy Santis also directs New Balance's Made in USA line — that is provenance, not a reason to fold the brands: they are separately branded, separately searched and sit in different bands."},{"tell":"ALD IS THE COMMON ABBREVIATION and it is safe on a tag, not in prose","detail":"Sellers write ALD constantly. It is aliased as an exact tag value, but three letters are far too short to mint a brand out of free text — the resolver must not read ALD out of surrounding prose."}]$j$::jsonb,
   'Aimé Leon Dore identity = COLLEGIATE/HERITAGE preppy (knit polos, cable knits, embroidered crests, a Queens/NY vocabulary) — the one brand in this pack where construction and fabric matter more than a graphic. Founded 2014 in New York by Teddy Santis. SINGLE-ERA: no rebrand, no name change, so there is no tag ladder to read — a piece is placed by its DROP, not its label generation. The New Balance partnership (the 550) is a separate sneaker market; Santis directing NB''s Made in USA line from 2021 is provenance and NOT a fold. NOTE the brand_key is ''aimleondore'': brandKey() strips the accent (the Hermès/''herms'' precedent). NO DECODER — the internal SKU is neither regular nor brand-unique. RN omitted — not sourceable.',
   'https://www.aimeleondore.com/', 0.55, false, 'migration:00462'),

  ('gallerydept', 'Gallery Dept.', ARRAY['gallery dept','gallery dept.','gallerydept','gallery department','gd']::text[],
   ARRAY['streetwear','hype','rtw','denim','mens','womens']::text[],
   $j$[{"era":"Gallery Dept.","years":"2017-present","description":"Founded 2017 in Los Angeles by Josué Thomas. A single-era brand with no rebrand — place a piece by its drop, not its label generation."},{"era":"Upcycled vintage base garments","years":"2017-present","description":"A substantial part of the line is built on RECLAIMED VINTAGE garments (often Levi's or Carhartt denim) that are then hand-painted, cut and repaired. The base garment's ORIGINAL tag — including its original brand and size — frequently survives inside the finished piece. That is normal construction, not a mislabel and not a fake tell."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA","note":"Gallery Dept. finishes its pieces in Los Angeles by hand. On an upcycled piece the origin text may be the BASE garment's, not the brand's — so origin is doubly unreliable here and is not an authentication signal."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"Gallery Dept. publishes no authentication standard, prints no regular garment-side code, and does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE DISTRESSING IS THE PRODUCT — DO NOT GRADE IT AS DAMAGE","detail":"THE Gallery Dept. fact and the single most consequential grading rule in this whole pack. Every piece is HAND-FINISHED: the paint splatter, the frayed hems, the bleach marks, the deliberate holes, the visible repairs and the uneven fades are the DESIGN, applied on purpose and individually. A grader who reads them as wear will mark a mint piece down to Poor — inverting the price of a garment that is worth more precisely because it looks destroyed. Grade against the brand's INTENT: genuine defects here are things the maker did not do (stains from use, odour, unintended tears, missing hardware). If it is not clear which is which, say so and route to human review rather than deducting."},{"tell":"NO TWO PIECES ARE IDENTICAL — so a photo cannot be matched to a stock image","detail":"Because the finishing is done by hand per garment, the paint placement genuinely differs piece to piece. Do not treat a mismatch against a reference/stock photo as a fake tell — variation IS the product. Describe THIS garment's actual paint and repair placement; it is the listing's most useful content."},{"tell":"THE SIZE TAG MAY BELONG TO A DIFFERENT GARMENT","detail":"On an upcycled piece the surviving interior tag is the BASE garment's — so it can read another brand's name and another brand's size system. Report the measured size and say the tag is the donor garment's rather than trusting it. This is the practical half of the upcycling fact."},{"tell":"THE LOGO IS A STENCILLED WORDMARK — and it authenticates nothing","detail":"The hand-stencilled GALLERY DEPT. wordmark and the crossed-out logo treatments are the fastest read in a photo and are imitated constantly. They identify the house, never the drop or the authenticity."}]$j$::jsonb,
   'Gallery Dept. identity = HAND-FINISHED DISTRESSING — paint splatter, frayed hems, deliberate holes, visible repairs — which is THE PRODUCT AND NOT DAMAGE, and is the most important grading rule in this pack. Founded 2017 in Los Angeles by Josué Thomas. Much of the line is UPCYCLED from reclaimed vintage denim (often Levi''s/Carhartt), so the base garment''s original brand+size tag frequently survives inside the finished piece and must not be trusted as the size. No two pieces are identical by construction, so a mismatch against a stock photo is not a fake tell. NO DECODER — the brand prints no regular garment-side code. RN omitted — not sourceable.',
   'https://www.gallerydept.com/', 0.55, false, 'migration:00462'),

  ('denimtears', 'Denim Tears', ARRAY['denim tears','denimtears','denim tears the cotton wreath']::text[],
   ARRAY['streetwear','hype','rtw','denim','mens','womens']::text[],
   $j$[{"era":"Denim Tears","years":"2019-present","description":"Founded 2019 by Tremaine Emory. A single-era brand — place a piece by its drop and its collaborator, not by a label generation."},{"era":"Levi's collaboration base","years":"2020-present","description":"The signature Cotton Wreath pieces are printed ON ACTUAL LEVI'S GARMENTS — 501 jeans and trucker jackets — as an ongoing collaboration. So a genuine Denim Tears piece legitimately carries LEVI'S tags, Levi's waist sizing and a Levi's care label INSIDE it. That is the product, not a mislabel."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA / varies by base garment","note":"Origin follows whichever base garment a piece is printed on (frequently a Levi's), so it is not a brand signal at all here and is certainly not an authentication one."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"Denim Tears publishes no authentication standard, prints no regular garment-side code of its own, and does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"IT IS A LEVI'S UNDERNEATH — AND IT IS STILL A DENIM TEARS","detail":"THE Denim Tears trap, and it is a dual-branding one rather than a counterfeit one. The Cotton Wreath 501s and trucker jackets ARE Levi's garments, printed as an official collaboration — so the interior tags read LEVI'S, the size is a LEVI'S WAIST NUMBER, and the care label is Levi's. A resolver that reads the tag and concludes 'this is a Levi's 501' has thrown away an order of magnitude of value; one that ignores the tag loses the size system. BOTH brands are true: title it as the collaboration it is, and read the size off the Levi's waist number."},{"tell":"THE COTTON WREATH IS THE BRAND — and it is a work about American history","detail":"The cotton-flower wreath print is the house's entire signature and it is not decoration: Tremaine Emory made it as a statement about cotton, slavery and Black American history. Describe it accurately and by name. It is imitated relentlessly and identifies the house only — never the drop and never the authenticity."},{"tell":"THE COLLABORATOR IS THE LADDER — read it, do not guess it","detail":"Denim Tears works through collaborations (Levi's, Converse, Stüssy, Champion and others), and which collaborator a piece is from is most of its price. That is frequently legible from the co-branded tags. Where it is not, say the drop is unconfirmed rather than assuming the common one."}]$j$::jsonb,
   'Denim Tears identity = THE COTTON WREATH print — a work by Tremaine Emory about cotton, slavery and Black American history — applied to COLLABORATOR base garments. Founded 2019. THE DEFINING FACT: the signature pieces are printed on ACTUAL LEVI''S 501s and trucker jackets under an official collaboration, so a genuine Denim Tears carries LEVI''S tags and a LEVI''S WAIST SIZE inside it. Both brands are true at once — title the collaboration, and read the size off the Levi''s number rather than the alpha system the rest of this pack uses. The COLLABORATOR (Levi''s/Converse/Stüssy/Champion) is the price ladder. NO DECODER — the brand prints no regular code of its own. RN omitted — not sourceable.',
   'https://www.denimtears.com/', 0.55, false, 'migration:00462'),

  ('rhude', 'Rhude', ARRAY['rhude','rhude los angeles','rhuigi']::text[],
   ARRAY['streetwear','luxury','hype','rtw','mens','womens']::text[],
   $j$[{"era":"Rhude","years":"2015-present","description":"Founded 2015 in Los Angeles by Rhuigi Villaseñor. A single-era brand with no rebrand — place a piece by its drop, not its label generation."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA / Made in Italy / Made in Portugal","note":"Rhude sits at the luxury end of this tier and manufactures across the USA, Italy and Portugal. None is a fake tell; origin is not an authentication signal here."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"Rhude publishes no authentication standard, prints no regular garment-side code, and does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THIS IS THE LUXURY END OF THE TIER — the fabric is a real price input","detail":"The most useful Rhude description fact: unlike the printed-hoodie brands beside it, Rhude is cut-and-sew luxury streetwear with genuine fabrics (silk shirting, heavyweight French terry, leather) and higher construction. So fabric and construction are worth describing properly here, as they are on ALD and unlike on Sp5der/Hellstar."},{"tell":"THE MOTIFS ARE MOTORSPORT AND AMERICANA — and they authenticate nothing","detail":"Racing/Formula 1 iconography, the cigarette and Marlboro-adjacent motifs, and the RHUDE script logo are the fastest reads in a photo. They identify the house and never the drop or the authenticity."},{"tell":"THERE IS NO STYLE CODE","detail":"The brand prints no regular garment-side identifier, which is why it gets no decoder. There is nothing to decode."}]$j$::jsonb,
   'Rhude identity = LUXURY streetwear cut-and-sew (silk shirting, heavyweight terry, leather) with MOTORSPORT/Americana motifs and the RHUDE script. Founded 2015 in Los Angeles by Rhuigi Villaseñor. Sits at the luxury end of this tier alongside ALD, so unlike the printed-hoodie brands beside it the FABRIC and CONSTRUCTION are real price inputs worth describing. Single-era — no rebrand, so there is no tag ladder; a piece is placed by its drop. NO DECODER — the brand prints no regular garment-side code. RN omitted — not sourceable.',
   'https://www.rhude.com/', 0.55, false, 'migration:00462'),

  ('sp5der', 'Sp5der', ARRAY['sp5der','spider','spider worldwide','sp5der worldwide','young thug spider','sp5der web']::text[],
   ARRAY['streetwear','hype','rtw','mens','womens']::text[],
   $j$[{"era":"Sp5der Worldwide","years":"c.2019-present","description":"The label associated with the rapper Young Thug (Jeffery Williams). A single-era brand that publishes very little about itself — there is no documented tag lineage to read, and claiming one would be inventing it."}]$j$::jsonb,
   $j$[{"pattern":"unreliable / not documented","note":"No sourceable origin pattern. The brand publishes essentially nothing about its manufacturing, so origin text carries no information here — do not read it as a signal in either direction."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate — this is the most bootlegged garment in the pack","detail":"Sp5der is bootlegged at enormous scale and the brand publishes NO authentication standard, NO serial and NO regular code, and does not authenticate for third parties. The structural problem is the group's through-line at its worst: THE GARMENT IS A BLANK HOODIE AND THE PRINT IS THE PRODUCT, so a bootleg reproduces essentially all of it and the two are not separable in a photo. There is nothing here we could act on. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE WEB/SP5DER GRAPHIC IS THE WHOLE IDENTITY — and it is copied exactly","detail":"The spiderweb print, the rhinestone-set lettering and the SP5DER wordmark (with the 5) are the entire read. Describe the graphic, the placement and whether rhinestones are PRESENT AND COMPLETE — missing rhinestones are a genuine, photographable, price-moving defect on these pieces and they do fall off. The graphic identifies the house only."},{"tell":"THE DROP IS THE PRICE AND IT IS USUALLY NOT ON THE TAG","detail":"THE Sp5der pricing fact. Early/OG drops comp multiples above recent ones, and two hoodies from different drops photograph identically. The tag typically does not say which drop it is. DO NOT GUESS: a drop attribution is a scarcity claim, and inventing one prices a common piece as a rare one. Say the drop is unconfirmed and route it to human review."},{"tell":"SPELL IT WITH THE 5 — and 'spider' alone is an ordinary word","detail":"The brand is SP5DER (also traded as Spider Worldwide). 'Spider' is aliased as an exact tag value, but it is an ordinary English word and a common graphic subject — the resolver must never mint this brand from the word 'spider' appearing in free text or in a garment's own print description."}]$j$::jsonb,
   'Sp5der (Spider Worldwide) identity = the spiderweb print + rhinestone-set SP5DER wordmark. The label associated with Young Thug, c.2019. THIS IS THE GROUP''S THROUGH-LINE AT ITS PUREST: the garment is a blank hoodie and the print IS the product, so a bootleg reproduces essentially all of it, the two are not separable in a photo, and the brand publishes NOTHING — no standard, no code, no documented tag lineage. The DROP is the entire price and it is usually not on the tag: never guess it. Rhinestone completeness is a real photographable defect. Runs SMALL. NO DECODER — nothing to decode. RN omitted — not sourceable.',
   'https://sp5der.com/', 0.50, false, 'migration:00462'),

  ('hellstar', 'Hellstar', ARRAY['hellstar','hellstar studios','hell star']::text[],
   ARRAY['streetwear','hype','rtw','mens','womens']::text[],
   $j$[{"era":"Hellstar Studios","years":"c.2021-present","description":"Founded around 2021 by Sean Holland. A recent single-era brand that publishes very little about itself — there is no documented tag lineage to read, and claiming one would be inventing it."}]$j$::jsonb,
   $j$[{"pattern":"unreliable / not documented","note":"No sourceable origin pattern. The brand publishes essentially nothing about its manufacturing, so origin text carries no information here — do not read it as a signal in either direction."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"Hellstar is bootlegged at very large scale and publishes NO authentication standard, NO serial and NO regular code, and does not authenticate for third parties. Same structural problem as Sp5der beside it: the garment is a blank hoodie and the print is the product, so a bootleg reproduces essentially all of it and the two are not separable in a photo. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE GRAPHIC IS THE WHOLE IDENTITY — flames, the star, the distressed print","detail":"The flame and star iconography, the HELLSTAR STUDIOS wordmark and heavily distressed/cracked screen prints are the entire read. IMPORTANT: the print is INTENTIONALLY distressed and cracked from new — a cracked Hellstar graphic is frequently the DESIGN rather than wear, which is the same trap Gallery Dept. carries in this pack. Do not automatically grade print cracking as a defect; describe it and route an unclear call to human review."},{"tell":"THE DROP IS THE PRICE AND IT IS USUALLY NOT ON THE TAG","detail":"Early drops comp above recent ones and two hoodies from different drops photograph identically. The tag typically does not say which drop it is. DO NOT GUESS — a drop attribution is a scarcity claim. Say it is unconfirmed and route to human review."},{"tell":"'Hellstar' and 'Hellstar Studios' are the same house","detail":"The wordmark appears both ways. The longer form is not a separate line or a diffusion label — it is the same brand, and both fold onto one canonical."}]$j$::jsonb,
   'Hellstar (Hellstar Studios) identity = flame/star iconography with heavily DISTRESSED, CRACKED screen prints — which are frequently the DESIGN FROM NEW rather than wear, the same grading trap Gallery Dept. carries in this pack. Founded c.2021 by Sean Holland. Publishes essentially nothing: no standard, no code, no documented tag lineage — and as a blank hoodie whose print is the product, a bootleg reproduces essentially all of it. The DROP is the price and it is usually not on the tag: never guess it. Runs OVERSIZED by design. NO DECODER — nothing to decode. RN omitted — not sourceable.',
   'https://hellstar.com/', 0.50, false, 'migration:00462'),

  ('antisocialsocialclub', 'Anti Social Social Club', ARRAY['anti social social club','antisocialsocialclub','assc','anti social club','a.s.s.c.']::text[],
   ARRAY['streetwear','hype','rtw','mens','womens']::text[],
   $j$[{"era":"Anti Social Social Club","years":"2015-present","description":"Founded 2015 by Neek Lurk. A single-era brand — place a piece by its drop, not its label generation."},{"era":"Hype peak vs post-peak","years":"peak c.2016-2018","description":"ASSC's resale peaked in the late 2010s and has since fallen a long way: the brand released very frequently and in volume, so scarcity — the thing that priced it — largely went away. A piece is therefore worth substantially LESS than its hype-era comps suggest, which is the opposite of the era ladders elsewhere in this KB. Price from RECENT comps, never from the brand's reputation."}]$j$::jsonb,
   $j$[{"pattern":"unreliable / not documented","note":"No sourceable origin pattern; ASSC prints on blanks from various suppliers. Origin carries no information here and is not an authentication signal."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"ASSC was among the most bootlegged brands of the 2010s and publishes no authentication standard, no serial and no regular code; it does not authenticate for third parties. The garment is a printed blank, so a bootleg reproduces essentially all of it. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE HYPE IS GONE — PRICE FROM RECENT COMPS, NOT FROM THE NAME","detail":"THE ASSC fact, and it runs OPPOSITE to every other era ladder in this KB. ASSC's resale peaked around 2016-2018 and has fallen a long way since: the brand dropped very frequently and in volume, so the scarcity that priced it evaporated. A seller (or a model) working from the brand's reputation will over-price it badly. There is no vintage premium to award here — take the recent comps at face value even when they look low for a name this famous."},{"tell":"THE LOGO IS BLOCK TEXT ON A BLANK — usually pink on white","detail":"The house mark is simply the ANTI SOCIAL SOCIAL CLUB block wordmark (most famously pink on a white hoodie) with the Japanese subtext. There is nothing else to read: no construction, no hardware, no fabric story. That is precisely why it is trivially bootlegged and why the graphic identifies the house only."},{"tell":"ASSC is the common abbreviation — safe on a tag, not in prose","detail":"Sellers write ASSC constantly and it is aliased as an exact tag value. Four letters are far too short to mint a brand out of free text — the resolver must not read ASSC out of surrounding prose."}]$j$::jsonb,
   'Anti Social Social Club identity = the block-text wordmark (famously pink on white) on a printed blank, with Japanese subtext — and NOTHING else to read: no construction, no hardware, no fabric story, which is exactly why it is trivially bootlegged. Founded 2015 by Neek Lurk. THE CAUTIONARY CASE OF THIS KB AND THE INVERSE OF EVERY OTHER ERA LADDER: resale peaked c.2016-2018 and has fallen a long way because the brand dropped so frequently and in such volume that scarcity evaporated. Price from RECENT comps, never from the name — there is no vintage premium to award. Runs SMALL. NO DECODER — nothing to decode. RN omitted — not sourceable.',
   'https://antisocialsocialclub.com/', 0.55, false, 'migration:00462')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- The confusable pairs in this group are DROP-vs-DROP and GRAPHIC-vs-GRAPHIC,
-- not silhouette-vs-silhouette: the silhouette is a hoodie on nearly all of them.
-- So each fingerprint leads with the GRAPHIC (the only thing a photo can read)
-- and then says plainly that the graphic cannot date the piece — because the
-- thing that prices it, the drop, usually is not legible at all.
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('offwhite', 'Diagonals', ARRAY['diagonal','diagonals','diag','diagonal stripes']::text[], 'Unisex', 'top', 'Off-White',
   'NOT a single garment — the house''s diagonal-stripe block, applied across hoodies, tees, jackets and bags. The stripes are the fastest Off-White read in a photo AND they are the single most imitated mark in streetwear, so they identify the HOUSE and nothing else: they cannot date a piece (the logo did not change when Abloh died in 2021) and they cannot price it. CHECK THE ZIP TIE and the care-label season code instead — those are the two things that actually carry information.',
   ARRAY['cotton jersey','French terry']::text[], '2013-present', '$400-$700', ARRAY['diagonals','stripes','off-white','abloh']::text[],
   'https://www.off---white.com/', 0.58, false, 'migration:00462'),
  ('offwhite', 'Quote Marks', ARRAY['quotes','quotation marks','quote tee','sculpture']::text[], 'Unisex', 'top', 'Off-White',
   'NOT a single garment — Abloh''s signature typographic device: an ordinary word set in "QUOTATION MARKS" ("SCULPTURE", "AIR", "SHOELACES"), printed on garments, hangtags and shoes alike. It is the most literal Off-White read there is and, like the diagonals, it identifies the house only. The QUOTED WORD ITSELF is worth transcribing verbatim into the listing — buyers search on it, and it is the closest thing to a drop identifier a photo can actually give you.',
   ARRAY['cotton jersey']::text[], '2013-present', '$300-$600', ARRAY['quotes','sculpture','typography','abloh']::text[],
   'https://www.off---white.com/', 0.55, false, 'migration:00462'),
  ('offwhite', 'Arrows Logo', ARRAY['arrows','arrow logo','crossing arrows']::text[], 'Unisex', 'top', 'Off-White',
   'NOT a single garment — the crossing-arrows mark, adapted from the Glasgow Airport signage system. Runs across hoodies, tees and knitwear. Same rule as the diagonals: a HOUSE read only. It dates nothing and prices nothing.',
   ARRAY['cotton jersey','French terry']::text[], '2010s-present', '$400-$700', ARRAY['arrows','logo','glasgow','off-white']::text[],
   'https://www.off---white.com/', 0.55, false, 'migration:00462'),
  ('offwhite', 'Industrial Belt', ARRAY['industrial belt','belt','yellow belt']::text[], 'Unisex', 'accessory', 'Off-White',
   'The oversized industrial-webbing belt printed with the OFF-WHITE wordmark, worn with a long tail hanging — the most recognizable Off-White accessory and one of its highest-volume resale items. Confirm the buckle hardware is complete and the webbing is not frayed at the tail: both are photographable and both move the price.',
   ARRAY['polyester webbing']::text[], '2016-present', '$200-$400', ARRAY['industrial belt','webbing','yellow','off-white']::text[],
   'https://www.off---white.com/', 0.55, false, 'migration:00462'),
  ('offwhite', 'Nike Collaboration', ARRAY['the ten','nike x off-white','off-white nike','virgil nike']::text[], 'Unisex', 'sneaker', 'Off-White x Nike',
   'A COLLAB LADDER, not a garment. Abloh''s Nike work — The Ten (2017) and everything after — comps as a hype SNEAKER with its own drop-level pricing, NOT off the Off-White clothing ladder. The deconstructed look is unmistakable: exposed foam, the zip tie, the quoted words on the midsole, the printed text on the medial side. BOTH brands belong in the title. Do not price one off the other, and do not guess the specific colourway if the photo does not settle it.',
   ARRAY['leather','mesh','foam']::text[], '2017-present', 'varies (hype)', ARRAY['the ten','nike','collab','sneaker','abloh']::text[],
   'https://www.off---white.com/', 0.55, false, 'migration:00462'),

  ('chromehearts', 'Cross Patch Hoodie', ARRAY['cross patch','cross hoodie','ch cross hoodie']::text[], 'Unisex', 'hoodie', 'Chrome Hearts',
   'The heavyweight hoodie carrying the Gothic CROSS as a leather or printed patch, usually with the floral-scroll lettering across the back. The house''s highest-volume apparel item in resale. CHECK FOR SILVER: a version with sterling hardware (buttons, zip pulls, tips) sits an order of magnitude above a purely printed one, so say explicitly which this is — it is the entire pricing question on the garment.',
   ARRAY['heavyweight cotton fleece','sterling silver hardware','leather patch']::text[], 'long-running core', '$800-$2,000', ARRAY['cross','hoodie','scroll','chrome hearts']::text[],
   'https://www.chromehearts.com/', 0.55, false, 'migration:00462'),
  ('chromehearts', 'Sterling Silver Jewelry', ARRAY['silver','jewelry','ring','pendant','dagger','cross ring']::text[], 'Unisex', 'accessory', 'Chrome Hearts',
   'The house''s CORE and its own market entirely — .925 STERLING SILVER rings, pendants, chains and daggers, hallmarked and genuinely solid rather than plated. This is why the brand costs what it does: the material is real, so WEIGHT is a genuine attribute and worth reporting. TARNISH IS NORMAL AGEING, NOT DAMAGE — a dark patina polishes out and must not be graded as a defect. Do not price these off the apparel ladder.',
   ARRAY['.925 sterling silver']::text[], '1988-present', 'varies (high)', ARRAY['sterling','silver','ring','dagger','925']::text[],
   'https://www.chromehearts.com/', 0.58, false, 'migration:00462'),
  ('chromehearts', 'Horseshoe Logo', ARRAY['horseshoe','ch plus','horseshoe logo']::text[], 'Unisex', 'top', 'Chrome Hearts',
   'NOT a single garment — the horseshoe/CH mark and the floral-scroll lettering, applied across tees, hoodies and hats. The fastest Chrome Hearts read in a photo and among the most imitated marks in the tier. A house read only: it dates nothing and authenticates nothing.',
   ARRAY['cotton jersey']::text[], 'long-running', '$400-$900', ARRAY['horseshoe','scroll','logo','chrome hearts']::text[],
   'https://www.chromehearts.com/', 0.55, false, 'migration:00462'),
  ('chromehearts', 'Leather Jacket', ARRAY['leather jacket','leather','moto jacket']::text[], 'Unisex', 'jacket', 'Chrome Hearts',
   'The house''s founding product line: heavy leather outerwear with sterling silver hardware — crosses, daggers, conchos and engraved snaps. The silver content and the hardware completeness are the price. Count the hardware; the pieces are separate, expensive and they go missing. Condition on the leather itself (cracking at the elbows, lining tears) is the other half.',
   ARRAY['leather','sterling silver hardware']::text[], '1988-present', 'varies (high)', ARRAY['leather','moto','conchos','silver','chrome hearts']::text[],
   'https://www.chromehearts.com/', 0.52, false, 'migration:00462'),

  ('aimleondore', 'Knit Polo', ARRAY['knit polo','polo','ald polo']::text[], 'Men', 'top', 'Aimé Leon Dore',
   'The brand''s defining garment and the clearest statement of what ALD is: a boxy, short-sleeved KNITTED polo (not a piqué jersey one) with a ribbed collar and a subtle embroidered crest. Cut deliberately BOXY and wide — that is the design, not a mis-tag. Unlike the printed hoodies elsewhere in this pack, the KNIT QUALITY and the fibre are real price inputs here and are worth describing.',
   ARRAY['cotton knit','merino wool']::text[], '2014-present', '$150-$250', ARRAY['knit polo','boxy','crest','ald']::text[],
   'https://www.aimeleondore.com/', 0.55, false, 'migration:00462'),
  ('aimleondore', 'New Balance Collaboration', ARRAY['ald new balance','ald 550','new balance 550','ald nb']::text[], 'Unisex', 'sneaker', 'Aimé Leon Dore x New Balance',
   'A COLLAB LADDER, not a garment. ALD x New Balance — the 550 above all, whose 2020 ALD revival is credited with returning the model to production — comps as a hype SNEAKER on the sneaker ladder, not off the ALD clothing ladder. BOTH brands belong in the title. Teddy Santis also directs New Balance''s Made in USA line, which is ordinary provenance and is NOT a reason to fold the brands: they are separately branded and separately searched.',
   ARRAY['leather','suede','mesh']::text[], '2019-present', 'varies (hype)', ARRAY['new balance','550','collab','sneaker','ald']::text[],
   'https://www.aimeleondore.com/', 0.55, false, 'migration:00462'),
  ('aimleondore', 'Logo Sweatshirt', ARRAY['ald sweatshirt','logo crewneck','ald hoodie','crewneck']::text[], 'Unisex', 'sweatshirt', 'Aimé Leon Dore',
   'The heavyweight crewneck or hoodie with a restrained embroidered or felt ALD/Aimé Leon Dore wordmark — collegiate rather than graphic, which is the whole difference between this brand and the rest of the pack. Heavyweight loopback terry is the norm; the WEIGHT of the fleece is a genuine attribute here. Cut boxy by design.',
   ARRAY['heavyweight French terry','loopback cotton']::text[], '2014-present', '$150-$250', ARRAY['crewneck','sweatshirt','collegiate','ald']::text[],
   'https://www.aimeleondore.com/', 0.52, false, 'migration:00462'),
  ('aimleondore', 'Cable Knit Sweater', ARRAY['cable knit','sweater','fisherman knit']::text[], 'Unisex', 'sweater', 'Aimé Leon Dore',
   'The heritage/preppy end of the line: chunky cable and fisherman knits, often in wool, cut boxy and cropped. The fibre content and the knit gauge are the price and both need stating — this is a garment with actual construction to grade, unlike a printed hoodie. Check for MOTH damage and pilling, which are the real defects on a wool knit.',
   ARRAY['wool','cotton knit']::text[], '2014-present', '$250-$400', ARRAY['cable knit','fisherman','wool','ald']::text[],
   'https://www.aimeleondore.com/', 0.50, false, 'migration:00462'),

  ('gallerydept', 'Painted Flare Jeans', ARRAY['flare jeans','painted jeans','la flares','gd flares']::text[], 'Unisex', 'bottom', 'Gallery Dept.',
   'The brand''s signature: a flared/bootcut jean, frequently UPCYCLED from vintage Levi''s, hand-painted with splatter or a stripe down the leg and hand-repaired with visible patching. THE DISTRESSING IS THE PRODUCT — the paint, the frayed hems, the holes and the visible repairs are applied on purpose and must NOT be graded as damage. No two pairs are identical, so a mismatch against a stock photo is not a fake tell. THE SIZE TAG MAY BE THE DONOR LEVI''S TAG — measure rather than trusting it.',
   ARRAY['upcycled denim','hand-applied paint']::text[], '2017-present', '$500-$1,000', ARRAY['flare','painted','distressed','upcycled','gallery dept']::text[],
   'https://www.gallerydept.com/', 0.55, false, 'migration:00462'),
  ('gallerydept', 'Logo Tee', ARRAY['logo tee','gd tee','stencil tee','atk tee']::text[], 'Unisex', 'tee', 'Gallery Dept.',
   'The hand-stencilled GALLERY DEPT. wordmark tee, usually on a boxy heavyweight blank and often over-dyed or bleached. The stencil edges are deliberately imperfect and the dye is deliberately uneven — THAT IS THE DESIGN, not a printing fault and not a fake tell. The most common Gallery Dept. item in resale.',
   ARRAY['heavyweight cotton jersey','hand-applied stencil']::text[], '2017-present', '$150-$300', ARRAY['logo tee','stencil','bleached','gallery dept']::text[],
   'https://www.gallerydept.com/', 0.55, false, 'migration:00462'),
  ('gallerydept', 'Painted Hoodie', ARRAY['painted hoodie','gd hoodie','splatter hoodie']::text[], 'Unisex', 'hoodie', 'Gallery Dept.',
   'The heavyweight hoodie with hand-applied paint splatter, over-dyeing and deliberate distressing at the cuffs and hem. Same rule as everything in this row: the wear IS the product. Grade against the maker''s intent — genuine defects are the things the maker did not do (use stains, odour, unintended tears), not the ones they did.',
   ARRAY['heavyweight cotton fleece','hand-applied paint']::text[], '2017-present', '$400-$800', ARRAY['painted','hoodie','splatter','distressed','gallery dept']::text[],
   'https://www.gallerydept.com/', 0.52, false, 'migration:00462'),
  ('gallerydept', 'Upcycled Vintage', ARRAY['upcycled','vintage','reworked','reconstructed']::text[], 'Unisex', 'label', 'Gallery Dept.',
   'NOT a model — the construction method behind much of the line, carried here because it changes how the garment must be READ. Pieces are built on RECLAIMED VINTAGE garments (frequently Levi''s or Carhartt) that are cut, painted and repaired by hand. The base garment''s ORIGINAL interior tag commonly survives, so the tag can read ANOTHER BRAND''S NAME and ANOTHER BRAND''S SIZE. That is normal construction and not a mislabel — but it means the tag is not the size. Measure the garment and say the tag is the donor''s.',
   ARRAY['upcycled denim','upcycled canvas']::text[], '2017-present', 'varies', ARRAY['upcycled','vintage','levis','carhartt','donor tag']::text[],
   'https://www.gallerydept.com/', 0.52, false, 'migration:00462'),

  ('denimtears', 'Cotton Wreath 501', ARRAY['cotton wreath','wreath jeans','levis 501 denim tears','cotton wreath jeans']::text[], 'Unisex', 'bottom', 'Denim Tears x Levi''s',
   'THE Denim Tears piece: the cotton-flower WREATH printed all over an ACTUAL LEVI''S 501 as an official collaboration. So the interior tags read LEVI''S, the care label is Levi''s, and THE SIZE IS A LEVI''S WAIST NUMBER (W x L) — not the alpha sizing the rest of this pack uses. Both brands are true at once: title it as the collaboration, and read the size off the Levi''s tag. A resolver that concludes "this is a Levi''s 501" from the tag has thrown away an order of magnitude of value.',
   ARRAY['Levi''s denim','screen print']::text[], '2020-present', '$400-$800', ARRAY['cotton wreath','501','levis','collab','denim tears']::text[],
   'https://www.denimtears.com/', 0.58, false, 'migration:00462'),
  ('denimtears', 'Cotton Wreath Sweatshirt', ARRAY['wreath hoodie','wreath crewneck','cotton wreath sweatshirt']::text[], 'Unisex', 'sweatshirt', 'Denim Tears',
   'The cotton-flower wreath printed on a heavyweight crewneck or hoodie — usually a collaborator''s blank (Champion and others have been used), so the interior tag may again name the base brand rather than Denim Tears. The wreath print placement and the base garment are the two things worth reading. Read the collaborator off the co-branded tags; do not guess it.',
   ARRAY['heavyweight cotton fleece','screen print']::text[], '2020-present', '$300-$500', ARRAY['cotton wreath','crewneck','hoodie','denim tears']::text[],
   'https://www.denimtears.com/', 0.52, false, 'migration:00462'),
  ('denimtears', 'Cotton Wreath', ARRAY['wreath','cotton flower','wreath print']::text[], 'Unisex', 'label', 'Denim Tears',
   'NOT a model — the house''s entire signature: a wreath of cotton flowers, made by Tremaine Emory as a statement about cotton, slavery and Black American history. It is a work, not decoration, and it deserves to be described accurately and by name. It appears across every collaboration and identifies the HOUSE only — never the collaborator, never the drop and never the authenticity. It is imitated relentlessly.',
   ARRAY['screen print']::text[], '2019-present', 'varies', ARRAY['wreath','cotton flower','emory','denim tears']::text[],
   'https://www.denimtears.com/', 0.55, false, 'migration:00462'),
  ('denimtears', 'Collaboration', ARRAY['denim tears collab','converse denim tears','stussy denim tears','champion denim tears']::text[], 'Unisex', 'label', 'Denim Tears',
   'A LADDER, not a garment. Denim Tears works almost entirely THROUGH collaborations (Levi''s, Converse, Stüssy, Champion and others) and WHICH collaborator a piece is from is most of its price. This is usually legible from the co-branded tags — read them. Where it is not legible, say the drop is unconfirmed rather than assuming the common one, and put BOTH brands in the title when they are.',
   ARRAY['varies by base garment']::text[], '2019-present', 'varies', ARRAY['collab','levis','converse','stussy','champion','denim tears']::text[],
   'https://www.denimtears.com/', 0.52, false, 'migration:00462'),

  ('rhude', 'Silk Shirt', ARRAY['silk shirt','camp shirt','bowling shirt','rhude shirt']::text[], 'Men', 'shirt', 'Rhude',
   'The luxury end of this whole tier in one garment: a boxy short-sleeved camp/bowling shirt in real SILK, printed with motorsport, cigarette or Americana motifs. The FABRIC is a genuine price input here — say it is silk and describe the hand. Silk shows snags, watermarks and deodorant damage readily, and those ARE genuine defects (unlike the intentional distressing elsewhere in this pack).',
   ARRAY['silk','silk twill']::text[], '2015-present', '$400-$700', ARRAY['silk shirt','camp shirt','racing','rhude']::text[],
   'https://www.rhude.com/', 0.52, false, 'migration:00462'),
  ('rhude', 'Rhude Script Tee', ARRAY['script tee','rhude tee','logo tee']::text[], 'Unisex', 'tee', 'Rhude',
   'The heavyweight tee carrying the RHUDE script logo or a racing/Marlboro-adjacent graphic. The brand''s highest-volume resale item. The script is a HOUSE read only — it dates nothing and prices nothing; the drop does, and the tag does not say which.',
   ARRAY['heavyweight cotton jersey']::text[], '2015-present', '$150-$300', ARRAY['script','tee','racing','rhude']::text[],
   'https://www.rhude.com/', 0.50, false, 'migration:00462'),
  ('rhude', 'Track Pant', ARRAY['track pant','traxedo','racing pant']::text[], 'Unisex', 'bottom', 'Rhude',
   'The side-striped track/racing trouser (the "Traxedo" lineage) — a tailored take on a track pant with a contrast side stripe and snap detailing. The construction is genuinely tailored rather than a jersey sweatpant, which is the separator from a generic track pant in a photo and is most of the price.',
   ARRAY['technical twill','satin stripe']::text[], '2015-present', '$400-$700', ARRAY['track pant','traxedo','stripe','rhude']::text[],
   'https://www.rhude.com/', 0.50, false, 'migration:00462'),

  ('sp5der', 'Web Hoodie', ARRAY['web hoodie','sp5der hoodie','spider hoodie','pink hoodie']::text[], 'Unisex', 'hoodie', 'Sp5der',
   'THE Sp5der piece and the group''s through-line at its purest: a heavyweight hoodie with the SPIDERWEB print and the rhinestone-set SP5DER wordmark (note the 5). Strip the graphic and it is a blank hoodie — which is exactly why it is bootlegged at scale and why the bootleg is not separable from it in a photo. CHECK THE RHINESTONES ARE COMPLETE: they fall off, the gaps are visible, and it is a genuine price-moving defect. THE DROP IS THE PRICE AND THE TAG DOES NOT SAY WHICH DROP IT IS — do not guess; say it is unconfirmed and route to human review.',
   ARRAY['heavyweight cotton fleece','rhinestones']::text[], 'c.2019-present', '$300-$600', ARRAY['web','hoodie','rhinestone','sp5der','young thug']::text[],
   'https://sp5der.com/', 0.52, false, 'migration:00462'),
  ('sp5der', 'Web Sweatpant', ARRAY['sp5der sweatpants','web sweatpant','spider sweatpants']::text[], 'Unisex', 'bottom', 'Sp5der',
   'The matching heavyweight sweatpant with the web print and rhinestone wordmark down the leg, usually sold and resold as a SET with the hoodie — a complete set comps materially above a single piece, so state clearly whether this is a set or a solo pant. Same rhinestone-completeness check; same never-guess-the-drop rule.',
   ARRAY['heavyweight cotton fleece','rhinestones']::text[], 'c.2019-present', '$250-$450', ARRAY['sweatpant','web','set','rhinestone','sp5der']::text[],
   'https://sp5der.com/', 0.50, false, 'migration:00462'),
  ('sp5der', 'Web Graphic', ARRAY['web','spiderweb','sp5der logo','555']::text[], 'Unisex', 'label', 'Sp5der',
   'NOT a model — the spiderweb print and the rhinestone-set SP5DER wordmark, which together are the brand''s ENTIRE identity across every garment. There is no construction, no hardware and no fabric story to read behind it. It identifies the house only: it cannot date a piece, cannot price it and cannot authenticate it — and it is copied exactly by bootlegs, because copying it is copying the whole product.',
   ARRAY['screen print','rhinestones']::text[], 'c.2019-present', 'varies', ARRAY['web','spiderweb','rhinestone','wordmark','sp5der']::text[],
   'https://sp5der.com/', 0.52, false, 'migration:00462'),

  ('hellstar', 'Flame Hoodie', ARRAY['hellstar hoodie','flame hoodie','studios hoodie']::text[], 'Unisex', 'hoodie', 'Hellstar',
   'THE Hellstar piece: a heavyweight hoodie with flame/star iconography and the HELLSTAR STUDIOS wordmark, cut OVERSIZED by design. THE PRINT IS INTENTIONALLY DISTRESSED AND CRACKED FROM NEW — a cracked graphic here is frequently the DESIGN rather than wear, the same trap Gallery Dept. carries in this pack. Do not automatically grade print cracking as a defect; describe it and route an unclear call to human review. The drop is the price and the tag does not say which drop it is — never guess.',
   ARRAY['heavyweight cotton fleece','distressed screen print']::text[], 'c.2021-present', '$200-$400', ARRAY['flame','hoodie','star','distressed','hellstar']::text[],
   'https://hellstar.com/', 0.52, false, 'migration:00462'),
  ('hellstar', 'Graphic Tee', ARRAY['hellstar tee','flame tee','studios tee']::text[], 'Unisex', 'tee', 'Hellstar',
   'The heavyweight tee with flame/skull/star graphics and the HELLSTAR STUDIOS wordmark, usually oversized and frequently over-dyed. Same intentional print-cracking rule as the hoodie. The brand''s highest-volume resale item and, being a printed blank, among the most bootlegged garments in the tier.',
   ARRAY['heavyweight cotton jersey','distressed screen print']::text[], 'c.2021-present', '$100-$250', ARRAY['tee','flame','skull','graphic','hellstar']::text[],
   'https://hellstar.com/', 0.50, false, 'migration:00462'),
  ('hellstar', 'Sweatpant', ARRAY['hellstar sweatpants','flame sweatpant','studios sweatpant']::text[], 'Unisex', 'bottom', 'Hellstar',
   'The matching heavyweight sweatpant with flame/star graphics, usually sold and resold as a SET with the hoodie — a complete set comps materially above a single piece, so state whether this is a set or a solo pant. Same intentional-distressing and never-guess-the-drop rules.',
   ARRAY['heavyweight cotton fleece','distressed screen print']::text[], 'c.2021-present', '$150-$300', ARRAY['sweatpant','set','flame','hellstar']::text[],
   'https://hellstar.com/', 0.50, false, 'migration:00462'),

  ('antisocialsocialclub', 'Logo Hoodie', ARRAY['assc hoodie','pink hoodie','block logo hoodie','undefeated hoodie']::text[], 'Unisex', 'hoodie', 'Anti Social Social Club',
   'THE ASSC piece: a hoodie carrying the block-text ANTI SOCIAL SOCIAL CLUB wordmark with Japanese subtext — most famously PINK ON WHITE. There is nothing else to read on it: no construction, no hardware, no fabric story, which is exactly why it was among the most bootlegged garments of the 2010s. ⚠ PRICE FROM RECENT COMPS, NOT FROM THE NAME: ASSC''s resale peaked c.2016-2018 and has fallen a long way since (it dropped too frequently and in too much volume for scarcity to hold). There is no vintage premium to award here.',
   ARRAY['cotton fleece','screen print']::text[], '2015-present', '$60-$150', ARRAY['assc','hoodie','pink','block logo','japanese']::text[],
   'https://antisocialsocialclub.com/', 0.52, false, 'migration:00462'),
  ('antisocialsocialclub', 'Logo Tee', ARRAY['assc tee','block logo tee','mind games tee']::text[], 'Unisex', 'tee', 'Anti Social Social Club',
   'The block-text wordmark tee with Japanese subtext — the brand''s highest-volume item and a printed blank, which is the whole reason it is trivially bootlegged. Same pricing rule as the hoodie: take the recent comps at face value even when they look low for a name this famous.',
   ARRAY['cotton jersey','screen print']::text[], '2015-present', '$40-$100', ARRAY['assc','tee','block logo','japanese']::text[],
   'https://antisocialsocialclub.com/', 0.50, false, 'migration:00462'),
  ('antisocialsocialclub', 'ASSC Collaboration', ARRAY['assc collab','assc undefeated','assc bape','assc neighborhood']::text[], 'Unisex', 'label', 'Anti Social Social Club',
   'A LADDER, not a garment. ASSC collaborated very widely (Undefeated, BAPE, Neighborhood and many others) and a collab piece is the ONE part of this brand that held value — it comps above ordinary ASSC, against the brand''s general decline. Read the collaborator off the co-branded print/tags and put both brands in the title; do not guess it, and do not assume a plain piece is a collab.',
   ARRAY['cotton fleece','screen print']::text[], '2015-present', 'varies', ARRAY['collab','undefeated','bape','neighborhood','assc']::text[],
   'https://antisocialsocialclub.com/', 0.50, false, 'migration:00462')
on conflict (brand_key, style_name, department) do update set
  aliases = excluded.aliases, product_line = excluded.product_line,
  category = excluded.category, visual_fingerprint = excluded.visual_fingerprint,
  fabric_tech = excluded.fabric_tech, era = excluded.era, msrp_band = excluded.msrp_band,
  keywords = excluded.keywords, source_url = excluded.source_url,
  confidence = excluded.confidence, verified = excluded.verified,
  updated_by = excluded.updated_by;

-- ── brand_style_codes: OFF-WHITE ONLY ───────────────────────────────────────
-- The only code in this group that clears all three bars (tag-printed, regular,
-- brand-unique FORMAT). Off-White prints a season/style code on the interior care
-- label: OM/OW + a 2-letter category + 3 digits + a season token + 3 letters + 3-4
-- digits (OMAA038R21FAB001). The OM/OW prefix is a gendered BRAND marker and the
-- whole is a 16-character compound — distinctive in the way the LV SD1160 code
-- (00399) and the Dior hyphenated triplet (00461) are, and nothing like the bare
-- digit runs the Chanel rule (US-1736) refuses.
--
-- THE GENDER GROUP IS THE SECOND CHARACTER, NOT THE FIRST TWO — deliberately.
-- Capturing "M" out of "OM" (rather than "OM" whole) lets the EXISTING genderCode
-- transform map it to Men/Women with no code change; a two-letter "OM" would fall
-- through the transform's W/M table and emit the raw "OM" as a gender.
--
-- Everything else in the group is deliberately decoder-less: Chrome Hearts,
-- Gallery Dept., Denim Tears, Rhude, Sp5der, Hellstar and ASSC print NO regular
-- garment-side code AT ALL (there is nothing to decode — a pattern would be
-- invented, not read), and Aimé Leon Dore's internal SKU is neither regular
-- across categories nor brand-unique in shape.
--
-- NOT AN AUTHENTICITY CHECK, and on this brand that warning is load-bearing: a
-- bootleg copies the care label along with everything else. The code recovers the
-- BRAND off a cut brand tab (the group's cut-tag case, which is what
-- enrichExtractionWithBrandKnowledge keys off styleCode for) and it recovers the
-- ERA via the season token — that is all it does, and the description says so.
--
-- Confidence is capped at 0.5 and the row lands verified=false: the code's
-- INTERNAL structure (which letters mean which category) is not published by the
-- house, so the shape here is read off observed codes rather than a brand source.
-- The US-1715 verifier should check the segment semantics against real tags.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by)
values
  ('offwhite', 'style_number',
   'Off-White season/style code printed on the interior care label: OM (men) or OW (women) + a 2-letter category + 3 digits + a season token (letter + 2-digit year) + 3 letters + 3-4 digits — e.g. OMAA038R21FAB001. Recovers the BRAND off a cut or removed brand tab (the group''s cut-tag case) and the ERA via the season token, which matters because the Off-White logo did NOT change when Abloh died in 2021. NOT an authenticity check: a bootleg copies the care label too. The segment semantics are read off observed codes rather than a published brand source — capped confidence, verify against real tags.',
   '^(?<code>O(?<gender>[MW])[A-Z]{2}\d{3}(?<season>[A-Z]\d{2})[A-Z]{3}\d{3,4})$',
   $j${"fieldMap": {"code": "styleCode", "gender": "gender", "season": "season"}, "transforms": {"gender": "genderCode"}, "confidence": 0.5}$j$::jsonb,
   $j$[{"code":"OMAA038R21FAB001","expected":{"styleCode":"OMAA038R21FAB001","gender":"Men"}},{"code":"OWAA049S23FAB002","expected":{"styleCode":"OWAA049S23FAB002","gender":"Women"}}]$j$::jsonb,
   'https://www.off---white.com/', 0.50, false, 'migration:00462')
on conflict (brand_key, decoder_kind) do update set
  description = excluded.description, pattern = excluded.pattern,
  extraction_rules = excluded.extraction_rules, examples = excluded.examples,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_size_charts (INCHES, BODY measurements) ───────────────────────────
-- THIS TIER PUBLISHES NO SIZE CHARTS. That is the honest situation and it is the
-- reason every confidence here is capped LOW (0.45-0.50) and every note says so
-- plainly: these are the standard US streetwear-alpha approximations, NOT
-- brand-fetched figures. Seeding them at a high confidence would be a lie about
-- provenance; omitting them would leave the model with nothing at all on the
-- fastest-moving garments in resale.
--
-- WHAT THE NOTES ACTUALLY CARRY IS THE FIT INTENT, because on this tier that is
-- the fact a chart cannot express: an oversized Hellstar/Gallery Dept. piece
-- measures far above its nominal size ON PURPOSE, and a Sp5der/ASSC/Chrome Hearts
-- piece runs SMALL. A grader who "corrects" either against a body chart is
-- reporting the design as a mis-tag.
--
-- TWO BRANDS BREAK THE ALPHA SYSTEM and their notes lead with it:
--   * DENIM TEARS — the Cotton Wreath signature is printed on an ACTUAL LEVI'S
--     501, so the size is a LEVI'S WAIST NUMBER (W x L), not an alpha size. Its
--     chart is therefore a WAIST chart, and it is the only one in this pack.
--   * OFF-WHITE — a Milan house, so its tailoring/RTW carries ITALIAN numbers
--     (US = IT - 36, the 00461 rule) even though its tees are alpha. One brand,
--     two systems: read the OBJECT before the number.
--
-- Mirrored 1:1 into the sizing-charts.ts in-code fallback.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by)
values
  ('offwhite', 'Off-White', ARRAY['off-white','off white','offwhite']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','knit','sweater','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Off-White''s graphic tees and hoodies are ALPHA-sized and the brand publishes no chart — this is the standard streetwear-alpha approximation, NOT brand-fetched. ⚠ ONE BRAND, TWO SYSTEMS: Off-White is a MILAN house, so its tailoring and RTW carry ITALIAN NUMBERS (44/46/48 — subtract 36 for the US size) while the tees are alpha. READ THE OBJECT BEFORE THE NUMBER; this chart covers the alpha-sized pieces only. The cut is Italian and runs SMALL/SLIM relative to US streetwear, so sizing down from a US blank is wrong here — many buyers size UP. BODY measurement — NOT flat-garment. Capped confidence: verify against the brand''s own guide.',
   'https://www.off---white.com/', 0.48, false, 'migration:00462'),
  ('offwhite', 'Off-White', ARRAY['off-white','off white','offwhite']::text[], 'Men', 'RTW (ITALIAN-SIZED)',
   ARRAY['blazer','suit','tailoring','coat','trouser','pant']::text[],
   $json$[{"size":"46 (= IT 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= IT 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= IT 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= IT 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= IT 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= IT 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'The number on an Off-White TAILORED piece is an ITALIAN size and the garment does not say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). Off-White is a MILAN house — this is the same Italian system the luxury RTW pack (00461: Bottega Veneta/Fendi/Versace) runs on, and Off-White is the ONLY brand in the hype tier that touches it. ⚠ THE SAME BRAND''S TEES AND HOODIES ARE ALPHA-SIZED — read the OBJECT before the number; a number on an Off-White is tailoring, a letter is a graphic piece. The cut runs SLIM. BODY measurement — NOT flat-garment. Standard IT-to-US approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.off---white.com/', 0.48, false, 'migration:00462'),

  ('chromehearts', 'Chrome Hearts', ARRAY['chrome hearts','chromehearts']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','knit','sweater','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Chrome Hearts is ALPHA-sized and the brand publishes no size chart at all (it runs no e-commerce) — this is the standard streetwear-alpha approximation, NOT brand-fetched. ⚠ THE CUT RUNS SMALL: Chrome Hearts apparel is cut close and buyers commonly size UP, which is the opposite of the oversized brands in this same pack (Hellstar, Gallery Dept.). Do not carry one brand''s fit intent across this tier — it splits. BODY measurement — NOT flat-garment. Capped confidence: verify against a measured garment rather than this chart.',
   'https://www.chromehearts.com/', 0.45, false, 'migration:00462'),

  ('aimleondore', 'Aimé Leon Dore', ARRAY['aimé leon dore','aime leon dore','aimeleondore']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','knit','sweater','polo','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Aimé Leon Dore is ALPHA-sized — the standard streetwear-alpha approximation, NOT brand-fetched. ⚠ THE CUT IS BOXY AND WIDE BY DESIGN, especially the knit polos and crewnecks: the garment measures SHORT and WIDE relative to its nominal size, and that is the design rather than a mis-tag. So a flat chest measurement will read large while the LENGTH reads small — report both and do not "correct" either. NOTE the brand_key is ''aimleondore'' (brandKey strips the accent), but the brand_match here carries the ACCENTED spelling too because sizing-charts norm() only lowercases and does NOT strip accents — the canonical passed in is "Aimé Leon Dore". BODY measurement — NOT flat-garment. Capped confidence.',
   'https://www.aimeleondore.com/', 0.45, false, 'migration:00462'),

  ('gallerydept', 'Gallery Dept.', ARRAY['gallery dept','gallerydept']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','knit','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Gallery Dept. is ALPHA-sized and publishes no chart — the standard streetwear-alpha approximation, NOT brand-fetched. ⚠ TWO WARNINGS THAT MATTER MORE THAN THE NUMBERS. (1) The cut is OVERSIZED/boxy by design, so flat measurements run well above this body chart on purpose. (2) MUCH OF THE LINE IS UPCYCLED FROM VINTAGE GARMENTS, so THE INTERIOR TAG MAY BE THE DONOR GARMENT''S — it can read another brand''s name and another brand''s size system entirely (frequently a Levi''s). On an upcycled piece the tag is NOT the size: measure the garment and say the tag is the donor''s. BODY measurement — NOT flat-garment. Capped confidence.',
   'https://www.gallerydept.com/', 0.45, false, 'migration:00462'),

  -- THE ONLY WAIST CHART IN THIS PACK — and the reason is the collaboration.
  ('denimtears', 'Denim Tears', ARRAY['denim tears','denimtears']::text[], 'Unisex', 'Bottoms (LEVI''S WAIST-SIZED)',
   ARRAY['bottom','jean','jeans','denim','pant','trouser']::text[],
   $json$[{"size":"W28 (= Levi's 28 / US 28in waist)","measurements":{"waist":"28-29"}},{"size":"W30 (= Levi's 30 / US 30in waist)","measurements":{"waist":"30-31"}},{"size":"W32 (= Levi's 32 / US 32in waist)","measurements":{"waist":"32-33"}},{"size":"W34 (= Levi's 34 / US 34in waist)","measurements":{"waist":"34-35"}},{"size":"W36 (= Levi's 36 / US 36in waist)","measurements":{"waist":"36-37"}},{"size":"W38 (= Levi's 38 / US 38in waist)","measurements":{"waist":"38-39"}}]$json$::jsonb,
   'THE ODD ONE OUT IN THIS PACK, AND IT IS THE COLLABORATION THAT DOES IT: the signature Cotton Wreath jeans and trucker jackets are printed on ACTUAL LEVI''S GARMENTS under an official collaboration, so the size is a LEVI''S WAIST NUMBER (W x L) — NOT the alpha sizing every other brand in this tier uses. Read the waist and inseam off the Levi''s tag inside the garment. ⚠ THAT SAME TAG SAYS LEVI''S, AND THE PIECE IS STILL A DENIM TEARS: both brands are true at once. Do not conclude "this is a Levi''s 501" from the interior tag — that throws away an order of magnitude of value — and do not discard the tag either, because it is the only place the size lives. Levi''s 501s are famously cut for a true-to-tag waist. The Cotton Wreath SWEATSHIRTS are alpha-sized on a collaborator''s blank; this chart is for the denim. BODY measurement (natural waist) — NOT the flat-garment waist, which measures roughly half. Capped confidence.',
   'https://www.denimtears.com/', 0.48, false, 'migration:00462'),

  ('rhude', 'Rhude', ARRAY['rhude']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','knit','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Rhude is ALPHA-sized — the standard streetwear-alpha approximation, NOT brand-fetched. The cut sits between the two poles of this pack: closer to true-to-size than the oversized brands (Hellstar, Gallery Dept.) and not as tight as the small-running ones (Sp5der, Chrome Hearts, ASSC), with some Italian-made pieces running slim. Report the measurement rather than applying a fit adjustment. BODY measurement — NOT flat-garment. Capped confidence.',
   'https://www.rhude.com/', 0.45, false, 'migration:00462'),

  ('sp5der', 'Sp5der', ARRAY['sp5der','spider worldwide']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Sp5der is ALPHA-sized and the brand publishes essentially nothing, including no size chart — this is the standard streetwear-alpha approximation, NOT brand-fetched, and it is the least-sourced chart in this pack. ⚠ THE CUT RUNS SMALL and buyers commonly size UP — the opposite of the oversized brands beside it (Hellstar, Gallery Dept.). The fit intent SPLITS across this tier: do not carry one brand''s to another. NOTE the brand_match deliberately does NOT include a bare "spider" — it is an ordinary English word and a common graphic subject, and it would fire on any garment whose own print is described as a spider. BODY measurement — NOT flat-garment. Capped confidence.',
   'https://sp5der.com/', 0.45, false, 'migration:00462'),

  ('hellstar', 'Hellstar', ARRAY['hellstar']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Hellstar is ALPHA-sized and the brand publishes essentially nothing, including no size chart — the standard streetwear-alpha approximation, NOT brand-fetched. ⚠ THE CUT IS OVERSIZED BY DESIGN: flat measurements run well above this body chart ON PURPOSE, and a grader who reads that as a mis-tag is reporting the design as an error. That is the opposite of the small-running brands in this same pack (Sp5der, Chrome Hearts, ASSC) — the fit intent SPLITS across this tier, so read the HOUSE before adjusting anything. BODY measurement — NOT flat-garment. Capped confidence.',
   'https://hellstar.com/', 0.45, false, 'migration:00462'),

  ('antisocialsocialclub', 'Anti Social Social Club', ARRAY['anti social social club','antisocialsocialclub']::text[], 'Unisex', 'Tops (alpha)',
   ARRAY['top','tee','shirt','hoodie','sweatshirt','jacket','outerwear']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"40-42"}},{"size":"XL","measurements":{"chest":"42-45"}},{"size":"XXL","measurements":{"chest":"45-48"}}]$json$::jsonb,
   'Anti Social Social Club is ALPHA-sized and publishes no chart — the standard streetwear-alpha approximation, NOT brand-fetched. The pieces are printed on ordinary blanks from various suppliers, so the fit is NOT consistent drop to drop: ASSC generally runs SMALL, but the blank changes, which is a real reason to trust a measurement over the tag here more than anywhere else in this pack. NOTE the brand_match deliberately does NOT include a bare "assc" — four letters are too short to match safely as a substring; the chart is reached via the canonical, which is what brand-knowledge.ts passes in. BODY measurement — NOT flat-garment. Capped confidence.',
   'https://antisocialsocialclub.com/', 0.45, false, 'migration:00462')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00462') on conflict do nothing;
