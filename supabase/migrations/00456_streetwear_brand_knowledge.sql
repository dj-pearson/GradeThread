-- US-1737: Streetwear & hype brand knowledge group (6 brands, 7 rows).
--
-- Supreme, Stüssy, BAPE, Kith, Palace, Fear of God / Essentials. Supreme and
-- Stüssy already have bare alias-only rows from 00389; the rest are new.
--
-- WHAT MAKES THIS GROUP DIFFERENT FROM EVERY PRIOR ONE: on Supreme, Burberry's
-- rule is inverted. Everywhere else in this epic the garment identifies itself
-- and the season is trivia — a Kensington trench is a Kensington trench whenever
-- it was cut. Here the DESIGN IS CONSTANT AND THE SEASON IS THE PRICE. The
-- Supreme Box Logo Tee has been reissued across many seasons in many colorways;
-- two of them are the same photograph and a large multiple apart in value. So
-- the identification question this group has to answer is not "what is it" (the
-- graphic answers that from across the room) but "WHICH DROP is it", and the
-- garment usually cannot answer that at all.
--
-- Which forces the group's defining stance: THIS PACK SEEDS NO DECODERS. It is
-- the first group in the epic with none, and that is a finding, not a gap. The
-- rule the epic uses is tag-printed AND regular AND brand-unique (00454's
-- Wrangler MW family, 00455's Kate Spade PXRU prefix). Streetwear identity is
-- carried by a GRAPHIC — the box logo, the shark mouth, the Tri-Ferg — and a
-- graphic is not a code: it is not on the tag, it is not parseable, and it is
-- the single most-copied thing about each of these brands. The season notation
-- (SS20 / FW17) is regular and IS how these pieces are priced, but it is NOT
-- TAG-PRINTED — it is established against a release archive. That makes it an
-- informational tell, exactly like the Beyond Yoga / Sweaty Betty web codes
-- (00452) and the Columbia/Marmot retailer SKUs (00453). A decoder over it would
-- mint a Supreme from any tag reading "FW17".
--
-- THE SIZING SPLIT — this pack's halves run in OPPOSITE directions, same as the
-- denim (00454) and luxury (00455) packs, and again it is why the six belong
-- together. Both halves are labeled with an ORDINARY ALPHA LETTER, and the
-- letter lies in opposite directions:
--
--     an "L" tag  ->  BAPE (JP L)         ≈ US M   — Japanese sizing, runs SMALL
--                 ->  Essentials (L)      ≈ drapes like US XL — deliberately huge
--
-- There is no national-system word on the tag to warn anyone (contrast 00455,
-- where "IT 42" at least announces itself). Both just say L. So every BAPE chart
-- carries its US equivalent INSIDE THE SIZE LABEL ("JP L (≈US M)") where the
-- model actually reads it — the 00455 lesson — and every Essentials chart states
-- that the drape is the DESIGN.
--
-- That last point is a GRADING fact, not just a listing one: an Essentials hoodie
-- is supposed to hang off the body, and a Supreme tee is supposed to be boxy.
-- Describing that as "runs large" reads as a defect or a mislabel. It is neither.
--
-- CORPORATE / SIBLING MAP (recorded because a shared parent reads as a
-- counterfeit signal to a naive model and is not one):
--   * Supreme: independent -> VF Corporation (2020) -> EssilorLuxottica (2024).
--     A VF-era Supreme piece shares a parent with Vans, The North Face and
--     Wrangler (00454) — which is ordinary, and is also why the long-running
--     Supreme x TNF collab exists.
--   * BAPE (Nowhere Co.) -> acquired by the Hong Kong group I.T in 2011.
--   * AAPE is BAPE's own DIFFUSION line ("AAPE BY *A BATHING APE*") at a fraction
--     of the price. It is BAPE's SIBLING, not BAPE — exactly as AGOLDE is not AG
--     Jeans (00454) and Miu Miu is not Prada (00455). It stays a passthrough.
--   * Fear of God mainline and Fear of God ESSENTIALS are one designer's two
--     lines an order of magnitude apart in price. Unlike the Michael Kors tiers
--     (00455), which all canonicalize to one eBay brand, these are seeded as TWO
--     BRAND KEYS — because comping an Essentials hoodie against mainline Fear of
--     God is not a rounding error, it is a 10x mispricing. This follows the AGOLDE
--     precedent (a sibling label earns its own canonical), not the MK one.
--
-- TWO ORDINARY-WORD TRAPS, both handled the way 00453 refused a bare "bean" and
-- 00455 refused a bare "tory" — the short form is NOT a curated alias:
--   * "essentials" is an ordinary retail word. adidas, Nike and H&M all ship an
--     "Essentials" line. A bare "essentials" must never mint Fear of God.
--   * "fog" is an ordinary English word. Same rule, same reason.
--
-- ONE CROSS-BRAND TRAP, and this one collides with a row ALREADY IN THE KB:
-- "GG Supreme" is GUCCI's coated monogram canvas, seeded in 00400 — it is not
-- this brand. "Supreme" is a real English adjective and Gucci uses it as one. A
-- Supreme-token read as the brand mislabels a Gucci bag, so Supreme's notes say
-- so explicitly. (See the commit message for the related detectBrandInText
-- hazard, which is pre-existing and NOT addressed here.)
--
-- COLLABORATIONS are this group's other cross-brand hazard and they are normal
-- here rather than exceptional: a Supreme x Nike piece carries BOTH marks, and a
-- naive reading picks whichever it sees first. The rule seeded throughout: the
-- brand is the PRIMARY label, the partner belongs in the style/keywords, and a
-- collab is worth a multiple of either brand's general line — so dropping the
-- partner undersells it and promoting the partner to `brand` mis-comps it.
--
-- NEVER AUTO-AUTHENTICATE — the story's hard line and the same stance as
-- US-1727/1728 (LV/Gucci) and 00455. These are among the most counterfeited
-- garments in the world and the fakes are specifically good at the tells a photo
-- can show. A box logo font, a shark face, a stitch count or a tag generation
-- NEVER proves authenticity. The KB flags inconsistencies in condition notes and
-- stops there. This is also why the tag_eras below are deliberately COARSE: the
-- per-season label generations collectors trade in are folklore rather than
-- published documentation, and seeding them at false precision would be both
-- invention and a step toward auto-authentication.
--
-- Data-only. Every fact carries source_url + confidence and lands verified=false
-- for the US-1715 admin verify queue. Idempotent throughout.

-- ── brand_knowledge ─────────────────────────────────────────────────────────

-- Supreme (ENRICHES the bare alias-only row seeded by 00389).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('supreme', 'Supreme', ARRAY['supreme','supremenewyork','supremenyc']::text[],
  ARRAY['streetwear','skate','tees','hoodies','accessories']::text[],
  $j$[{"era":"season-drop production (SS/FW)","years":"1994-present","description":"Supreme releases in weekly DROPS inside a Spring/Summer or Fall/Winter season, and the season — not the design — is the identity: the same Box Logo Tee has been reissued across many seasons and colorways at very different resale prices. The season is NOT printed as a decodable code on the garment; it is established from the specific colorway/graphic against a release archive. Treat any season claim as UNVERIFIED unless the seller states it, and never infer one from the design alone."},{"era":"VF Corporation ownership","years":"2020-2024","description":"Supreme was independent until VF Corporation acquired it in 2020; EssilorLuxottica acquired it in 2024. Provenance/era context only — it is not a tag tell and not an authenticity test. It is also why the long-running Supreme x The North Face collaboration exists (VF owns TNF): a shared corporate parent is ordinary, not a red flag."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"Supreme is one of the most counterfeited brands in existence, and the counterfeits are specifically good at the things a photo can show. The box logo font, the label stitching, the tag generation — NONE of these proves authenticity, and a confident-looking match on any of them is exactly what a good fake is built to produce. NEVER label a Supreme item authentic; flag inconsistencies in condition notes only."},{"tell":"The SEASON is the price, and the garment rarely shows it","detail":"THE Supreme call. The Box Logo Tee is the same design across many seasons at very different values, so 'what is it' is easy and nearly worthless — 'which drop is it' is the whole question and usually cannot be answered from the photos. Do NOT guess a season. An unsupported season claim is the single most expensive error on this brand in both directions."},{"tell":"Box logo","detail":"Informational, NOT an authenticity test: the box logo is a red rectangle with Futura Heavy Oblique white text. It identifies the BRAND and ranks nothing — it appears on tees, hoodies, caps and accessories across three decades and every price point, and it is the most-reproduced graphic in streetwear."},{"tell":"GG Supreme is GUCCI, not Supreme","detail":"CROSS-BRAND: 'Supreme' is an ordinary English adjective and Gucci uses it as one — GG Supreme is Gucci's coated monogram canvas (a separate KB row). A 'Supreme' token next to 'GG' or 'Gucci' is a GUCCI piece and must never be branded Supreme."},{"tell":"Collaborations carry two marks","detail":"A Supreme x Nike / x The North Face / x Louis Vuitton piece shows BOTH brands, and it is worth a multiple of either brand's general line. The brand is the PRIMARY label (Supreme); the partner belongs in the style/keywords. Dropping the partner undersells the piece; promoting the partner to the brand comps it against the wrong catalog entirely."}]$j$::jsonb,
  'US alpha sizing, cut BOXY by design — the relaxed fit is the intended silhouette, not a mislabel. The SEASON is the price and the garment usually cannot prove it: never infer a drop from the design. EXTREME counterfeit risk — NEVER auto-authenticate. Independent until VF Corporation (2020), then EssilorLuxottica (2024); the VF era is why Supreme x The North Face exists. NOTE "GG Supreme" is GUCCI''s canvas, not this brand.',
  'https://www.supremenewyork.com/', 0.80, false, 'migration:00456')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Stüssy (ENRICHES the bare alias-only row seeded by 00389). NOTE the brand_key
-- is 'stssy', not 'stussy' — brandKey() strips the umlaut along with every other
-- non-[a-z0-9] character, and 00389 seeded the key that way. Do not "fix" it: the
-- resolver derives the same key from the canonical at read time, so a corrected
-- spelling here would simply never be found.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('stssy', 'Stüssy', ARRAY['stussy','stssy','stussytribe','internationalstussytribe']::text[],
  ARRAY['streetwear','surf','skate','tees','fleece']::text[],
  $j$[{"era":"vintage tag generations","years":"1980s-1990s","description":"Stüssy has used a series of distinct woven neck labels since the 1980s, and VINTAGE pieces carry a large premium over current production of the same design — so on this brand the tag generation is a real value signal in a way it is not for the rest of this group. But the specific tag-to-year mapping is collector folklore rather than published documentation: a label can support 'vintage' as a claim and can never prove a year, and it never proves authenticity."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Stüssy item authentic. The scrawl signature is hand-drawn and therefore varies legitimately between pieces AND is trivially traced by counterfeiters — so neither a 'wrong-looking' signature nor a 'right-looking' one is evidence. Flag inconsistencies in condition notes only."},{"tell":"The Stock logo is a signature, not a font","detail":"Informational: the Stock logo is founder Shawn Stussy''s hand-drawn scrawl of his own surname, taken from how he signed surfboards. Because it is handwriting rather than a typeface, small variation between pieces is NORMAL and is not a defect and not a counterfeit tell."},{"tell":"Vintage is the value question here","detail":"Unlike the rest of this group, where the drop is the price, Stüssy''s spread is mostly VINTAGE vs current production of the same design. The neck tag is the only thing that speaks to it, and it speaks only loosely — do not assert an era the tag cannot support."}]$j$::jsonb,
  'US alpha sizing, relaxed/boxy cut. The value question on this brand is VINTAGE vs current production of the same design, and only the neck tag speaks to it — loosely, and never conclusively. The Stock logo is founder Shawn Stussy''s handwriting, so legitimate variation between pieces is normal. Independent. NEVER auto-authenticate.',
  'https://www.stussy.com/', 0.78, false, 'migration:00456')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- BAPE (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('bape', 'BAPE', ARRAY['bape','abathingape','bathingape','apehead']::text[],
  ARRAY['streetwear','camo','hoodies','japanese']::text[],
  $j$[{"era":"pre-I.T. acquisition","years":"before 2011","description":"BAPE (Nowhere Co., founded by Nigo) was acquired by the Hong Kong group I.T in 2011. Collectors distinguish 'pre-I.T.' pieces, which carry a premium. This is a PROVENANCE/era distinction, not an authenticity test — and it is not printed on the tag."},{"era":"Made in Japan","years":"1993-2000s","description":"Early BAPE was produced in JAPAN in deliberately small runs sold through Nowhere/BAPE stores. A 'Made in Japan' wash tag therefore suggests an earlier piece and supports a premium — but it is a country of manufacture, not a year, and it proves nothing about authenticity."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"BAPE is among the most counterfeited brands on earth and the Shark hoodie is its most counterfeited garment. The shark face, the camo registration, the teeth stitching — none of these proves authenticity, and every one of them is exactly what a good fake reproduces. NEVER label a BAPE item authentic; flag inconsistencies in condition notes only."},{"tell":"AAPE IS NOT BAPE","detail":"CRITICAL and routinely misread: AAPE (\"AAPE BY *A BATHING APE*\") is BAPE''s own DIFFUSION line at a fraction of the price. It is entirely AUTHENTIC and it is NOT BAPE — so an AAPE piece is neither a fake nor a mainline piece. Reading the four letters as a typo of BAPE overprices it by a wide margin. This is the AGOLDE/AG Jeans rule and the Miu Miu/Prada rule applied to this brand."},{"tell":"Baby Milo is a BAPE line","detail":"Informational: Baby Milo is BAPE''s own character line (the cartoon ape). It is a LINE of the same brand, not a separate brand and not a collaboration — it belongs in the style, not the brand."},{"tell":"Collaborations carry two marks","detail":"BAPE collaborates constantly, and a collab piece is worth a multiple of the general line. The brand is the PRIMARY label (BAPE); the partner belongs in the style/keywords, never in the brand."}]$j$::jsonb,
  'JAPANESE sizing and it runs SMALL against a US body: a BAPE L is roughly a US M. The tag says only "L" — there is no national-system word to warn anyone, which is what makes this the group''s costliest sizing error. Camo PATTERNS are named and function as the colorway (1st Camo, ABC Camo, City Camo). AAPE is BAPE''s own diffusion SIBLING and must never be folded into this brand; Baby Milo IS a BAPE line and belongs in the style. Nowhere Co. until the I.T Group acquisition (2011). EXTREME counterfeit risk — NEVER auto-authenticate.',
  'https://bape.com/', 0.78, false, 'migration:00456')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Kith (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('kith', 'Kith', ARRAY['kith','kithnyc','kithnewyork']::text[],
  ARRAY['streetwear','elevated basics','hoodies','collaborations']::text[],
  -- tag_eras deliberately EMPTY: Kith is a 2011 brand with no documented,
  -- resale-relevant label generations. Seeding an era here would be invention.
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Kith item authentic. A serif logo, a woven label or a box proves nothing; flag inconsistencies in condition notes only."},{"tell":"The COLLAB is usually the value","detail":"Kith''s house program is elevated basics, and its resale spread is driven mostly by COLLABORATIONS (Kith x Nike / x New Balance / x adidas and many more). The brand is the PRIMARY label (Kith); the partner belongs in the style/keywords. A collab piece is worth a multiple of the equivalent house piece, so dropping the partner undersells it badly."},{"tell":"Seasonal programs are the drop","detail":"Informational: Kith releases in seasonal programs, so — as across this group — the SEASON contributes to price and the garment usually cannot prove it. Do not infer a season from the design."}]$j$::jsonb,
  'US alpha sizing; the house line is elevated basics cut fuller than a standard tee but nothing like the Essentials drape. Resale value is driven mostly by COLLABORATIONS — the brand stays Kith and the partner belongs in the style. Founded 2011 by Ronnie Fieg; independent. NEVER auto-authenticate.',
  'https://kith.com/', 0.72, false, 'migration:00456')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Palace (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('palace', 'Palace', ARRAY['palace','palaceskateboards']::text[],
  ARRAY['streetwear','skate','tees','hoodies']::text[],
  -- tag_eras deliberately EMPTY: Palace is a 2009 brand with no documented,
  -- resale-relevant label generations.
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Palace item authentic. The Tri-Ferg is the most-copied Palace element; a clean-looking one proves nothing. Flag inconsistencies in condition notes only."},{"tell":"Tri-Ferg","detail":"Informational, NOT an authenticity test: the Tri-Ferg is Palace''s triangle logo — a Penrose-style triangle with the P-A-L wordmark on its three sides. It identifies the BRAND and ranks nothing; it appears across the whole line at every price point."},{"tell":"The DROP is the price, and the garment rarely shows it","detail":"As with Supreme: Palace releases weekly in seasonal drops, the same graphics recur, and the season is not printed on the garment. Do not infer a drop from the design."}]$j$::jsonb,
  'UK brand, US alpha sizing, boxy skate cut by design. Releases in weekly drops — the SEASON contributes to price and the garment usually cannot prove it. Founded 2009 in London; independent. NOTE "Palace" is an ordinary English word: it should only be read as this brand when the garment actually carries Palace branding. NEVER auto-authenticate.',
  'https://www.palaceskateboards.com/', 0.72, false, 'migration:00456')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Fear of God — MAINLINE (NEW row). Deliberately a SEPARATE key from Essentials;
-- see the header for why this follows the AGOLDE precedent and not the MK one.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('fearofgod', 'Fear of God', ARRAY['fearofgod','fearofgodmainline']::text[],
  ARRAY['streetwear','luxury basics','collections']::text[],
  $j$[{"era":"numbered Collections","years":"2013-present","description":"Fear of God mainline is released as numbered COLLECTIONS (First, Second, Third and on), and the collection number is the era: it is how a mainline piece is dated and comped, and it is the term the resale market uses. It is not a code printed on the tag — it is established from the piece against a collection archive, so it cannot be inferred from the design alone."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Fear of God item authentic; flag inconsistencies in condition notes only."},{"tell":"MAINLINE IS NOT ESSENTIALS","detail":"THE Fear of God call, and the most expensive error available on this brand: mainline Fear of God and Fear of God ESSENTIALS are one designer''s two lines an ORDER OF MAGNITUDE apart in price. They are seeded here as two separate brands for exactly that reason. Both labels print their own name — read the label, and never comp one against the other."},{"tell":"The COLLECTION is the era","detail":"Informational: mainline pieces are placed by numbered collection rather than by season. The collection is not tag-printed, so do not assert one the piece cannot support."}]$j$::jsonb,
  'MAINLINE ONLY — the ~10x-more-expensive sibling of Fear of God ESSENTIALS, which is a SEPARATE brand row (brand_key fearofgodessentials). Never comp the two against each other. Dated by numbered COLLECTION, not season. Founded 2013 by Jerry Lorenzo. NO SIZE CHARTS ARE SEEDED FOR THIS KEY ON PURPOSE: mainline sizing is collection-specific and is not published as a stable grade, so a chart here would be invention — and because the in-code fallback matches brandMatch by SUBSTRING, a "fear of god" chart would also fire on every "Fear of God Essentials" garment and hand it the wrong numbers. Mainline falls through to the generic charts, exactly as Coach/LV/Gucci do. NEVER auto-authenticate.',
  'https://fearofgod.com/', 0.70, false, 'migration:00456')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Fear of God ESSENTIALS (NEW row) — its own brand, not a style of the above.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('fearofgodessentials', 'Fear of God Essentials',
  ARRAY['fearofgodessentials','essentialsfearofgod','essentialsbyfearofgod','fogessentials']::text[],
  ARRAY['streetwear','hoodies','sweatpants','diffusion']::text[],
  $j$[{"era":"logo-treatment generations","years":"2018-present","description":"Essentials seasons are distinguished by the LOGO TREATMENT on the chest/back (flocked, rubberized or applique across different seasons) and by whether the piece carries the '1977' print. Collectors use these to place a piece in a season, and seasons comp differently. The mapping is NOT published by the brand — treat it as a loose dating hint, never as an authenticity test."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"Essentials is one of the most counterfeited garments of the last decade, and the fakes target precisely the logo treatment a photo can show. A crisp rubberized logo proves NOTHING. NEVER label an Essentials item authentic; flag inconsistencies in condition notes only."},{"tell":"ESSENTIALS IS NOT MAINLINE FEAR OF GOD","detail":"The other half of this brand''s defining fact: Essentials is the DIFFUSION line and is worth roughly an order of magnitude less than mainline Fear of God. It is entirely AUTHENTIC — it is not a fake and not a knockoff — and it must never be comped against mainline. Both labels print their own name."},{"tell":"The OVERSIZED drape is the design","detail":"GRADING-RELEVANT: Essentials is cut deliberately huge — dropped shoulders, boxy body, long sleeve. An Essentials L drapes like a US XL. That is the intended silhouette, NOT a mislabel, NOT stretching, and NOT a defect. Do not grade the drape as wear and do not describe it as 'runs large' as though it were an error."},{"tell":"A bare 'Essentials' is not this brand","detail":"CROSS-BRAND: 'Essentials' is an ordinary retail word — adidas, Nike and H&M all ship an 'Essentials' line. Only 'Fear of God Essentials' (or an unambiguous Essentials logo treatment) is this brand. A bare 'essentials' token must never mint it."}]$j$::jsonb,
  'The DIFFUSION line of Fear of God, ~10x cheaper than mainline (a SEPARATE brand row, brand_key fearofgod) — never comp the two against each other. It is entirely AUTHENTIC, not a knockoff. Cut DELIBERATELY OVERSIZED: an Essentials L drapes like a US XL, and that drape is the design, not a defect and not a mislabel. Named seasonal colorways (Buttercream, Moss, Oat, Concrete) are how pieces are described. NOTE a bare "essentials" is an ordinary retail word and is NOT this brand. EXTREME counterfeit risk — NEVER auto-authenticate.',
  'https://fearofgod.com/collections/essentials', 0.75, false, 'migration:00456')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────

insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values

  -- Supreme: the box logo family is the resale engine, and its members differ by
  -- the SIZE AND PLACEMENT of one graphic — which is all a photo can show, since
  -- the season it was cut in cannot be read off the garment at all.
  ('supreme', 'Box Logo Tee', 'Men', 'tee', 'Box Logo',
   'THE Supreme icon: a red rectangle with "Supreme" in white Futura Heavy Oblique, printed on the CHEST of a boxy tee. vs the Box Logo Hoodie: same graphic, different garment. vs the Small Box Logo: this one is chest-width, the Small Box is a much smaller badge worn high on the left chest. CRITICAL — the graphic identifies the STYLE and says nothing about the SEASON, and the season is the price: this tee has been reissued across many seasons and colorways at very different values. Identify the style; do NOT guess the drop.',
   ARRAY['cotton jersey']::text[], null, '$$$', ARRAY['box logo','bogo','tee','futura']::text[],
   'https://www.supremenewyork.com/', 0.75, false, 'migration:00456'),
  ('supreme', 'Box Logo Hoodie', 'Men', 'hoodie', 'Box Logo',
   'The heavyweight pullover hood carrying the same chest box logo. vs the Box Logo Tee: identical graphic on a hooded fleece — read the GARMENT, not the logo. The hoodie is the higher band of the two. Same season caveat: the colorway plus the release archive place the drop, the garment cannot.',
   ARRAY['heavyweight fleece']::text[], null, '$$$$', ARRAY['box logo','bogo','hoodie','pullover']::text[],
   'https://www.supremenewyork.com/', 0.75, false, 'migration:00456'),
  ('supreme', 'Small Box Logo Tee', 'Men', 'tee', 'Small Box Logo',
   'A MUCH SMALLER box logo badge worn high on the left chest rather than across it. vs the Box Logo Tee: the separator is the graphic''s SIZE and PLACEMENT, and the two are different styles at different values — the full box logo spans the chest, the small box is a pocket-sized badge.',
   ARRAY['cotton jersey']::text[], null, '$$', ARRAY['small box logo','small box','tee']::text[],
   'https://www.supremenewyork.com/', 0.70, false, 'migration:00456'),
  ('supreme', 'Motion Logo Tee', 'Men', 'tee', 'Motion Logo',
   'The "Supreme" wordmark stretched/italicized into a motion-blur graphic across the chest — a distinct graphic family from the box logo, not a variant of it.',
   ARRAY['cotton jersey']::text[], null, '$$', ARRAY['motion logo','tee']::text[],
   'https://www.supremenewyork.com/', 0.65, false, 'migration:00456'),
  ('supreme', 'Supreme Collaboration', 'Unisex', 'label', 'Collaboration',
   'NOT a garment — the COLLAB marker, and on this brand it is a first-class fact rather than a footnote. A Supreme x Nike / x The North Face / x Louis Vuitton piece carries BOTH marks and is worth a multiple of the general line. The brand stays SUPREME (the primary label); the partner belongs in the style/keywords. Dropping the partner undersells the piece; promoting the partner to `brand` comps it against the wrong catalog.',
   ARRAY[]::text[], null, '$$$$', ARRAY['collab','collaboration','x nike','x north face','x louis vuitton']::text[],
   'https://www.supremenewyork.com/', 0.70, false, 'migration:00456'),

  -- Stüssy: the scrawl is the brand and the tag is the era. The styles below are
  -- graphic families, which is the only thing a photo can separate.
  ('stssy', 'Stock Logo Tee', 'Men', 'tee', 'Stock',
   'The hand-drawn "Stüssy" scrawl — founder Shawn Stussy''s own signature, taken from how he signed surfboards — printed across the chest. Because it is HANDWRITING rather than a typeface, small variation between pieces is normal and is neither a defect nor a counterfeit tell.',
   ARRAY['cotton jersey']::text[], null, '$$', ARRAY['stock logo','scrawl','signature','tee']::text[],
   'https://www.stussy.com/', 0.72, false, 'migration:00456'),
  ('stssy', 'World Tour Tee', 'Men', 'tee', 'World Tour',
   'The scrawl logo on the front with a list of CITIES stacked on the BACK (the "world tour" conceit). vs the Stock Logo Tee: the back print is the separator and it is invisible on a front-only photo — a back shot is required to tell these two apart.',
   ARRAY['cotton jersey']::text[], null, '$$', ARRAY['world tour','cities','back print','tee']::text[],
   'https://www.stussy.com/', 0.70, false, 'migration:00456'),
  ('stssy', '8 Ball', 'Men', 'fleece', '8 Ball',
   'The billiard 8-ball graphic, most familiar on fleece. A distinct graphic family from the Stock scrawl.',
   ARRAY['fleece']::text[], null, '$$', ARRAY['8 ball','eight ball','fleece']::text[],
   'https://www.stussy.com/', 0.65, false, 'migration:00456'),
  ('stssy', 'Basic Stüssy Tee', 'Men', 'tee', 'Basic',
   'The plain "Stüssy" wordmark tee with no secondary graphic — the brand''s volume piece and its lowest band.',
   ARRAY['cotton jersey']::text[], null, '$', ARRAY['basic','wordmark','tee']::text[],
   'https://www.stussy.com/', 0.62, false, 'migration:00456'),

  -- BAPE: the camo is the colorway (seeded below), so the styles are GARMENTS.
  ('bape', 'Shark Full Zip Hoodie', 'Men', 'hoodie', 'Shark',
   'THE BAPE icon: a full-zip hood whose zipper runs THROUGH THE HOOD so the shark''s mouth closes over the wearer''s face, with the shark teeth and eyes printed on the hood itself. Unmistakable when the hood is photographed. It is also the single most counterfeited garment in streetwear — the face proves the STYLE, never authenticity.',
   ARRAY['heavyweight fleece']::text[], null, '$$$$', ARRAY['shark','full zip','hoodie','wgm']::text[],
   'https://bape.com/', 0.78, false, 'migration:00456'),
  ('bape', 'Bapesta', 'Men', 'shoe', 'Bapesta',
   'The low-top sneaker with a patent-leather STAR on the side panel. A shoe, not apparel — sized in JP/US shoe sizing, so the apparel charts here do not apply to it.',
   ARRAY['patent leather']::text[], null, '$$$', ARRAY['bapesta','sta','star','sneaker']::text[],
   'https://bape.com/', 0.70, false, 'migration:00456'),
  ('bape', 'Ape Head Logo Tee', 'Men', 'tee', 'Ape Head',
   'The stylized APE HEAD (a chunky, angular gorilla face) printed large on the chest. vs Baby Milo: the Ape Head is the angular brand mark, Baby Milo is a soft cartoon character — they are different lines, not variants.',
   ARRAY['cotton jersey']::text[], null, '$$', ARRAY['ape head','logo','tee']::text[],
   'https://bape.com/', 0.68, false, 'migration:00456'),
  ('bape', 'Baby Milo', 'Unisex', 'label', 'Baby Milo',
   'NOT a garment — BAPE''s own CHARACTER LINE (the soft cartoon ape). It is a line of this same brand, not a separate brand and not a collaboration, so it belongs in the style and never in `brand`. Generally a lower band than the Shark pieces.',
   ARRAY[]::text[], null, '$$', ARRAY['baby milo','milo','character']::text[],
   'https://bape.com/', 0.65, false, 'migration:00456'),
  ('bape', 'BAPE Collaboration', 'Unisex', 'label', 'Collaboration',
   'NOT a garment — the COLLAB marker. BAPE collaborates constantly and a collab piece is worth a multiple of the general line. The brand stays BAPE (the primary label); the partner belongs in the style/keywords.',
   ARRAY[]::text[], null, '$$$$', ARRAY['collab','collaboration']::text[],
   'https://bape.com/', 0.65, false, 'migration:00456'),

  -- Kith: the house line is basics, so the COLLAB is the value — which makes the
  -- collab marker the most useful "style" this brand has.
  ('kith', 'Kith Collaboration', 'Unisex', 'label', 'Collaboration',
   'NOT a garment — the COLLAB marker, and on Kith it is the dominant value driver: a Kith x Nike / x New Balance / x adidas piece is worth a multiple of the equivalent house piece. The brand stays KITH (the primary label); the partner belongs in the style/keywords. Dropping the partner undersells the piece badly.',
   ARRAY[]::text[], null, '$$$', ARRAY['collab','collaboration','x nike','x new balance']::text[],
   'https://kith.com/', 0.70, false, 'migration:00456'),
  ('kith', 'Williams Hoodie', 'Men', 'hoodie', 'Williams',
   'Kith''s staple heavyweight pullover hood — the house program''s core fleece, carried season to season. Read the label rather than the silhouette: an unbranded heavyweight hood is not identifiable as this by shape alone.',
   ARRAY['heavyweight fleece']::text[], null, '$$$', ARRAY['williams','hoodie','pullover']::text[],
   'https://kith.com/', 0.60, false, 'migration:00456'),
  ('kith', 'Classic Logo Tee', 'Men', 'tee', 'Classic Logo',
   'The Kith serif wordmark printed on a tee — the house volume piece and the brand''s lowest band.',
   ARRAY['cotton jersey']::text[], null, '$', ARRAY['classic logo','serif','tee']::text[],
   'https://kith.com/', 0.60, false, 'migration:00456'),

  -- Palace: one logo, and the garment is the separator.
  ('palace', 'Tri-Ferg Tee', 'Men', 'tee', 'Tri-Ferg',
   'THE Palace icon: the Tri-Ferg — a Penrose-style triangle with the P-A-L wordmark running along its three sides — printed on the chest of a boxy tee. vs the Tri-Ferg Hoodie: same graphic, different garment; read the GARMENT, not the logo.',
   ARRAY['cotton jersey']::text[], null, '$$', ARRAY['tri-ferg','triferg','triangle','tee']::text[],
   'https://www.palaceskateboards.com/', 0.72, false, 'migration:00456'),
  ('palace', 'Tri-Ferg Hoodie', 'Men', 'hoodie', 'Tri-Ferg',
   'The pullover hood carrying the same Tri-Ferg triangle. vs the Tri-Ferg Tee: identical graphic on a hooded fleece, and the higher band of the two.',
   ARRAY['fleece']::text[], null, '$$$', ARRAY['tri-ferg','triferg','hoodie','pullover']::text[],
   'https://www.palaceskateboards.com/', 0.72, false, 'migration:00456'),
  ('palace', 'P-Logo', 'Men', 'tee', 'P-Logo',
   'The standalone "P" mark — a distinct graphic family from the Tri-Ferg triangle, not a variant of it.',
   ARRAY['cotton jersey']::text[], null, '$$', ARRAY['p logo','p-logo']::text[],
   'https://www.palaceskateboards.com/', 0.62, false, 'migration:00456'),
  ('palace', 'Palace Collaboration', 'Unisex', 'label', 'Collaboration',
   'NOT a garment — the COLLAB marker (Palace x adidas is the long-running one). Worth a multiple of the general line; the brand stays PALACE and the partner belongs in the style/keywords.',
   ARRAY[]::text[], null, '$$$', ARRAY['collab','collaboration','x adidas']::text[],
   'https://www.palaceskateboards.com/', 0.65, false, 'migration:00456'),

  -- Fear of God MAINLINE: the collection is the era and the LINE is the money
  -- fact. Both of this designer's line labels are seeded as styles on their own
  -- brand rows, because the pair is the thing that gets misread.
  ('fearofgod', 'Fear of God Mainline', 'Unisex', 'label', 'Mainline',
   'NOT a garment — the MAINLINE label, and the tier that mainline comps apply to. vs Fear of God ESSENTIALS: an ORDER OF MAGNITUDE apart in price, which is why they are seeded as two separate brands. Both labels print their own name — read the label, never the silhouette, and never comp one against the other.',
   ARRAY[]::text[], '2013-present', '$$$$', ARRAY['mainline','fear of god','collection']::text[],
   'https://fearofgod.com/', 0.70, false, 'migration:00456'),
  ('fearofgod', 'Numbered Collection', 'Unisex', 'label', 'Collection',
   'NOT a garment — the COLLECTION marker. Mainline is released as numbered Collections (First, Second, Third and on) and the collection number is how a piece is dated and comped. It is NOT tag-printed: it is established against a collection archive, so it cannot be inferred from the design.',
   ARRAY[]::text[], '2013-present', '$$$$', ARRAY['collection','sixth collection','seventh collection']::text[],
   'https://fearofgod.com/', 0.62, false, 'migration:00456'),

  -- Fear of God ESSENTIALS: the drape is the design, and the logo treatment is
  -- the only thing that speaks (loosely) to the season.
  ('fearofgodessentials', 'Essentials Pullover Hoodie', 'Unisex', 'hoodie', 'Essentials',
   'The brand''s volume piece: a DELIBERATELY OVERSIZED pullover hood — dropped shoulders, boxy body, long sleeve — with a small "ESSENTIALS" logo (flocked, rubberized or applique depending on the season) on the chest or back. The drape IS the design: an Essentials L hangs like a US XL. Do not grade that as stretching, wear or a mislabel.',
   ARRAY['cotton-blend fleece']::text[], '2018-present', '$$', ARRAY['essentials','hoodie','pullover','oversized']::text[],
   'https://fearofgod.com/collections/essentials', 0.75, false, 'migration:00456'),
  ('fearofgodessentials', 'Essentials Sweatpant', 'Unisex', 'bottom', 'Essentials',
   'The matching oversized sweatpant, usually with the logo at the thigh or hem. Same rule as the hoodie: the volume is the design, not a fit error.',
   ARRAY['cotton-blend fleece']::text[], '2018-present', '$$', ARRAY['essentials','sweatpant','jogger','oversized']::text[],
   'https://fearofgod.com/collections/essentials', 0.72, false, 'migration:00456'),
  ('fearofgodessentials', 'Essentials Tee', 'Unisex', 'tee', 'Essentials',
   'The boxy heavyweight tee with the small Essentials logo. The lowest band of the line.',
   ARRAY['heavyweight cotton jersey']::text[], '2018-present', '$', ARRAY['essentials','tee','boxy']::text[],
   'https://fearofgod.com/collections/essentials', 0.70, false, 'migration:00456'),
  ('fearofgodessentials', '1977 Print', 'Unisex', 'label', 'Essentials',
   'NOT a garment — the "1977" print that appears on many Essentials pieces (front, back or sleeve). Collectors use its PRESENCE, alongside the logo treatment, to place a piece in a season. It is a loose dating hint only: it is not published, it dates nothing precisely, and it does not authenticate.',
   ARRAY[]::text[], '2018-present', '$$', ARRAY['1977','print','season']::text[],
   'https://fearofgod.com/collections/essentials', 0.62, false, 'migration:00456')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: NONE. ────────────────────────────────────────────────
-- This is the first group in the epic that seeds NO decoder, and it is a finding
-- rather than an omission — see the header. The epic's rule is tag-printed AND
-- regular AND brand-unique. Streetwear identity is carried by a GRAPHIC, which is
-- not on the tag and is not parseable. The season notation (SS20 / FW17) is
-- genuinely regular and IS the price, but it is not tag-printed — it is resolved
-- against a release archive — so it is an informational tell exactly like the
-- Beyond Yoga / Sweaty Betty web codes (00452), never a decoder. A pattern over
-- it would mint a Supreme from any tag reading "FW17", which is the Lee "101"
-- mistake (00454) on the most-counterfeited brand in the KB.
--
-- Locked in by no-false-recovery cases in the golden set.

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Seeded ONLY where the brand uses a STABLE proprietary name. Supreme, Stüssy,
-- Kith and Palace are deliberately absent: their colors are per-drop and plain
-- ("red", "black"), so there is nothing proprietary to seed — the same rule that
-- kept the seasonal wash names out of 00454 and Chanel's colors out of 00455.

insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  -- BAPE: the CAMO PATTERNS are named, stable, and function exactly as the
  -- colorway does on other brands — a BAPE piece is described by its camo.
  ('bape', '1st Camo', ARRAY['first camo','ape head camo']::text[], null, null,
   'https://bape.com/', 0.70, false, 'migration:00456'),
  ('bape', 'ABC Camo', ARRAY['abc']::text[], null, null,
   'https://bape.com/', 0.70, false, 'migration:00456'),
  ('bape', 'City Camo', ARRAY['city']::text[], null, null,
   'https://bape.com/', 0.60, false, 'migration:00456'),
  ('bape', 'Woodland Camo', ARRAY['woodland']::text[], null, null,
   'https://bape.com/', 0.58, false, 'migration:00456'),
  -- Fear of God Essentials: the seasonal color names ARE how pieces are
  -- described and searched, and they are stable enough to be worth seeding.
  ('fearofgodessentials', 'Buttercream', ARRAY['butter','cream']::text[], null, null,
   'https://fearofgod.com/collections/essentials', 0.65, false, 'migration:00456'),
  ('fearofgodessentials', 'Moss', ARRAY['olive','green moss']::text[], null, null,
   'https://fearofgod.com/collections/essentials', 0.62, false, 'migration:00456'),
  ('fearofgodessentials', 'Oat', ARRAY['oatmeal','tan']::text[], null, null,
   'https://fearofgod.com/collections/essentials', 0.62, false, 'migration:00456'),
  ('fearofgodessentials', 'Concrete', ARRAY['grey','gray concrete']::text[], null, null,
   'https://fearofgod.com/collections/essentials', 0.62, false, 'migration:00456'),
  ('fearofgodessentials', 'Stretch Limo', ARRAY['black']::text[], null, null,
   'https://fearofgod.com/collections/essentials', 0.58, false, 'migration:00456')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts ───────────────────────────────────────────────────────
-- ALL VALUES ARE INCHES, and these are GARMENT-FLAT figures doubled to a body
-- equivalent for the nominal streetwear grade — not brand-published specs. The
-- notes say so and confidence is capped at 0.55-0.60 so the US-1715 verifier
-- replaces them with published numbers rather than rubber-stamping them.
--
-- THE GROUP'S SIGNATURE TRAP LIVES HERE. Every chart is labeled with an ordinary
-- alpha letter and the letter lies in OPPOSITE directions across the pack: a BAPE
-- L is roughly a US M (Japanese sizing, runs small) while an Essentials L drapes
-- like a US XL (deliberately oversized). Unlike 00455's "IT 42", nothing on the
-- tag announces which system it is. So the BAPE charts carry their US equivalent
-- INSIDE THE SIZE LABEL ("JP L (≈US M)"), where the model actually reads it.
--
-- NO CHART IS SEEDED FOR brand_key 'fearofgod' (mainline), on purpose and for two
-- independent reasons: its sizing is collection-specific and unpublished, so a
-- chart would be invention; and findSizingCharts matches brandMatch by SUBSTRING,
-- so a "fear of god" chart would ALSO fire on every "Fear of God Essentials"
-- garment — the diffusion label's name CONTAINS the mainline's — and hand it the
-- wrong numbers. Mainline falls through to the generic charts, as Coach/LV/Gucci
-- do. Asserted in streetwear-content_test.ts.
--
-- All INSERTs — no UPDATE of an existing row. No shared-chart narrowing is
-- needed: no existing chart's brand_match claims any of these brands.

insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values

  ('supreme', 'Supreme', ARRAY['supreme']::text[], 'Men', 'Tops (tees & hoodies, US alpha)',
   ARRAY['tee','t-shirt','shirt','top','hoodie','sweatshirt','crewneck','hooded']::text[],
   $json$[{"size":"S","measurements":{"chest":"36-38","length":"27-28"}},{"size":"M","measurements":{"chest":"38-40","length":"28-29"}},{"size":"L","measurements":{"chest":"42-44","length":"29-30"}},{"size":"XL","measurements":{"chest":"46-48","length":"30-31"}},{"size":"XXL","measurements":{"chest":"50-52","length":"31-32"}}]$json$::jsonb,
   'Supreme is US alpha sizing — no national cross-map applies, unlike BAPE in this same group, whose L is roughly a US M. The cut is BOXY BY DESIGN: a Supreme tee is meant to be short and wide, so a wide flat measurement is the intended silhouette and NOT a mislabel, NOT stretching and NOT a defect. These are body-equivalent figures in inches for the nominal streetwear grade, not Supreme-published specs. Measure the garment flat (chest across the underarm seam, doubled; length from the high shoulder point). Sizing does not change by season — the SEASON changes the price, not the fit.',
   'https://www.supremenewyork.com/', 0.55, false, 'migration:00456'),

  ('supreme', 'Supreme', ARRAY['supreme']::text[], 'Men', 'Bottoms (US numeric waist)',
   ARRAY['bottom','pant','jean','short','trouser','sweatpant','cargo']::text[],
   $json$[{"size":"US 28","measurements":{"waist":"28-29"}},{"size":"US 30","measurements":{"waist":"30-31"}},{"size":"US 32","measurements":{"waist":"32-33"}},{"size":"US 34","measurements":{"waist":"34-35"}},{"size":"US 36","measurements":{"waist":"36-37"}}]$json$::jsonb,
   'Supreme bottoms are US NOMINAL WAIST — the label is a measurement, not a letter mapped onto a body (the denim exception from 00454 applies here too). Cut relaxed by design. These are nominal figures in inches, not Supreme-published specs. Measure the flat waistband and double it.',
   'https://www.supremenewyork.com/', 0.55, false, 'migration:00456'),

  ('stssy', 'Stüssy', ARRAY['stussy','stüssy']::text[], 'Men', 'Tops (tees & fleece, US alpha)',
   ARRAY['tee','t-shirt','shirt','top','hoodie','sweatshirt','crewneck','fleece','hooded']::text[],
   $json$[{"size":"S","measurements":{"chest":"36-38","length":"27-28"}},{"size":"M","measurements":{"chest":"38-40","length":"28-29"}},{"size":"L","measurements":{"chest":"42-44","length":"29-30"}},{"size":"XL","measurements":{"chest":"46-48","length":"30-31"}},{"size":"XXL","measurements":{"chest":"50-52","length":"31-32"}}]$json$::jsonb,
   'Stüssy is US alpha sizing — no national cross-map applies, unlike BAPE in this same group. Cut relaxed/boxy by design, which is the intended silhouette and not a mislabel. These are body-equivalent figures in inches for the nominal streetwear grade, not Stüssy-published specs. Measure the garment flat (chest across the underarm seam, doubled). NOTE vintage pieces were graded differently from current production, so on this brand especially the tag is a claim to check against the actual measurement.',
   'https://www.stussy.com/', 0.55, false, 'migration:00456'),

  ('bape', 'BAPE', ARRAY['bape','a bathing ape','bathing ape']::text[], 'Men', 'Tops (JAPANESE sizing)',
   ARRAY['tee','t-shirt','shirt','top','hoodie','sweatshirt','crewneck','fleece','hooded','jacket']::text[],
   $json$[{"size":"JP S (≈US XS)","measurements":{"chest":"34-36","length":"25-26"}},{"size":"JP M (≈US S)","measurements":{"chest":"36-38","length":"26-27"}},{"size":"JP L (≈US M)","measurements":{"chest":"38-40","length":"27-28"}},{"size":"JP XL (≈US L)","measurements":{"chest":"42-44","length":"28-29"}},{"size":"JP XXL (≈US XL)","measurements":{"chest":"46-48","length":"29-30"}}]$json$::jsonb,
   'BAPE is JAPANESE sizing and it runs SMALL against a US body: a BAPE L is roughly a US M — one full size down. THIS IS THE GROUP''S COSTLIEST SIZING ERROR because nothing on the tag announces it. The tag says only "L", exactly like the Supreme and Essentials tags in this same pack, and those mean completely different bodies — an Essentials L drapes like a US XL, two sizes the other way. That is why the US equivalent is written into the size label here. These are body-equivalent figures in inches for the nominal JP grade, not BAPE-published specs. Measure the garment flat (chest across the underarm seam, doubled) and treat the tag as a claim to check. Does not apply to the Bapesta, which is a shoe.',
   'https://bape.com/', 0.55, false, 'migration:00456'),

  ('kith', 'Kith', ARRAY['kith']::text[], 'Men', 'Tops (tees & fleece, US alpha)',
   ARRAY['tee','t-shirt','shirt','top','hoodie','sweatshirt','crewneck','fleece','hooded']::text[],
   $json$[{"size":"S","measurements":{"chest":"37-39","length":"27-28"}},{"size":"M","measurements":{"chest":"39-41","length":"28-29"}},{"size":"L","measurements":{"chest":"43-45","length":"29-30"}},{"size":"XL","measurements":{"chest":"47-49","length":"30-31"}},{"size":"XXL","measurements":{"chest":"51-53","length":"31-32"}}]$json$::jsonb,
   'Kith is US alpha sizing — no national cross-map applies, unlike BAPE in this same group. The house line is cut fuller than a standard tee but nothing like the Essentials drape, which is a different brand in this same pack. These are body-equivalent figures in inches for the nominal grade, not Kith-published specs. Measure the garment flat (chest across the underarm seam, doubled). A COLLABORATION does not change the fit — it changes the price.',
   'https://kith.com/', 0.55, false, 'migration:00456'),

  ('palace', 'Palace', ARRAY['palace','palace skateboards']::text[], 'Men', 'Tops (tees & fleece, US alpha)',
   ARRAY['tee','t-shirt','shirt','top','hoodie','sweatshirt','crewneck','fleece','hooded']::text[],
   $json$[{"size":"S","measurements":{"chest":"36-38","length":"27-28"}},{"size":"M","measurements":{"chest":"38-40","length":"28-29"}},{"size":"L","measurements":{"chest":"42-44","length":"29-30"}},{"size":"XL","measurements":{"chest":"46-48","length":"30-31"}},{"size":"XXL","measurements":{"chest":"50-52","length":"31-32"}}]$json$::jsonb,
   'Palace is a UK brand on US alpha sizing — despite the origin, no national cross-map applies here (contrast BAPE in this same group, whose L is roughly a US M). Cut boxy by design, which is the intended skate silhouette and not a mislabel. These are body-equivalent figures in inches for the nominal streetwear grade, not Palace-published specs. Measure the garment flat (chest across the underarm seam, doubled).',
   'https://www.palaceskateboards.com/', 0.55, false, 'migration:00456'),

  ('fearofgodessentials', 'Fear of God Essentials',
   ARRAY['fear of god essentials','fearofgodessentials','essentials by fear of god']::text[],
   'Unisex', 'Tops (OVERSIZED, alpha)',
   ARRAY['tee','t-shirt','shirt','top','hoodie','sweatshirt','crewneck','fleece','hooded']::text[],
   $json$[{"size":"XS (drapes ≈US S)","measurements":{"chest":"38-40","length":"26-27"}},{"size":"S (drapes ≈US M)","measurements":{"chest":"42-44","length":"27-28"}},{"size":"M (drapes ≈US L)","measurements":{"chest":"46-48","length":"28-29"}},{"size":"L (drapes ≈US XL)","measurements":{"chest":"50-52","length":"29-30"}},{"size":"XL (drapes ≈US XXL)","measurements":{"chest":"54-56","length":"30-31"}}]$json$::jsonb,
   'Fear of God Essentials is cut DELIBERATELY OVERSIZED — dropped shoulders, boxy body — so an Essentials L drapes like a US XL, roughly one size up. THAT DRAPE IS THE DESIGN: it is not stretching, not a mislabel, not "runs large" as an error, and it must NOT be graded as wear. The drape is written into the size label because nothing on the tag announces it — the tag says only "L", and a BAPE L in this same group is a US M, two sizes the OTHER way. No national cross-map applies. These are body-equivalent figures in inches for the nominal grade, not brand-published specs. Measure the garment flat (chest across the underarm seam, doubled). Sizing does not differ by season — the season changes the price, not the fit.',
   'https://fearofgod.com/collections/essentials', 0.55, false, 'migration:00456'),

  ('fearofgodessentials', 'Fear of God Essentials',
   ARRAY['fear of god essentials','fearofgodessentials','essentials by fear of god']::text[],
   'Unisex', 'Bottoms (OVERSIZED, alpha)',
   ARRAY['bottom','pant','sweatpant','jogger','short','trouser']::text[],
   $json$[{"size":"XS (drapes ≈US S)","measurements":{"waist":"26-28"}},{"size":"S (drapes ≈US M)","measurements":{"waist":"28-31"}},{"size":"M (drapes ≈US L)","measurements":{"waist":"31-34"}},{"size":"L (drapes ≈US XL)","measurements":{"waist":"34-37"}},{"size":"XL (drapes ≈US XXL)","measurements":{"waist":"37-40"}}]$json$::jsonb,
   'Fear of God Essentials bottoms are cut DELIBERATELY OVERSIZED and the volume is the design, not a fit error — do not grade it as wear. Elasticated waists measure relaxed, so the figures are a range rather than a nominal waist. No national cross-map applies. These are body-equivalent figures in inches, not brand-published specs. Measure the flat waistband relaxed and double it.',
   'https://fearofgod.com/collections/essentials', 0.55, false, 'migration:00456')
on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00456') on conflict do nothing;
