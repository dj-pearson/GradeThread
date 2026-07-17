-- US-1984: Premium denim brand knowledge, tier 2 (8 brands).
--
-- Diesel, G-Star RAW, PAIGE, FRAME, MOTHER, Rag & Bone, Hudson Jeans, Joe's
-- Jeans — the denim tier beside 00454 (Wrangler / Lee / 7FAM / True Religion /
-- AG / Citizens), which is already seeded and is deliberately NOT re-touched.
-- ALL EIGHT were passthrough-only: no row, no alias, no chart, so a "mother" tag
-- rendered the seller's own casing into the prompt block and the eBay Brand
-- aspect.
--
-- 00454 established this category's rule: on PREMIUM denim the value is the FIT
-- NAME, and the fit name is a proper noun on the tag. This pack is that rule at
-- scale — six of the eight print a fit name and nothing else. What makes the
-- group worth its own migration is the three things 00454 did not have:
--
--   1. THE GROUP SPLITS EUROPEAN vs LA, and only the European half has an era.
--      Diesel (1978, Italy) and G-Star (1989, Netherlands) are old enough to date
--      and both coin their vocabulary. The six LA/contemporary houses (PAIGE,
--      FRAME, MOTHER, Rag & Bone, Hudson, Joe's) are 2000s premium denim, which
--      is not collectible by age — so NO tag_eras are seeded for them, on the
--      same rule that left 7FAM/AG/Citizens era-less in 00454. Fabricating an era
--      would be worse than having none.
--
--   2. DESIGNED DESTRUCTION IS THE MONEY FACT, and it runs three ways. MOTHER
--      NAMES its hem destruction (Fray, Chew) — a "Looker Ankle Fray" ships
--      shredded — and Diesel built a house on the destroyed wash. A grader who
--      reads either as wear marks a BRAND-NEW garment down to Poor. G-Star
--      inverts it: raw denim's honest fading is patina that buyers pay a premium
--      FOR. All three live in style FINGERPRINTS rather than tells, because
--      buildTrustedBrandFactsBlock truncates tells at 900 chars and
--      brandPackPromptBlock renders fingerprints VERBATIM (the US-1740 rule).
--
--   3. SIZING RUNS IN THREE DIRECTIONS, NOT TWO. 00454 had vintage-runs-small vs
--      premium-runs-large. Here the stretch houses (PAIGE Transcend, Hudson,
--      Joe's) run LARGE and give permanently; a RAW G-Star SHRINKS toward its tag
--      on first wash — the opposite mechanism; and MOTHER's frayed hem makes the
--      tag inseam a fiction. One blanket "denim runs X" rule is wrong for this
--      pack in two different directions.
--
-- LINEAGE MAP (recorded because a family resemblance between fit blocks looks
-- like copying to a naive model, and it is not — it is one genealogical tree):
-- ADRIANO GOLDSCHMIED co-founded DIESEL with Renzo Rosso in 1978 and two decades
-- later co-founded AG JEANS (00454) — this pack's oldest brand and 00454's AG
-- share a founder. MOTHER was founded by veterans of 7 For All Mankind and
-- Citizens of Humanity (both 00454). And HUDSON + JOE'S SHARE A CORPORATE PARENT:
-- Joe's Jeans Inc. acquired Hudson in 2013 and the combined company became
-- Differential Brands Group, later folded into Centric Brands — the same
-- shared-parent play as Wrangler/Lee under Kontoor in 00454.
--
-- DECODERS — seeded for exactly ONE of the eight, on the epic's standing rule
-- (tag-printed AND regular AND brand-unique in FORMAT):
--   * Diesel style_name — the model vocabulary is COINED. "Thommer", "Sleenker",
--     "Zatiny" and "Larkee" mean nothing in any language, so — like Uniqlo's
--     HEATTECH (00458) and unlike True Religion's "Ricky" (an ordinary first name
--     that needed the Super T compound to be safe) — the token identifies the
--     brand STANDING ALONE. That is what gives this group its cut-tag case.
-- Deliberately NOT decoded:
--   * G-Star's 3301 and 5620 are bare digit runs — the Lee "101" rule (00454) and
--     the Chanel serial rule (US-1736). A pattern over them mints a brand from any
--     tag carrying a 4-digit number.
--   * Rag & Bone's "Fit 1 / Fit 2 / Fit 3" IS regular and IS tag-printed, but
--     "Fit 2" is an ordinary English phrase — it fails brand-uniqueness, which is
--     the third test and the one that is easiest to skip.
--   * Hudson's fits (Barbara, Nico, Blake, Byron) are ordinary given names — the
--     exact True Religion "Ricky" hazard, with no stitch-weight suffix available
--     to compound with and make safe.
--   * FRAME's Le/L'Homme prefix is French, not brand-unique. MOTHER's fits (The
--     Looker, The Insider, The Tomcat) are ordinary English words. PAIGE and
--     Joe's print a fit NAME, not a regular code.
--
-- Data-only, idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  -- The two European brands: the only two here with a documented era, and the
  -- only two whose model vocabulary is coined rather than borrowed from English.
  ('diesel', 'Diesel', ARRAY['diesel','diesel jeans','diesel industry','diesel black gold','55dsl','diesel only the brave']::text[],
   ARRAY['denim','premium','italian','casual','mens','womens']::text[],
   $j$[{"era":"Pre-2019 coined fit names","years":"1990s-2019","description":"Diesel's long-running model vocabulary — Larkee, Thommer, Sleenker, Safado, Zatiny, Tepphar, Krooley, Buster. These names ran for two decades and a tag carrying one places the jean BEFORE the 2019 reset. The name itself is the dating tell on this brand, which is unusual and useful: it survives on the tag when nothing else dates the piece."},{"era":"The Glenn Martens D- family","years":"2019-present","description":"Glenn Martens became creative director in 2018 and the denim line was renamed onto a D- prefix — D-Strukt, D-Fining, D-Akemi, D-Viker — alongside year-named pieces (1995, 2020). A D- prefixed model name places the jean in the CURRENT era. So the model name alone separates the two Diesel generations without any other evidence."},{"era":"Diesel Black Gold","years":"2008-2018","description":"The discontinued premium/runway line, tagged as its own label. It sat ABOVE the mainline at retail and a Black Gold tag is a value signal rather than an ordinary Diesel one. The line was shut down around 2018, so the tag also dates the piece."},{"era":"Made in Italy","years":"vintage/premium lines","description":"Early and premium-line Diesel was Italian-made; the volume line is now largely offshore. On this brand a Made-in-Italy tag skews older or higher-line, but it is a weak hint on its own and is NOT an authenticity test."}]$j$::jsonb,
   $j$[{"pattern":"Made in Italy (early/premium) / Imported (current)","note":"An era and line hint rather than an authenticity verdict: Italian production skews vintage or premium-line, while a modern imported pair is entirely normal and unremarkable."}]$j$::jsonb,
   $j$[{"tell":"The DESTROYED WASH IS THE PRODUCT — do not grade it as damage","detail":"HIGHEST-CONSEQUENCE DIESEL FACT. Diesel built its reputation on heavily treated denim: shredding, holes, paint, patches and abrasion are frequently the DESIGNED FINISH and a brand-new pair can arrive looking wrecked. Grading that finish as wear marks a mint garment down to Poor and inverts its price. Read the destruction against the rest of the garment — a designed rip has clean, deliberate, symmetric placement with intact surrounding fibres and often an intentional backing patch; genuine wear is asymmetric, dirty, and sits where a body actually abrades a jean (seat, crotch, hem, pocket edges)."},{"tell":"The model name is COINED and it identifies the brand alone","detail":"Thommer, Sleenker, Larkee, Zatiny, Safado, Tepphar, Krooley, Buster, D-Strukt — these are invented words that mean nothing in English or Italian. That is why Diesel is the ONLY brand in this pack with a decoder: unlike an ordinary first name (True Religion's Ricky) the token stands alone as brand evidence, so it recovers Diesel off a cut tag. Transcribe it verbatim."},{"tell":"The model name DATES the jean","detail":"The pre-2019 names (Larkee, Thommer, Sleenker) versus the Glenn Martens D- family (D-Strukt, D-Fining) split the brand into two eras, and the tag name is the only evidence needed. Useful because Diesel's logo and patch have been comparatively stable — the model name dates the piece when the branding cannot."},{"tell":"The wash code is NOT a decodable style code","detail":"Diesel prints a wash/lot code beside the model name (forms like 0688H, 084HN, 069ZB). It identifies the FINISH, not the style, and it is a bare alphanumeric with no brand-unique shape — so it is deliberately not decoded here. Transcribe it into the listing if it is legible, but never let it recover a brand or a model."},{"tell":"Never auto-authenticate","detail":"Diesel is widely counterfeited and no published authentication standard, serial or date code exists. Flag inconsistencies in condition_notes and route authenticity to human review; never emit an authentic/fake verdict."}]$j$::jsonb,
   'Diesel identity = the COINED model name on the tag + the heavily treated wash. Founded 1978 in Molvena, Italy by Renzo Rosso — CO-FOUNDED WITH ADRIANO GOLDSCHMIED, who two decades later co-founded AG JEANS (seeded in 00454), so this pack''s oldest brand and 00454''s AG genuinely share a founder. Owned by Rosso''s OTB Group ("Only The Brave"), which also holds Maison Margiela, Marni and Jil Sander — a shared parent that is expected and is NOT a counterfeit signal. Sub-labels: Diesel Black Gold (premium, discontinued ~2018) and 55DSL (youth/sport line) are tagged as their own labels and are not mainline Diesel. The ONLY brand in this pack with a decoder — its model vocabulary is invented, so a single token recovers the brand off a cut tag. RN omitted — not sourceable.',
   'https://www.diesel.com/', 0.70, false, 'migration:00464'),

  ('gstarraw', 'G-Star RAW', ARRAY['g-star','gstar','g star','g-star raw','gstarraw','g star raw','gstar raw']::text[],
   ARRAY['denim','premium','dutch','streetwear','mens','womens']::text[],
   $j$[{"era":"Gap Star","years":"1989-1994","description":"The company launched in 1989 in Amsterdam as GAP STAR and renamed to G-Star in 1994 to avoid the collision with the American retailer Gap. A Gap Star tag is an early-1990s piece and is genuinely rare. NOTE the trap this creates in the other direction: a Gap Star tag is NOT a Gap tag, and must never be resolved to Gap."},{"era":"The Elwood / 3D denim era","years":"1996-present","description":"The Elwood (1996), designed by Pierre Morisset, introduced the 3D-constructed denim the brand is known for and remains its landmark piece. The 3D construction is a CONSTRUCTION era rather than a tag era — it is visible in the garment itself, which is what makes it durable evidence."},{"era":"RAW branding","years":"2000s-present","description":"The RAW suffix (G-Star RAW) marks the brand's untreated-denim premise and is the current branding. Its presence or absence on a tag is a weak era hint only."}]$j$::jsonb,
   $j$[{"pattern":"Made in Bangladesh / Turkey / China (current), Italy or Tunisia (early)","note":"A weak era hint at most. G-Star is a Dutch brand and has essentially never been Dutch-MADE, so a non-European production tag is entirely normal here and carries no authenticity signal."}]$j$::jsonb,
   $j$[{"tell":"RAW DENIM FADE IS PATINA, NOT DAMAGE — this brand inverts the usual rule","detail":"HIGHEST-CONSEQUENCE G-STAR FACT, and it runs OPPOSITE to every other brand in this pack. G-Star's premise is untreated raw denim, which is meant to be worn unwashed so it fades where the body creases it. The resulting whiskers (hip creases), honeycombs (behind the knee) and stacks are EARNED PATINA that raw-denim buyers pay a premium for — a well-faded pair can be worth MORE than a flat unworn one. Do not grade high-contrast fading on a raw G-Star as wear. Genuine damage is different and still counts: broken threads, holes at the crotch or hem, and open seams."},{"tell":"The 3D knee construction is the brand read on an unlabelled photo","detail":"The Elwood and the Arc/3D fits are built with articulated knee darts or pads and a seat panel — a motocross-derived construction that is SEWN IN and clearly visible in a photo. It is this brand's counterpart to the Wrangler broken-W: it survives a missing tag and it is the fastest way to place an unlabelled G-Star."},{"tell":"3301 and 5620 are MODEL numbers, not decodable codes","detail":"3301 is the core denim family and 5620 is the Elwood's number. Deliberately NOT seeded as a decoder: both are bare digit runs with no brand-unique shape, so a pattern over them would false-recover G-Star from any tag carrying a 4-digit number — the same rule that keeps Lee's 101 undecoded. Treat the number as a model name that must be CORROBORATED by a G-Star tag or the 3D construction, never as brand evidence on its own."},{"tell":"Raw denim SHRINKS — it does not stretch out","detail":"Unsanforized/raw denim shrinks on its first wash, typically an inch or two in the waist. So a raw G-Star behaves OPPOSITE to the stretch premium brands in this same pack, which give permanently at the waistband with wear. Whether the pair has been washed changes the measurement, so measure it rather than reading the tag."},{"tell":"Never auto-authenticate","detail":"No G-Star serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'G-Star RAW identity = the 3D/Elwood knee construction + untreated RAW denim. Founded 1989 in Amsterdam by Jos van Tilburg as GAP STAR, renamed G-Star in 1994; the Elwood (1996, designed by Pierre Morisset) is the brand''s landmark and the origin of its 3D denim. Independent Dutch company. NO decoder: 3301/5620 are bare digit runs (the Lee 101 rule). CAUTION: the early "Gap Star" mark must never resolve to GAP — they are unrelated companies, which is precisely why the name was changed. RN omitted — not sourceable.',
   'https://www.g-star.com/', 0.70, false, 'migration:00464'),

  -- The six LA/contemporary houses. NO tag_eras for any of them: 2000s-2010s
  -- premium denim is not collectible by age, and no authoritative era
  -- documentation exists. Same call 00454 made for 7FAM/AG/Citizens.
  ('paige', 'PAIGE', ARRAY['paige','paige denim','paige jeans','paige adams-geller']::text[],
   ARRAY['denim','premium','contemporary','womens','mens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA","note":"PAIGE cuts and sews much of its denim in Los Angeles, so Made in USA is EXPECTED here rather than notable — the same reading as AG and Citizens in 00454, and the opposite of what a domestic tag means on Wrangler/Lee, where it marks vintage."}]$j$::jsonb,
   $j$[{"tell":"TRANSCEND is the fabric platform and it is printed on the tag","detail":"HIGHEST-VALUE PAIGE FACT. Transcend (and Transcend Vintage) is the brand's proprietary stretch-fabric trademark and it is the brand's whole selling point. It is a coined word printed on the tag, so — like Uniqlo's HEATTECH — it is strong brand corroboration. Practical consequence: Transcend is a heavy-recovery stretch, so the pair gives with wear and a used one measures above its tag."},{"tell":"The FIT NAME is the product and it is on the tag","detail":"Verdugo (the ankle skinny — the volume women's seller), Hoxton (high-rise skinny), Margot, Cindy; Federal (the men's slim straight — the men's volume seller), Lennox, Croft, Normandie. The name is printed beside the size. Read it and carry it into the title — a buyer shops the fit name."},{"tell":"No signature pocket stitch — use the tag","detail":"Like AG and Citizens, PAIGE has no bold identifying pocket arc to fall back on. So the tag is the identification and an unlabelled pair is genuinely hard to place — say so rather than guessing the fit from the silhouette."},{"tell":"Never auto-authenticate","detail":"No PAIGE serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'PAIGE identity = the tag-printed fit name (Verdugo / Federal) + the TRANSCEND stretch-fabric trademark. Founded 2004-2005 in Los Angeles by Paige Adams-Geller, a former denim fit model — the brand''s premise is that she fit-tested the line on herself, which is why the fit names carry the brand. Much of the line is still made in Los Angeles, so a domestic tag is normal here. No decoder: the tag carries a fit NAME, not a regular code. RN omitted — not sourceable.',
   'https://www.paige.com/', 0.65, false, 'migration:00464'),

  -- FRAME and MOTHER are ORDINARY ENGLISH WORDS. Both are added to
  -- DETECT_EXCLUDED_FROM_TEXT in brand-normalize.ts in this same commit — see the
  -- note on each row. They stay reachable by TAG (an exact-key lookup, which is
  -- what the eBay aspect and the comp filter read) and are never minted from prose.
  ('frame', 'FRAME', ARRAY['frame','frame denim','frame jeans','le frame']::text[],
   ARRAY['denim','premium','contemporary','womens','mens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA (denim) / Imported (RTW)","note":"FRAME was founded in London but its denim is largely Los Angeles-made, so a domestic tag on the jeans is normal. Non-denim ready-to-wear is imported and unremarkable. Neither is an authenticity signal."}]$j$::jsonb,
   $j$[{"tell":"The FRENCH FIT NAME is the brand read","detail":"HIGHEST-VALUE FRAME FACT. FRAME names every fit in French — Le Skinny de Jeanne, Le High Straight, Le Garcon, Le Crop Mini Boot — and the men's line is L'HOMME. A denim tag reading Le or L'Homme beside a size is FRAME with very high probability; no other denim house uses the convention. It is not seeded as a decoder because the prefix is ordinary French rather than brand-unique, but as corroboration it is strong."},{"tell":"The brand name is an ORDINARY WORD — never read it out of prose","detail":"'Frame' is a common noun in clothing copy (a sunglasses frame, the frame of a bag), so the brand must only ever be taken from the TAG, never inferred from a title or description that happens to contain the word. Handled in code: FRAME is excluded from free-text brand detection."},{"tell":"No signature pocket stitch — use the tag","detail":"FRAME's back pockets are plain or subtly stitched, so there is no pocket tell to fall back on. The tag and the French fit name are the identification."},{"tell":"Never auto-authenticate","detail":"No FRAME serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'FRAME identity = the FRENCH fit name (Le Skinny de Jeanne / L''Homme) on the tag. Founded 2012 in London by Erik Torstensson and Jens Grede; now Los Angeles-based, and the denim is largely LA-made. NAME HAZARD: "frame" is an ordinary English word that clothing copy emits constantly, so the brand is in DETECT_EXCLUDED_FROM_TEXT (brand-normalize.ts) — reachable by tag, never guessed from prose. No decoder: the Le/L'' prefix is ordinary French, not brand-unique. RN omitted — not sourceable.',
   'https://www.frame-store.com/', 0.65, false, 'migration:00464'),

  ('mother', 'MOTHER', ARRAY['mother','mother denim','motherdenim','mother jeans']::text[],
   ARRAY['denim','premium','contemporary','womens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA","note":"MOTHER is a Los Angeles house and its denim is largely domestically sewn, so Made in USA is EXPECTED rather than notable — the same reading as AG, Citizens and PAIGE, and the opposite of what it means on Wrangler/Lee."}]$j$::jsonb,
   $j$[{"tell":"THE FRAYED HEM IS THE PRODUCT — never grade it as damage","detail":"HIGHEST-CONSEQUENCE MOTHER FACT and the most expensive error available on this brand. MOTHER NAMES its hem destruction and sells it as the feature: 'Fray', 'Chew', 'Step Fray', 'Ankle Fray'. A pair called The Looker Ankle Fray ships from the factory with a deliberately shredded, unfinished hem. Reading that hem as wear marks a BRAND-NEW garment down to Poor and destroys the price of a jean that is worth more BECAUSE it looks destroyed. The hem treatment is in the fit name on the tag — read the name before judging the hem."},{"tell":"The hem treatment is ORTHOGONAL to the fit name","detail":"'Fray' and 'Chew' are not fits — they are hem finishes that ANY fit can carry, which is why they are recorded as their own entry. The Looker is a fit; The Looker Ankle Fray is that fit with a named shredded hem, and it is a different product at a different price. Read both and put both in the title, exactly as True Religion's stitch grade (Super T) must be read independently of its fit name."},{"tell":"The FIT NAME is the product and it is on the tag","detail":"The Looker (the skinny — the volume seller), The Insider (crop bootcut), The Hustler (the flare), The Tomcat (relaxed straight), The Rascal, The Dazzler. All are prefixed 'The'. The name is printed beside the size — read it and title it."},{"tell":"The brand name is an ORDINARY WORD — never read it out of prose","detail":"'Mother' is a common word in clothing copy, and 'mother of pearl' buttons is one of the most frequent phrases in vintage listing text. So the brand must only ever be taken from the TAG, never inferred from a title or description containing the word. Handled in code: MOTHER is excluded from free-text brand detection."},{"tell":"Never auto-authenticate","detail":"No MOTHER serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'MOTHER identity = the "The X" fit name + a NAMED hem treatment (Fray / Chew) that is designed destruction, not damage. Founded 2010 in Los Angeles by Tim Kaeding and Lela Becker, veterans of the LA premium-denim houses seeded in 00454 (7 For All Mankind / Citizens of Humanity) — which is why MOTHER''s fit blocks resemble theirs, a shared lineage rather than a copy. Women''s-focused: no men''s chart is seeded because the line is women''s. NAME HAZARD: "mother" is an ordinary English word ("mother of pearl"), so the brand is in DETECT_EXCLUDED_FROM_TEXT (brand-normalize.ts) — reachable by tag, never guessed from prose. No decoder: the fits are ordinary English words. RN omitted — not sourceable.',
   'https://www.motherdenim.com/', 0.65, false, 'migration:00464'),

  -- Aliases carry BOTH "rag & bone" and "rag and bone": brandKey() strips the
  -- ampersand, so the two spellings key DIFFERENTLY (ragbone vs ragandbone) and
  -- sellers type both. It looks like a duplicate line and is not — the same trap
  -- the accented spellings hit in 00462.
  ('ragbone', 'Rag & Bone', ARRAY['rag & bone','rag and bone','ragbone','rag bone','rag+bone','ragandbone']::text[],
   ARRAY['denim','premium','contemporary','mens','womens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA (early denim) / Imported (current)","note":"The brand's origin story is Kentucky-made denim and early production was domestic; current production is largely offshore. A weak era hint at most and never an authenticity test."}]$j$::jsonb,
   $j$[{"tell":"The men's fits are NUMBERED and the number is on the tag","detail":"HIGHEST-VALUE RAG & BONE FACT. The men's denim runs on a numbered fit system: Fit 1 (skinny), Fit 2 (slim — the volume seller), Fit 3 (relaxed slim/athletic), Fit 4 (relaxed). The number is printed on the tag and it is what a buyer searches, so carry it into the title verbatim. It is deliberately NOT seeded as a decoder — 'Fit 2' is an ordinary English phrase and would false-recover the brand from any tag using those two words — so it must be CORROBORATED by a Rag & Bone tag rather than treated as brand evidence on its own."},{"tell":"The women's fits are named, not numbered","detail":"Cate (skinny), Dre (boyfriend/relaxed), Nina (high-rise skinny). The two halves of the line use DIFFERENT naming systems, which is unusual — do not expect a number on a women's tag or a name on a men's one."},{"tell":"The name is British slang, and the brand is American","detail":"'Rag-and-bone man' is the British term for a scrap collector; the founders are British but the brand was founded and is based in NEW YORK. Do not read the name as indicating British manufacture or a British label."},{"tell":"Denim is only part of the line","detail":"Rag & Bone is a full ready-to-wear and footwear house, and much of its resale volume is jackets, knitwear and boots rather than jeans. The numbered Fit system applies to the MEN'S DENIM only — do not apply it to a non-denim garment."},{"tell":"Never auto-authenticate","detail":"No Rag & Bone serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Rag & Bone identity = the NUMBERED men''s fit system (Fit 1/2/3) on the tag, with named women''s fits (Cate / Dre / Nina). Founded 2002 in New York by Marcus Wainwright and David Neville; the name is British slang for a scrap collector but the house is American. ALIAS TRAP: brandKey() strips the ampersand, so "rag & bone" and "rag and bone" are DIFFERENT keys and both are aliased. No decoder: "Fit 2" is regular and tag-printed but is an ordinary English phrase, failing the brand-uniqueness test. RN omitted — not sourceable.',
   'https://www.rag-bone.com/', 0.65, false, 'migration:00464'),

  -- Canonical is "Hudson Jeans", NOT "Hudson" — the AG Jeans play from 00454. A
  -- bare "Hudson" is an ordinary place and surname that free text emits on its
  -- own, so the short form is kept as an exact-match ALIAS only and never as the
  -- canonical string (which is what detectBrandInText scans over prose).
  ('hudsonjeans', 'Hudson Jeans', ARRAY['hudson','hudson jeans','hudsonjeans','hudson denim']::text[],
   ARRAY['denim','premium','contemporary','womens','mens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA (early) / Imported (current)","note":"Early Hudson was Los Angeles-made; later production moved offshore. A weak era hint only — it carries little value signal, because 2000s premium denim is not collectible by age."}]$j$::jsonb,
   $j$[{"tell":"The FLAP back pocket with signet buttons is the brand read","detail":"HIGHEST-VALUE HUDSON FACT. Hudson's signature is a back pocket with a button-down FLAP fastened by engraved signet buttons — the one brand mark in this pack's LA half that is genuinely readable on an unlabelled photo, since PAIGE, FRAME and Joe's have no distinguishing pocket. It is sewn into the garment, so it survives a missing tag. Not every Hudson fit carries it, so its ABSENCE proves nothing."},{"tell":"The FIT NAME is the product and it is on the tag","detail":"Barbara (high-rise super skinny — the volume women's seller), Nico (mid-rise super skinny), Collin (mid-rise skinny), Krista; Blake (the men's slim straight — the men's volume seller), Byron (men's straight). The name is printed beside the size — read it and title it."},{"tell":"The fits are ordinary GIVEN NAMES — corroborate them","detail":"Barbara, Nico, Blake, Byron and Collin are ordinary first names, so — exactly like True Religion's Ricky in 00454 — they are NOT brand evidence on their own and no decoder is seeded. Unlike True Religion there is no Super T-style suffix to compound with, so the name must be corroborated by a Hudson tag or the flap pocket."},{"tell":"Shares a corporate parent with Joe's Jeans — expected, not suspicious","detail":"Joe's Jeans Inc. ACQUIRED Hudson in 2013 and the combined company became Differential Brands Group, later folded into Centric Brands. Hudson and Joe's (the sibling in this same pack) therefore share a parent — the same situation as Wrangler and Lee under Kontoor in 00454. A shared parent is not a counterfeit signal. Keep the two brands' comps separate regardless."},{"tell":"Never auto-authenticate","detail":"No Hudson serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Hudson Jeans identity = the FLAP back pocket with signet buttons + the tag-printed fit name (Barbara / Blake). Founded 2002 in Los Angeles by Peter Kim and Ben Taverniti. Acquired by JOE''S JEANS Inc. in 2013; the combined company became Differential Brands Group and was later folded into CENTRIC BRANDS — so Hudson and Joe''s (also in this pack) share a parent, which is expected and is NOT a counterfeit signal. NOTE the canonical is "Hudson Jeans", not "Hudson": a bare "Hudson" is an ordinary place and surname, so the short form is an exact-match alias only and never the canonical string. No decoder: the fits are ordinary given names. RN omitted — not sourceable.',
   'https://www.hudsonjeans.com/', 0.65, false, 'migration:00464'),

  -- A bare "joe" is deliberately NOT an alias — it is an ordinary given name (the
  -- same rule that keeps "bean" off L.L.Bean and "citizens" off Citizens of
  -- Humanity). A bare "joes" IS safe: BRAND_ALIASES is an exact whole-field
  -- lookup, so it only fires when the seller's entire brand field is "Joes".
  ('joesjeans', 'Joe''s Jeans', ARRAY['joes jeans','joesjeans','joe s jeans','joes','joes jeans usa']::text[],
   ARRAY['denim','premium','contemporary','womens','mens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA (early) / Imported (current)","note":"Early Joe's was Los Angeles-made; later production moved offshore. A weak era hint only, with little value signal — 2000s premium denim is not collectible by age."}]$j$::jsonb,
   $j$[{"tell":"The FIT NAME is the product and it is on the tag","detail":"HIGHEST-VALUE JOE'S FACT. The Brixton (the men's straight-and-narrow — the men's volume seller), The Slim Fit; The Charlie (women's high-rise skinny), The Icon (mid-rise skinny — the long-running classic), The Provocateur (bootcut). The name is printed beside the size; it is what a buyer searches and it is what sets the comp."},{"tell":"HONEY is the curvy fit and it is a distinct product","detail":"Honey is Joe's curvy-fit bootcut — cut for a larger hip-to-waist ratio rather than being a different leg shape. It is the brand's signature women's fit and it comps on its own terms, so it must never be flattened into a generic bootcut. The name is on the tag."},{"tell":"No signature pocket stitch — use the tag","detail":"Joe's back pockets are plain or subtly stitched, with no bold identifying arc of the kind True Religion or 7FAM carry. The tag is the identification and an unlabelled pair is hard to place — say so rather than guessing."},{"tell":"Shares a corporate parent with Hudson — expected, not suspicious","detail":"Joe's Jeans Inc. ACQUIRED Hudson (the sibling in this same pack) in 2013 and the combined company became Differential Brands Group, later folded into Centric Brands. The shared parent is expected and is not a counterfeit signal, but the two brands are distinct products and must never be comped against each other."},{"tell":"Never auto-authenticate","detail":"No Joe's serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Joe''s Jeans identity = the tag-printed fit name (The Brixton / The Icon / Honey), with no signature pocket stitch to fall back on. Founded 2001 in Los Angeles by Joe Dahan. The company ACQUIRED HUDSON in 2013 and became Differential Brands Group, later folded into CENTRIC BRANDS — so Joe''s and Hudson (also in this pack) share a parent, which is expected and is NOT a counterfeit signal. A bare "joe" is deliberately not an alias (an ordinary given name); "joes" is safe only because the alias table is an exact whole-field lookup. No decoder: the tag carries a fit NAME, not a regular code. RN omitted — not sourceable.',
   'https://www.joesjeans.com/', 0.65, false, 'migration:00464')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- Every fingerprint has ONE job: separate the style from the sibling it is
-- actually confused with — which in this pack is nearly always the neighbouring
-- FIT, because six of eight brands have no pocket tell at all. The
-- designed-destruction warnings live HERE rather than in the tells, because
-- brandPackPromptBlock renders fingerprints VERBATIM while the grading block
-- truncates tells at 900 chars (US-1740).
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  -- Diesel: the coined name identifies the brand AND dates it.
  ('diesel', 'Larkee', ARRAY['larkee','larkee-beex','larkee beex']::text[], 'Men', 'jean', 'Larkee',
   'Diesel''s long-running REGULAR STRAIGHT and the brand''s highest-volume men''s resale item. vs Thommer (slim) and Sleenker (skinny): the three sit on a single narrowing scale and are unreliable to separate on a flat-lay, so read the COINED NAME off the tag rather than judging the leg by eye — the name is the whole disambiguation. Larkee is a pre-2019 name, which also places the jean before the D- era.',
   ARRAY['denim','stretch denim']::text[], '1990s-2019 naming era', '$128-$198', ARRAY['larkee','diesel','regular straight','coined name']::text[],
   'https://www.diesel.com/', 0.65, false, 'migration:00464'),
  ('diesel', 'Thommer', ARRAY['thommer','thommer-x','thommer x']::text[], 'Men', 'jean', 'Thommer',
   'The men''s SLIM fit — the Larkee''s narrower sibling and the fit it is most often confused with. No pocket tell separates any two Diesel fits; the tag name does. A "-X" suffix marks the stretch version of the same block. Pre-2019 name, so it dates the jean to the older era.',
   ARRAY['stretch denim']::text[], '1990s-2019 naming era', '$148-$228', ARRAY['thommer','diesel','slim','coined name']::text[],
   'https://www.diesel.com/', 0.60, false, 'migration:00464'),
  ('diesel', 'Sleenker', ARRAY['sleenker','sleenker-x','sleenker x']::text[], 'Men', 'jean', 'Sleenker',
   'The men''s SKINNY — the narrowest of the pre-2019 men''s blocks, and the end of the Larkee/Thommer/Sleenker scale. Same rule: the coined name on the tag is the identification, not the silhouette in the photo.',
   ARRAY['stretch denim']::text[], '1990s-2019 naming era', '$148-$228', ARRAY['sleenker','diesel','skinny','coined name']::text[],
   'https://www.diesel.com/', 0.60, false, 'migration:00464'),
  ('diesel', 'Zatiny', ARRAY['zatiny','zathan']::text[], 'Men', 'jean', 'Zatiny',
   'The men''s BOOTCUT — the one pre-2019 men''s block whose silhouette is genuinely distinguishable in a photo, because the leg opens below the knee while the rest of the family tapers. Still confirm with the tag: Zatiny is a coined word and a strong brand read on its own.',
   ARRAY['denim']::text[], '1990s-2019 naming era', '$128-$198', ARRAY['zatiny','diesel','bootcut','coined name']::text[],
   'https://www.diesel.com/', 0.60, false, 'migration:00464'),
  ('diesel', 'D-Strukt', ARRAY['d-strukt','dstrukt','d strukt']::text[], 'Men', 'jean', 'D- family',
   'The CURRENT-era slim, and the entry that shows why the name dates the jean: D-Strukt is part of the D- family introduced under Glenn Martens from 2019, replacing Thommer as the volume slim. A D- prefix on the tag places the piece in the current era; a Thommer places it before it. The two are the SAME slot in the line a decade apart — which is why the model name, not the silhouette, is the era evidence.',
   ARRAY['stretch denim']::text[], '2019-present (Glenn Martens D- family)', '$148-$248', ARRAY['d-strukt','diesel','slim','glenn martens','current era']::text[],
   'https://www.diesel.com/', 0.60, false, 'migration:00464'),
  ('diesel', 'Diesel Black Gold', ARRAY['black gold','diesel black gold','dbg']::text[], 'Unisex', 'other', 'Diesel Black Gold',
   'NOT a fit — a discontinued premium LINE with its own tag, recorded because a Black Gold tag is a value signal rather than an ordinary Diesel one. It sat ABOVE the mainline at retail and was shut down around 2018, so the tag both prices and dates the piece. Read the tag for the words "Black Gold"; do not infer the line from the garment.',
   ARRAY['denim']::text[], '2008-2018', null, ARRAY['black gold','diesel','premium line','discontinued']::text[],
   'https://www.diesel.com/', 0.55, false, 'migration:00464'),

  -- G-Star: the 3D construction is the one thing here readable without a tag.
  ('gstarraw', 'Elwood 5620 3D', ARRAY['elwood','5620','elwood 5620','5620 3d','g-star elwood']::text[], 'Unisex', 'jean', 'Elwood',
   'THE G-Star piece and the brand''s landmark: the 1996 Elwood, designed by Pierre Morisset, whose motocross-derived 3D construction is SEWN INTO the garment — articulated knee darts/pads and a seat panel that are plainly visible in a photo. This is the one style in this entire pack identifiable with NO tag at all, and it is the brand''s counterpart to the Wrangler broken-W. "5620" is its model number but is NOT brand evidence on its own — it is a bare digit run, so the 3D KNEE is the read and the number only corroborates.',
   ARRAY['raw denim','3D construction']::text[], '1996-present', '$150-$230', ARRAY['elwood','5620','3d','knee darts','g-star','raw denim']::text[],
   'https://www.g-star.com/', 0.70, false, 'migration:00464'),
  ('gstarraw', '3301', ARRAY['3301','3301 slim','3301 straight','g-star 3301']::text[], 'Unisex', 'jean', '3301',
   'G-Star''s CORE denim family and its highest-volume resale item, sold across every leg shape (3301 Slim, 3301 Straight, 3301 Tapered) — so "3301" names the FAMILY and the leg word beside it names the fit. Both are on the tag; read both. CRITICAL: 3301 is a bare four-digit number with no brand-unique shape, so it must NEVER recover the brand on its own — corroborate with a G-Star tag or the 3D construction, the same rule that keeps Lee''s 101 undecoded.',
   ARRAY['raw denim','stretch denim']::text[], 'long-running core', '$110-$180', ARRAY['3301','g-star','raw denim','core family']::text[],
   'https://www.g-star.com/', 0.65, false, 'migration:00464'),
  ('gstarraw', 'Arc 3D', ARRAY['arc','arc 3d','arc 3d slim','arc zip']::text[], 'Unisex', 'jean', 'Arc',
   'The TWISTED/curved-leg fit — the seams spiral around the leg rather than running straight down it, which is a construction tell visible in a photo (look for the outseam migrating toward the front of the knee). vs the 3301 family: the 3301''s seams run conventionally. The Arc is the 3D idea applied to the whole leg rather than just the knee.',
   ARRAY['raw denim','3D construction']::text[], 'long-running core', '$130-$200', ARRAY['arc','3d','twisted seam','g-star']::text[],
   'https://www.g-star.com/', 0.60, false, 'migration:00464'),
  ('gstarraw', 'Type C', ARRAY['type c','typec','type c 3d']::text[], 'Unisex', 'jean', 'Type C',
   'The tapered 3D block sitting between the Arc and the 3301 — recorded because three adjacent 3D-constructed fits with similar seam work is exactly the situation where a model must NOT guess. Name the fit only when the tag says it.',
   ARRAY['raw denim','3D construction']::text[], 'long-running core', '$130-$200', ARRAY['type c','3d','tapered','g-star']::text[],
   'https://www.g-star.com/', 0.55, false, 'migration:00464'),

  -- PAIGE: fit name + the Transcend fabric trademark.
  ('paige', 'Verdugo', ARRAY['verdugo','verdugo ankle','verdugo ultra skinny']::text[], 'Women', 'jean', 'Verdugo',
   'The ankle SKINNY and PAIGE''s highest-volume women''s resale item, almost always in TRANSCEND stretch. vs Hoxton (also a high-rise skinny): the two are genuinely close and PAIGE has NO signature pocket stitch to separate them, so the tag name is the only reliable read. The Verdugo is cropped at the ankle where the Hoxton runs full length.',
   ARRAY['Transcend','stretch denim']::text[], 'long-running core', '$179-$229', ARRAY['verdugo','ankle skinny','transcend','paige']::text[],
   'https://www.paige.com/', 0.65, false, 'migration:00464'),
  ('paige', 'Hoxton', ARRAY['hoxton','hoxton ankle','hoxton high rise']::text[], 'Women', 'jean', 'Hoxton',
   'The HIGH-RISE skinny — the Verdugo''s closest sibling and the fit it is most often confused with. No pocket tell separates them; read the tag. Sold in ankle and full-length variants, so the crop is not a reliable separator either.',
   ARRAY['Transcend','stretch denim']::text[], 'long-running core', '$189-$239', ARRAY['hoxton','high rise','skinny','transcend','paige']::text[],
   'https://www.paige.com/', 0.60, false, 'migration:00464'),
  ('paige', 'Federal', ARRAY['federal','federal slim straight']::text[], 'Men', 'jean', 'Federal',
   'The men''s SLIM STRAIGHT and PAIGE''s highest-volume men''s resale item — the direct counterpart to AG''s Graduate in 00454. vs Lennox (slim) and Croft (skinny): three adjacent men''s blocks with no pocket tell, so the tag name is the identification. Whatever stretch it has is TRANSCEND, which gives with wear.',
   ARRAY['Transcend','stretch denim']::text[], 'long-running core', '$189-$229', ARRAY['federal','slim straight','transcend','paige']::text[],
   'https://www.paige.com/', 0.65, false, 'migration:00464'),
  ('paige', 'Lennox', ARRAY['lennox','lennox slim']::text[], 'Men', 'jean', 'Lennox',
   'The men''s SLIM — narrower than the Federal and wider than the Croft. Recorded as the Federal''s neighbour: the three men''s blocks sit close together and cannot be told apart on a flat-lay, which is precisely why the fit name must come from the tag.',
   ARRAY['Transcend','stretch denim']::text[], 'long-running core', '$189-$229', ARRAY['lennox','slim','transcend','paige']::text[],
   'https://www.paige.com/', 0.55, false, 'migration:00464'),
  ('paige', 'Margot', ARRAY['margot','margot high rise','margot skinny']::text[], 'Women', 'jean', 'Margot',
   'A high-rise women''s block sitting beside the Verdugo and Hoxton. Recorded for the same reason as Lennox: PAIGE''s women''s line is several adjacent skinny/high-rise fits with no distinguishing pocket, so name the fit only when the tag says it.',
   ARRAY['Transcend','stretch denim']::text[], 'long-running core', '$189-$239', ARRAY['margot','high rise','transcend','paige']::text[],
   'https://www.paige.com/', 0.55, false, 'migration:00464'),

  -- FRAME: the French name IS the brand read.
  ('frame', 'Le Skinny de Jeanne', ARRAY['le skinny de jeanne','le skinny','skinny de jeanne']::text[], 'Women', 'jean', 'Le Skinny',
   'FRAME''s original and highest-volume women''s skinny, and the clearest example of the brand''s read: the tag literally says "Le Skinny de Jeanne". A French fit name on a denim tag is FRAME with very high probability — no other denim house names its fits this way. vs Le High Straight: the names are the disambiguation, since FRAME has no pocket tell.',
   ARRAY['stretch denim']::text[], 'long-running core', '$189-$239', ARRAY['le skinny de jeanne','le skinny','frame','french fit name']::text[],
   'https://www.frame-store.com/', 0.65, false, 'migration:00464'),
  ('frame', 'Le High Straight', ARRAY['le high straight','le high','high straight']::text[], 'Women', 'jean', 'Le High',
   'The HIGH-RISE straight leg and one of FRAME''s core women''s blocks. Same brand read (the "Le" prefix on the tag); the fit is separated from Le Skinny and Le Garcon by the name alone, because the back pockets are plain across the line.',
   ARRAY['denim','stretch denim']::text[], 'long-running core', '$209-$259', ARRAY['le high straight','frame','high rise','french fit name']::text[],
   'https://www.frame-store.com/', 0.60, false, 'migration:00464'),
  ('frame', 'Le Garcon', ARRAY['le garcon','le garçon','garcon','boyfriend']::text[], 'Women', 'jean', 'Le Garcon',
   'The relaxed BOYFRIEND fit — the widest of FRAME''s core women''s blocks and the opposite pole from Le Skinny. NOTE the spelling: the tag carries the French "Le Garçon" with a cedilla, which is routinely mis-typed in listings and breaks the comp search. Copy it from the tag exactly.',
   ARRAY['denim']::text[], 'long-running core', '$209-$259', ARRAY['le garcon','boyfriend','relaxed','frame']::text[],
   'https://www.frame-store.com/', 0.60, false, 'migration:00464'),
  ('frame', 'L''Homme', ARRAY['l homme','lhomme','l''homme','l''homme slim','homme slim']::text[], 'Men', 'jean', 'L''Homme',
   'FRAME''s entire MEN''S denim line is named L''Homme (L''Homme Slim, L''Homme Skinny, L''Homme Straight) — so the tag reading "L''Homme" identifies both the brand and the department at once, and the word beside it is the fit. This is the single most useful FRAME string: an L''Homme tag on a pair of jeans is a men''s FRAME.',
   ARRAY['stretch denim']::text[], 'long-running core', '$199-$249', ARRAY['l homme','lhomme','frame','mens','french fit name']::text[],
   'https://www.frame-store.com/', 0.65, false, 'migration:00464'),

  -- MOTHER: the fit name + a NAMED hem treatment. The hem entry is this pack's
  -- counterpart to True Religion's "Super T" stitch-grade entry in 00454 — a
  -- price lever that is orthogonal to the fit and must be read separately.
  ('mother', 'The Looker', ARRAY['the looker','looker','looker ankle fray','the looker fray']::text[], 'Women', 'jean', 'The Looker',
   'MOTHER''s SKINNY and its highest-volume resale item. THE CALL ON THIS JEAN IS THE HEM, not the fit: a "Looker Ankle Fray" ships from the factory with a deliberately shredded, unfinished hem, and reading that hem as wear marks a BRAND-NEW garment down to Poor. The hem treatment is named in the fit string on the tag (Fray / Chew / Step Fray) — read the whole string before judging the hem, and carry all of it into the title.',
   ARRAY['stretch denim']::text[], 'long-running core', '$198-$248', ARRAY['the looker','looker','fray','chew','mother','skinny']::text[],
   'https://www.motherdenim.com/', 0.70, false, 'migration:00464'),
  ('mother', 'Fray / Chew hem', ARRAY['fray','chew','ankle fray','step fray','fray hem','chewed hem']::text[], 'Women', 'other', 'Hem treatment',
   'NOT a fit — a HEM TREATMENT that any MOTHER fit can carry, which is exactly why it is recorded as its own entry. "Fray" is a deliberately frayed raw hem; "Chew" is a chewed-up, torn hem; "Step Fray" is an asymmetric stepped one. ALL OF IT IS FACTORY-DESIGNED DESTRUCTION SOLD AS THE FEATURE — the garment is worth MORE because it looks destroyed, and a grader who reads it as damage inverts the price. It is visible in a photo and it must be read INDEPENDENTLY of the fit name, with both in the title ("The Looker Ankle Fray"), exactly as True Religion''s stitch grade is read independently of its fit.',
   ARRAY['stretch denim']::text[], 'long-running core', null, ARRAY['fray','chew','step fray','hem','mother','designed distressing']::text[],
   'https://www.motherdenim.com/', 0.70, false, 'migration:00464'),
  ('mother', 'The Insider', ARRAY['the insider','insider','insider crop']::text[], 'Women', 'jean', 'The Insider',
   'The crop BOOTCUT — often sold with a Fray or Chew hem, which is the point of the crop. vs The Hustler (the full-length flare): both flare below the knee and the Insider is cropped, but a frayed hem makes the length ambiguous in a photo. Read the tag name; the same designed-destruction rule applies to its hem.',
   ARRAY['stretch denim']::text[], 'long-running core', '$228-$268', ARRAY['the insider','insider','crop bootcut','fray','mother']::text[],
   'https://www.motherdenim.com/', 0.60, false, 'migration:00464'),
  ('mother', 'The Hustler', ARRAY['the hustler','hustler','hustler ankle fray']::text[], 'Women', 'jean', 'The Hustler',
   'The FLARE and one of MOTHER''s signature silhouettes — the widest leg opening in the line. Its most-sold form is "The Hustler Ankle Fray", i.e. the flare WITH the shredded hem. Same rule as every MOTHER piece: the frayed hem is the product, not damage.',
   ARRAY['stretch denim']::text[], 'long-running core', '$228-$298', ARRAY['the hustler','hustler','flare','ankle fray','mother']::text[],
   'https://www.motherdenim.com/', 0.65, false, 'migration:00464'),
  ('mother', 'The Tomcat', ARRAY['the tomcat','tomcat','tomcat roller']::text[], 'Women', 'jean', 'The Tomcat',
   'The relaxed STRAIGHT — a roomier, more vintage-cut block than the Looker, frequently in a rigid rather than stretch denim. Recorded as the Looker''s opposite pole: same brand, same hem treatments available, very different silhouette and comp.',
   ARRAY['rigid denim','denim']::text[], 'long-running core', '$228-$268', ARRAY['the tomcat','tomcat','relaxed straight','mother']::text[],
   'https://www.motherdenim.com/', 0.60, false, 'migration:00464'),
  ('mother', 'The Rascal', ARRAY['the rascal','rascal','rascal ankle snippet']::text[], 'Women', 'jean', 'The Rascal',
   'A relaxed/slouchy block sitting beside the Tomcat. Recorded because MOTHER''s "The X" fits are ordinary English words that give no clue to the silhouette — nothing about "Rascal" says relaxed — so the fit must be read from the tag and never inferred from the name.',
   ARRAY['denim']::text[], 'long-running core', '$228-$268', ARRAY['the rascal','rascal','relaxed','mother']::text[],
   'https://www.motherdenim.com/', 0.55, false, 'migration:00464'),

  -- Rag & Bone: the men's line is NUMBERED, the women's is NAMED.
  ('ragbone', 'Fit 2', ARRAY['fit 2','fit2','fit 2 slim']::text[], 'Men', 'jean', 'Numbered fits',
   'The men''s SLIM and Rag & Bone''s highest-volume men''s resale item — the middle of the numbered scale (Fit 1 skinny / Fit 2 slim / Fit 3 relaxed slim / Fit 4 relaxed). The NUMBER is printed on the tag and it is what a buyer searches, so carry "Fit 2" into the title verbatim. It must be corroborated by a Rag & Bone tag: "Fit 2" is an ordinary English phrase, which is why it is not a decoder.',
   ARRAY['denim','stretch denim']::text[], 'long-running core', '$195-$275', ARRAY['fit 2','slim','rag and bone','numbered fit']::text[],
   'https://www.rag-bone.com/', 0.65, false, 'migration:00464'),
  ('ragbone', 'Fit 1', ARRAY['fit 1','fit1','fit 1 skinny']::text[], 'Men', 'jean', 'Numbered fits',
   'The men''s SKINNY — the narrowest of the numbered scale and the Fit 2''s immediate neighbour. The number is the only separator: the fits share every brand mark, so a flat-lay cannot distinguish them and the tag settles it.',
   ARRAY['stretch denim']::text[], 'long-running core', '$195-$265', ARRAY['fit 1','skinny','rag and bone','numbered fit']::text[],
   'https://www.rag-bone.com/', 0.60, false, 'migration:00464'),
  ('ragbone', 'Fit 3', ARRAY['fit 3','fit3','fit 3 athletic','fit 3 relaxed']::text[], 'Men', 'jean', 'Numbered fits',
   'The men''s RELAXED SLIM / athletic block — roomier through the seat and thigh than the Fit 2. Recorded to complete the numbered scale, which is the whole men''s identification system on this brand: read the number, do not judge the leg.',
   ARRAY['denim']::text[], 'long-running core', '$195-$275', ARRAY['fit 3','relaxed slim','athletic','rag and bone','numbered fit']::text[],
   'https://www.rag-bone.com/', 0.60, false, 'migration:00464'),
  ('ragbone', 'Cate', ARRAY['cate','cate skinny','cate mid rise']::text[], 'Women', 'jean', 'Cate',
   'The women''s SKINNY and the core women''s block. NOTE the system switch that makes this brand unusual: the women''s fits are NAMED (Cate, Dre, Nina) while the men''s are NUMBERED — so do not expect a number on this tag, and do not read a women''s name onto the Fit scale.',
   ARRAY['stretch denim']::text[], 'long-running core', '$195-$255', ARRAY['cate','skinny','rag and bone','womens']::text[],
   'https://www.rag-bone.com/', 0.60, false, 'migration:00464'),
  ('ragbone', 'Dre', ARRAY['dre','dre boyfriend','dre relaxed']::text[], 'Women', 'jean', 'Dre',
   'The women''s relaxed BOYFRIEND fit — the Cate''s opposite block. Same naming rule: a name, not a number, and the tag is the identification since the pockets carry no distinguishing arc.',
   ARRAY['denim']::text[], 'long-running core', '$195-$265', ARRAY['dre','boyfriend','relaxed','rag and bone','womens']::text[],
   'https://www.rag-bone.com/', 0.55, false, 'migration:00464'),

  -- Hudson: the flap pocket is the one LA-half brand mark readable without a tag.
  ('hudsonjeans', 'Barbara', ARRAY['barbara','barbara high rise','barbara super skinny']::text[], 'Women', 'jean', 'Barbara',
   'The HIGH-RISE super skinny and Hudson''s highest-volume women''s resale item. Look for the brand''s FLAP back pocket with signet buttons — the one identifying mark in this pack''s LA half that reads on an unlabelled photo. vs Nico (mid-rise super skinny): the RISE is the difference and it is unreliable on a flat-lay, so read the tag. "Barbara" is an ordinary first name and is not brand evidence on its own.',
   ARRAY['stretch denim']::text[], 'long-running core', '$185-$215', ARRAY['barbara','high rise','super skinny','flap pocket','hudson']::text[],
   'https://www.hudsonjeans.com/', 0.65, false, 'migration:00464'),
  ('hudsonjeans', 'Nico', ARRAY['nico','nico mid rise','nico super skinny']::text[], 'Women', 'jean', 'Nico',
   'The MID-RISE super skinny — the Barbara''s closest sibling, differing only in rise. Recorded as the Barbara''s counterpart: two adjacent skinnies separated by a measurement that photographs ambiguously is exactly the case for reading the tag.',
   ARRAY['stretch denim']::text[], 'long-running core', '$185-$215', ARRAY['nico','mid rise','super skinny','hudson']::text[],
   'https://www.hudsonjeans.com/', 0.60, false, 'migration:00464'),
  ('hudsonjeans', 'Collin', ARRAY['collin','collin skinny','collin mid rise']::text[], 'Women', 'jean', 'Collin',
   'A long-running mid-rise skinny sitting beside the Nico. Recorded because Hudson''s women''s line is several adjacent skinny blocks whose names are ordinary given names — nothing about "Collin" indicates a fit, so the tag is the only source.',
   ARRAY['stretch denim']::text[], 'long-running core', '$175-$205', ARRAY['collin','skinny','mid rise','hudson']::text[],
   'https://www.hudsonjeans.com/', 0.55, false, 'migration:00464'),
  ('hudsonjeans', 'Blake', ARRAY['blake','blake slim straight']::text[], 'Men', 'jean', 'Blake',
   'The men''s SLIM STRAIGHT and Hudson''s highest-volume men''s resale item. The flap back pocket with signet buttons is the brand read. vs Byron (the straight): the two men''s blocks differ only in leg width, and "Blake" and "Byron" are both ordinary first names — corroborate with a Hudson tag or the flap pocket, never from the name alone.',
   ARRAY['stretch denim']::text[], 'long-running core', '$185-$215', ARRAY['blake','slim straight','flap pocket','hudson']::text[],
   'https://www.hudsonjeans.com/', 0.65, false, 'migration:00464'),
  ('hudsonjeans', 'Byron', ARRAY['byron','byron straight']::text[], 'Men', 'jean', 'Byron',
   'The men''s STRAIGHT — the Blake''s roomier sibling. Recorded as the Blake''s counterpart; the tag name is the separator, since both wear the same flap pocket.',
   ARRAY['denim']::text[], 'long-running core', '$185-$215', ARRAY['byron','straight','hudson']::text[],
   'https://www.hudsonjeans.com/', 0.55, false, 'migration:00464'),

  -- Joe's Jeans: fit name only; Honey is the one distinct product.
  ('joesjeans', 'The Brixton', ARRAY['the brixton','brixton','brixton straight narrow']::text[], 'Men', 'jean', 'The Brixton',
   'The men''s STRAIGHT AND NARROW and Joe''s highest-volume men''s resale item. Joe''s has NO signature pocket stitch, so the tag is the identification — an unlabelled pair is genuinely hard to place and that should be said rather than guessed. vs The Slim Fit: the Brixton is the straighter of the two.',
   ARRAY['stretch denim']::text[], 'long-running core', '$158-$198', ARRAY['the brixton','brixton','straight narrow','joes jeans']::text[],
   'https://www.joesjeans.com/', 0.65, false, 'migration:00464'),
  ('joesjeans', 'The Charlie', ARRAY['the charlie','charlie','charlie high rise skinny']::text[], 'Women', 'jean', 'The Charlie',
   'The women''s HIGH-RISE skinny and the core current women''s block. vs The Icon (mid-rise skinny): the RISE is the only difference and it photographs ambiguously, so read the tag name.',
   ARRAY['stretch denim']::text[], 'long-running core', '$168-$198', ARRAY['the charlie','charlie','high rise','skinny','joes jeans']::text[],
   'https://www.joesjeans.com/', 0.60, false, 'migration:00464'),
  ('joesjeans', 'The Icon', ARRAY['the icon','icon','icon mid rise skinny']::text[], 'Women', 'jean', 'The Icon',
   'The MID-RISE skinny — Joe''s long-running classic women''s fit and the Charlie''s closest sibling. Recorded as the Charlie''s counterpart: same brand marks, same silhouette, different rise, and only the tag says which.',
   ARRAY['stretch denim']::text[], 'long-running core', '$168-$198', ARRAY['the icon','icon','mid rise','skinny','joes jeans']::text[],
   'https://www.joesjeans.com/', 0.60, false, 'migration:00464'),
  ('joesjeans', 'Honey', ARRAY['honey','honey curvy','honey bootcut','the honey']::text[], 'Women', 'jean', 'Honey',
   'The CURVY bootcut and Joe''s signature women''s fit — and the one Joe''s entry that is a genuinely distinct product rather than a neighbouring leg shape. Honey is cut for a larger hip-to-waist ratio, so it is a FIT BLOCK, not a leg width: it must never be flattened into a generic bootcut, because it comps on its own terms. The name is on the tag.',
   ARRAY['stretch denim']::text[], 'long-running core', '$169-$198', ARRAY['honey','curvy','bootcut','joes jeans']::text[],
   'https://www.joesjeans.com/', 0.65, false, 'migration:00464')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Diesel ONLY ──────────────────────────────────────────
-- The one brand in this pack whose garment-printed identifier passes all three
-- tests (tag-printed AND regular AND brand-unique). See the header for why the
-- other seven are refused — the pointed ones are G-Star's 3301 (a bare digit run,
-- the Lee 101 rule) and Rag & Bone's "Fit 2" (regular and tag-printed, but an
-- ordinary English phrase).
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  -- Diesel's model vocabulary is COINED — invented words that mean nothing in any
  -- language. That is the Uniqlo HEATTECH precedent (00458), not the True
  -- Religion "Ricky" problem (00454): the token needs no compound suffix to be
  -- safe, because no ordinary text produces it. So this recovers Diesel from a cut
  -- tag on the model name ALONE, which is this group's cut-tag case.
  --
  -- The optional "-X" suffix (Thommer-X = the stretch version of the same block)
  -- is tolerated but NOT captured — it marks the fabric, not the style, and there
  -- is no DecodeResult field for it. A non-capturing group is the US-1739 rule:
  -- a bogus fieldMap target would silently write a phantom property.
  ('diesel', 'style_name',
   'Diesel tag-printed model name. The vocabulary is COINED (Thommer, Sleenker, Larkee, Zatiny mean nothing in English or Italian), so a single token identifies the brand even when the brand tag itself is cut. The name also dates the jean: the listed pre-2019 names versus the Glenn Martens D- family (D-Strukt, D-Fining) are two distinct eras. An optional trailing "-X" stretch marker is tolerated but not captured.',
   '^(?<style>THOMMER|SLEENKER|LARKEE(?:-BEEX)?|ZATINY|ZATHAN|SAFADO|TEPPHAR|KROOLEY|BUSTER|WAYKEE|BELTHER|SLANDY|SKINZEE|D-STRUKT|D-FINING|D-AKEMI|D-VIKER)(?:-X)?$',
   $j${"fieldMap":{"style":"styleCode"},"transforms":{"style":"upper"},"confidence":0.6}$j$::jsonb,
   $j$[{"code":"THOMMER","expected":{"styleCode":"THOMMER"}},{"code":"Sleenker","expected":{"styleCode":"SLEENKER"}},{"code":"Thommer-X","expected":{"styleCode":"THOMMER"},"note":"The -X stretch marker is tolerated but not captured — it marks the fabric, not the style."},{"code":"D-STRUKT","expected":{"styleCode":"D-STRUKT"},"note":"The current Glenn Martens era, decoded by the same rule."},{"code":"LARKEE-BEEX","expected":{"styleCode":"LARKEE-BEEX"}},{"code":"0688H","expected":null,"note":"A Diesel WASH code is a bare alphanumeric identifying the finish — it is not a style code and must NOT recover a brand."},{"code":"Slim","expected":null,"note":"An ordinary English fit word must NOT recover a brand."},{"code":"3301","expected":null,"note":"A bare digit run is an ordinary number (the Lee 101 rule) — it must NOT recover a brand."}]$j$::jsonb,
   'https://www.diesel.com/', 0.60, false, 'migration:00464')
on conflict (brand_key, decoder_kind) do nothing;

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Denim "color" is a WASH NAME, and washes are seasonal and near-infinite, so a
-- colorway dictionary is mostly the wrong shape for this category — the same call
-- 00454 made. Seeded ONLY where the term is a stable, brand-DEFINING one rather
-- than a season's fancy. That is essentially just G-Star, whose whole premise is
-- the untreated fabric and whose RAW term is in the brand's own name.
-- Deliberately NOT seeded: MOTHER's wash names are jokes that change every season
-- ("Love Gun"), Diesel identifies its washes by a rotating alphanumeric code
-- rather than a name, and PAIGE's Transcend is a FABRIC, not a colour.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('gstarraw', 'Raw Indigo', ARRAY['raw','raw denim','raw indigo','unwashed','rigid']::text[], null, null, 'https://www.g-star.com/', 0.65, false, 'migration:00464'),
  ('gstarraw', 'Dark Aged', ARRAY['dark aged','dark wash','aged']::text[], null, null, 'https://www.g-star.com/', 0.55, false, 'migration:00464'),
  ('diesel', 'Dark Rinse', ARRAY['dark rinse','rinse','dark wash']::text[], null, null, 'https://www.diesel.com/', 0.55, false, 'migration:00464')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts (INCHES) ──────────────────────────────────────────────
-- Same basis as 00454: denim labels are MEASUREMENTS, not alpha letters mapped
-- onto a body, so these are NOMINAL WAIST charts — they map the label to the
-- waist it CLAIMS. And the claim is frequently false.
--
-- WHAT IS NEW HERE is that this pack lies in THREE directions, not the two 00454
-- had (vintage-small vs premium-large):
--   * STRETCH PREMIUM (PAIGE/Hudson/Joe's/FRAME/MOTHER and the stretch Diesel
--     fits) runs LARGE against the tag — vanity sizing plus stretch that relaxes,
--     and a USED pair has permanently given at the waistband.
--   * RAW G-STAR SHRINKS toward or below its tag on the first wash. An unwashed
--     raw pair measures near its tag; a washed one does not. Opposite mechanism.
--   * MOTHER's FRAYED HEM makes the tag inseam a fiction — the hem is
--     deliberately uneven, so there is no single length to report.
-- The only defensible number is the flat waistband doubled, published as such.
--
-- HONESTY NOTE ON CONFIDENCE: these are the standard premium-denim nominal
-- grades, not figures fetched from each brand's own published guide, and they are
-- seeded at LOW/CAPPED confidence with the approximation stated so the US-1715
-- verifier replaces them rather than rubber-stamping them.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('diesel', 'Diesel', ARRAY['diesel']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W29","measurements":{"waist":"29"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — the label is a claimed measurement, not a body chart. Diesel labels W (waist) x L (inseam) in inches for BOTH genders, which is a European convention and differs from the US premium brands'' women''s numeric scale. PREMIUM caveat applies to the stretch fits (the -X versions): they relax with wear, so a used pair measures above its tag. DIESEL-SPECIFIC: heavy shredding, holes and abrasion are usually the DESIGNED WASH, not wear — do not let a destroyed finish drive a size or condition judgment. Measure the flat waistband, double it, and publish that figure. Standard premium-denim grade rather than Diesel-fetched figures — capped confidence.',
   'https://www.diesel.com/', 0.55, false, 'migration:00464'),
  ('diesel', 'Diesel', ARRAY['diesel']::text[], 'Women', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"W24","measurements":{"waist":"24"}},{"size":"W25","measurements":{"waist":"25"}},{"size":"W26","measurements":{"waist":"26"}},{"size":"W27","measurements":{"waist":"27"}},{"size":"W28","measurements":{"waist":"28"}},{"size":"W29","measurements":{"waist":"29"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the waist in inches. NOTE THE EUROPEAN CONVENTION: unlike the US premium brands in this pack, Diesel labels women''s denim W (waist) x L (inseam) exactly as it does men''s — the inch basis is the same, but the tag carries a W prefix and a separate inseam. Diesel non-denim ready-to-wear may instead use an EU/IT number, which is a DIFFERENT scale entirely — do not map an IT 42 onto this chart. PREMIUM caveat applies to the stretch fits. Measure the flat waistband and double it. Standard premium-denim grade rather than Diesel-fetched figures — capped confidence.',
   'https://www.diesel.com/', 0.55, false, 'migration:00464'),
  ('diesel', 'Diesel', ARRAY['diesel']::text[], 'Unisex', 'Denim jackets (alpha)', ARRAY['jacket','coat','denim jacket','outerwear','vest']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"42-44"}},{"size":"XL","measurements":{"chest":"46-48"}},{"size":"XXL","measurements":{"chest":"50-52"}}]$json$::jsonb,
   'BODY measurement (chest) — the jackets are alpha-sized rather than waist-labeled, so unlike the jeans charts above this one IS a body chart. Same DIESEL-SPECIFIC warning: a destroyed or heavily treated finish on the jacket is usually designed, not wear. Measure the flat chest (armpit to armpit, doubled) and publish it. Standard US alpha approximation rather than Diesel-fetched figures — capped confidence.',
   'https://www.diesel.com/', 0.50, false, 'migration:00464'),

  ('gstarraw', 'G-Star RAW', ARRAY['g-star','gstar','g star']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W29","measurements":{"waist":"29"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — the label is a claimed measurement, not a body chart. G-Star labels W (waist) x L (inseam) in inches for both genders (a European convention). G-STAR-SPECIFIC AND IT RUNS OPPOSITE TO THE REST OF THIS PACK: RAW denim SHRINKS on its first wash (commonly an inch or two in the waist), where the stretch premium brands here GIVE and run large. So an unwashed raw pair measures near its tag while a washed one measures under it — whether it has been washed changes the answer, and the tag cannot tell you. Also do not read raw denim''s high-contrast fading (whiskers, honeycombs) as wear: it is earned patina buyers pay for. Measure the flat waistband, double it, publish that. Standard denim grade rather than G-Star-fetched figures — capped confidence.',
   'https://www.g-star.com/', 0.55, false, 'migration:00464'),
  ('gstarraw', 'G-Star RAW', ARRAY['g-star','gstar','g star']::text[], 'Women', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"W24","measurements":{"waist":"24"}},{"size":"W25","measurements":{"waist":"25"}},{"size":"W26","measurements":{"waist":"26"}},{"size":"W27","measurements":{"waist":"27"}},{"size":"W28","measurements":{"waist":"28"}},{"size":"W29","measurements":{"waist":"29"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the waist in inches, carried as W (waist) x L (inseam) in the European convention rather than the US bare-numeric one. Same G-STAR-SPECIFIC shrink caveat as the men''s chart: a RAW pair shrinks on first wash rather than giving with wear, which is the opposite of the stretch premium brands in this pack. Measure the flat waistband and double it. Standard denim grade rather than G-Star-fetched figures — capped confidence.',
   'https://www.g-star.com/', 0.50, false, 'migration:00464'),
  ('gstarraw', 'G-Star RAW', ARRAY['g-star','gstar','g star']::text[], 'Unisex', 'Denim jackets (alpha)', ARRAY['jacket','coat','denim jacket','outerwear','vest']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"42-44"}},{"size":"XL","measurements":{"chest":"46-48"}},{"size":"XXL","measurements":{"chest":"50-52"}}]$json$::jsonb,
   'BODY measurement (chest) — the jackets are alpha-sized rather than waist-labeled, so unlike the jeans charts this one IS a body chart. A RAW denim jacket shrinks on first wash for the same reason the jeans do, and its 3D-constructed sleeves can read as misshapen when they are simply built that way. Measure the flat chest (armpit to armpit, doubled). Standard US alpha approximation rather than G-Star-fetched figures — capped confidence.',
   'https://www.g-star.com/', 0.50, false, 'migration:00464'),

  ('paige', 'PAIGE', ARRAY['paige']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches; hip rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against the tag). PAIGE-SPECIFIC: the line is built on TRANSCEND, a high-recovery stretch fabric, so the give is real and permanent — a used Verdugo measures above its tag and will not return. Measure the flat waistband, double it, and publish that number rather than the tag. Standard premium-denim numeric grade rather than PAIGE-fetched figures — capped confidence.',
   'https://www.paige.com/', 0.55, false, 'migration:00464'),
  ('paige', 'PAIGE', ARRAY['paige']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat applies: the men''s fits are TRANSCEND stretch and relax with wear, so a worn Federal measures above its tag. Measure the flat waistband and double it. Standard premium-denim grade rather than PAIGE-fetched figures — capped confidence.',
   'https://www.paige.com/', 0.50, false, 'migration:00464'),

  ('frame', 'FRAME', ARRAY['frame']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches; hip rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against the tag; stretch gives with wear and a used pair has permanently given at the waistband). Measure the flat waistband and double it. Standard premium-denim numeric grade rather than FRAME-fetched figures — capped confidence.',
   'https://www.frame-store.com/', 0.55, false, 'migration:00464'),
  ('frame', 'FRAME', ARRAY['frame']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W29","measurements":{"waist":"29"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. FRAME''s entire men''s denim line is L''HOMME, so an L''Homme tag on a pair of jeans means this chart rather than the women''s one — the tag names the department. PREMIUM caveat applies (stretch relaxes with wear). Measure the flat waistband and double it. Standard premium-denim grade rather than FRAME-fetched figures — capped confidence.',
   'https://www.frame-store.com/', 0.50, false, 'migration:00464'),

  -- MOTHER: WOMEN'S ONLY — the line is women's, so no men's chart is seeded
  -- rather than inventing one. The hem note is the whole point of this row.
  ('mother', 'MOTHER', ARRAY['mother']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches; hip rises ~9-10in over the waist. MOTHER is a WOMEN''S line, so there is no men''s chart. PREMIUM caveat applies (runs LARGE against the tag; stretch gives permanently with wear). MOTHER-SPECIFIC AND IT IS THE POINT OF THIS ROW: the INSEAM cannot be read from the tag on a Fray or Chew style, because the hem is DELIBERATELY shredded and uneven — there is no single length to report, so measure the inside leg to the SHORTEST point and say the hem is a factory fray. Do not record the frayed hem as damage: it is the product, and a new pair arrives that way. Measure and double the flat waistband too. Standard premium-denim numeric grade rather than MOTHER-fetched figures — capped confidence.',
   'https://www.motherdenim.com/', 0.55, false, 'migration:00464'),

  ('ragbone', 'Rag & Bone', ARRAY['rag & bone','rag and bone','ragbone','rag bone']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W29","measurements":{"waist":"29"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat applies (runs large; stretch gives with wear). RAG & BONE-SPECIFIC: the men''s FIT NUMBER (Fit 1/2/3/4) is a separate axis from the waist size and both are on the tag — the number is the cut, not the size, so never map a "Fit 2" onto this chart as if it were a measurement. Measure the flat waistband and double it. Standard premium-denim grade rather than Rag & Bone-fetched figures — capped confidence.',
   'https://www.rag-bone.com/', 0.55, false, 'migration:00464'),
  ('ragbone', 'Rag & Bone', ARRAY['rag & bone','rag and bone','ragbone','rag bone']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches. PREMIUM caveat applies (runs large against the tag). NOTE the line''s split naming: the women''s fits are NAMED (Cate, Dre, Nina) while the men''s are NUMBERED, so a women''s tag carries a name plus this waist number and no Fit number. Measure the flat waistband and double it. Standard premium-denim numeric grade rather than Rag & Bone-fetched figures — capped confidence.',
   'https://www.rag-bone.com/', 0.50, false, 'migration:00464'),

  -- brand_match deliberately EXCLUDES a bare "hudson" for symmetry with the
  -- canonical decision, but note the mechanism differs: findSizingCharts matches
  -- the CANONICAL brand string ("Hudson Jeans"), which contains "hudson jeans",
  -- so the chart is reached without ever putting a loose token in the table.
  ('hudsonjeans', 'Hudson Jeans', ARRAY['hudson jeans','hudsonjeans']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches; hip rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against the tag; the super-skinny fits are heavy stretch and give permanently at the waistband). Measure the flat waistband, double it, and publish that number rather than the tag. Standard premium-denim numeric grade rather than Hudson-fetched figures — capped confidence.',
   'https://www.hudsonjeans.com/', 0.55, false, 'migration:00464'),
  ('hudsonjeans', 'Hudson Jeans', ARRAY['hudson jeans','hudsonjeans']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat applies (stretch relaxes with wear, so a worn Blake measures above its tag). Measure the flat waistband and double it. Standard premium-denim grade rather than Hudson-fetched figures — capped confidence.',
   'https://www.hudsonjeans.com/', 0.50, false, 'migration:00464'),

  ('joesjeans', 'Joe''s Jeans', ARRAY['joes jeans','joesjeans','joe''s jeans']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches; hip rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against the tag; stretch gives permanently with wear). JOE''S-SPECIFIC: the HONEY is a CURVY block cut for a larger hip-to-waist ratio, so its hip runs fuller than this chart at the same waist number — do not read a Honey''s hip off this row. Measure the flat waistband and double it, and measure the hip separately on a Honey. Standard premium-denim numeric grade rather than Joe''s-fetched figures — capped confidence.',
   'https://www.joesjeans.com/', 0.55, false, 'migration:00464'),
  ('joesjeans', 'Joe''s Jeans', ARRAY['joes jeans','joesjeans','joe''s jeans']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat applies (stretch relaxes with wear, so a worn Brixton measures above its tag). Measure the flat waistband and double it. Standard premium-denim grade rather than Joe''s-fetched figures — capped confidence.',
   'https://www.joesjeans.com/', 0.50, false, 'migration:00464')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- NOTE — no shared-chart narrowing is needed here (contrast 00453, which had to
-- narrow the shared outdoor row). None of the eight brands is claimed by an
-- existing multi-brand chart: the 00454 denim brands each carry their own rows,
-- Levi's and Madewell carry theirs from 00389, and the generic men's-pants
-- fallback has an EMPTY brand_match so it is only selected when no brand chart
-- matched. The one collision worth stating: "FRAME" and "MOTHER" are ordinary
-- words, but brand_match is tested against the CANONICAL BRAND STRING rather than
-- free text, so an ordinary-word token is safe HERE — the prose hazard lives in
-- detectBrandInText and is handled by DETECT_EXCLUDED_FROM_TEXT in
-- brand-normalize.ts. Both directions verified in premium-denim-content_test.ts.

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00464') on conflict do nothing;
