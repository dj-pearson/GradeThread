-- US-1736: Luxury & designer brand knowledge group (6 brands).
--
-- Chanel, Burberry, Prada, Michael Kors, Kate Spade, Tory Burch — the luxury
-- tier beside the three flagships already seeded (Coach 00398, Louis Vuitton
-- 00399, Gucci 00400), which are deliberately NOT re-touched here.
--
-- Like the denim group (00454), this pack splits in half and the halves have
-- OPPOSITE rules, which is why it is worth one migration:
--
--   * EUROPEAN HOUSES (Chanel / Burberry / Prada) — among the most counterfeited
--     brands on earth. Their tag number is in a NATIONAL system (FR / UK / IT),
--     and their RTW runs SMALL against the US body a cross-map implies, because
--     vanity sizing is a US retail convention that these houses do not follow.
--   * AMERICAN ACCESSIBLE LUXURY (Michael Kors / Kate Spade / Tory Burch) — US
--     sizing, true-to-large. And for these three "is it real?" is usually the
--     WRONG QUESTION: the dominant value hazard is not a fake, it is an entirely
--     AUTHENTIC made-for-outlet or diffusion-line piece worth a fraction of the
--     mainline piece it resembles. The question is WHICH LINE, and the answer is
--     printed on the label.
--
-- THE GROUP'S SIGNATURE TRAP is the sizing system, and it is the reason the six
-- belong together. Three different national systems are in this pack and the
-- SAME NUMBER means different sizes in each:
--
--     a "42" tag  ->  Chanel (FR 42) = US 10
--                 ->  Prada  (IT 42) = US 6
--     a "12" tag  ->  Burberry (UK 12) = US 8
--
-- Reading a Prada 42 as a Chanel 42 is a two-size error on a high-value garment.
-- So EVERY European chart here is labeled in its own system WITH the US
-- equivalent in the size label itself ("IT 42 (US 6)"), and every note names the
-- system explicitly. The three American brands' notes say "US sizing" for the
-- same reason — the contrast is the fact.
--
-- CORPORATE MAP (recorded in the notes because a shared parent reads as a
-- counterfeit signal to a naive model and is not one): Kate Spade is TAPESTRY,
-- the same parent as Coach (already seeded, 00398) and Stuart Weitzman. Michael
-- Kors is CAPRI HOLDINGS, which also owns Versace and Jimmy Choo — so an MK and a
-- Versace piece sharing a corporate parent is ordinary. Prada Group owns Miu Miu,
-- Church's and Car Shoe — Miu Miu is Prada's sibling, NOT Prada, exactly as
-- AGOLDE is Citizens' sibling and not AG Jeans (00454). Chanel is privately held
-- by the Wertheimer family; Burberry and Tory Burch are independent.
--
-- LINE HIERARCHY is the money fact on the American half and it is a first-class
-- brand_styles row for each, because the line is the price:
--   * "Michael Kors Collection" (runway, Made in Italy) >> "KORS Michael Kors"
--     (discontinued middle line) >> "MICHAEL Michael Kors" (diffusion). All three
--     labels literally print their tier, and all three canonicalize to the eBay
--     brand "Michael Kors" — the LINE belongs in `style`, never in `brand`.
--   * "kate spade new york" (mainline) vs made-for-outlet product vs "Kate Spade
--     Saturday" (the 2013-2015 diffusion label, discontinued — a Saturday tag
--     dates the piece exactly).
-- Burberry ran the same play and retired it: Prorsum (runway) / London
-- (mainline) / Brit (casual) were consolidated into one "Burberry" label in 2016,
-- so a sub-label tag is itself a pre-2016 dating tell.
--
-- DECODERS — seeded for exactly ONE of the six, on the same rule the rest of the
-- epic uses (tag-printed AND regular AND brand-unique):
--   * Kate Spade `style_number` — the tag-printed PXRU/WKRU-family style code. The
--     4-LETTER family prefix is what makes it brand-unique and therefore safe to
--     anchor a pattern on. It identifies the STYLE FAMILY only; seeded at low
--     confidence for the US-1715 verifier to confirm rather than rubber-stamp.
--
-- CHANEL IS DELIBERATELY DECODER-LESS, and this is the group's one genuinely
-- close call, so it is recorded here rather than left to be re-litigated. The
-- interior serial sticker is tag-printed and regular, and the LOUIS VUITTON
-- PRECEDENT (00399) seeds exactly this kind of informational date code — but LV's
-- is "2 letters + 4 digits" (SD1160), a format distinctive enough to anchor on,
-- whereas Chanel's is a BARE 7-OR-8-DIGIT RUN. A bare digit run is an ordinary
-- number: a decoder over it would recover Chanel from ANY tag carrying an 8-digit
-- number, which is the Lee "101" mistake from 00454 with a much wider blast
-- radius (a fabricated Chanel is the most expensive false positive in the KB).
-- The serial's real content — that the DIGIT COUNT dates the piece — is seeded
-- where it belongs instead: as tag_eras + an authentication_tell, informational,
-- proving nothing. Locked in by a no-false-recovery case in the golden set.
--
-- Burberry, Prada, Michael Kors and Tory Burch are decoder-less for the ordinary
-- reason: they print a LINE NAME or a retailer SKU, not a regular brand-unique
-- garment code — and a SKU is an informational tell, never a decoder.
--
-- NEVER AUTO-AUTHENTICATE — the same stance as US-1727/1728 (LV/Gucci), and it
-- holds for all six. A serial sticker, a hologram, a check alignment or a
-- medallion NEVER proves authenticity. The KB flags inconsistencies in condition
-- notes and stops there.
--
-- Data-only. Every fact carries source_url + confidence and lands verified=false
-- for the US-1715 admin verify queue. Idempotent throughout.

-- ── brand_knowledge ─────────────────────────────────────────────────────────

-- Chanel (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('chanel', 'Chanel', ARRAY['chanel','cocochanel','chanelparis']::text[],
  ARRAY['luxury','handbags','jackets','tweed','ready-to-wear']::text[],
  $j$[{"era":"7-digit serial sticker","years":"1986-2005","description":"Interior adhesive serial-number sticker with 7 digits. Dates the piece to an era only."},{"era":"8-digit serial sticker","years":"2005-2021","description":"The sticker moved to 8 digits. Still an era marker only — it encodes no model and no size."},{"era":"microchip","years":"2021-present","description":"From 2021 Chanel replaced the printed serial sticker with an embedded RFID MICROCHIP. Absence of a visible serial on a recent piece is NORMAL, not a defect and not a red flag."}]$j$::jsonb,
  $j$[{"tell":"Serial sticker / microchip","detail":"A serial sticker identifies the ERA ONLY (by digit count), never the model, and proves NOTHING about authenticity — stickers are among the most-copied elements. Post-2021 pieces carry a hidden microchip and no visible serial."},{"tell":"NEVER auto-authenticate","detail":"Chanel is one of the most counterfeited brands in existence. A serial, a CC lock, a quilt or a hologram alone NEVER proves authenticity — a real determination needs construction, hardware weight, stitch count, leather and (post-2021) chip verification. NEVER label a Chanel item authentic; flag inconsistencies in condition notes only."},{"tell":"Chain construction separates the icons","detail":"Informational, NOT an authenticity test: the Classic Flap's chain has LEATHER woven through it, while the 2.55 Reissue's chain is ALL METAL. This distinguishes two different models at two different prices — it says nothing about whether either is real."}]$j$::jsonb,
  'FRENCH sizing (FR = US + 32; FR 42 = US 10) and it runs SMALL against that map — Chanel does not use US vanity sizing. The serial sticker dates the piece and nothing more. EXTREME counterfeit risk: NEVER auto-authenticate. Privately held (Wertheimer family) — no corporate siblings.',
  'https://www.chanel.com/us/', 0.80, false, 'migration:00455')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Burberry (ENRICHES the bare alias-only row seeded by 00389).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('burberry', 'Burberry', ARRAY['burberry','burberrys','burberrylondon','burberrysoflondon']::text[],
  ARRAY['luxury','outerwear','trench coats','scarves','ready-to-wear']::text[],
  $j$[{"era":"Burberrys (with the S)","years":"pre-1999","description":"A label reading BURBERRYS or BURBERRYS OF LONDON is the PRE-1999 mark — the brand dropped the possessive S in the 1999 rebrand. This is the single highest-leverage Burberry dating tell and it is legible on the main label."},{"era":"sub-label era (Prorsum / London / Brit)","years":"c.2000-2016","description":"Burberry ran three tiers — Prorsum (runway, top), London (mainline), Brit (casual, entry) — and consolidated all three into ONE Burberry label announced in 2016. A Prorsum/London/Brit tag therefore both dates the piece to the sub-label era AND states its tier."},{"era":"single Burberry label","years":"2016-present","description":"Post-consolidation pieces carry a plain Burberry label with no tier word."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"Burberry check outerwear is heavily counterfeited. Check alignment, a Nova Check lining or an Equestrian Knight logo NEVER proves authenticity on its own. NEVER label a Burberry item authentic; flag inconsistencies in condition notes only."},{"tell":"Burberrys spelling","detail":"Informational dating tell, NOT an authenticity test: a BURBERRYS (with S) label means pre-1999. It does not make a piece real, and a modern-spelled Burberry label does not make one fake."},{"tell":"Check pattern is not a tier signal","detail":"The Nova/House Check appears across every tier and across licensed accessories, so the check alone says nothing about value. The TIER WORD on the label (Prorsum > London > Brit) is what ranks a pre-2016 piece."}]$j$::jsonb,
  'The label carries two independent facts: the SPELLING dates it (Burberrys = pre-1999) and the TIER WORD ranks it (Prorsum > London > Brit, all consolidated into one label in 2016). UK sizing on womenswear (UK = US + 4; UK 12 = US 8), IT numeric on men''s tailoring — and it runs SMALL against the cross-map. Independent PLC; no corporate siblings.',
  'https://us.burberry.com/', 0.80, false, 'migration:00455')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Prada (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('prada', 'Prada', ARRAY['prada','pradamilano']::text[],
  ARRAY['luxury','handbags','nylon','ready-to-wear']::text[],
  $j$[{"era":"Prada Sport (red stripe)","years":"c.1997-2000s","description":"The red-stripe sport line was originally labeled PRADA SPORT and was later renamed LINEA ROSSA. A PRADA SPORT label is therefore the older form and dates the piece; the red stripe itself continues to this day under the Linea Rossa name."},{"era":"Re-Nylon","years":"2019-present","description":"From 2019 Prada began converting its signature nylon to RE-NYLON (regenerated ECONYL). A Re-Nylon label is a post-2019 marker; earlier nylon is the original Pocono/Tessuto and is NOT a lesser material."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"Prada is among the most counterfeited luxury brands. A triangle plaque, a Saffiano cross-hatch, an authenticity card or a serial NEVER proves authenticity on its own. NEVER label a Prada item authentic; flag inconsistencies in condition notes only."},{"tell":"Saffiano is a FINISH, not a Prada-exclusive","detail":"CRITICAL and routinely misread: Saffiano is a cross-hatch-stamped, wax-treated leather finish that Prada originated but that is now used industry-wide — Michael Kors builds much of its line on the same look at a fraction of the price. A cross-hatch texture therefore does NOT mean Prada. Read the hardware and the label, never the texture."},{"tell":"Authenticity card","detail":"Informational only: the card that ships with a piece is a paper insert, is trivially reproduced, and is frequently absent from genuine resale pieces. Its presence or absence proves nothing either way."}]$j$::jsonb,
  'ITALIAN sizing (IT = US + 36 on womenswear, IT = US + 10 on menswear chest; IT 42 = US 6) and it runs SMALL against that map. NOTE the collision with Chanel: a 42 tag is US 6 here and US 10 on a Chanel FR tag. Prada Group also owns MIU MIU, Church''s and Car Shoe — Miu Miu is Prada''s SIBLING, not Prada, and must never be relabeled as Prada.',
  'https://www.prada.com/us/en.html', 0.80, false, 'migration:00455')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Michael Kors (ENRICHES the bare alias-only row seeded by 00389).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('michaelkors', 'Michael Kors', ARRAY['michaelkors','mk','kors','michaelmichaelkors','korsmichaelkors','michaelkorscollection']::text[],
  ARRAY['accessible luxury','handbags','ready-to-wear']::text[],
  $j$[{"era":"KORS Michael Kors","years":"c.2004-2010s","description":"The KORS Michael Kors label was the middle tier between Collection and MICHAEL, and has been discontinued — a KORS-labeled piece is therefore from that era. It is a dating tell, not a defect."}]$j$::jsonb,
  $j$[{"tell":"Read the LINE, not the logo","detail":"THE Michael Kors call, and it is a value question rather than an authenticity one. Three tiers all print their own name: MICHAEL KORS COLLECTION (runway, largely Made in Italy) is worth multiples of MICHAEL MICHAEL KORS (the diffusion line, whose label literally stacks the word MICHAEL above Michael Kors). KORS Michael Kors sat between them and is discontinued. The MK logo is on all of them and ranks nothing."},{"tell":"Made-for-outlet product","detail":"Much MK outlet product is manufactured FOR the outlet and never sold at full retail. It is entirely AUTHENTIC and worth materially less than the mainline piece it resembles — so a suspicion of 'fake' is usually a misread of an outlet piece. Do not describe it as fake, and do not price it as mainline."},{"tell":"NEVER auto-authenticate","detail":"MK is counterfeited, but the dominant hazard here is line/outlet confusion rather than fakes. Either way: NEVER label an item authentic; flag inconsistencies in condition notes only."}]$j$::jsonb,
  'US sizing, true-to-large — the opposite of the European half of this group. The LINE is the price (Collection >> KORS >> MICHAEL) and every line prints its own name on the label; all of them canonicalize to the eBay brand "Michael Kors", so the line belongs in `style`, never in `brand`. Parent is CAPRI HOLDINGS, which also owns Versace and Jimmy Choo — a shared parent with Versace is ordinary, not a counterfeit signal.',
  'https://www.michaelkors.com/', 0.80, false, 'migration:00455')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Kate Spade (ENRICHES the bare alias-only row seeded by 00389).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('katespade', 'Kate Spade', ARRAY['katespade','katespadenewyork','ksny']::text[],
  ARRAY['accessible luxury','handbags','dresses','ready-to-wear']::text[],
  $j$[{"era":"Kate Spade Saturday","years":"2013-2015","description":"Saturday was a lower-priced diffusion label that ran for roughly two years before being discontinued in 2015. A Saturday tag therefore dates the piece almost exactly — and marks it as diffusion, not mainline."}]$j$::jsonb,
  $j$[{"tell":"Read the LINE, not the spade","detail":"The value question here is which line: 'kate spade new york' is the mainline; made-for-outlet product is built for the outlet channel and never sold at full retail; 'Kate Spade Saturday' was the 2013-2015 diffusion label. The spade logo appears on all of them and ranks nothing."},{"tell":"Made-for-outlet product","detail":"Outlet product is entirely AUTHENTIC and worth materially less than the mainline piece it resembles. Describing it as fake is wrong; pricing it as mainline is also wrong."},{"tell":"NEVER auto-authenticate","detail":"NEVER label a Kate Spade item authentic. A logo, a lining print or a style code proves nothing; flag inconsistencies in condition notes only."}]$j$::jsonb,
  'US sizing, true-to-large. The LINE is the price (mainline vs made-for-outlet vs the discontinued Saturday). Parent is TAPESTRY — the SAME parent as Coach (already seeded, 00398) and Stuart Weitzman, which is ordinary corporate structure and not a counterfeit signal.',
  'https://www.katespade.com/', 0.78, false, 'migration:00455')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Tory Burch (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('toryburch', 'Tory Burch', ARRAY['toryburch']::text[],
  ARRAY['accessible luxury','shoes','handbags','ready-to-wear']::text[],
  -- tag_eras deliberately EMPTY: Tory Burch is a 2004 brand with no documented,
  -- resale-relevant label generations. Seeding an era here would be invention.
  $j$[]$j$::jsonb,
  $j$[{"tell":"The double-T medallion is the brand mark, not a tier","detail":"The interlocking double-T medallion appears across the whole line from the Reva flat up, so it identifies the BRAND and ranks nothing. It is also the single most-copied Tory Burch element."},{"tell":"Made-for-outlet product","detail":"As with the rest of this group's American half, outlet product is entirely AUTHENTIC and worth materially less than the mainline piece it resembles."},{"tell":"NEVER auto-authenticate","detail":"NEVER label a Tory Burch item authentic. A medallion, a logo plate or a dust bag proves nothing; flag inconsistencies in condition notes only."}]$j$::jsonb,
  'US sizing, true-to-large. Founded 2004; independent — no corporate siblings. NOTE the alias hazard: "tory" alone is an ordinary given name and is deliberately NOT a curated alias, on the same rule that keeps a bare "citizens" off Citizens of Humanity (00454).',
  'https://www.toryburch.com/', 0.78, false, 'migration:00455')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────

insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values

  -- Chanel: the RTW icon plus the four bag lines that carry the resale volume.
  ('chanel', 'Tweed Jacket', 'Women', 'jacket', 'Ready-to-wear',
   'THE Chanel ready-to-wear piece: a collarless, boxy fantasy-tweed jacket with a silk lining, patch pockets and braided trim. Its construction fingerprint is a fine CHAIN sewn into the inside of the hem — it weights the jacket so it hangs straight — and the lining is quilted through to the tweed rather than hanging loose. Informational only: the chain identifies the CONSTRUCTION, it does not authenticate anything.',
   ARRAY['fantasy tweed','silk lining']::text[], null, '$$$$', ARRAY['tweed','jacket','collarless','chain hem']::text[],
   'https://www.chanel.com/us/fashion/', 0.75, false, 'migration:00455'),
  ('chanel', 'Classic Flap', 'Women', 'bag', 'Classic',
   'The diamond-quilted flap bag with a CC TURNLOCK and a chain that has LEATHER WOVEN THROUGH it. vs the 2.55 Reissue: these two are constantly conflated and are different prices — the Classic Flap has the CC lock and the leather-woven chain, the Reissue has neither.',
   ARRAY['lambskin','caviar leather']::text[], null, '$$$$', ARRAY['classic flap','quilted','cc turnlock']::text[],
   'https://www.chanel.com/us/', 0.75, false, 'migration:00455'),
  ('chanel', '2.55 Reissue', 'Women', 'bag', 'Reissue',
   'The heritage reissue: a rectangular MADEMOISELLE lock (not the CC turnlock) and an ALL-METAL chain with no leather woven through it. vs the Classic Flap: the lock and the chain are the two separators and both are readable in any photo of the front of the bag.',
   ARRAY['aged calfskin']::text[], null, '$$$$', ARRAY['2.55','reissue','mademoiselle lock']::text[],
   'https://www.chanel.com/us/', 0.72, false, 'migration:00455'),
  ('chanel', 'Boy Bag', 'Women', 'bag', 'Boy',
   'Boxier and more structured than the flaps, with a chunky rectangular PUSH-LOCK and a squared-off body. The silhouette alone separates it from the Classic Flap on a flat-lay.',
   ARRAY[]::text[], '2011-present', '$$$$', ARRAY['boy bag','push lock','structured']::text[],
   'https://www.chanel.com/us/', 0.72, false, 'migration:00455'),
  ('chanel', 'Chanel 19', 'Women', 'bag', '19',
   'Oversized, soft DIAMOND quilting on a slouchy body with a mixed-metal chain (gold, silver and ruthenium on the same strap). The oversized quilt and the mixed metals are the fingerprint — the Classic Flap''s quilt is much finer and its hardware is a single metal.',
   ARRAY[]::text[], '2019-present', '$$$$', ARRAY['chanel 19','oversized quilt','mixed metal']::text[],
   'https://www.chanel.com/us/', 0.70, false, 'migration:00455'),

  -- Burberry: the trench family is the resale engine, and the three fits differ
  -- ONLY by cut and length — same gabardine, same construction. So the FIT NAME
  -- on the tag is the identification (the 13MWZ-vs-936DEN lesson from 00454).
  ('burberry', 'Kensington Trench', 'Unisex', 'coat', 'Heritage Trench',
   'The SLIM-fit heritage trench in cotton gabardine, mid-length (roughly to the knee). vs Chelsea and Westminster: all three are the same gabardine with the same storm flap, epaulettes, D-ring belt and check lining — they differ ONLY in fit and length, which is very hard to judge on a flat-lay. READ THE FIT NAME OFF THE TAG rather than estimating the cut by eye.',
   ARRAY['cotton gabardine']::text[], null, '$$$$', ARRAY['kensington','trench','gabardine','slim']::text[],
   'https://us.burberry.com/', 0.75, false, 'migration:00455'),
  ('burberry', 'Chelsea Trench', 'Unisex', 'coat', 'Heritage Trench',
   'The SLIMMEST and SHORTEST of the three heritage trenches. vs Kensington: same fabric and same hardware, cut narrower and shorter — the tag is the only reliable separator.',
   ARRAY['cotton gabardine']::text[], null, '$$$$', ARRAY['chelsea','trench','gabardine','short']::text[],
   'https://us.burberry.com/', 0.75, false, 'migration:00455'),
  ('burberry', 'Westminster Trench', 'Unisex', 'coat', 'Heritage Trench',
   'The RELAXED and LONGEST heritage trench. vs Kensington and Chelsea: same gabardine again — the fit name on the tag is the identification.',
   ARRAY['cotton gabardine']::text[], null, '$$$$', ARRAY['westminster','trench','gabardine','relaxed','long']::text[],
   'https://us.burberry.com/', 0.75, false, 'migration:00455'),
  ('burberry', 'Nova Check Scarf', 'Unisex', 'scarf', 'Check',
   'The cashmere scarf in the camel/black/red/white house check. High counterfeit volume and heavily licensed historically, so the check pattern by itself ranks nothing — read the label.',
   ARRAY['cashmere']::text[], null, '$$$', ARRAY['nova check','scarf','cashmere','house check']::text[],
   'https://us.burberry.com/', 0.72, false, 'migration:00455'),
  ('burberry', 'Burberry Prorsum', 'Unisex', 'label', 'Tier label',
   'NOT a garment — the discontinued RUNWAY TIER label, retired when Burberry consolidated its three sub-labels into one in 2016. It must be read as a TIER and a DATE at once: Prorsum outranks London, which outranks Brit, and any of the three means the piece predates the consolidation. The tier word is on the main label and is the single most valuable thing on a pre-2016 Burberry.',
   ARRAY[]::text[], 'c.2000-2016', '$$$$', ARRAY['prorsum','london','brit','sub-label','tier']::text[],
   'https://us.burberry.com/', 0.70, false, 'migration:00455'),

  -- Prada: the nylon is the icon; Saffiano is the cross-brand confusion.
  ('prada', 'Re-Nylon', 'Unisex', 'bag', 'Nylon',
   'Prada''s signature technical nylon — matte, tightly woven, with the enameled TRIANGLE plaque. Re-Nylon is the regenerated (ECONYL) version introduced in 2019; earlier pieces are the original Pocono/Tessuto nylon and are NOT a lesser material. vs Saffiano: nylon is a smooth woven textile, Saffiano is a stamped cross-hatch LEATHER — they are not confusable in a photo.',
   ARRAY['Re-Nylon','ECONYL','Pocono nylon']::text[], '2019-present (Re-Nylon)', '$$$$', ARRAY['re-nylon','tessuto','nylon','triangle plaque']::text[],
   'https://www.prada.com/us/en.html', 0.75, false, 'migration:00455'),
  ('prada', 'Saffiano', 'Unisex', 'bag', 'Saffiano',
   'The cross-hatch-stamped, wax-treated leather Prada originated. THE TRAP ON THIS LINE IS CROSS-BRAND: Saffiano is now an industry-wide FINISH, and Michael Kors builds much of its line on the same cross-hatch look at a fraction of the price — so the texture does NOT identify Prada. The triangle plaque and the label do.',
   ARRAY['Saffiano leather']::text[], null, '$$$$', ARRAY['saffiano','cross-hatch','textured leather']::text[],
   'https://www.prada.com/us/en.html', 0.75, false, 'migration:00455'),
  ('prada', 'Linea Rossa', 'Unisex', 'jacket', 'Linea Rossa',
   'The RED-STRIPE sport line, formerly labeled PRADA SPORT — a Prada Sport label is the older form of the same line and dates the piece. The red stripe with the triangle plaque is the fingerprint; it is a distinct line with its own comps and must not be titled as mainline Prada.',
   ARRAY['technical nylon']::text[], 'c.1997-present (Prada Sport -> Linea Rossa)', '$$$', ARRAY['linea rossa','prada sport','red stripe']::text[],
   'https://www.prada.com/us/en.html', 0.72, false, 'migration:00455'),
  ('prada', 'Galleria', 'Women', 'bag', 'Saffiano',
   'The structured Saffiano tote with a trapezoidal body and a top handle. vs Cleo: Galleria is rigid, boxy and cross-hatch Saffiano; Cleo is a soft, flat, curved brushed-leather shoulder bag. The silhouettes are unmistakable side by side.',
   ARRAY['Saffiano leather']::text[], null, '$$$$', ARRAY['galleria','tote','saffiano','structured']::text[],
   'https://www.prada.com/us/en.html', 0.70, false, 'migration:00455'),

  -- Michael Kors: the LINE is the product. All three canonicalize to the brand
  -- "Michael Kors"; the tier lives here, in the style, which is the whole point.
  ('michaelkors', 'Michael Kors Collection', 'Unisex', 'label', 'Collection',
   'NOT a garment — the TOP TIER label (the runway line, largely Made in Italy). Worth MULTIPLES of a MICHAEL Michael Kors piece that may look similar in a thumbnail. The label reads MICHAEL KORS COLLECTION and the country of manufacture usually corroborates it. This is the single highest-leverage fact on the brand.',
   ARRAY[]::text[], null, '$$$$', ARRAY['collection','runway','made in italy','top tier']::text[],
   'https://www.michaelkors.com/', 0.75, false, 'migration:00455'),
  ('michaelkors', 'MICHAEL Michael Kors', 'Unisex', 'label', 'MICHAEL',
   'NOT a garment — the DIFFUSION tier, and by volume the overwhelming majority of MK resale. Its label literally stacks the word MICHAEL above Michael Kors, which is the separator and is legible on any tag photo. vs Collection: the MK logo is identical on both and ranks nothing — only the label wording does.',
   ARRAY[]::text[], null, '$$', ARRAY['michael michael kors','diffusion','entry tier']::text[],
   'https://www.michaelkors.com/', 0.75, false, 'migration:00455'),
  ('michaelkors', 'KORS Michael Kors', 'Unisex', 'label', 'KORS',
   'NOT a garment — the DISCONTINUED middle tier, between Collection and MICHAEL. A KORS label dates the piece to roughly the mid-2000s-2010s as well as ranking it.',
   ARRAY[]::text[], 'c.2004-2010s', '$$$', ARRAY['kors','middle tier','discontinued']::text[],
   'https://www.michaelkors.com/', 0.70, false, 'migration:00455'),
  ('michaelkors', 'Jet Set', 'Women', 'bag', 'MICHAEL',
   'MK''s highest-VOLUME resale item: the Jet Set tote/crossbody, most often in the cross-hatch Saffiano-style leather or the MK Signature coated canvas. vs Prada Saffiano: the same cross-hatch texture at a completely different price point — the texture is a finish, not a brand.',
   ARRAY['Saffiano-style leather','coated canvas']::text[], null, '$$', ARRAY['jet set','tote','crossbody','saffiano']::text[],
   'https://www.michaelkors.com/', 0.72, false, 'migration:00455'),
  ('michaelkors', 'MK Signature', 'Women', 'bag', 'MICHAEL',
   'The repeating-MK-logo COATED CANVAS (not leather), most familiar in the Vanilla/brown colorway. It is a printed PVC-coated textile — grading it as leather misdescribes it, and its wear pattern (surface cracking at the corners) is different from a leather bag''s.',
   ARRAY['PVC-coated canvas']::text[], null, '$$', ARRAY['mk signature','logo print','coated canvas','vanilla']::text[],
   'https://www.michaelkors.com/', 0.72, false, 'migration:00455'),

  -- Kate Spade: same shape as MK — the line is the price.
  ('katespade', 'kate spade new york', 'Unisex', 'label', 'Mainline',
   'NOT a garment — the MAINLINE label, and the tier that full-retail comps apply to. vs made-for-outlet product: they can look nearly identical in a thumbnail and are worth materially different amounts.',
   ARRAY[]::text[], null, '$$$', ARRAY['kate spade new york','ksny','mainline']::text[],
   'https://www.katespade.com/', 0.75, false, 'migration:00455'),
  ('katespade', 'Kate Spade Outlet', 'Unisex', 'label', 'Outlet',
   'NOT a garment — MADE-FOR-OUTLET product, manufactured for the outlet channel and never sold at full retail. It is entirely AUTHENTIC and worth materially less than the mainline piece it resembles. Do NOT describe it as fake, and do NOT comp it against mainline.',
   ARRAY[]::text[], null, '$', ARRAY['outlet','made for outlet','factory']::text[],
   'https://www.katespade.com/', 0.70, false, 'migration:00455'),
  ('katespade', 'Kate Spade Saturday', 'Unisex', 'label', 'Saturday',
   'NOT a garment — the DISCONTINUED lower-priced diffusion label, which ran only from 2013 until 2015. A Saturday tag therefore both dates the piece almost exactly and marks it as diffusion rather than mainline.',
   ARRAY[]::text[], '2013-2015', '$', ARRAY['saturday','diffusion','discontinued']::text[],
   'https://www.katespade.com/', 0.70, false, 'migration:00455'),
  ('katespade', 'Cameron Street', 'Women', 'bag', 'Mainline',
   'A mainline bag family in a pebbled/embossed leather with a structured, flat-bottomed body. Named families like this are the mainline signal — outlet product generally carries its own naming.',
   ARRAY['pebbled leather']::text[], null, '$$', ARRAY['cameron street','structured','pebbled']::text[],
   'https://www.katespade.com/', 0.65, false, 'migration:00455'),

  -- Tory Burch: the two shoes ARE the brand's resale, and they are separated by
  -- how the medallion is used — pressed flat vs cut through.
  ('toryburch', 'Reva Ballet Flat', 'Women', 'shoe', 'Reva',
   'THE Tory Burch icon: a soft ballet flat with a large double-T medallion sitting FLAT on the toe. vs the Miller sandal: the Reva''s medallion is a solid plate applied to the vamp, while the Miller''s medallion is CUT THROUGH so the strap passes between the toes. Wear concentrates on the medallion edges and the sole toe on this one.',
   ARRAY['leather','patent leather']::text[], null, '$$', ARRAY['reva','ballet flat','medallion']::text[],
   'https://www.toryburch.com/', 0.75, false, 'migration:00455'),
  ('toryburch', 'Miller Sandal', 'Women', 'shoe', 'Miller',
   'The thong sandal whose double-T medallion is CUT OUT — the toe strap passes through the medallion itself. vs the Reva: the Reva''s medallion is solid and sits flat on a closed toe. The footbed logo stamp and the medallion edge are the wear points.',
   ARRAY['leather','patent leather']::text[], null, '$$', ARRAY['miller','sandal','thong','cut-out medallion']::text[],
   'https://www.toryburch.com/', 0.75, false, 'migration:00455'),
  ('toryburch', 'Robinson', 'Women', 'bag', 'Robinson',
   'The structured tote in cross-hatch Saffiano-style leather with a small double-T plate. vs the Ella: Robinson is rigid, boxy, and leather; Ella is a soft, foldable NYLON tote. The two are the brand''s bag volume and are not confusable once the material is read.',
   ARRAY['Saffiano-style leather']::text[], null, '$$', ARRAY['robinson','tote','saffiano','structured']::text[],
   'https://www.toryburch.com/', 0.70, false, 'migration:00455'),
  ('toryburch', 'Ella Tote', 'Women', 'bag', 'Ella',
   'The soft, packable NYLON tote with leather trim and a double-T plate. vs Robinson: nylon and collapsible rather than rigid leather. Nylon fails differently from leather — look for pulls and seam fraying, not corner scuffing.',
   ARRAY['nylon']::text[], null, '$', ARRAY['ella','nylon tote','packable']::text[],
   'https://www.toryburch.com/', 0.70, false, 'migration:00455')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: ONE decoder only (see the header for why) ────────────
-- Chanel's serial sticker is the close call and it is deliberately NOT here: a
-- bare 7-8 digit run is an ordinary number, so a pattern over it would mint a
-- Chanel from any tag carrying an 8-digit number. See the header.

insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  -- Kate Spade style number: tag-printed and regular, and the 4-LETTER family
  -- prefix is what makes it brand-unique enough to anchor on. Identifies the
  -- STYLE FAMILY only. Low confidence on purpose — this is exactly the kind of
  -- fact the US-1715 verifier should confirm against a real tag, not rubber-stamp.
  ('katespade', 'style_number',
   'Kate Spade tag-printed style number: a 4-letter family prefix + 4 digits (e.g. PXRU5228, WKRU2673). Identifies the STYLE FAMILY only — it does not encode size, colorway or tier, and it does not authenticate.',
   '^(?<style>(?:PXRU|WKRU|PXRC|WKRC)[0-9]{4})$',
   $j${"fieldMap":{"style":"styleCode"},"transforms":{"style":"upper"},"confidence":0.55}$j$::jsonb,
   $j$[{"code":"PXRU5228","expected":{"styleCode":"PXRU5228"}}]$j$::jsonb,
   'https://www.katespade.com/', 0.55, false, 'migration:00455')
on conflict (brand_key, decoder_kind) do nothing;

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Seeded ONLY where the brand uses a STABLE proprietary color name. Chanel and
-- Kate Spade are deliberately absent: their color names are seasonal and turn
-- over every collection, so seeding them would encode facts with a shelf life
-- (the same rule that kept the seasonal wash names out of 00454).

insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  -- Burberry: the checks are named patterns and function as the colorway.
  ('burberry', 'Nova Check', ARRAY['house check','haymarket check','classic check']::text[], null, null,
   'https://us.burberry.com/', 0.70, false, 'migration:00455'),
  ('burberry', 'Vintage Check', ARRAY['archive check']::text[], null, '2018-present',
   'https://us.burberry.com/', 0.62, false, 'migration:00455'),
  ('burberry', 'Honey', ARRAY['classic trench beige','archive beige']::text[], null, null,
   'https://us.burberry.com/', 0.65, false, 'migration:00455'),
  -- Prada lists its colors in ITALIAN, which sellers routinely transcribe onto a
  -- listing untranslated — so the mapping is the useful fact here.
  ('prada', 'Nero', ARRAY['black']::text[], '#000000', null,
   'https://www.prada.com/us/en.html', 0.68, false, 'migration:00455'),
  ('prada', 'Cammello', ARRAY['camel','tan']::text[], null, null,
   'https://www.prada.com/us/en.html', 0.62, false, 'migration:00455'),
  ('prada', 'Talco', ARRAY['talc','off-white','chalk']::text[], null, null,
   'https://www.prada.com/us/en.html', 0.60, false, 'migration:00455'),
  -- Michael Kors.
  ('michaelkors', 'Vanilla', ARRAY['vanilla signature','cream logo']::text[], null, null,
   'https://www.michaelkors.com/', 0.62, false, 'migration:00455'),
  ('michaelkors', 'Luggage', ARRAY['tan','brown luggage']::text[], null, null,
   'https://www.michaelkors.com/', 0.60, false, 'migration:00455'),
  -- Tory Burch: "Tory Red" is the brand's one genuinely stable proprietary name.
  ('toryburch', 'Tory Red', ARRAY['tory burch red']::text[], null, null,
   'https://www.toryburch.com/', 0.68, false, 'migration:00455')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts ───────────────────────────────────────────────────────
-- ALL VALUES ARE INCHES. Every European chart carries its US equivalent INSIDE
-- the size label ("IT 42 (US 6)") so the cross-map survives into the rendered
-- prompt table, where the model actually reads it. Figures are the standard
-- national body grades, not brand-fetched measurements — the notes say so and
-- confidence is capped at 0.55-0.60 so the US-1715 verifier replaces them with
-- published brand numbers rather than rubber-stamping them.
--
-- All INSERTs — no UPDATE of an existing row. No shared-chart narrowing is
-- needed: no existing chart's brand_match claims any of these six brands.

insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values

  ('chanel', 'Chanel', ARRAY['chanel']::text[], 'Women', 'Jackets & tweed (FR sizing)',
   ARRAY['jacket','blazer','coat','tweed','outerwear']::text[],
   $json$[{"size":"FR 34 (US 2)","measurements":{"bust":"33-34","waist":"25-26"}},{"size":"FR 36 (US 4)","measurements":{"bust":"34-35","waist":"26-27"}},{"size":"FR 38 (US 6)","measurements":{"bust":"35.5-36.5","waist":"27.5-28.5"}},{"size":"FR 40 (US 8)","measurements":{"bust":"37-38","waist":"29-30"}},{"size":"FR 42 (US 10)","measurements":{"bust":"38.5-39.5","waist":"30.5-31.5"}},{"size":"FR 44 (US 12)","measurements":{"bust":"40-41","waist":"32-33"}}]$json$::jsonb,
   'Chanel is FRENCH sizing: the tag number is FR, and FR = US + 32 (FR 42 = US 10). DO NOT read it as Italian — a 42 on a PRADA tag is IT 42 = US 6, two sizes away. These are BODY measurements in inches for the nominal FR grade, not Chanel-published garment specs. Chanel RTW runs SMALL against this map: it does not use US vanity sizing, so a US 6 body frequently needs FR 40. Measure the garment flat (bust across the underarm seam, doubled) and treat the tag as a claim to check.',
   'https://www.chanel.com/us/fashion/', 0.55, false, 'migration:00455'),

  ('chanel', 'Chanel', ARRAY['chanel']::text[], 'Women', 'Dresses & tops (FR sizing)',
   ARRAY['dress','top','blouse','skirt','shirt','knit','sweater']::text[],
   $json$[{"size":"FR 34 (US 2)","measurements":{"bust":"33-34","waist":"25-26","hip":"35.5-36.5"}},{"size":"FR 36 (US 4)","measurements":{"bust":"34-35","waist":"26-27","hip":"36.5-37.5"}},{"size":"FR 38 (US 6)","measurements":{"bust":"35.5-36.5","waist":"27.5-28.5","hip":"38-39"}},{"size":"FR 40 (US 8)","measurements":{"bust":"37-38","waist":"29-30","hip":"39.5-40.5"}},{"size":"FR 42 (US 10)","measurements":{"bust":"38.5-39.5","waist":"30.5-31.5","hip":"41-42"}},{"size":"FR 44 (US 12)","measurements":{"bust":"40-41","waist":"32-33","hip":"42.5-43.5"}}]$json$::jsonb,
   'Chanel is FRENCH sizing (FR = US + 32; FR 42 = US 10). These are BODY measurements in inches for the nominal FR grade, not Chanel-published garment specs. Chanel RTW runs SMALL against this map — no US vanity sizing. Measure the garment flat and treat the tag as a claim to check.',
   'https://www.chanel.com/us/fashion/', 0.55, false, 'migration:00455'),

  ('burberry', 'Burberry', ARRAY['burberry']::text[], 'Women', 'Trench & outerwear (UK sizing)',
   ARRAY['trench','coat','jacket','outerwear','blazer']::text[],
   $json$[{"size":"UK 6 (US 2)","measurements":{"bust":"33-34","waist":"25-26","hip":"35.5-36.5"}},{"size":"UK 8 (US 4)","measurements":{"bust":"34-35","waist":"26-27","hip":"36.5-37.5"}},{"size":"UK 10 (US 6)","measurements":{"bust":"35.5-36.5","waist":"27.5-28.5","hip":"38-39"}},{"size":"UK 12 (US 8)","measurements":{"bust":"37-38","waist":"29-30","hip":"39.5-40.5"}},{"size":"UK 14 (US 10)","measurements":{"bust":"38.5-39.5","waist":"30.5-31.5","hip":"41-42"}},{"size":"UK 16 (US 12)","measurements":{"bust":"40-41","waist":"32-33","hip":"42.5-43.5"}}]$json$::jsonb,
   'Burberry womenswear is UK sizing: UK = US + 4 (UK 12 = US 8). A UK 12 trench is NOT a US 12 — mislabeling it costs two sizes. These are BODY measurements in inches for the nominal UK grade, not Burberry-published garment specs, and Burberry runs SMALL against the cross-map. Measure the coat flat (chest across the underarm seam, doubled) and treat the tag as a claim to check.',
   'https://us.burberry.com/', 0.55, false, 'migration:00455'),

  ('burberry', 'Burberry', ARRAY['burberry']::text[], 'Men', 'Tailoring & outerwear (IT sizing)',
   ARRAY['trench','coat','jacket','blazer','suit','outerwear','shirt']::text[],
   $json$[{"size":"IT 46 (US 36)","measurements":{"chest":"36-37"}},{"size":"IT 48 (US 38)","measurements":{"chest":"38-39"}},{"size":"IT 50 (US 40)","measurements":{"chest":"40-41"}},{"size":"IT 52 (US 42)","measurements":{"chest":"42-43"}},{"size":"IT 54 (US 44)","measurements":{"chest":"44-45"}},{"size":"IT 56 (US 46)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'Burberry menswear tailoring is ITALIAN numeric: IT = US + 10 on the chest (IT 50 = US 40). Note this is a DIFFERENT system from the same brand''s womenswear, which is UK. These are BODY chest measurements in inches for the nominal IT grade, not Burberry-published garment specs, and it runs SMALL against the cross-map. Measure the chest across the underarm seam and double it.',
   'https://us.burberry.com/', 0.55, false, 'migration:00455'),

  ('prada', 'Prada', ARRAY['prada']::text[], 'Women', 'Ready-to-wear (IT sizing)',
   ARRAY['dress','top','blouse','skirt','jacket','coat','knit','shirt','sweater']::text[],
   $json$[{"size":"IT 38 (US 2)","measurements":{"bust":"33-34","waist":"25-26","hip":"35.5-36.5"}},{"size":"IT 40 (US 4)","measurements":{"bust":"34-35","waist":"26-27","hip":"36.5-37.5"}},{"size":"IT 42 (US 6)","measurements":{"bust":"35.5-36.5","waist":"27.5-28.5","hip":"38-39"}},{"size":"IT 44 (US 8)","measurements":{"bust":"37-38","waist":"29-30","hip":"39.5-40.5"}},{"size":"IT 46 (US 10)","measurements":{"bust":"38.5-39.5","waist":"30.5-31.5","hip":"41-42"}},{"size":"IT 48 (US 12)","measurements":{"bust":"40-41","waist":"32-33","hip":"42.5-43.5"}}]$json$::jsonb,
   'Prada is ITALIAN sizing: IT = US + 36 on womenswear (IT 42 = US 6). DO NOT read it as French — a 42 on a CHANEL tag is FR 42 = US 10, two sizes larger. This collision is the most expensive mistake in this brand group. These are BODY measurements in inches for the nominal IT grade, not Prada-published garment specs. Prada RTW runs SMALL against this map — no US vanity sizing. Measure the garment flat and treat the tag as a claim to check.',
   'https://www.prada.com/us/en.html', 0.55, false, 'migration:00455'),

  ('prada', 'Prada', ARRAY['prada']::text[], 'Men', 'Ready-to-wear (IT sizing)',
   ARRAY['jacket','coat','blazer','suit','shirt','knit','sweater','top']::text[],
   $json$[{"size":"IT 46 (US 36)","measurements":{"chest":"36-37"}},{"size":"IT 48 (US 38)","measurements":{"chest":"38-39"}},{"size":"IT 50 (US 40)","measurements":{"chest":"40-41"}},{"size":"IT 52 (US 42)","measurements":{"chest":"42-43"}},{"size":"IT 54 (US 44)","measurements":{"chest":"44-45"}},{"size":"IT 56 (US 46)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'Prada menswear is ITALIAN numeric: IT = US + 10 on the chest (IT 50 = US 40). Note the menswear offset (+10) is NOT the womenswear offset (+36) — they are different grades of the same national system. These are BODY chest measurements in inches for the nominal IT grade, not Prada-published garment specs, and it runs SMALL against the cross-map. Measure the chest across the underarm seam and double it.',
   'https://www.prada.com/us/en.html', 0.55, false, 'migration:00455'),

  ('michaelkors', 'Michael Kors', ARRAY['michael kors','michaelkors']::text[], 'Women', 'Tops & dresses (US sizing)',
   ARRAY['top','dress','blouse','shirt','knit','sweater','jacket','blazer']::text[],
   $json$[{"size":"XS (US 0-2)","measurements":{"bust":"32-34","waist":"24-26"}},{"size":"S (US 4-6)","measurements":{"bust":"34-36.5","waist":"26-28.5"}},{"size":"M (US 8-10)","measurements":{"bust":"37-39.5","waist":"29-31.5"}},{"size":"L (US 12-14)","measurements":{"bust":"40-42.5","waist":"32-34.5"}},{"size":"XL (US 16)","measurements":{"bust":"43-45","waist":"35-37"}}]$json$::jsonb,
   'Michael Kors is US sizing — NOT the FR/IT/UK systems the European half of this brand group uses, so no cross-map applies. It runs true-to-large, the opposite of Chanel/Prada/Burberry. These are BODY measurements in inches for the nominal US alpha grade, not MK-published garment specs. Measure the garment flat (bust across the underarm seam, doubled). Sizing does NOT differ between the Collection and MICHAEL lines — the line changes the price, not the fit.',
   'https://www.michaelkors.com/', 0.55, false, 'migration:00455'),

  ('michaelkors', 'Michael Kors', ARRAY['michael kors','michaelkors']::text[], 'Women', 'Bottoms (US numeric)',
   ARRAY['bottom','pant','jean','skirt','short','trouser','legging']::text[],
   $json$[{"size":"US 0","measurements":{"waist":"24-25","hip":"34.5-35.5"}},{"size":"US 2","measurements":{"waist":"25-26","hip":"35.5-36.5"}},{"size":"US 4","measurements":{"waist":"26-27","hip":"36.5-37.5"}},{"size":"US 6","measurements":{"waist":"27.5-28.5","hip":"38-39"}},{"size":"US 8","measurements":{"waist":"29-30","hip":"39.5-40.5"}},{"size":"US 10","measurements":{"waist":"30.5-31.5","hip":"41-42"}},{"size":"US 12","measurements":{"waist":"32-33","hip":"42.5-43.5"}}]$json$::jsonb,
   'Michael Kors is US sizing — no national cross-map applies, unlike the European half of this brand group — and it runs true-to-large. These are BODY measurements in inches for the nominal US numeric grade, not MK-published garment specs. Measure the flat waistband and double it.',
   'https://www.michaelkors.com/', 0.55, false, 'migration:00455'),

  ('katespade', 'Kate Spade', ARRAY['kate spade','katespade']::text[], 'Women', 'Dresses (US numeric)',
   ARRAY['dress','gown','jumpsuit']::text[],
   $json$[{"size":"US 0","measurements":{"bust":"32-33","waist":"24-25","hip":"34.5-35.5"}},{"size":"US 2","measurements":{"bust":"33-34","waist":"25-26","hip":"35.5-36.5"}},{"size":"US 4","measurements":{"bust":"34-35","waist":"26-27","hip":"36.5-37.5"}},{"size":"US 6","measurements":{"bust":"35.5-36.5","waist":"27.5-28.5","hip":"38-39"}},{"size":"US 8","measurements":{"bust":"37-38","waist":"29-30","hip":"39.5-40.5"}},{"size":"US 10","measurements":{"bust":"38.5-39.5","waist":"30.5-31.5","hip":"41-42"}},{"size":"US 12","measurements":{"bust":"40-41","waist":"32-33","hip":"42.5-43.5"}}]$json$::jsonb,
   'Kate Spade is US sizing — no national cross-map applies, unlike the European half of this brand group — and it runs true-to-large. These are BODY measurements in inches for the nominal US numeric grade, not Kate Spade-published garment specs. Measure the garment flat (bust across the underarm seam, doubled). Mainline, outlet and the discontinued Saturday label share the same size grade — the LINE changes the price, not the fit.',
   'https://www.katespade.com/', 0.55, false, 'migration:00455'),

  ('katespade', 'Kate Spade', ARRAY['kate spade','katespade']::text[], 'Women', 'Tops & knits (US alpha)',
   ARRAY['top','blouse','shirt','knit','sweater','cardigan','jacket']::text[],
   $json$[{"size":"XS (US 0-2)","measurements":{"bust":"32-34","waist":"24-26"}},{"size":"S (US 4-6)","measurements":{"bust":"34-36.5","waist":"26-28.5"}},{"size":"M (US 8-10)","measurements":{"bust":"37-39.5","waist":"29-31.5"}},{"size":"L (US 12-14)","measurements":{"bust":"40-42.5","waist":"32-34.5"}},{"size":"XL (US 16)","measurements":{"bust":"43-45","waist":"35-37"}}]$json$::jsonb,
   'Kate Spade is US sizing — no national cross-map applies — and it runs true-to-large. These are BODY measurements in inches for the nominal US alpha grade, not Kate Spade-published garment specs. Measure the garment flat (bust across the underarm seam, doubled).',
   'https://www.katespade.com/', 0.55, false, 'migration:00455'),

  ('toryburch', 'Tory Burch', ARRAY['tory burch','toryburch']::text[], 'Women', 'Tops & dresses (US numeric)',
   ARRAY['top','dress','blouse','shirt','knit','sweater','jacket','blazer','tunic']::text[],
   $json$[{"size":"US 0","measurements":{"bust":"32-33","waist":"24-25","hip":"34.5-35.5"}},{"size":"US 2","measurements":{"bust":"33-34","waist":"25-26","hip":"35.5-36.5"}},{"size":"US 4","measurements":{"bust":"34-35","waist":"26-27","hip":"36.5-37.5"}},{"size":"US 6","measurements":{"bust":"35.5-36.5","waist":"27.5-28.5","hip":"38-39"}},{"size":"US 8","measurements":{"bust":"37-38","waist":"29-30","hip":"39.5-40.5"}},{"size":"US 10","measurements":{"bust":"38.5-39.5","waist":"30.5-31.5","hip":"41-42"}},{"size":"US 12","measurements":{"bust":"40-41","waist":"32-33","hip":"42.5-43.5"}}]$json$::jsonb,
   'Tory Burch is US sizing — no national cross-map applies, unlike the European half of this brand group — and it runs true-to-large. These are BODY measurements in inches for the nominal US numeric grade, not Tory Burch-published garment specs. Measure the garment flat (bust across the underarm seam, doubled).',
   'https://www.toryburch.com/', 0.55, false, 'migration:00455'),

  ('toryburch', 'Tory Burch', ARRAY['tory burch','toryburch']::text[], 'Women', 'Bottoms (US numeric)',
   ARRAY['bottom','pant','jean','skirt','short','trouser','legging']::text[],
   $json$[{"size":"US 0","measurements":{"waist":"24-25","hip":"34.5-35.5"}},{"size":"US 2","measurements":{"waist":"25-26","hip":"35.5-36.5"}},{"size":"US 4","measurements":{"waist":"26-27","hip":"36.5-37.5"}},{"size":"US 6","measurements":{"waist":"27.5-28.5","hip":"38-39"}},{"size":"US 8","measurements":{"waist":"29-30","hip":"39.5-40.5"}},{"size":"US 10","measurements":{"waist":"30.5-31.5","hip":"41-42"}},{"size":"US 12","measurements":{"waist":"32-33","hip":"42.5-43.5"}}]$json$::jsonb,
   'Tory Burch is US sizing — no national cross-map applies — and it runs true-to-large. These are BODY measurements in inches for the nominal US numeric grade, not Tory Burch-published garment specs. Measure the flat waistband and double it.',
   'https://www.toryburch.com/', 0.55, false, 'migration:00455')
on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00455') on conflict do nothing;
