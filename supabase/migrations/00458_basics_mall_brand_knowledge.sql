-- US-1739: Basics, mall & fast-fashion brand knowledge group (7 brands, 7 rows).
--
-- Uniqlo, Gap, Banana Republic, Old Navy, American Eagle, Abercrombie & Fitch,
-- Tommy Hilfiger.
--
-- All seven ALREADY have a bare alias-only row from 00389 (they were seeded from
-- brand-normalize.ts with nothing but an alias list, verified=true). So unlike
-- 00456/00457 this migration is mostly an UPDATE: it fills the empty
-- category_focus / tag_eras / authentication_tells / notes on rows that already
-- canonicalize correctly. The `on conflict do update` clauses are load-bearing
-- here, not defensive.
--
-- WHAT MAKES THIS GROUP DIFFERENT: THE TAG SAYS THE BRAND, AND THE BRAND IS NOT
-- THE QUESTION. This is the exact INVERSE of 00457, and the two are worth reading
-- as a pair. There the piece was easy and the BRAND was the puzzle — a WILFRED
-- tag is an Aritzia coat and nothing said so. Here the tag says GAP in a blue box
-- and the garment is a crewneck tee. Both facts are free. Neither is worth money.
--
-- So what DOES decide the price of a $12 staple, given the brand and the piece are
-- both already known? Two things, and they are this pack's whole reason to exist:
--
--   1. THE LINE — mainline vs MADE-FOR-OUTLET. Gap Factory, Banana Republic
--      Factory Store and their siblings are NOT overstock of the mainline good.
--      They are a separate, lower-spec product manufactured FOR the outlet, at a
--      materially lower price band, and the tag differs by ONE WORD.
--   2. THE ERA — a 1990s flag-logo Tommy Hilfiger and a 2024 Tommy Hilfiger polo
--      carry the SAME BRAND NAME and are not the same product or the same money.
--
-- Both are printed on the tag. Neither is visible in the silhouette. That is the
-- identification problem this group actually has, and it is why "the brand is
-- obvious" does not make the pack trivial.
--
-- THE ERA SPREAD IS THE LARGEST IN THE EPIC, and it is the reason a "low-value"
-- group earns real tag_eras. Everywhere else in this epic the era refines a
-- listing. Here it MULTIPLIES it: the same brand name spans a ~10x range.
--
--     Tommy Hilfiger   1990s big-flag / crest era  — the hip-hop-era collectible.
--     Abercrombie & Fitch  pre-1977 sporting goods — a DIFFERENT COMPANY lineage
--                                                    (Teddy Roosevelt's outfitter),
--                                                    not the mall brand at all.
--     Banana Republic  1978-~1988 safari/travel    — the Zieglers' original brand;
--                                                    a different product entirely.
--
-- Note what that means for the epic's usual rule. 00456 split Fear of God from
-- Essentials into two brand keys precisely BECAUSE they are an order of magnitude
-- apart. The era spread here is the same magnitude — and it still does NOT earn a
-- split, because an era is not a line: there is no second brand to key. Vintage
-- Tommy IS Tommy. So the spread is carried as tag_eras + styles, where the model
-- can read it, and the brand stays one row. That is a different answer to the same
-- 10x question, and the distinction is LINE vs ERA.
--
-- THE OUTLET LINES FOLD, AND THE FOLD IS DISCLOSED — the pack's second call, and
-- the one that is genuinely arguable. Gap Factory / BR Factory sit at a lower
-- price band, which is the 00456 argument FOR splitting. They fold anyway, for a
-- reason 00456 did not have: eBay's Brand aspect for a Banana Republic Factory
-- shirt IS "Banana Republic" — there is no separate catalogue brand to resolve to,
-- so a split would invent one and mis-map the aspect on every listing. The band
-- difference is ~2x rather than 10x, so folding costs far less than the invention
-- would. But it is NOT dropped: the factory line is seeded as a first-class
-- authentication tell AND a brand_style, so it is DISCLOSED in the listing rather
-- than silently comped as mainline. Fold the brand, surface the line.
--
-- "GAP" IS THE WORST ORDINARY-WORD TOKEN IN THE ENTIRE EPIC, and it is worse than
-- 00457's "moth" on exactly the axis that matters. Both are condition words. But
-- "moth" is at least a NOUN a seller would have to choose; "gap" is the word this
-- product's own condition text reaches for constantly and unavoidably:
--
--     "a gap in the waistband"      "gaping at the bust"     "button gap"
--     "a small gap in the stitching"                         "gap between the placket"
--
-- and — the part that has no equivalent anywhere else in this epic — "Gap" is a
-- REAL BRAND spelled identically. 00457 could refuse "moth" as an alias outright
-- because Moth is only a house LABEL, reachable as a style. That escape does not
-- exist here: "Gap" IS the canonical brand and it MUST resolve. So the token
-- cannot be removed, only contained, and the containment already exists in two
-- places that this migration must not break:
--
--     detectBrandInText  — regex-bounded on BOTH sides, so "Gap" never fires on
--                          "gaps"/"gaping". It DOES still fire on a bare "gap".
--                          That is why it is only ever fed an eBay TITLE (a
--                          barcode match), never condition text.
--     findSizingCharts   — brandTextMatches is LEADING-boundary only, and it is
--                          fed the BRAND field alone, never a description.
--
-- Both are asserted in basics-mall-content_test.ts. The rule for anyone extending
-- this: never widen "gap" past a whole-brand-field match, and never feed
-- condition text to a brand detector.
--
-- babyGap / GapKids / GapFit ARE aliased, and that is a consequence of the
-- LEADING-boundary matcher rather than a style choice: "babygap".indexOf("gap")
-- is preceded by "y", a word character, so a bare "gap" brandMatch does NOT fire
-- on it. The concatenated forms must be listed explicitly or babyGap silently
-- misses Gap's charts. (Spaced "Baby Gap" matches fine.) This is the first bill
-- come due from 00457's boundary fix, and it is the right trade.
--
-- ONE DECODER — and it is the first in three groups, so the reasoning matters more
-- than the row. 00456 refused (the identifier is a GRAPHIC — not on the tag, not
-- parseable). 00457 refused (the identifier IS printed and IS regular, but every
-- one is an ordinary GIVEN NAME — not brand-unique). UNIQLO PASSES ALL THREE
-- TESTS, on a kind of token no prior group had:
--
--     HEATTECH · AIRism · BLOCKTECH · DRY-EX
--
--   printed?      YES — on the neck/care label, prominently, as the selling point.
--   regular?      YES — a small CLOSED SET of registered trademarks.
--   brand-unique? YES — and this is the part "Juliette" and "TNA" failed. These
--                 are COINED words. They mean nothing in English. "HEATTECH" on a
--                 care label cannot be anything but Uniqlo, whereas "Maeve" is a
--                 name and "TNA" is three letters.
--
-- So this group gets the cut-tag recovery case the last two could not have: brand
-- tag gone, care label says HEATTECH, brand recovers to Uniqlo. That is the exact
-- scenario the epic exists for.
--
-- "ULTRA LIGHT DOWN" IS DELIBERATELY EXCLUDED from that decoder, and the exclusion
-- is the same rule that admits the other four. It is Uniqlo's product name, but it
-- is a DESCRIPTIVE ENGLISH PHRASE — any brand may truthfully call a jacket an
-- ultra light down jacket. It fails brand-unique for precisely the reason
-- HEATTECH passes it. It stays a brand_style, never a decoder token.
--
-- NO OTHER BRAND HERE EARNS A DECODER. Old Navy's "Powersoft" and American
-- Eagle's "AirFlex" are coined and are tempting on the same logic — they are
-- omitted because the trademark SET is not one this migration can enumerate with a
-- citation, and a decoder that fires on a half-remembered token list is worse than
-- no decoder. Uniqlo's four are the ones that can be sourced. A future story may
-- extend this on evidence, not on recall.
--
-- ZERO COLORWAYS — the third group running, and again for a NEW reason worth
-- recording. 00457 had nothing proprietary to seed (seasonal English words).
-- UNIQLO IS DIFFERENT: it prints a genuine 2-digit COLOR NUMBER on the tag (the
-- 09/69-style code), which is proprietary and stable and exactly the kind of
-- system this table is for. It is omitted anyway, on the epic's own rule: the
-- mapping cannot be cited here, and a colour decoder built from recall would
-- mislabel silently and confidently. The FACT that the number exists is seeded as
-- an authentication tell ("do not guess the mapping") — which is the useful,
-- honest half. The rest waits for a source. Everyone else in the pack uses
-- ordinary descriptive colour words ("Heather Grey") and has nothing to seed.
--
-- registered_numbers are omitted throughout as UNSOURCED — the call 00448, 00449
-- and 00457 made. Several of these brands have well-known RNs; "well-known" is not
-- a citation, and an RN is a legal identifier where a near-miss is a false
-- authentication signal. Omitted rather than guessed.
--
-- CORPORATE MAP (a shared parent reads as a counterfeit signal to a naive model
-- and is not one — the same note 00457 needed for URBN):
--   * GAP INC owns Gap, Old Navy, Banana Republic AND Athleta (00448). Four of
--     this epic's brands share one parent; a shared Gap Inc corporate tag between
--     them is ORDINARY.
--   * FAST RETAILING owns Uniqlo AND Theory (00457). Same note.
--   * PVH owns Tommy Hilfiger AND Calvin Klein.
--   * ABERCROMBIE & FITCH CO owns HOLLISTER — and Hollister does NOT fold into
--     A&F. It is not a house label: it is separately branded, separately searched
--     and sits at a LOWER price band, so it keeps its own canonical (it already
--     has one in brand-normalize.ts). The parent company is not the brand.
--   * TOMMY BAHAMA IS NOT TOMMY HILFIGER — a different company (Oxford
--     Industries). See the Tommy Hilfiger row: this is 00457's Vince/Vince Camuto
--     shape, with one structural difference that changes the remedy.
--
-- NEVER AUTO-AUTHENTICATE — the epic's hard line. Vintage Tommy and 2000s A&F are
-- both heavily counterfeited, which raises the stakes and does not change the
-- stance: flag inconsistencies in condition notes and stop.
--
-- Data-only. Every fact carries source_url + confidence and lands verified=false
-- for the US-1715 admin verify queue. Idempotent throughout.

-- ── brand_knowledge ─────────────────────────────────────────────────────────

-- Uniqlo (row EXISTS from 00389, alias-only — this fills it). The one brand in the
-- pack with a decoder, and the only one whose identity is a FABRIC PLATFORM.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('uniqlo', 'Uniqlo',
  ARRAY['uniqlo','uniqlou','uniqlojapan']::text[],
  ARRAY['basics','japanese','fabric tech','outerwear','knits']::text[],
  $j$[{"era":"+J (Jil Sander)","years":"2009-2011, revived 2020-2021","description":"+J is Uniqlo's collaboration line with Jil Sander and is the single biggest resale multiplier on the brand — a +J piece is not priced like a Uniqlo staple. The line is printed on the neck label as '+J'. This is a real provenance fact, not an authenticity test."},{"era":"Uniqlo U","years":"2016-present","description":"Uniqlo U is the Christophe Lemaire-led in-house line, labelled 'Uniqlo U' on the tag. It carries a modest premium over mainline Uniqlo and is a distinct line, not a season."},{"era":"Designer collaborations","years":"various","description":"Uniqlo runs frequent, heavily-resold designer and licensed collaborations (JW Anderson, Marimekko, and many licensed graphic partnerships). The collaborator is printed on the label. A collab tag is a PRICE fact and must not be read as a counterfeit signal — an unfamiliar co-brand on a Uniqlo tag is normal for this brand."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Uniqlo item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE FABRIC TECH IS THE IDENTITY — and it is the one token that survives a cut tag","detail":"THE Uniqlo call, and the reason this brand is the only one in its group with a decoder. Uniqlo's identity is a FABRIC PLATFORM, not a silhouette: HEATTECH (thermal), AIRism (moisture-wicking base layer), BLOCKTECH (windproof/water-repellent shell) and DRY-EX (performance knit) are Uniqlo's own COINED, registered trademarks and are printed prominently on the neck/care label as the selling point. They mean nothing in English, so they can identify the brand outright — unlike an ordinary style name. If the brand tag is cut but a care label reads HEATTECH, the garment is Uniqlo. The tech also separates two visually identical crewnecks at different values, and it cannot be read off a photo."},{"tell":"'Ultra Light Down' is a product name, NOT a brand-unique token","detail":"The counterweight to the tell above, and the line between them is the whole rule. Ultra Light Down is Uniqlo's signature packable down jacket and a genuine style — but 'ultra light down' is a DESCRIPTIVE ENGLISH PHRASE that any brand may truthfully use for an ultra light down jacket. It identifies the PIECE, never the brand. Contrast HEATTECH, which is a coined word and can."},{"tell":"The 2-digit COLOR NUMBER is real — do not guess what it means","detail":"Uniqlo prints a 2-digit colour number on the garment tag as part of its product coding (a genuine, stable, proprietary system, unlike the seasonal English colour words most mall brands use). The NUMBER's existence is a useful tell: it confirms Uniqlo-style tag coding. Its MAPPING is deliberately not seeded here and must NOT be guessed — a mis-decoded colour is a confident, silent listing error. Read the colour from the garment, not from the code."},{"tell":"Uniqlo runs SMALL against a US body","detail":"Uniqlo's cut is graded to a Japanese fit and runs SMALL and slim against a general US body — roughly one size down, most pronounced in the shoulders and through the chest. Old Navy and American Eagle in this same group run the OPPOSITE way (vanity-sized, running LARGE). All three tags say only a letter. Measure the garment; never carry one brand's grade onto another."},{"tell":"Fast Retailing is Theory's parent too","detail":"Informational: Uniqlo is owned by Fast Retailing, which also owns Theory. Ordinary corporate provenance; not a tag tell and not a counterfeit signal."}]$j$::jsonb,
  'JAPANESE basics brand; sizing RUNS SMALL/slim against a US body (roughly one size down), most noticeably in the shoulders. THE FABRIC TECH IS THE IDENTITY — HEATTECH, AIRism, BLOCKTECH and DRY-EX are Uniqlo''s own COINED trademarks, printed on the care label, and are the only tokens in this brand group that can recover the brand from a cut tag (they mean nothing in English). Contrast "Ultra Light Down", which is Uniqlo''s signature packable jacket but is a DESCRIPTIVE phrase — it names the piece, never the brand. +J (Jil Sander) is the biggest resale multiplier on the brand; Uniqlo U (Lemaire) carries a modest premium; collabs are frequent and an unfamiliar co-brand on the tag is NORMAL. Uniqlo prints a 2-digit COLOR NUMBER — never guess its mapping. Owned by Fast Retailing (Theory''s parent). NEVER auto-authenticate.',
  'https://www.uniqlo.com/', 0.72, false, 'migration:00458')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Gap (row EXISTS from 00389, alias-only). The ordinary-word problem of the epic:
-- "gap" is a CONDITION word AND the real brand, so it can be contained but never
-- refused. See the header.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('gap', 'Gap',
  ARRAY['gap','thegap','gapinc','babygap','gapkids','gapfit','gapbody','gapfactory']::text[],
  ARRAY['basics','denim','sweatshirts','tees','kids']::text[],
  $j$[{"era":"1990s blue-box logo","years":"~1990-2000","description":"The square blue 'GAP' box logo of the 1990s marks the brand's vintage era — 90s Gap sweatshirts, denim and pocket tees are a genuine collectible category priced well above modern mainline Gap. The logo is on the garment and the neck label. This DATES a piece and is a price fact; it is not an authenticity test and does not fix a year precisely."},{"era":"Gap Factory / outlet line","years":"ongoing","description":"Gap Factory (formerly Gap Outlet) garments are MADE FOR THE OUTLET at a lower spec and a lower price band — they are not overstock of the mainline good. The tag says 'Gap Factory' rather than 'Gap'. This is a LINE fact, not an era, and it is the single most common silent mis-comp on the brand."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Gap item authentic. Flag inconsistencies in condition notes only."},{"tell":"'GAP' IS A CONDITION WORD BEFORE IT IS A BRAND","detail":"THE Gap call and the most dangerous token in this entire brand epic — worse than Anthropologie's 'moth', because 'moth' is only a house label that can be refused outright while 'Gap' is a REAL canonical brand that MUST resolve. 'Gap' is a word this product's own condition text produces constantly and unavoidably: 'a gap in the waistband', 'gaping at the bust', 'button gap', 'a gap in the stitching'. The word must be read as this BRAND only when it appears as the garment's BRAND — on the label or in the brand field — and NEVER from the word appearing in a description, a condition note, or a measurement remark. A brand detector must never be fed condition text."},{"tell":"THE FACTORY LINE IS A DIFFERENT PRODUCT AT A DIFFERENT PRICE","detail":"CRITICAL and the group's defining line trap. Gap Factory (formerly Gap Outlet) is NOT mainline Gap overstock — it is a separate, lower-spec product manufactured FOR the outlet channel, and the tag differs by ONE WORD. It is still listed under the brand 'Gap' (there is no separate eBay catalogue brand), so the brand FOLDS — but the line must be DISCLOSED in the listing, not silently comped against mainline. If the tag says 'Gap Factory', say so."},{"tell":"The house sub-labels are DEPARTMENTS, not tiers","detail":"babyGap, GapKids, GapFit (activewear) and GapBody (sleep/intimates) are Gap's own sub-labels and all fold onto the brand 'Gap' with the sub-label carried in the style. They are categories, not price ranks. Note the concatenated spellings ('babyGap', 'GapKids') are how the tags actually print them."},{"tell":"Gap Inc is Old Navy, Banana Republic AND Athleta's parent","detail":"Informational: Gap Inc owns Gap, Old Navy, Banana Republic and Athleta — four brands in this same knowledge base. A shared Gap Inc corporate tag between them is ORDINARY provenance and is not a counterfeit signal. It is also NOT a reason to fold them: they are separately branded and separately searched."}]$j$::jsonb,
  'US sizing, alpha and numeric; the house cut is relaxed/true-to-size. NOTE "gap" is a garment-CONDITION word ("a gap in the waistband", "gaping at the bust") far more often than it is this brand — read it as the brand ONLY from the label or the brand field, NEVER from a description. THE FACTORY LINE IS A DIFFERENT PRODUCT: "Gap Factory" is made FOR the outlet at a lower spec and a lower price band, not mainline overstock — it folds onto the brand "Gap" (no separate eBay brand exists) but MUST be disclosed, not comped as mainline. Sub-labels babyGap / GapKids / GapFit / GapBody are DEPARTMENTS and fold with the label in `style`. The 1990s blue-box logo marks the collectible vintage era. Part of Gap Inc (Old Navy, Banana Republic, Athleta). NEVER auto-authenticate.',
  'https://www.gap.com/', 0.72, false, 'migration:00458')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Banana Republic (row EXISTS from 00389, alias-only). The safari era is the point:
-- the ORIGINAL brand is a different product from the mall brand wearing its name.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('bananarepublic', 'Banana Republic',
  ARRAY['bananarepublic','bananarepublicfactory','bananarepublicfactorystore','brfactory']::text[],
  ARRAY['workwear','basics','tailoring','knits','merino']::text[],
  $j$[{"era":"Safari / travel era","years":"1978-~1988","description":"Banana Republic began as a SAFARI AND TRAVEL outfitter founded by Mel and Patricia Ziegler, with a hand-illustrated catalogue and surplus-derived safari clothing — a completely different product from the mall workwear brand that now carries the name (Gap Inc acquired it in 1983 and repositioned it through the late 1980s). Safari-era Banana Republic is a genuine vintage collectible with its own buyers and its own prices. The era is legible from the label and the garment; it DATES a piece and is not an authenticity test."},{"era":"Banana Republic Factory Store","years":"ongoing","description":"BR Factory garments are MADE FOR THE OUTLET at a lower spec and a lower price band — not mainline overstock. The tag reads 'Banana Republic Factory Store'. A LINE fact, not an era."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Banana Republic item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE SAFARI-ERA BRAND IS A DIFFERENT PRODUCT WEARING THE SAME NAME","detail":"THE Banana Republic call. From 1978 to roughly 1988 Banana Republic was a SAFARI AND TRAVEL outfitter — the Zieglers' hand-illustrated-catalogue brand built on surplus — and it has essentially nothing in common with the mall tailoring brand that now carries the name. Safari-era pieces are a vintage collectible with their own buyers and their own (much higher) prices. This is an ERA, not a LINE: there is no second brand to key, so it is carried here and in the styles rather than split off. A safari-era piece read as modern Banana Republic is mis-comped by a wide margin, and the label is what separates them."},{"tell":"THE FACTORY LINE IS A DIFFERENT PRODUCT AT A DIFFERENT PRICE","detail":"CRITICAL, and the same trap as Gap's: 'Banana Republic Factory Store' is made FOR the outlet at a lower spec and a lower price band — NOT mainline overstock. The tag differs by two words. The brand still folds to 'Banana Republic' (there is no separate eBay catalogue brand), but the line must be DISCLOSED, not silently comped as mainline."},{"tell":"Gap Inc is the parent","detail":"Informational: Banana Republic is Gap Inc, the same parent as Gap, Old Navy and Athleta. A shared corporate tag is ORDINARY and is not a counterfeit signal — and not a reason to fold the brands together."}]$j$::jsonb,
  'US sizing; the modern house cut is tailored workwear, true to size and the most conservative grade in this group. TWO ERAS THAT ARE NOT THE SAME PRODUCT: 1978-~1988 Banana Republic was a SAFARI/TRAVEL outfitter (the Zieglers'' hand-illustrated-catalogue brand, acquired by Gap Inc in 1983 and repositioned) and safari-era pieces are a vintage collectible at far higher prices than the mall tailoring brand now wearing the name. That is an ERA, not a LINE — no second brand to key. THE FACTORY LINE IS A DIFFERENT PRODUCT: "Banana Republic Factory Store" is made FOR the outlet at lower spec and a lower band; it folds onto the brand but MUST be disclosed. Known for merino knits and the Sloan pant. Part of Gap Inc. NEVER auto-authenticate.',
  'https://bananarepublic.gap.com/', 0.70, false, 'migration:00458')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Old Navy (row EXISTS from 00389, alias-only). The vanity-sizing end of the
-- group's sizing spread — the opposite direction from Uniqlo.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('oldnavy', 'Old Navy',
  ARRAY['oldnavy']::text[],
  ARRAY['basics','value','denim','activewear','kids']::text[],
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label an Old Navy item authentic. Flag inconsistencies in condition notes only."},{"tell":"Old Navy runs LARGE — it is vanity-sized","detail":"THE Old Navy call, and it points the OPPOSITE way from Uniqlo in this same pack. Old Navy's grade is generous against a general US body: an Old Navy M sits nearer a US L than the nominal grade suggests. This is the value-tier vanity-sizing pattern, and the tag says only a letter or a number. Uniqlo in this same group runs SMALL. Never carry one brand's grade onto the other — measure the garment and treat the tag as a claim to check."},{"tell":"The named JEAN FITS are the listing tokens that matter","detail":"Old Navy names its denim fits (Rockstar is the long-running skinny/jegging family; Pixie is the ankle-pant family) and buyers search those names. The fit name is printed on the tag or the pocket flasher. NOTE 'Rockstar' and 'Pixie' are ordinary English words — read them as fit names only when the garment actually carries Old Navy branding, never from surrounding text."},{"tell":"The VALUE TIER is the fact, and it caps the comp","detail":"Informational and price-relevant: Old Navy is Gap Inc's VALUE brand and prices accordingly. It is the lowest band of this pack by a wide margin. An Old Navy piece comped against a Gap or Banana Republic equivalent — despite the shared parent — is over-priced. The shared Gap Inc parent is provenance, not price."},{"tell":"Gap Inc is the parent","detail":"Informational: Old Navy is Gap Inc, the same parent as Gap, Banana Republic and Athleta. A shared corporate tag is ORDINARY and is not a counterfeit signal."}]$j$::jsonb,
  'US sizing (alpha XS-XXL and numeric, plus an extended range) that RUNS LARGE — Old Navy is VANITY-SIZED and an Old Navy M sits nearer a US L. Uniqlo in this same group runs the OPPOSITE way, and both tags say only a letter: measure, never carry a grade across. Gap Inc''s VALUE brand and the lowest price band in this group by a wide margin — the shared Gap Inc parent is provenance, NOT a reason to comp it against Gap or Banana Republic. Named denim fits (Rockstar, Pixie) are the listing tokens buyers search; note both are ordinary English words and are fit names only on an actual Old Navy garment. NEVER auto-authenticate.',
  'https://oldnavy.gap.com/', 0.68, false, 'migration:00458')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- American Eagle (row EXISTS from 00389, alias-only). Aerie FOLDS — same price
-- band, the 00457 Aritzia/Wilfred play.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('americaneagle', 'American Eagle',
  ARRAY['americaneagle','americaneagleoutfitters','aeo','aerie']::text[],
  ARRAY['denim','basics','tees','intimates','value']::text[],
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label an American Eagle item authentic. Flag inconsistencies in condition notes only."},{"tell":"AERIE IS AMERICAN EAGLE — and the tag does not say so","detail":"THE American Eagle call, and this pack's one instance of 00457's defining shape. Aerie is American Eagle Outfitters' intimates/loungewear/swim sub-brand, and an Aerie tag frequently carries no 'American Eagle' anywhere on it. Aerie sits in the SAME PRICE BAND as its parent, so it FOLDS onto the brand 'American Eagle' with 'Aerie' carried in the style — the Aritzia/Wilfred play, NOT the Fear of God split (which is reserved for lines an order of magnitude apart). Buyers search 'Aerie' heavily, so the line must be kept in the listing, never dropped."},{"tell":"'Aerie' is an ordinary English noun","detail":"CROSS-BRAND: an aerie is an eagle's nest — an ordinary (if uncommon) English word, and a fittingly-chosen one. It resolves to this brand only as a whole-brand token on an actual garment label, never from the word appearing in surrounding text."},{"tell":"DENIM IS THE BRAND, and the named FIT is the listing token","detail":"American Eagle is a denim-led brand: jeans are the volume product and the piece most likely to be resold. AE names its fits and stretch platforms, and those names are printed on the tag or the pocket flasher — they are what buyers search. The named fit separates two visually identical pairs at different values and it is far more reliable read off the tag than guessed from the photo."},{"tell":"American Eagle runs LARGE","detail":"AE's grade is generous against a general US body — the mall-brand vanity-sizing pattern, the same direction as Old Navy and the OPPOSITE of Uniqlo in this same pack. AE denim is graded in true waist inches, which is the more reliable number; the alpha tops are where the generosity shows. Measure the garment."}]$j$::jsonb,
  'US sizing; RUNS LARGE (vanity-sized, the same direction as Old Navy and the OPPOSITE of Uniqlo in this group). DENIM IS THE BRAND — jeans are the volume product, graded in true waist inches (the more reliable number), and the NAMED FIT printed on the tag is the listing token buyers search. AERIE IS AMERICAN EAGLE: the intimates/loungewear/swim sub-brand''s tag often says only "aerie", it sits in the SAME price band, so it FOLDS onto this brand with "Aerie" carried in `style` (the Aritzia/Wilfred play, not the Fear of God split). NOTE "aerie" is an ordinary English noun (an eagle''s nest). NEVER auto-authenticate.',
  'https://www.ae.com/', 0.68, false, 'migration:00458')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Abercrombie & Fitch (row EXISTS from 00389, alias-only). Two eras that are two
-- different companies, and a sibling brand (Hollister) that must NOT fold.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('abercrombiefitch', 'Abercrombie & Fitch',
  ARRAY['abercrombie','abercrombiefitch','abercrombieandfitch','anf','abercrombiekids']::text[],
  ARRAY['basics','denim','tees','mall','logo'] ::text[],
  $j$[{"era":"Original sporting-goods Abercrombie & Fitch","years":"1892-~1977","description":"The ORIGINAL Abercrombie & Fitch was an elite SPORTING GOODS and outfitting house — safari, fishing and expedition gear, famously Theodore Roosevelt's and Ernest Hemingway's outfitter — which went bankrupt in 1977. The name was later bought and rebuilt as the mall apparel brand, which shares the name and NOTHING ELSE: not the company, not the product, not the buyer. Pre-1977 pieces are a serious vintage collectible and are not remotely comparable to mall-era A&F. The label is what separates them."},{"era":"Logo / moose era","years":"~1997-2010","description":"The heavily logo-branded mall era — big front graphics, the moose, and 'Abercrombie & Fitch' spelled across the chest. This era is a distinct and rising Y2K collectible category priced above the modern rebranded product, and it is also the most counterfeited A&F. It DATES a piece; it is not an authenticity test."},{"era":"Post-rebrand","years":"~2016-present","description":"A&F deliberately moved away from heavy logo branding toward a quieter, more contemporary product. Modern pieces are the ordinary mall band. A piece with no visible logo is NORMAL for this era and is not evidence of a fake or of a removed graphic."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label an Abercrombie & Fitch item authentic. Flag inconsistencies in condition notes only. The 1997-2010 logo era is among the most counterfeited product in this brand group, which raises the stakes and does not change the stance."},{"tell":"THE PRE-1977 BRAND IS A DIFFERENT COMPANY ENTIRELY","detail":"THE Abercrombie call and the sharpest era break in this epic. The original Abercrombie & Fitch (1892-1977) was an elite SPORTING GOODS and expedition outfitter — Roosevelt's and Hemingway's supplier — that went bankrupt; the name was bought and rebuilt as a mall apparel brand. They share a NAME and nothing else. A pre-1977 piece is a serious vintage collectible and is not comparable to mall-era A&F in product, buyer or price. This is still an ERA and not a LINE — there is no second brand to key — but it is the case where that distinction strains hardest."},{"tell":"HOLLISTER IS NOT ABERCROMBIE","detail":"CROSS-BRAND: Abercrombie & Fitch Co OWNS Hollister, but Hollister is NOT a house label and must NOT fold into this brand. It is separately branded, separately searched, and sits at a LOWER price band — so it keeps its own canonical brand. The parent COMPANY is not the brand. Contrast Aerie, which folds into American Eagle because it shares its parent's price band; and contrast Gap Factory, which folds because no separate eBay brand exists for it. The corporate fact alone never decides — the price band and the catalogue do."},{"tell":"The LOGO ERA is the value, and the rebrand is not a defect","detail":"GRADING- AND PRICE-RELEVANT: ~1997-2010 logo-heavy A&F (the moose, big chest graphics) is a distinct Y2K collectible priced above the modern product. The post-2016 rebrand deliberately dropped heavy logo branding — so a modern A&F piece with NO visible logo is NORMAL for its era. Do not read an absent logo as a removed graphic, a fake, or a fault."},{"tell":"'Abercrombie' is also a surname","detail":"CROSS-BRAND: Abercrombie is an ordinary Scottish surname (the founder's). It should be read as this brand only when the garment actually carries A&F branding."}]$j$::jsonb,
  'US sizing; the mall-era cut runs SLIM/small, particularly in menswear. THREE ERAS, AND THE FIRST IS A DIFFERENT COMPANY: the ORIGINAL A&F (1892-1977) was an elite SPORTING GOODS/expedition outfitter (Roosevelt''s and Hemingway''s) that went bankrupt — the name was bought and rebuilt as the mall brand, sharing a name and nothing else, and pre-1977 pieces are a serious vintage collectible. The ~1997-2010 LOGO/moose era is a distinct Y2K collectible above modern band, and the most counterfeited. Post-2016 the brand deliberately dropped heavy logo branding — an absent logo on a modern piece is NORMAL, not a defect or a fake. HOLLISTER IS NOT THIS BRAND: A&F Co owns it, but it is separately branded, separately searched and a lower band, so it keeps its own canonical — the parent company is not the brand. NEVER auto-authenticate.',
  'https://www.abercrombie.com/', 0.70, false, 'migration:00458')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Tommy Hilfiger (row EXISTS from 00389, alias-only). The biggest era multiplier in
-- the pack, and the Tommy Bahama containing-name trap — 00457's Vince/Vince Camuto
-- shape with one structural difference that changes the remedy. See the tells.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('tommyhilfiger', 'Tommy Hilfiger',
  ARRAY['tommyhilfiger','tommyjeans','tommyhilfigerdenim','hilfiger']::text[],
  ARRAY['mall','preppy','denim','polos','outerwear','vintage']::text[],
  $j$[{"era":"1990s flag / crest era","years":"~1990-2000","description":"The 1990s big-flag and crest-logo era — oversized red/white/blue flag branding, spell-out chest logos, sailing and rugby pieces. Adopted by 1990s hip-hop culture, this era is the brand's serious collectible and resells for MULTIPLES of the modern mainline product. It is also the most counterfeited Tommy, both period-fake and modern reproduction. The era DATES a piece and is a price fact, not an authenticity test."},{"era":"Modern mainline","years":"~2005-present","description":"The contemporary mall/department-store product — smaller flag branding, ordinary mall price band. The bulk of what is resold, and not the collectible era."},{"era":"Tommy Jeans","years":"1990s original, revived ~2018","description":"Tommy Jeans is the brand's denim/streetwear line, printed as 'Tommy Jeans' on the label. The 1990s original is part of the collectible flag era; the modern revival deliberately reissues that look and is NOT the vintage — the two are visually similar by design and are priced very differently. The label and the tag construction separate them, not the graphic."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Tommy Hilfiger item authentic. Flag inconsistencies in condition notes only. Vintage flag-era Tommy is among the most counterfeited product in this brand group — both period fakes and modern reproductions — which raises the stakes and does not change the stance."},{"tell":"THE ERA IS THE PRICE — 1990s flag Tommy is a different market","detail":"THE Tommy Hilfiger call and the largest era multiplier in this brand group. 1990s big-flag/crest Tommy — adopted by hip-hop culture and collected as such — resells for MULTIPLES of the visually similar modern mainline piece. The brand name on the tag is identical for both. This is an ERA, not a LINE: there is no second brand to key, so it is carried in the tag eras and the styles rather than split into its own canonical (contrast Fear of God / Essentials, which are two labels and therefore two keys). A vintage flag piece comped against modern Tommy is under-priced by a wide margin, and vice versa."},{"tell":"THE MODERN REVIVAL LOOKS LIKE THE VINTAGE ON PURPOSE","detail":"CRITICAL and the trap that follows directly from the tell above. Tommy Jeans' modern revival (~2018 onward) DELIBERATELY reissues the 1990s flag look — so the GRAPHIC cannot date the garment, because a modern piece is supposed to look old. A big flag logo is NOT evidence of a 1990s piece. Only the LABEL and the tag construction separate them. Never infer the vintage era from the graphic alone; if the tag does not support it, do not claim it."},{"tell":"TOMMY BAHAMA IS A DIFFERENT COMPANY","detail":"CROSS-BRAND: Tommy Bahama (Oxford Industries) is NOT Tommy Hilfiger — unrelated businesses sharing a first name, exactly the Vince / Vince Camuto shape. A bare 'Tommy' token is therefore NOT decisive: it must never resolve to this brand on its own, only as part of the full name. The structural difference from the Vince case is that neither full name CONTAINS the other ('Tommy Hilfiger' does not contain 'Tommy Bahama'), so full-name matching separates them cleanly and no protective entry is needed — the danger is only in the bare first name."},{"tell":"Tommy Jeans is a LINE of this brand and folds","detail":"Informational: Tommy Jeans / Tommy Hilfiger Denim are the brand's own denim lines — genuinely this brand, sharing its price band — so they fold onto 'Tommy Hilfiger' with the line carried in the style. Contrast Tommy Bahama, which shares only the first name and is a different company. The corporate fact decides, not the string."},{"tell":"PVH is Calvin Klein's parent too","detail":"Informational: Tommy Hilfiger is owned by PVH, which also owns Calvin Klein. Ordinary corporate provenance; not a tag tell and not a counterfeit signal."}]$j$::jsonb,
  'US sizing; classic/preppy cut, generally true to size and the most conservative grade in this group alongside Banana Republic. THE ERA IS THE PRICE: 1990s big-flag/crest Tommy (the hip-hop-era collectible) resells for MULTIPLES of the visually similar modern mainline piece, and the brand name on the tag is identical for both. That is an ERA, not a LINE — no second brand to key. AND THE MODERN REVIVAL LOOKS LIKE THE VINTAGE ON PURPOSE: Tommy Jeans (~2018+) deliberately reissues the 90s flag look, so the GRAPHIC cannot date the garment — only the label and tag construction can. NOT TOMMY BAHAMA — a different company (Oxford Industries) sharing a first name, so a bare "Tommy" is never decisive; unlike Vince/Vince Camuto neither full name contains the other, so full-name matching separates them. Tommy Jeans IS this brand and folds. Owned by PVH (Calvin Klein''s parent). NEVER auto-authenticate.',
  'https://usa.tommy.com/', 0.72, false, 'migration:00458')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- Per the story note ("prioritize size charts + fit names over deep decoders"),
-- these lean on the FIT/LINE names buyers actually search rather than on deep
-- per-product fingerprints: on a $12 staple the fit name and the line ARE the
-- identification, and the silhouette is not worth describing.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values

  -- Uniqlo. The fabric platform IS the style here — see the decoder below.
  ('uniqlo', 'HEATTECH', 'Unisex', 'base layer', 'HEATTECH',
   'Thin thermal base layer; the tell is the printed HEATTECH label rather than the silhouette, which is an ordinary crew/scoop base layer. Sold in graded warmth levels (standard / Extra Warm / Ultra Warm) which are printed on the label — do not infer the level from thickness in a photo.',
   ARRAY['HEATTECH']::text[], '2003-present', '$15-40',
   ARRAY['heattech','thermal','base layer','uniqlo heattech','extra warm']::text[],
   'https://www.uniqlo.com/', 0.72, false, 'migration:00458'),

  ('uniqlo', 'AIRism', 'Unisex', 'base layer', 'AIRism',
   'Lightweight moisture-wicking base layer/innerwear. Again the printed AIRism label is the tell, not the cut. AIRism is also used as a fabric in outerwear and shirting, so the token can appear on a garment that is not a base layer — read the garment, use the label for the fabric.',
   ARRAY['AIRism']::text[], '2012-present', '$10-30',
   ARRAY['airism','innerwear','base layer','uniqlo airism','wicking']::text[],
   'https://www.uniqlo.com/', 0.70, false, 'migration:00458'),

  ('uniqlo', 'Ultra Light Down', 'Unisex', 'jacket', 'Ultra Light Down',
   'Uniqlo''s signature packable down jacket — very light, compressible, typically with a matching stuff pouch (the pouch is frequently missing on resale and its absence is worth noting rather than grading down). NOTE this style name is a DESCRIPTIVE PHRASE, not a brand-unique token: it names the PIECE and must never be used to recover the brand. Contrast HEATTECH.',
   ARRAY['Ultra Light Down']::text[], '2009-present', '$40-90',
   ARRAY['ultra light down','uld','packable down','puffer','uniqlo down']::text[],
   'https://www.uniqlo.com/', 0.70, false, 'migration:00458'),

  ('uniqlo', 'BLOCKTECH', 'Unisex', 'jacket', 'BLOCKTECH',
   'Windproof/water-repellent shell fabric, used across parkas and coats. The printed BLOCKTECH label is the tell and is brand-unique.',
   ARRAY['BLOCKTECH']::text[], '2013-present', '$50-100',
   ARRAY['blocktech','shell','windproof','water repellent','uniqlo parka']::text[],
   'https://www.uniqlo.com/', 0.65, false, 'migration:00458'),

  ('uniqlo', '+J (Jil Sander)', 'Unisex', 'collaboration', '+J',
   'The Jil Sander collaboration line, labelled "+J" on the neck tag. THE biggest resale multiplier on the brand — a +J piece is not priced like a Uniqlo staple. The label is the only reliable tell; the design is minimalist and does not announce itself.',
   ARRAY[]::text[], '2009-2011, revived 2020-2021', 'resale well above mainline',
   ARRAY['+j','jil sander','uniqlo +j','plus j','collab']::text[],
   'https://www.uniqlo.com/', 0.68, false, 'migration:00458'),

  ('uniqlo', 'Uniqlo U', 'Unisex', 'line', 'Uniqlo U',
   'The Christophe Lemaire-led in-house line, labelled "Uniqlo U". Carries a modest premium over mainline. A LINE, not a season — it folds onto the Uniqlo brand with the line kept in the style.',
   ARRAY[]::text[], '2016-present', 'modest premium over mainline',
   ARRAY['uniqlo u','lemaire','uniqlo you']::text[],
   'https://www.uniqlo.com/', 0.65, false, 'migration:00458'),

  -- Gap.
  ('gap', 'Gap Arch Logo Sweatshirt', 'Unisex', 'sweatshirt', 'Gap Logo',
   'The spell-out/arch "GAP" chest sweatshirt and hoodie — the brand''s most-resold single garment. The 1990s blue-box-logo version is the collectible one and is a different price from the modern reissue, which deliberately revives the look: the GRAPHIC cannot date it, only the label can.',
   ARRAY[]::text[], '1990s original; reissued repeatedly', '$20-60 modern; vintage well above',
   ARRAY['gap logo','arch logo','gap hoodie','gap sweatshirt','vintage gap']::text[],
   'https://www.gap.com/', 0.65, false, 'migration:00458'),

  ('gap', 'Gap 1969 Denim', 'Unisex', 'jeans', '1969 Denim',
   'Gap''s denim line, marked "1969" (the founding year) on the tag or patch. Graded in true waist/inseam inches, which is the reliable number on the garment.',
   ARRAY[]::text[], '~2009-present', '$30-70',
   ARRAY['gap 1969','gap denim','gap jeans','1969']::text[],
   'https://www.gap.com/', 0.60, false, 'migration:00458'),

  ('gap', 'Gap Factory (outlet line)', 'Unisex', 'line', 'Gap Factory',
   'NOT A GARMENT — a LINE, seeded as a style so it is DISCLOSED on the listing. Gap Factory (formerly Gap Outlet) is made FOR the outlet at a lower spec and a lower price band; it is NOT mainline overstock. The tag says "Gap Factory". The brand folds to Gap (no separate eBay catalogue brand exists), so this is the only place the distinction can survive into the listing.',
   ARRAY[]::text[], 'ongoing', 'below mainline Gap',
   ARRAY['gap factory','gap outlet','factory store']::text[],
   'https://www.gapfactory.com/', 0.62, false, 'migration:00458'),

  ('gap', 'babyGap / GapKids', 'Kids', 'line', 'GapKids',
   'Gap''s kids and baby sub-labels, printed as the concatenated "babyGap" / "GapKids". A DEPARTMENT, not a price tier — folds onto the Gap brand with the sub-label kept in the style.',
   ARRAY[]::text[], 'ongoing', '$10-40',
   ARRAY['babygap','gapkids','gap kids','baby gap']::text[],
   'https://www.gap.com/', 0.60, false, 'migration:00458'),

  -- Banana Republic.
  ('bananarepublic', 'Safari-era Banana Republic', 'Unisex', 'vintage', 'Safari / travel era',
   'THE Banana Republic collectible, and effectively a different brand: 1978-~1988 safari and travel outfitting — surplus-derived jackets, bush shirts, cotton/khaki utility pieces — from the Zieglers'' hand-illustrated-catalogue era. Its buyers and prices have nothing to do with the modern mall tailoring brand. Identify it from the LABEL, not the khaki: modern BR also sells utility-looking cotton.',
   ARRAY[]::text[], '1978-~1988', 'vintage collectible; well above modern BR',
   ARRAY['safari','vintage banana republic','travel','bush jacket','ziegler']::text[],
   'https://bananarepublic.gap.com/', 0.60, false, 'migration:00458'),

  ('bananarepublic', 'Sloan Fit Pant', 'Women', 'pant', 'Sloan',
   'BR''s long-running slim ankle work trouser and one of its most searched tokens by name. The fit name is printed on the tag; the silhouette is an ordinary slim ankle pant and does not identify itself in a photo.',
   ARRAY[]::text[], '~2013-present', '$40-90',
   ARRAY['sloan','sloan fit','ankle pant','work pant','banana republic sloan']::text[],
   'https://bananarepublic.gap.com/', 0.60, false, 'migration:00458'),

  ('bananarepublic', 'Merino Sweater', 'Unisex', 'sweater', 'Merino',
   'BR''s merino wool knit program is a core resale item and the FIBRE is the value: a merino BR sweater and an acrylic-blend one are the same silhouette at different money, and a photo cannot tell them apart. Read the care label.',
   ARRAY['Merino wool']::text[], 'ongoing', '$30-80',
   ARRAY['merino','wool sweater','banana republic merino','knit']::text[],
   'https://bananarepublic.gap.com/', 0.58, false, 'migration:00458'),

  ('bananarepublic', 'Banana Republic Factory Store (outlet line)', 'Unisex', 'line', 'BR Factory',
   'NOT A GARMENT — a LINE, seeded as a style so it is DISCLOSED. "Banana Republic Factory Store" is made FOR the outlet at a lower spec and a lower price band, NOT mainline overstock. The tag differs from mainline by two words. The brand folds to Banana Republic, so this is the only place the distinction survives into the listing.',
   ARRAY[]::text[], 'ongoing', 'below mainline BR',
   ARRAY['br factory','banana republic factory','factory store','outlet']::text[],
   'https://bananarepublicfactory.gapfactory.com/', 0.62, false, 'migration:00458'),

  -- Old Navy.
  ('oldnavy', 'Rockstar Jeans', 'Women', 'jeans', 'Rockstar',
   'Old Navy''s long-running skinny/jegging denim family and the brand''s most searched denim token. The fit name is printed on the tag or pocket flasher. NOTE "Rockstar" is an ordinary English word — it is this fit ONLY on an actual Old Navy garment.',
   ARRAY[]::text[], '~2010-present', '$15-40',
   ARRAY['rockstar','rock star jeans','jegging','skinny','old navy rockstar']::text[],
   'https://oldnavy.gap.com/', 0.60, false, 'migration:00458'),

  ('oldnavy', 'Pixie Pant', 'Women', 'pant', 'Pixie',
   'Old Navy''s ankle-pant family; a high-volume resale staple searched by name. NOTE "Pixie" is an ordinary English word — this fit ONLY on an actual Old Navy garment.',
   ARRAY[]::text[], '~2013-present', '$15-35',
   ARRAY['pixie','pixie pant','ankle pant','old navy pixie']::text[],
   'https://oldnavy.gap.com/', 0.58, false, 'migration:00458'),

  ('oldnavy', 'Powersoft', 'Unisex', 'activewear', 'Powersoft',
   'Old Navy''s activewear fabric platform, printed on the tag. Structurally the same kind of token as Uniqlo''s HEATTECH — a coined fabric name — but it is deliberately NOT seeded as a decoder: the trademark set cannot be enumerated here with a citation, and a decoder built on recall is worse than none. Use it as a keyword only.',
   ARRAY['Powersoft']::text[], 'ongoing', '$10-30',
   ARRAY['powersoft','old navy active','leggings','activewear']::text[],
   'https://oldnavy.gap.com/', 0.55, false, 'migration:00458'),

  -- American Eagle.
  ('americaneagle', 'Aerie', 'Women', 'line', 'Aerie',
   'AE''s intimates/loungewear/swim sub-brand, and the pack''s one "the tag does not say the parent" case. An Aerie tag frequently carries no "American Eagle" anywhere. It shares AE''s price band, so it FOLDS onto the brand with "Aerie" kept here in the style — buyers search "Aerie" heavily and dropping the line loses them. NOTE "aerie" is an ordinary English noun (an eagle''s nest).',
   ARRAY[]::text[], '2006-present', '$15-60',
   ARRAY['aerie','aerie by american eagle','loungewear','intimates','offline']::text[],
   'https://www.aerie.com/', 0.65, false, 'migration:00458'),

  ('americaneagle', 'AE Jeans (named fit)', 'Unisex', 'jeans', 'AE Denim',
   'Denim is American Eagle''s volume product and the piece most likely to be resold. AE names its fits and stretch platforms and prints the name on the tag or pocket flasher — the named fit is the listing token buyers search and it separates two visually identical pairs at different values. Graded in true waist/inseam inches, which is the reliable number. Read the fit off the tag; never guess it from the photo.',
   ARRAY[]::text[], 'ongoing', '$25-60',
   ARRAY['ae jeans','american eagle jeans','denim','curvy','jegging']::text[],
   'https://www.ae.com/', 0.58, false, 'migration:00458'),

  -- Abercrombie & Fitch.
  ('abercrombiefitch', 'Vintage sporting-goods A&F (pre-1977)', 'Unisex', 'vintage', 'Original A&F',
   'A DIFFERENT COMPANY, seeded here as a style because there is no second brand to key. The original Abercrombie & Fitch (1892-1977) was an elite sporting goods and expedition outfitter — Roosevelt''s and Hemingway''s — that went bankrupt before the mall brand bought the name. A serious vintage collectible with nothing in common with mall-era A&F but the name. The LABEL identifies it.',
   ARRAY[]::text[], '1892-1977', 'vintage collectible; unrelated to mall-era pricing',
   ARRAY['vintage abercrombie','sporting goods','pre-1977','expedition','safari']::text[],
   'https://www.abercrombie.com/', 0.55, false, 'migration:00458'),

  ('abercrombiefitch', 'Logo / Moose-era A&F', 'Unisex', 'tee', 'Logo era',
   'The ~1997-2010 logo-heavy mall era — the moose, big chest graphics, spell-out branding. A distinct and rising Y2K collectible priced above the modern rebranded product, and the most counterfeited A&F. NOTE the modern brand deliberately dropped heavy logo branding, so an absent logo on a modern piece is NORMAL and is not a removed graphic or a fake.',
   ARRAY[]::text[], '~1997-2010', 'above modern A&F band',
   ARRAY['moose','abercrombie logo','y2k','vintage abercrombie','spell out']::text[],
   'https://www.abercrombie.com/', 0.60, false, 'migration:00458'),

  ('abercrombiefitch', 'Curve Love Denim', 'Women', 'jeans', 'Curve Love',
   'A&F''s named denim fit built for a smaller waist-to-hip ratio, printed on the tag. One of the brand''s strongest modern resale tokens and searched by name — the modern A&F denim program is well regarded and is a genuine exception to this group''s low-value pattern.',
   ARRAY[]::text[], '~2019-present', '$40-90',
   ARRAY['curve love','abercrombie jeans','denim','a&f denim']::text[],
   'https://www.abercrombie.com/', 0.58, false, 'migration:00458'),

  -- Tommy Hilfiger.
  ('tommyhilfiger', 'Vintage flag-logo Tommy', 'Unisex', 'vintage', '1990s flag era',
   'THE Tommy collectible and the largest era multiplier in this brand group: 1990s big-flag/crest branding, adopted by hip-hop culture and collected as such, reselling for MULTIPLES of the visually similar modern piece. CRITICAL — the modern Tommy Jeans revival DELIBERATELY reissues this look, so the GRAPHIC cannot date the garment. Only the LABEL and tag construction separate them. Never claim the vintage era from the graphic alone.',
   ARRAY[]::text[], '~1990-2000', 'multiples of modern mainline',
   ARRAY['vintage tommy','flag logo','tommy hilfiger vintage','90s tommy','crest']::text[],
   'https://usa.tommy.com/', 0.62, false, 'migration:00458'),

  ('tommyhilfiger', 'Tommy Jeans', 'Unisex', 'line', 'Tommy Jeans',
   'The brand''s denim/streetwear LINE, printed "Tommy Jeans" on the label. Genuinely this brand and in its price band, so it folds onto Tommy Hilfiger with the line kept here (contrast Tommy Bahama, a different company sharing only a first name). The 1990s original belongs to the collectible flag era; the ~2018 revival deliberately reissues that look and is NOT the vintage.',
   ARRAY[]::text[], '1990s original; revived ~2018', '$30-90 modern',
   ARRAY['tommy jeans','tommy hilfiger denim','tj','tommy jeans revival']::text[],
   'https://usa.tommy.com/', 0.62, false, 'migration:00458'),

  ('tommyhilfiger', 'Crest / Rugby Polo', 'Men', 'polo', 'Classic',
   'The brand''s preppy core: crest-branded and rugby-striped polos and shirts. A high-volume resale staple. The 1990s versions belong to the collectible era; the modern ones are the ordinary mall band, and — as everywhere on this brand — the label rather than the graphic decides which.',
   ARRAY[]::text[], 'ongoing', '$20-60 modern',
   ARRAY['tommy polo','rugby','crest','preppy','tommy hilfiger shirt']::text[],
   'https://usa.tommy.com/', 0.58, false, 'migration:00458')

on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: ONE — Uniqlo's fabric-tech trademarks. ────────────────
--
-- The first decoder in three groups, and the reasoning is in the header. Briefly:
-- 00456 refused because the identifier is a GRAPHIC (not on the tag, not
-- parseable); 00457 refused because the identifier is an ordinary GIVEN NAME (not
-- brand-unique). Uniqlo's fabric trademarks pass all three tests — printed on the
-- care label, a closed regular set, and COINED words that mean nothing in English.
--
-- This is what gives the group its cut-tag recovery case: brand tag gone, care
-- label reads HEATTECH, brand recovers to Uniqlo. Asserted in the golden set.
--
-- SCOPE IS DELIBERATELY NARROW. Only the four tokens that can be sourced are
-- listed. "ULTRA LIGHT DOWN" is excluded because it is a DESCRIPTIVE ENGLISH
-- PHRASE (any brand may call a jacket an ultra light down jacket) — it fails
-- brand-unique for exactly the reason the other four pass. Old Navy's "Powersoft"
-- and American Eagle's "AirFlex" are the same coined shape and are omitted for a
-- different reason: their trademark SETS cannot be enumerated here with a
-- citation, and a decoder firing on a half-remembered token list is worse than no
-- decoder. Extend on evidence, not on recall.
--
-- The pattern is anchored (^...$) and matches the WHOLE tag token — never a
-- substring — so it cannot fire on prose that merely contains the word.
--
-- THE WARMTH GRADE IS MATCHED BUT NOT CAPTURED, and that is deliberate rather
-- than an oversight. HEATTECH's level (Extra Warm / Ultra Warm) is printed on the
-- label and is real, but DecodeResult (brand-decoders.ts) has NO field to put it
-- in — its derived fields are gender/styleCode/size/colorInitial/colorway/season/
-- year. A fieldMap entry pointing at a field that does not exist would be written
-- onto the result object as a phantom property that nothing ever reads: silently
-- dead, and worse, it would look seeded. So the level sits in a NON-CAPTURING
-- group — "HEATTECH EXTRA WARM" still matches and still recovers the brand, and
-- the level survives as prose on the style row, where it is actually read.
--
-- fieldMap maps `style` -> styleCode SPECIFICALLY because brand recovery in
-- enrichExtractionWithBrandKnowledge keys off a decoder hit HAVING a styleCode
-- (`decoderHits.find((h) => h.styleCode)`). A decoder that captured nothing into
-- styleCode would match and recover NOTHING. The canonical spelling then comes
-- from pack.brand, not from the decoder — so "Uniqlo" is spelled correctly
-- without an entry in brand-decoders' KEY_TO_CANONICAL map.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by)
values ('uniqlo', 'style_name',
  'Care/neck-label fabric-technology trademark. Uniqlo prints its coined fabric platform name on the label as the selling point; the token is brand-unique (it means nothing in English), so it identifies the brand even when the brand tag itself is cut. An optional trailing HEATTECH warmth level (Extra Warm / Ultra Warm) is tolerated but not captured.',
  '^(?<style>HEATTECH|AIRISM|BLOCKTECH|DRY-?EX)(?:\s+(?:EXTRA\s+WARM|ULTRA\s+WARM))?$',
  $j${"fieldMap": {"style": "styleCode"}, "transforms": {"style": "upper"}, "confidence": 0.72}$j$::jsonb,
  $j$[{"input":"HEATTECH","note":"bare platform token — recovers brand Uniqlo"},{"input":"HEATTECH EXTRA WARM","note":"graded warmth level printed on the label"},{"input":"AIRism","note":"case-insensitive; the tag prints mixed case"},{"input":"BLOCKTECH","note":"shell fabric"},{"input":"DRY-EX","note":"hyphen optional"}]$j$::jsonb,
  'https://www.uniqlo.com/', 0.72, false, 'migration:00458')
on conflict (brand_key, decoder_kind) do update set
  description = excluded.description, pattern = excluded.pattern,
  extraction_rules = excluded.extraction_rules, examples = excluded.examples,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_colorways: NONE. ──────────────────────────────────────────────────
--
-- The third group running with none, and the third distinct reason — worth
-- recording rather than repeating. 00457 had nothing proprietary to seed (its
-- colours are seasonal English words). Six of these seven are the same: "Heather
-- Grey", "True Black" — ordinary descriptive words, nothing to seed.
--
-- UNIQLO IS THE EXCEPTION, AND IT IS OMITTED ANYWAY. Uniqlo prints a genuine
-- 2-digit COLOR NUMBER on the tag — proprietary, stable, and exactly the system
-- this table exists for. It is not seeded because the MAPPING cannot be cited
-- here, and a colour decoder built from recall would mislabel silently and
-- confidently on every listing it touched. The honest half — that the number
-- exists and must not be guessed at — is seeded as an authentication tell on the
-- Uniqlo row instead. The mapping waits for a source. This is the same rule that
-- kept Chanel's colours out of 00455 and the denim washes out of 00454.

-- ── brand_size_charts ───────────────────────────────────────────────────────
--
-- The story's priority ("prioritize size charts + fit names"), and the pack's real
-- sizing story is the SPREAD: this group's tags all say the same letters and mean
-- different bodies.
--
--     Uniqlo          runs SMALL   — Japanese grade, slim through the shoulders.
--     Old Navy        runs LARGE   — value-tier vanity sizing.
--     American Eagle  runs LARGE   — same pattern.
--     Gap / BR / A&F / Tommy       — true-to-size (A&F slim in menswear).
--
-- So a Uniqlo M and an Old Navy M are meaningfully different garments and NOTHING
-- ON EITHER TAG SAYS SO. Each cross-map is written INSIDE THE SIZE LABEL where the
-- model actually reads it (the 00455 lesson), not in a note alone.
--
-- These are body-equivalent approximations in INCHES for the nominal grade, not
-- brand-published specs — hence the modest confidence. They ground the measurement
-- -> size mapping; the model still reads the photos.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values

  -- Uniqlo — RUNS SMALL (the opposite end of this group's spread).
  ('uniqlo', 'Uniqlo', ARRAY['uniqlo']::text[], 'Women', 'Tops (alpha, RUNS SMALL)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','cardigan','base layer','heattech','airism','long sleeve']::text[],
   $json$[{"size":"XS (fits ≈US 0-2)","measurements":{"bust":"31-32.5","waist":"24-25.5"}},{"size":"S (fits ≈US 2-4)","measurements":{"bust":"33-34.5","waist":"26-27.5"}},{"size":"M (fits ≈US 4-6)","measurements":{"bust":"35-36.5","waist":"28-29.5"}},{"size":"L (fits ≈US 8-10)","measurements":{"bust":"37.5-39","waist":"30.5-32"}},{"size":"XL (fits ≈US 12)","measurements":{"bust":"40-41.5","waist":"33-34.5"}},{"size":"XXL (fits ≈US 14)","measurements":{"bust":"42.5-44","waist":"35.5-37"}}]$json$::jsonb,
   'Uniqlo RUNS SMALL: the grade is cut to a Japanese fit and sits roughly one size below a general US body — a Uniqlo M is nearer a US 4-6. Old Navy and American Eagle in this SAME group run the OPPOSITE way (vanity-sized), and every one of these tags says only a letter, so the cross-map is written into the size label rather than left to the note. HEATTECH and AIRism base layers are cut CLOSE TO THE BODY BY DESIGN — that is the function of a base layer, not a small size or a shrunk garment, and it must not be graded as one. These are body-equivalent figures in inches for the nominal grade, not Uniqlo-published specs. Measure the garment flat (bust across the underarm seam, doubled) and treat the tag as a claim to check.',
   'https://www.uniqlo.com/', 0.55, false, 'migration:00458'),

  ('uniqlo', 'Uniqlo', ARRAY['uniqlo']::text[], 'Men', 'Tops (alpha, RUNS SMALL)',
   ARRAY['top','tee','shirt','polo','knit','sweater','sweatshirt','base layer','heattech','airism','long sleeve']::text[],
   $json$[{"size":"XS (fits ≈US XS)","measurements":{"chest":"33-35","waist":"27-29"}},{"size":"S (fits ≈US XS-S)","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M (fits ≈US S-M)","measurements":{"chest":"37-39.5","waist":"31-33.5"}},{"size":"L (fits ≈US M-L)","measurements":{"chest":"39.5-42","waist":"33.5-36"}},{"size":"XL (fits ≈US L-XL)","measurements":{"chest":"42-44.5","waist":"36-38.5"}},{"size":"XXL (fits ≈US XL)","measurements":{"chest":"44.5-47","waist":"38.5-41"}}]$json$::jsonb,
   'Uniqlo menswear RUNS SMALL and SLIM against a US body — roughly one size down, and the difference is most pronounced across the SHOULDERS and chest rather than the length. A Uniqlo L fits nearer a US M. The cross-map is in the size label because the tag says only a letter. Base layers (HEATTECH/AIRism) are cut close to the body BY DESIGN — not a small size and not shrinkage; do not grade the fit as a defect. Body-equivalent figures in inches, not published specs. Measure the chest flat across the underarm seam and double it.',
   'https://www.uniqlo.com/', 0.55, false, 'migration:00458'),

  -- Gap — true to size.
  ('gap', 'Gap', ARRAY['gap','babygap','gapkids','gapfit','gapbody']::text[], 'Women', 'Tops (alpha/numeric)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','sweatshirt','hoodie','cardigan','long sleeve']::text[],
   $json$[{"size":"XS (0-2)","measurements":{"bust":"32.5-34","waist":"25-26.5"}},{"size":"S (4-6)","measurements":{"bust":"35-36.5","waist":"27.5-29"}},{"size":"M (8-10)","measurements":{"bust":"37.5-39.5","waist":"30-32"}},{"size":"L (12-14)","measurements":{"bust":"41-43","waist":"33.5-35.5"}},{"size":"XL (16-18)","measurements":{"bust":"44.5-46.5","waist":"37-39"}},{"size":"XXL (20)","measurements":{"bust":"48-50","waist":"40.5-42.5"}}]$json$::jsonb,
   'Gap is broadly TRUE TO SIZE with a relaxed house cut — it does not carry the vanity-sizing lean that Old Navy and American Eagle do in this same group, despite Old Navy sharing its parent (Gap Inc). Note the brandMatch list carries the CONCATENATED sub-label spellings (babyGap, GapKids, GapFit, GapBody) explicitly: the matcher requires a token to start a word, so a bare "gap" does NOT fire inside "babygap". These are body-equivalent figures in inches, not Gap-published specs. Measure the garment flat and treat the tag as a claim to check.',
   'https://www.gap.com/', 0.55, false, 'migration:00458'),

  ('gap', 'Gap', ARRAY['gap','babygap','gapkids','gapfit','gapbody']::text[], 'Women', 'Bottoms / denim (true waist inches)',
   ARRAY['bottom','pant','jean','denim','trouser','short','skirt','legging','1969']::text[],
   $json$[{"size":"24 (00)","measurements":{"waist":"24-24.5","hip":"34-34.5"}},{"size":"25 (0)","measurements":{"waist":"25-25.5","hip":"35-35.5"}},{"size":"26 (2)","measurements":{"waist":"26-26.5","hip":"36-36.5"}},{"size":"27 (4)","measurements":{"waist":"27-27.5","hip":"37-37.5"}},{"size":"28 (6)","measurements":{"waist":"28-28.5","hip":"38-38.5"}},{"size":"29 (8)","measurements":{"waist":"29-29.5","hip":"39-39.5"}},{"size":"30 (10)","measurements":{"waist":"30-31","hip":"40-41"}},{"size":"31 (12)","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32 (14)","measurements":{"waist":"32-33.5","hip":"42-43.5"}}]$json$::jsonb,
   'Gap denim is graded in TRUE WAIST INCHES, which makes it the most reliable number in this whole brand group — an alpha tag is a claim, a waist number is close to a measurement. The parenthesised US numeric size is the rough equivalent. Gap 1969 is the denim line marking. Measure the flat waistband and DOUBLE it; measure across the widest point of the hip and double. Stretch denim measures smaller relaxed than it wears — note the fibre content. Body-equivalent figures in inches, not published specs.',
   'https://www.gap.com/', 0.55, false, 'migration:00458'),

  -- Banana Republic — true to size, the most conservative grade here.
  ('bananarepublic', 'Banana Republic', ARRAY['banana republic','bananarepublic']::text[], 'Women', 'Tops (alpha/numeric)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','cardigan','merino','long sleeve']::text[],
   $json$[{"size":"XXS (00)","measurements":{"bust":"31-32","waist":"23.5-24.5"}},{"size":"XS (0-2)","measurements":{"bust":"32.5-34","waist":"25-26.5"}},{"size":"S (4-6)","measurements":{"bust":"35-36.5","waist":"27.5-29"}},{"size":"M (8-10)","measurements":{"bust":"37.5-39.5","waist":"30-32"}},{"size":"L (12-14)","measurements":{"bust":"41-43","waist":"33.5-35.5"}},{"size":"XL (16)","measurements":{"bust":"44.5-46","waist":"37-38.5"}}]$json$::jsonb,
   'Banana Republic is TRUE TO SIZE with a tailored workwear cut — alongside Tommy Hilfiger the most conservative grade in this group, and a full step away from Old Navy''s vanity sizing despite the shared Gap Inc parent. TWO ERAS ARE NOT THE SAME PRODUCT: safari-era BR (1978-~1988) is a vintage collectible on its own grade and is not comparable to the modern brand — check the label before applying this chart. The "Factory Store" line is a lower-spec outlet product; the sizing is comparable but the value is not. On merino knits the FIBRE is the value and cannot be read off a photo. Body-equivalent figures in inches, not published specs. Measure flat and double.',
   'https://bananarepublic.gap.com/', 0.55, false, 'migration:00458'),

  ('bananarepublic', 'Banana Republic', ARRAY['banana republic','bananarepublic']::text[], 'Men', 'Tops (alpha)',
   ARRAY['top','tee','shirt','polo','knit','sweater','merino','oxford','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36","neck":"14-14.5"}},{"size":"S","measurements":{"chest":"36-38","neck":"14.5-15"}},{"size":"M","measurements":{"chest":"38-40","neck":"15-15.5"}},{"size":"L","measurements":{"chest":"41-43","neck":"15.5-16"}},{"size":"XL","measurements":{"chest":"44-46","neck":"16.5-17"}},{"size":"XXL","measurements":{"chest":"47-49","neck":"17.5-18"}}]$json$::jsonb,
   'Banana Republic menswear is TRUE TO SIZE and tailored. Dress shirts are frequently graded by NECK and SLEEVE rather than by an alpha size, and where both appear the neck/sleeve numbers are the reliable ones — an alpha is a claim. BR also cuts the same shirt in named fits (slim/standard), which change the body but not the neck: read the fit off the tag, never from the drape in a photo. Body-equivalent figures in inches, not published specs. Measure the chest flat across the underarm seam and double it.',
   'https://bananarepublic.gap.com/', 0.55, false, 'migration:00458'),

  -- Old Navy — RUNS LARGE (the other end of the spread from Uniqlo).
  ('oldnavy', 'Old Navy', ARRAY['old navy','oldnavy']::text[], 'Women', 'Tops (alpha, RUNS LARGE)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','sweatshirt','hoodie','tank','long sleeve']::text[],
   $json$[{"size":"XS (fits ≈US 0-2)","measurements":{"bust":"33-34.5","waist":"25.5-27"}},{"size":"S (fits ≈US 4-6)","measurements":{"bust":"35.5-37","waist":"28-29.5"}},{"size":"M (fits ≈US 8-10)","measurements":{"bust":"38-40","waist":"30.5-32.5"}},{"size":"L (fits ≈US 12-14)","measurements":{"bust":"41.5-43.5","waist":"34-36"}},{"size":"XL (fits ≈US 16-18)","measurements":{"bust":"45-47","waist":"37.5-39.5"}},{"size":"XXL (fits ≈US 20)","measurements":{"bust":"48.5-50.5","waist":"41-43"}}]$json$::jsonb,
   'Old Navy RUNS LARGE — it is VANITY-SIZED, the value-tier pattern: an Old Navy M sits nearer a US L than the nominal grade suggests. Uniqlo in this SAME group runs the OPPOSITE way (a Uniqlo M is nearer a US 4-6), and both tags say only "M", which is exactly why the cross-map is written into the size label. Old Navy also carries an extended range beyond this table. A garment that measures larger than its tag is NORMAL for this brand — it is the grade, not stretching, not a mislabel, and not a defect to grade down. Body-equivalent figures in inches, not published specs. Measure flat and double.',
   'https://oldnavy.gap.com/', 0.55, false, 'migration:00458'),

  ('oldnavy', 'Old Navy', ARRAY['old navy','oldnavy']::text[], 'Women', 'Bottoms / denim (RUNS LARGE)',
   ARRAY['bottom','pant','jean','denim','trouser','short','skirt','legging','rockstar','pixie']::text[],
   $json$[{"size":"0 (waist ≈25)","measurements":{"waist":"25-25.5","hip":"35-35.5"}},{"size":"2 (waist ≈26)","measurements":{"waist":"26-26.5","hip":"36-36.5"}},{"size":"4 (waist ≈27)","measurements":{"waist":"27-27.5","hip":"37-37.5"}},{"size":"6 (waist ≈28)","measurements":{"waist":"28-28.5","hip":"38-38.5"}},{"size":"8 (waist ≈29)","measurements":{"waist":"29-30","hip":"39-40"}},{"size":"10 (waist ≈31)","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"12 (waist ≈32.5)","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}},{"size":"14 (waist ≈34)","measurements":{"waist":"34-35.5","hip":"44-45.5"}}]$json$::jsonb,
   'Old Navy bottoms are VANITY-SIZED and run LARGE — the numeric size sits generous against a true waist measurement, so the waist inches in this table are the reliable number and the tag number is a claim. Rockstar (skinny/jegging) and Pixie (ankle) are the named fits buyers search; both are ordinary English words and are fit names ONLY on an actual Old Navy garment. Rockstar denim is heavily STRETCH — it measures smaller relaxed than it wears, so note the fibre content and measure relaxed rather than pulling the waistband taut. Body-equivalent figures in inches, not published specs. Measure the flat waistband and double it.',
   'https://oldnavy.gap.com/', 0.55, false, 'migration:00458'),

  -- American Eagle — RUNS LARGE; denim is the brand.
  ('americaneagle', 'American Eagle', ARRAY['american eagle','americaneagle','aerie']::text[], 'Women', 'Jeans / bottoms (true waist inches)',
   ARRAY['bottom','pant','jean','denim','jegging','short','skirt','legging','curvy']::text[],
   $json$[{"size":"00 (waist ≈23)","measurements":{"waist":"23-23.5","hip":"33-33.5"}},{"size":"0 (waist ≈24)","measurements":{"waist":"24-24.5","hip":"34-34.5"}},{"size":"2 (waist ≈25)","measurements":{"waist":"25-25.5","hip":"35-35.5"}},{"size":"4 (waist ≈26)","measurements":{"waist":"26-26.5","hip":"36-36.5"}},{"size":"6 (waist ≈27)","measurements":{"waist":"27-27.5","hip":"37-37.5"}},{"size":"8 (waist ≈28)","measurements":{"waist":"28-29","hip":"38-39"}},{"size":"10 (waist ≈30)","measurements":{"waist":"30-31","hip":"40-41"}},{"size":"12 (waist ≈31.5)","measurements":{"waist":"31.5-32.5","hip":"41.5-42.5"}},{"size":"14 (waist ≈33)","measurements":{"waist":"33-34.5","hip":"43-44.5"}}]$json$::jsonb,
   'DENIM IS THIS BRAND — jeans are AE''s volume product and the piece most likely to be resold. AE denim is graded in TRUE WAIST INCHES, which makes it far more reliable than the brand''s alpha tops, which RUN LARGE (vanity-sized, the same direction as Old Navy and the opposite of Uniqlo in this same group). The NAMED FIT printed on the tag or pocket flasher is the listing token buyers search and it separates two visually identical pairs at different values — read it off the tag, never guess it from the photo. CURVY is a distinct AE fit cut for a smaller waist-to-hip ratio: a Curvy pair measures a LARGER HIP at the same tagged waist, so it is not a mislabel and must not be graded as a stretched or altered garment. Most AE denim is heavy STRETCH and measures smaller relaxed than it wears. Aerie folds onto this brand and shares the grade. Body-equivalent figures in inches, not published specs. Measure the flat waistband relaxed and double it.',
   'https://www.ae.com/', 0.55, false, 'migration:00458'),

  ('americaneagle', 'American Eagle', ARRAY['american eagle','americaneagle','aerie']::text[], 'Men', 'Jeans / bottoms (W x L inches)',
   ARRAY['bottom','pant','jean','denim','trouser','short','chino']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28-28.5","hip":"35-36"}},{"size":"W29","measurements":{"waist":"29-29.5","hip":"36-37"}},{"size":"W30","measurements":{"waist":"30-30.5","hip":"37-38"}},{"size":"W31","measurements":{"waist":"31-31.5","hip":"38-39"}},{"size":"W32","measurements":{"waist":"32-32.5","hip":"39-40"}},{"size":"W33","measurements":{"waist":"33-33.5","hip":"40-41"}},{"size":"W34","measurements":{"waist":"34-34.5","hip":"41-42"}},{"size":"W36","measurements":{"waist":"36-36.5","hip":"43-44"}},{"size":"W38","measurements":{"waist":"38-38.5","hip":"45-46"}},{"size":"W40","measurements":{"waist":"40-40.5","hip":"47-48"}}]$json$::jsonb,
   'AE menswear denim is tagged W x L in TRUE INCHES — the most reliable sizing in this brand group, since both numbers are measurements rather than a graded claim. ALWAYS capture the INSEAM (L) as well as the waist: a W32 L30 and a W32 L34 are different products to a buyer and the length is the half most often omitted from a listing. AE stretch denim measures smaller relaxed than it wears; note the fibre content. Body-equivalent figures in inches, not published specs. Measure the flat waistband relaxed, double it, and measure the inseam from the crotch seam to the hem.',
   'https://www.ae.com/', 0.55, false, 'migration:00458'),

  -- Abercrombie & Fitch — mall-era cut runs slim, especially menswear.
  ('abercrombiefitch', 'Abercrombie & Fitch', ARRAY['abercrombie','abercrombie & fitch','abercrombiefitch']::text[], 'Women', 'Jeans / bottoms (true waist inches)',
   ARRAY['bottom','pant','jean','denim','short','skirt','curve love']::text[],
   $json$[{"size":"23 (00)","measurements":{"waist":"23-23.5","hip":"33.5-34"}},{"size":"24 (0)","measurements":{"waist":"24-24.5","hip":"34.5-35"}},{"size":"25 (1)","measurements":{"waist":"25-25.5","hip":"35.5-36"}},{"size":"26 (2)","measurements":{"waist":"26-26.5","hip":"36.5-37"}},{"size":"27 (4)","measurements":{"waist":"27-27.5","hip":"37.5-38"}},{"size":"28 (6)","measurements":{"waist":"28-28.5","hip":"38.5-39.5"}},{"size":"29 (8)","measurements":{"waist":"29-29.5","hip":"39.5-40.5"}},{"size":"30 (10)","measurements":{"waist":"30-31","hip":"40.5-41.5"}},{"size":"31 (12)","measurements":{"waist":"31-32","hip":"41.5-42.5"}},{"size":"32 (14)","measurements":{"waist":"32-33.5","hip":"42.5-44"}}]$json$::jsonb,
   'A&F denim is graded in TRUE WAIST INCHES and the modern denim program is well regarded — a genuine exception to this group''s low-value pattern, and the brand''s strongest current resale category. CURVE LOVE is A&F''s named fit cut for a smaller waist-to-hip ratio: a Curve Love pair measures a LARGER HIP (roughly an extra inch or more) at the same tagged waist. That is the DESIGN — it is not a mislabel, not a stretched garment, and must not be graded as either. The fit name is printed on the tag and is a searched listing token; read it off the tag rather than inferring it from the hip measurement alone. Body-equivalent figures in inches, not published specs. Measure the flat waistband relaxed and double it.',
   'https://www.abercrombie.com/', 0.55, false, 'migration:00458'),

  ('abercrombiefitch', 'Abercrombie & Fitch', ARRAY['abercrombie','abercrombie & fitch','abercrombiefitch']::text[], 'Men', 'Tops (alpha, cut SLIM)',
   ARRAY['top','tee','shirt','polo','knit','sweater','sweatshirt','hoodie','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"33-35","waist":"27-29"}},{"size":"S","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M","measurements":{"chest":"37.5-39.5","waist":"31-33"}},{"size":"L","measurements":{"chest":"40-42","waist":"33.5-35.5"}},{"size":"XL","measurements":{"chest":"42.5-45","waist":"36-38"}},{"size":"XXL","measurements":{"chest":"45.5-48","waist":"38.5-41"}}]$json$::jsonb,
   'A&F menswear is cut SLIM — the mall-era grade is trim through the chest and body, closer to Uniqlo''s direction than to Old Navy''s in this same group, though not as small. THE ERA MATTERS MORE THAN THE GRADE HERE: ~1997-2010 logo/moose-era A&F is a distinct Y2K collectible priced above the modern rebranded product, and the modern brand deliberately dropped heavy logo branding — an absent logo on a modern piece is NORMAL and is not a removed graphic or a fake. Pre-1977 sporting-goods A&F is a different company entirely and this chart does not apply to it. Body-equivalent figures in inches, not published specs. Measure the chest flat across the underarm seam and double it.',
   'https://www.abercrombie.com/', 0.55, false, 'migration:00458'),

  -- Tommy Hilfiger — true to size, classic cut.
  ('tommyhilfiger', 'Tommy Hilfiger', ARRAY['tommy hilfiger','tommyhilfiger','tommy jeans']::text[], 'Men', 'Tops (alpha)',
   ARRAY['top','tee','shirt','polo','knit','sweater','sweatshirt','hoodie','rugby','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36","neck":"14-14.5"}},{"size":"S","measurements":{"chest":"36-38","neck":"14.5-15"}},{"size":"M","measurements":{"chest":"38-40.5","neck":"15-15.5"}},{"size":"L","measurements":{"chest":"41-43.5","neck":"15.5-16"}},{"size":"XL","measurements":{"chest":"44-46.5","neck":"16.5-17"}},{"size":"XXL","measurements":{"chest":"47-49.5","neck":"17.5-18"}}]$json$::jsonb,
   'Tommy Hilfiger is TRUE TO SIZE with a classic/preppy cut — alongside Banana Republic the most conservative grade in this group, and a full step from Uniqlo''s small grade in either direction. THE ERA IS THE PRICE ON THIS BRAND, AND THE CHART CANNOT SEE IT: 1990s flag-era Tommy was cut deliberately OVERSIZED and resells for MULTIPLES of the modern piece — so a vintage garment measuring far larger than this table is NORMAL for its era and is not a mislabel or a stretched garment. This chart describes the MODERN grade. And the modern Tommy Jeans revival reissues the 90s look ON PURPOSE, so the graphic cannot date the garment — only the label can. Dress shirts are graded by neck/sleeve, which are the reliable numbers. Body-equivalent figures in inches, not published specs. Measure the chest flat across the underarm seam and double it.',
   'https://usa.tommy.com/', 0.55, false, 'migration:00458'),

  ('tommyhilfiger', 'Tommy Hilfiger', ARRAY['tommy hilfiger','tommyhilfiger','tommy jeans']::text[], 'Women', 'Tops (alpha/numeric)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','polo','cardigan','long sleeve']::text[],
   $json$[{"size":"XS (0-2)","measurements":{"bust":"32.5-34","waist":"25-26.5"}},{"size":"S (4-6)","measurements":{"bust":"35-36.5","waist":"27.5-29"}},{"size":"M (8-10)","measurements":{"bust":"37.5-39.5","waist":"30-32"}},{"size":"L (12-14)","measurements":{"bust":"41-43","waist":"33.5-35.5"}},{"size":"XL (16)","measurements":{"bust":"44.5-46","waist":"37-38.5"}},{"size":"XXL (18)","measurements":{"bust":"47.5-49","waist":"40-41.5"}}]$json$::jsonb,
   'Tommy Hilfiger womenswear is TRUE TO SIZE with a classic cut. As on the menswear side, THE ERA IS THE PRICE and this chart describes the MODERN grade only: 1990s flag-era pieces were cut oversized and are a different market — a vintage garment measuring far larger than this table is normal for its era, not a mislabel. The modern revival reissues the 90s look deliberately, so the graphic cannot date the garment; only the label can. Body-equivalent figures in inches, not published specs. Measure the garment flat and double it.',
   'https://usa.tommy.com/', 0.55, false, 'migration:00458')

on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00458') on conflict do nothing;
