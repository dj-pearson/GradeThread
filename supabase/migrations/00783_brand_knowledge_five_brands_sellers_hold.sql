-- US-3125: the last five of the eight brands sellers hold that the KB did not
-- know, plus the two refusals that close the list.
--
-- The eight were measured on prod 2026-09-06 by joining `inventory_items.brand`
-- against `brand_knowledge` on `canonical_brand` AND the `aliases` array, not on
-- a key join -- a fuzzy key match failing is the obvious way to file a story for
-- a brand that is already there. That join is now
-- `scripts/brand-kb-gap.mjs`, so the question can be re-asked instead of
-- re-derived.
--
-- THREE OF THE EIGHT WERE ALREADY DONE BEFORE THIS FILE WAS WRITTEN, and saying
-- so is half the value of the pass: prAna and Pact were seeded by 00731 and
-- Veronica Beard by 00739, both applied to prod on 2026-09-06 -- the same day
-- the measurement was taken, which is why they still read as absent in it.
-- Nothing here re-seeds them.
--
-- ⚠ THESE ARE DELIBERATELY MINIMAL PACKS, AND THE EMPTY COLUMNS ARE THE POINT.
-- `tag_eras`, `country_patterns` and `authentication_tells` are empty and every
-- row's notes say so in words. An empty array here means NOT RESEARCHED. It does
-- NOT mean "researched and there is nothing", which is what an unexplained empty
-- column reads as. See vault/20-domain/brands/brand-kb-negative-findings.md.
--
-- ── The sub-label rule this file settles ───────────────────────────────────
--
-- Lauren Ralph Lauren gets its OWN brand_key rather than an alias on
-- `ralphlauren`, and Ermenegildo Zegna's sub-lines are refused on the same
-- ground. An alias asserts that two strings name the SAME entity, and a
-- sub-label that prices and sizes differently is not the same entity. The rule
-- and its reasoning live in vault/20-domain/brands/brand-kb-alias-refusals.md.
--
-- ── Sourcing ───────────────────────────────────────────────────────────────
--
-- Every `source_url` below is the brand's OWN published page, read on
-- 2026-09-10. Registered numbers were re-read the same day from
-- https://www.ftc.gov/rn-database/search via scripts/ops/ftc-rn-lookup.mjs and
-- are seeded ONLY where the registrant is the label or the corporate link is
-- itself sourced from the label.

insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   notes, source_url, confidence, verified, updated_by)
values
  ('gant', 'GANT',
   ARRAY['gant','gantusa','gant usa']::text[],
   ARRAY['preppy','american sportswear','shirting','rugby shirts','knitwear','menswear','womenswear']::text[],
   ARRAY[]::text[],
   'Read from the brand''s own site on 2026-09-10: "American Sportswear since 1949", with a GANT x Yale University collaboration carried in the navigation for both men and women -- the New Haven origin the house still trades on. Categories are shirts, polo shirts, rugby shirts, tees, sweatshirts, knitwear, jackets, blazers, trousers, jeans and accessories across menswear and womenswear. NO REGISTERED NUMBER SEEDED, and that is a REFUSAL rather than an absence: the FTC register SUBSTRING-matches, so "GANT" returns 100 hits -- L''EGANTE, GANTOS INCORPORATED, GANTS INC, TIMELESS ELEGANTS, ELEGANT SELECTIONS, ELEGANTE ORIGINALS -- and not one of them is this house. Re-run 2026-09-10 with the same result 00731 recorded. ⚠ "gant rugger" IS NOT SEEDED AS AN ALIAS: it is a sub-line, and this file''s Lauren Ralph Lauren decision refuses to fold a sub-label into its house. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.gant.com/', 0.60, false, 'migration:00783'),

  ('quince', 'Quince',
   ARRAY['quince']::text[],
   ARRAY['cashmere','silk','organic cotton','linen','basics','direct-to-consumer','womenswear','menswear']::text[],
   ARRAY['RN 177170']::text[],
   'RN 177170 is FTC-record sourced -- registrant "Last Brand, Inc." 00731 REFUSED this number because the registrant name contains nothing of the label, which is the RN 17257 / Longchamp shape exactly. THE CORPORATE LINK IS NOW SOURCED FROM THE LABEL ITSELF: Quince''s own Terms of Service opens "This website is operated by Last Brand, Inc. (Quince)", read 2026-09-10 at https://www.quince.com/terms. That is the brand naming its own registrant, which is the only thing that turns a plausible hit into a match. The brand''s own site (read the same day) sells Women, Men, Home, Baby & Kids, Jewelry, Beauty & Wellness, Bags & Accessories and Travel, and leads on "100% Mongolian Cashmere" and "100% Washable Silk" under a stated "factory-direct model". ⚠ "last brand" IS NOT AN ALIAS: it is the legal entity, it is two ordinary words, and no garment carries it. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://www.quince.com/', 0.65, false, 'migration:00783'),

  ('7diamonds', '7Diamonds',
   ARRAY['7diamonds','7 diamonds','seven diamonds']::text[],
   ARRAY['menswear','womenswear','denim','printed shirts','california']::text[],
   ARRAY[]::text[],
   'The brand''s own About page, read 2026-09-10: "Since our start in California in 2000, 7Diamonds has been committed to crafting high-quality, refined apparel", with Men, Women, Denim and Accessories as its categories. CANONICAL CASING IS "7Diamonds", one word, because that is how the brand writes it; sellers type "7 Diamonds" with a space, so both are aliases and both normalise to the same key. NO REGISTERED NUMBER, and it is a refusal not an absence: the register substring-matches, so "7 Diamonds" returns DIAMONDS RUN LTD, PRECIOUS AS DIAMONDS, DIAMONDS IN THE CITY LLC, Diamonds and Sweatshirts LLC and five more, none of them this label, while "Seven Diamonds" returns nothing at all. Re-run 2026-09-10. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://www.7diamonds.com/pages/about-us', 0.60, false, 'migration:00783'),

  ('ermenegildozegna', 'Ermenegildo Zegna',
   ARRAY['ermenegildozegna','ermenegildo zegna','zegna']::text[],
   ARRAY['luxury','menswear','tailoring','suiting','wool','knitwear','italy']::text[],
   ARRAY['RN 101133']::text[],
   'RN 101133 is FTC-record sourced -- registrant "ERMENEGILDO ZEGNA CORPORATION", product line "CLOTHING", and it is the ONLY hit the register returns for either "Zegna" or "Ermenegildo Zegna". The registrant IS the label, which is what makes this a match rather than a same-words coincidence. The house''s own group site, read 2026-09-10: "Established as a fabric maker, ZEGNA is internationally recognized as a leading global luxury menswear brand and part of the Ermenegildo Zegna Group", founded "over 110 years ago in the mountains in Piedmont, Northern Italy" and dated to 1910; the group''s other labels are Thom Browne, TOM FORD FASHION and the Filiera textile platform. ⚠ THE LABEL NOW TRADES AS "ZEGNA" AND THE KEY DELIBERATELY DOES NOT. brand_key must equal brandKey(canonical_brand) for brand-normalize.ts to resolve a seller string to this row, and nearly all resale stock carries "Ermenegildo Zegna" -- keying on "zegna" would strand every item a seller types the long way. The current name is an alias instead. ⚠ SUB-LINES ARE NOT ALIASED: "Z Zegna" and "Zegna Couture" are tiers that price differently, and this file''s Lauren Ralph Lauren decision refuses to fold a sub-label into its house. They are NOT RESEARCHED, not merged. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://www.zegnagroup.com/en/brands/', 0.70, false, 'migration:00783'),

  ('laurenralphlauren', 'Lauren Ralph Lauren',
   ARRAY['laurenralphlauren','lauren ralph lauren']::text[],
   ARRAY['womenswear','menswear','dresses','sportswear','tailoring','department store']::text[],
   ARRAY[]::text[],
   'THIS IS A SUB-LABEL OF A HOUSE THE KB ALREADY CARRIES, AND IT GETS ITS OWN KEY. Ralph Lauren Corporation''s own brands page lists five labels -- Ralph Lauren Luxury, Polo Ralph Lauren, Lauren Ralph Lauren, Chaps and Hospitality -- and its page for this one describes Lauren for Women as "a lifestyle collection of sportswear, denim, and dresses, as well as accessories and footwear at a more accessible price point", Lauren for Men as "a complete collection of men''s tailored clothing, including suits, sport coats, dress shirts, dress pants, tuxedos, topcoats, and ties", plus Lauren Home. Read 2026-09-10 at https://corporate.ralphlauren.com/lauren-ralph-lauren and /brands; www.ralphlauren.com answered 307 to automation the same day, which is a bot challenge and not a dead page. THE DECISION, and why it is not an alias: an alias asserts two strings name the SAME entity, and the ralphlauren row''s own tell says "the label wording IS the value tier -- Chaps is NOT Polo Ralph Lauren". Folding "Lauren Ralph Lauren" into ralphlauren would price a department-store dress off Purple Label comps and size it off RL menswear charts, which is the error that tell exists to prevent. The precedent is already in the table: poloralphlauren is a separate brand_key (00389) with its own RN 109514 (00729), and 00629 recorded that folding it into ralphlauren''s aliases CONTRADICTS brand-normalize.ts. ⚠ NO REGISTERED NUMBER SEEDED. The register answers nothing for "Lauren Ralph Lauren" and returns nine Ralph Lauren registrants for the house, two of them womenswear entities (RN 67635 RALPH LAUREN WOMENSWEAR, INC. and RN 94306 THE RALPH LAUREN WOMENSWEAR COMPANY, L.P.). Either is PROBABLY behind this label, and "probably" is what the Longchamp trap is made of -- an RN names a registrant and can never attribute one sibling label rather than another. ⚠ A BARE "lauren" IS NOT AN ALIAS: it is an ordinary given name, the same refusal that keeps "joe" off Joe''s Jeans. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://corporate.ralphlauren.com/lauren-ralph-lauren', 0.75, false, 'migration:00783')

on conflict (brand_key) do update set
  canonical_brand    = excluded.canonical_brand,
  aliases            = excluded.aliases,
  category_focus     = excluded.category_focus,
  registered_numbers = excluded.registered_numbers,
  notes              = excluded.notes,
  source_url         = excluded.source_url,
  confidence         = excluded.confidence,
  updated_by         = excluded.updated_by;

-- ── brand_styles: the ONLY sibling rows this pass earns ────────────────────
--
-- Four of the five brands get NO style rows, and that is the correct output
-- rather than a gap: nothing on gant.com, quince.com, 7diamonds.com or
-- zegnagroup.com names a model identity, and a style row invented to fill the
-- table would be exactly the unsourced fact the provenance contract refuses.
--
-- Lauren Ralph Lauren is the exception because its own corporate page NAMES its
-- divisions. Lauren Home is deliberately absent -- it is bedding, bath, lighting
-- and floorcovering, not a garment.

insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   keywords, source_url, confidence, verified, updated_by)
values
  ('laurenralphlauren', 'Lauren for Women', 'Women', 'top', 'Lauren for Women',
   'The house''s own words: "a lifestyle collection of sportswear, denim, and dresses, as well as accessories and footwear at a more accessible price point". Department-store women''s tier, below Polo Ralph Lauren and far below Ralph Lauren Luxury.',
   ARRAY['lauren','womens','dresses','sportswear','denim']::text[],
   'https://corporate.ralphlauren.com/lauren-ralph-lauren', 0.75, false, 'migration:00783'),
  ('laurenralphlauren', 'Lauren for Men', 'Men', 'top', 'Lauren for Men',
   'The house''s own words: "a complete collection of men''s tailored clothing, including suits, sport coats, dress shirts, dress pants, tuxedos, topcoats, and ties". Tailored clothing, NOT the Polo sportswear line -- the two are different labels at different prices.',
   ARRAY['lauren','mens','tailoring','suits','dress shirts']::text[],
   'https://corporate.ralphlauren.com/lauren-ralph-lauren', 0.75, false, 'migration:00783')

on conflict (brand_key, style_name, department) do update set
  category           = excluded.category,
  product_line       = excluded.product_line,
  visual_fingerprint = excluded.visual_fingerprint,
  keywords           = excluded.keywords,
  source_url         = excluded.source_url,
  confidence         = excluded.confidence,
  updated_by         = excluded.updated_by;

-- ── What this file REFUSES, and why ───────────────────────────────────────
--
-- Written down so the next person does not re-derive the same dead ends.
--
--   NORMAN ROCKWELL (5 items) -- REFUSED, and it is not a near miss. Norman
--     Rockwell is an American illustrator who died in 1978; his estate licenses
--     IMAGES, and the FTC register returns nothing for the name, which is what a
--     licensor rather than a manufacturer looks like. A garment carrying a
--     Rockwell print has a real label on its collar -- Gildan, Hanes, a band-tee
--     blank -- and that label, not the artist, is the brand. Seeding "Norman
--     Rockwell" into brand_knowledge would assert that a licensor is a garment
--     maker, which is the decoder bar's fourth question (WHICH ENTITY DOES THE
--     IDENTIFIER NAME?) answered wrong on purpose.
--
--     THE ROW IS EVIDENCE ABOUT THE BRAND FIELD, NOT ABOUT THE KB, and it is not
--     alone: 00731 recorded CASHMERE (3 items) in the same top-25, which is a
--     FIBRE. Two of the top twenty-five brand values are not brands at all --
--     one a licensor, one a material -- so roughly 8% of what the field ranks as
--     a brand is something else. A KB gap report that does not classify these
--     will keep proposing packs for them. See
--     vault/20-domain/brands/brand-kb-negative-findings.md.
--
--   GANT and 7 DIAMONDS keep their 00731 RN refusals, re-confirmed 2026-09-10.
--     They are seeded above WITHOUT a registered number, which is the point that
--     was open in 00731: the refusal was about the RN, never about the brand.
--
--   Z ZEGNA, ZEGNA COUTURE, GANT RUGGER -- sub-lines, refused as aliases and NOT
--     minted as keys either. A sub-label earns its own key when a source states
--     that it prices or sizes differently, as Ralph Lauren Corporation does for
--     Lauren. Nothing sourced says so for these three yet.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00783') on conflict do nothing;
