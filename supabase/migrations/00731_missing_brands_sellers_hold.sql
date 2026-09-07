-- US-3125: six brands our sellers hold that the KB did not know at all.
--
-- Chosen by joining `inventory_items.brand` against `brand_knowledge` on prod --
-- what sellers are actually holding, not what a brand list says matters. Each
-- was re-checked against `canonical_brand` AND the `aliases` array before being
-- called absent, because a fuzzy key join failing is the obvious way to seed a
-- brand that is already there under another name.
--
-- ⚠ THESE ARE DELIBERATELY MINIMAL PACKS, AND THE EMPTY COLUMNS ARE THE POINT.
-- Each row carries an identity, a category focus and an FTC-sourced registered
-- number. `tag_eras`, `country_patterns` and `authentication_tells` are EMPTY
-- ARRAYS, and every row's notes say so in words.
--
-- An empty array here means NOT RESEARCHED. It does NOT mean "researched and
-- there is nothing", which is what an unexplained empty column reads as, and
-- which is the exact confusion vault/20-domain/brands/brand-kb-negative-findings.md
-- exists to prevent -- a missing RN on a handbag is a statutory absence, an
-- empty authentication_tells here is just work nobody has done. Seeding a
-- half-pack and saying which half is honest; seeding a half-pack silently is
-- how a gap becomes a finding.
--
-- ── THE RNs, and the bar they had to clear ─────────────────────────────────
--
-- All six read from https://www.ftc.gov/rn-database/search on 2026-09-06 with
-- scripts/ops/ftc-rn-lookup.mjs. Seeded only where the REGISTRANT IS THE LABEL,
-- because an RN names the company that registered it and never the brand.

insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   notes, source_url, confidence, verified, updated_by)
values
  ('prana', 'prAna',
   ARRAY['prana','pranaliving','prana living']::text[],
   ARRAY['outdoor','yoga','climbing','sustainable apparel','menswear','womenswear']::text[],
   ARRAY['RN 124977']::text[],
   'RN 124977 is FTC-record sourced -- registrant "PRANA LIVING LLC", product line "APPAREL". ⚠ THE REGISTER RETURNS A SECOND, BARER HIT: RN 45953 "PRANA" with no product line. It is NOT seeded: a bare word match cannot be told from an unrelated registrant of the same common noun (prana is a Sanskrit term in wide use), and PRANA LIVING LLC is the entity that names the label. CANONICAL CASING IS "prAna" with a lower-case p and a capital A -- the brand styles it that way and sellers type it both ways, so both are aliases. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work, NOT because there is nothing to find.',
   'https://www.prana.com/', 0.60, false, 'migration:00731'),

  ('pact', 'Pact',
   ARRAY['pact','wearpact','pactapparel','pact organic']::text[],
   ARRAY['organic cotton','basics','underwear','loungewear','sustainable apparel']::text[],
   ARRAY['RN 128480']::text[],
   'RN 128480 is FTC-record sourced -- registrant "WEAR PACT", product line "ORGANIC COTTON BASICS", which is the brand''s own positioning and its former trading name. ⚠ "PACT" IS A COMMON WORD AND THE REGISTER SUBSTRING-MATCHES: the same search returns Pactimo, BASIC IMPACT, IMPACT USA, HIGH IMPACT and fifty more, none of them this brand. The product line is what disambiguates, not the name. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://wearpact.com/', 0.60, false, 'migration:00731'),

  ('mizzenmain', 'Mizzen+Main',
   ARRAY['mizzenmain','mizzen+main','mizzen and main','mizzen & main']::text[],
   ARRAY['menswear','performance dress shirts','golf','moisture-wicking']::text[],
   ARRAY['RN 157281']::text[],
   'RN 157281 is FTC-record sourced -- registrant "Mizzen and Main LLC", product line "Men''s apparel". The registrant spells out the "+" that the brand styles; both forms are aliases because a seller types either. ⚠ mizzenandmain.com answered 429 (rate limited) when this was written, which is the site throttling an automated request rather than a wrong URL -- do not read it as dead. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://www.mizzenandmain.com/', 0.60, false, 'migration:00731'),

  ('freefly', 'Free Fly',
   ARRAY['freefly','free fly','freeflyapparel','free fly apparel']::text[],
   ARRAY['outdoor','bamboo fabric','fishing','sun protection','menswear','womenswear']::text[],
   ARRAY['RN 166238']::text[],
   'RN 166238 is FTC-record sourced -- registrant "Free Fly Fishing Company LLC", product line "Children''s apparel Men''s apparel Women''s apparel". The registrant name contains the label and the product line is apparel across three departments, which is what makes this a match rather than a same-words coincidence. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://freeflyapparel.com/', 0.60, false, 'migration:00731'),

  ('peruvianconnection', 'Peruvian Connection',
   ARRAY['peruvianconnection','peruvian connection']::text[],
   ARRAY['pima cotton','alpaca','knitwear','womenswear','catalogue retail']::text[],
   ARRAY['RN 161231']::text[],
   'RN 161231 is FTC-record sourced -- registrant "Peruvian Connection, LLC", product line "Carpets / rugs Women''s apparel". The registrant IS the label. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://www.peruvianconnection.com/', 0.60, false, 'migration:00731'),

  ('bylt', 'BYLT',
   ARRAY['bylt','byltbasics','bylt basics']::text[],
   ARRAY['menswear','basics','tees','polos','direct-to-consumer']::text[],
   ARRAY['RN 162924']::text[],
   'RN 162924 is FTC-record sourced -- registrant "BYLT, LLC.", product line "Baby Apparel Children''s apparel Men''s apparel Women''s apparel". The registrant IS the label. ⚠ NOT RESEARCHED: tag eras, country patterns and authentication tells are empty because nobody has done that work.',
   'https://byltbasics.com/', 0.60, false, 'migration:00731')

on conflict (brand_key) do update set
  canonical_brand    = excluded.canonical_brand,
  aliases            = excluded.aliases,
  category_focus     = excluded.category_focus,
  registered_numbers = excluded.registered_numbers,
  notes              = excluded.notes,
  source_url         = excluded.source_url,
  confidence         = excluded.confidence,
  updated_by         = excluded.updated_by;

-- ── brands sellers hold that this file REFUSES to seed, and why ────────────
--
-- Written down so the next person does not re-derive the same dead ends.
--
--   GANT (8 items) and 7 DIAMONDS (6) -- the register SUBSTRING-MATCHES, and
--     for these two that is all it does. "GANT" returns 100 hits -- L'EGANTE,
--     GANTOS, ELEGANT SELECTIONS, TIMELESS ELEGANTS -- and not one is the
--     Swedish house. "7 Diamonds" returns DIAMONDS RUN LTD, PRECIOUS AS
--     DIAMONDS and the like. A tool that ranks by string similarity would hand
--     you a confident wrong answer here; the correct output is nothing.
--     They still need a brand_knowledge row, just not from this source.
--
--   QUINCE (7)          RN 177170  Last Brand, Inc.
--   VERONICA BEARD (6)  RN 155820  Pipes & Shaw LLC   [Women's apparel]
--     Single plausible hits whose registrant name contains NOTHING of the
--     label. Both are probably the operating entity, and "probably" is what the
--     Longchamp trap is made of. Confirm the corporate link from a source, then
--     seed. Same treatment as Beyond Yoga's I AM BEYOND LLC (00729) and Buck
--     Mason's SIMPLE MAN LLC (00730).
--
--   ST. JOHN (5)  RN 89209 "ST. JOHN" plus four more St. John registrants
--     (ST. JOHN MANUFACTURING, CHRISTOPHER ST. JOHN, SUSAN ST. JOHN, MICHELLE
--     ST. JOHN). An exact-looking hit surrounded by same-name companies and no
--     product line to separate them. Ambiguous, so refused.
--
--   TOAD&CO (4), ROBERT GRAHAM (3), TRAVIS MATHEW (3) -- the register returns
--     NOTHING, under those spellings and the obvious variants. A legitimate
--     absence rather than a failed lookup; plenty of real brands hold no US
--     registration.
--
--   NORMAN ROCKWELL (5) is not an apparel brand and CASHMERE (3) is a material.
--     Neither belongs in brand_knowledge. They are evidence about the brand
--     FIELD -- sellers are typing licensors and fibres into it -- which is a
--     finding for US-3125 rather than a pack to seed.
--
--   NOT YET LOOKED UP, and still held by sellers: Ermenegildo Zegna (6),
--     Lauren Ralph Lauren (6), Giorgio Armani (5), Desigual (4), John Varvatos
--     (3), Sundry (3). Lauren Ralph Lauren is the interesting one -- Polo Ralph
--     Lauren IS in the KB, so it is a missing SUB-LABEL of a house we carry, and
--     the two size and price differently.

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00731') on conflict do nothing;
