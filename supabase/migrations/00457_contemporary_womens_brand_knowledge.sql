-- US-1738: Contemporary women's brand knowledge group (7 brands, 7 rows).
--
-- Anthropologie, Sézane, Aritzia, Reformation, Vince, Theory, Eileen Fisher.
-- All seven are NEW rows — none of them has even a bare alias-only row in 00389,
-- so before this migration every one of them rendered the seller's own casing
-- into the prompt block and the eBay Brand aspect.
--
-- WHAT MAKES THIS GROUP DIFFERENT FROM EVERY PRIOR ONE: THE TAG DOES NOT SAY THE
-- BRAND. Everywhere else in this epic the garment names itself and the work is
-- deciding WHICH piece it is — a Kensington trench (00455) says Burberry, a Box
-- Logo Tee (00456) says Supreme. Here the two highest-volume brands in the pack
-- are RETAILERS whose house labels print their OWN names and never the parent's:
--
--     the tag says          the brand to list under is
--     ------------          -------------------------
--     WILFRED / BABATON / TNA / SUNDAY BEST   ->  Aritzia
--     MAEVE / PILCRO / MOTH / DAILY PRACTICE  ->  Anthropologie
--
-- A seller holding a Wilfred coat is holding an Aritzia coat, and nothing on the
-- garment says so. That is the group's whole identification problem, and it is
-- the inverse of the usual one: the piece is easy, the BRAND is the puzzle.
--
-- WHICH PRECEDENT APPLIES — the call worth re-reading. 00456 split Fear of God
-- into two brand keys because mainline and Essentials are an ORDER OF MAGNITUDE
-- apart in price, so folding them would have 10x-mispriced every comp. That does
-- NOT hold here: Wilfred, Babaton and TNA sit in the SAME price band as each
-- other, and so do Maeve, Pilcro and Moth. So this group follows the MICHAEL KORS
-- precedent (00455) instead — every house label folds onto ONE canonical brand
-- and the label itself lives in `style`, which is also how the resale market
-- actually searches ("Aritzia Wilfred Free coat"). Folding has a second payoff:
-- it keeps the short tokens OUT of CANONICAL_BRANDS. "TNA" is three letters and
-- would be an AG-grade hazard (00454) as a canonical; as an alias that resolves
-- to "Aritzia" it never reaches detectBrandInText at all.
--
-- ANTHROPOLOGIE IS ALSO A MULTI-BRAND RETAILER, which is a trap the rest of the
-- epic has no equivalent for. Anthropologie SELLS third-party brands alongside
-- its house labels. So "bought at Anthropologie" does not mean "branded
-- Anthropologie" — only the house labels are. A third-party piece keeps its own
-- brand, and reading the STORE as the brand mis-comps it in both directions.
--
-- THE ORDINARY-WORD DENSITY IS THE WORST IN THE EPIC. 00453 refused a bare
-- "bean", 00455 a bare "tory", 00456 a bare "essentials". This pack has five at
-- once, and they are the brand names themselves rather than stray tokens:
--
--     "theory"      — an ordinary English noun.
--     "vince"       — an ordinary given name.
--     "reformation" — an ordinary English noun.
--     "maeve"       — an ordinary given name.
--     "moth"        — an ordinary English noun AND, far worse, a CONDITION term.
--                     "moth holes" / "moth damage" appear constantly in the
--                     condition text this very product generates. An alias here
--                     would mint Anthropologie off a description of the damage.
--
-- Every one of them is handled the same way: exact-key aliases only where the
-- full brand string is unambiguous, and NEVER a bare short form. "moth" is not an
-- alias at all — it is reachable only as a style of Anthropologie.
--
-- VINCE vs VINCE CAMUTO — the group's signature trap, and the most dangerous
-- thing in this file. These are TWO DIFFERENT COMPANIES: Vince (Vince Holding
-- Corp) is the contemporary knitwear label; Vince Camuto is a separate
-- footwear/apparel label from the Camuto Group. "Vince Camuto" CONTAINS "Vince",
-- which is structurally the 00456 Fear of God trap — but worse, because there the
-- two labels were at least the same designer's work, and here they are unrelated
-- businesses.
--
-- The remedy exploits an asymmetry no prior group in this epic has used. The two
-- chart lookups do NOT match the same way:
--
--     DB charts     -> fetched by EXACT brand_key (.eq("brand_key", key)).
--                      brandKey("Vince Camuto") is "vincecamuto", so a 'vince'
--                      row can NEVER reach it. SAFE.
--     in-code charts -> findSizingCharts matches brandMatch by SUBSTRING, and
--                      "vince camuto".includes("vince") is TRUE. LEAKS.
--
-- And no narrowing fixes the in-code side: there is no token unique to the
-- shorter name (the 00456 finding). So VINCE IS SEEDED WITH A DB CHART AND NO
-- IN-CODE FALLBACK CHART — the first brand in the epic to be given one and not
-- the other, deliberately. Pre-migration Vince falls through to the generics (as
-- Coach/LV/Gucci do); post-migration it gets its own exact-keyed chart; and Vince
-- Camuto correctly falls through to the generics in both states. Asserted in
-- contemporary-womens-content_test.ts, which fails loudly if someone later
-- "completes" the mirror.
--
-- THREE SIZING SYSTEMS, THREE DIRECTIONS, none of which announces itself — the
-- same shape as 00454's vintage-vs-premium, 00455's European-vs-American and
-- 00456's Japanese-vs-oversized splits, and again the reason these seven belong
-- in one pack:
--
--     Sézane          FR 38  =  US 6      — French national sizing. The number
--                                           lies: it is not a US 38, and it is
--                                           not an alpha.
--     Aritzia         runs SMALL          — starts at 00/XXS; an Aritzia S sits
--                                           near a US 2-4.
--     Eileen Fisher   runs LARGE          — cut deliberately relaxed; an EF M
--                                           drapes like a US L.
--
-- So an "M" means different bodies on Aritzia and Eileen Fisher, and a "38" on
-- Sézane is a US 6. Every chart carries its cross-map INSIDE THE SIZE LABEL where
-- the model actually reads it — the 00455 lesson — rather than in a note alone.
--
-- Eileen Fisher's drape is a GRADING fact and not only a listing one, exactly as
-- the Essentials drape is (00456): the garment is SUPPOSED to hang loose. Reading
-- that as stretching or as a mislabel grades an intact garment down.
--
-- ZERO DECODERS — the second group in the epic with none, but for a NEW reason
-- worth recording rather than a repeat of 00456's. There the identifier was a
-- GRAPHIC, which is not on the tag and not parseable. Here the identifier IS
-- printed and IS regular: this group names its pieces, and the NAME is what the
-- market searches (a Reformation Juliette, an Anthropologie Maeve, an Aritzia
-- Wilfred). It fails the epic's third test — brand-unique. Every one of those
-- names is an ordinary given name. 00454 seeded a True Religion decoder only
-- because "Ricky Super T" is a COMPOUND — "Ricky" alone is a first name and would
-- have been the Lee "101" mistake. A bare "Juliette" has no second part to make
-- it safe. So the naming convention is seeded as a first-class informational
-- fact, never as a decoder, and no-false-recovery golden cases lock it in.
--
-- ZERO COLORWAYS, on the rule that kept Chanel's colors out of 00455 and the
-- denim washes out of 00454: seed only a STABLE PROPRIETARY name. This group's
-- colors are seasonal descriptive English words — "Ivory", "Sage", "Black". There
-- is nothing proprietary to seed, and inventing a palette would be invention.
--
-- CORPORATE MAP (recorded because a shared parent reads as a counterfeit signal
-- to a naive model and is not one):
--   * Anthropologie is URBN — the same parent as Free People (00449). A shared
--     URBN tag between the two is ordinary.
--   * Theory is owned by FAST RETAILING, Uniqlo's parent. Ordinary; not a tell.
--   * Vince Camuto (Camuto Group, later Designer Brands) is NOT Vince. See above.
--   * Theyskens' Theory IS a Theory line (Olivier Theyskens, retired ~2014) — a
--     line of this brand, like Baby Milo is a BAPE line (00456), so it belongs in
--     the style. Contrast Vince Camuto, which is a different company entirely.
--     The two look identical from the outside; only one folds.
--
-- registered_numbers are omitted throughout as UNSOURCED, the same call 00448
-- (Athleta) and 00449 (Free People) made. An RN we cannot cite is invention.
--
-- NEVER AUTO-AUTHENTICATE — the epic's hard line. These brands are counterfeited
-- less than 00456's, but the stance does not depend on the counterfeit rate: the
-- KB flags inconsistencies in condition notes and stops there.
--
-- Data-only. Every fact carries source_url + confidence and lands verified=false
-- for the US-1715 admin verify queue. Idempotent throughout.

-- ── brand_knowledge ─────────────────────────────────────────────────────────

-- Anthropologie (NEW row). A RETAILER and a house-brand family at once.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('anthropologie', 'Anthropologie',
  ARRAY['anthropologie','anthro','maeve','pilcro','dailypractice','heihei']::text[],
  ARRAY['contemporary womens','dresses','blouses','knits','denim']::text[],
  -- tag_eras deliberately EMPTY: no documented, resale-relevant label
  -- generations. The HOUSE LABEL is the identity here, not the tag era, and it is
  -- seeded as brand_styles instead.
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label an Anthropologie item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE TAG SAYS THE HOUSE LABEL, NOT ANTHROPOLOGIE","detail":"THE Anthropologie call and the group's defining fact. Anthropologie's own garments are labeled with HOUSE BRAND names — Maeve, Pilcro, Moth, Daily Practice, Hei Hei — and the word 'Anthropologie' is frequently nowhere on the garment. A seller holding a Maeve dress is holding an Anthropologie dress. Read the house label as the STYLE and list the brand as Anthropologie: that is how the resale market searches it."},{"tell":"Anthropologie also SELLS other brands","detail":"CRITICAL and the other half of the same fact: Anthropologie is a MULTI-BRAND RETAILER as well as a house-brand family. It stocks many third-party labels. So 'bought at Anthropologie' does NOT mean 'branded Anthropologie' — only the HOUSE labels are. A third-party garment sold there keeps its own brand, and reading the STORE as the brand mis-comps it. If the tag carries a brand that is not a known house label, that brand is the brand."},{"tell":"'Moth' is a condition word before it is a brand","detail":"CROSS-BRAND / CROSS-DOMAIN: Moth is Anthropologie's house KNITWEAR label, and 'moth' is also an ordinary English noun and — far more dangerously — a garment-CONDITION term. 'Moth holes' and 'moth damage' appear constantly in exactly the condition text this product generates. A bare 'moth' token is almost always damage, NOT this brand. Only an actual MOTH neck label is the house line."},{"tell":"URBN is Free People's parent too","detail":"Informational: Anthropologie is part of URBN, the same parent as Free People and Urban Outfitters. A shared URBN corporate tag between an Anthropologie and a Free People piece is ORDINARY and is not a counterfeit signal."}]$j$::jsonb,
  'US women''s sizing (numeric 00-16 and alpha XS-XL). THE TAG USUALLY SAYS A HOUSE LABEL, NOT "Anthropologie" — Maeve (dresses/blouses), Pilcro (denim), Moth (knits), Daily Practice (loungewear). Fold the house label into `style` and list the brand as Anthropologie. BUT Anthropologie is ALSO a multi-brand retailer: a third-party garment bought there keeps its OWN brand — only the house labels are Anthropologie. NOTE "moth" is a garment-DAMAGE term far more often than it is the knit label, and "maeve" is an ordinary given name. Part of URBN (the Free People parent). NEVER auto-authenticate.',
  'https://www.anthropologie.com/', 0.72, false, 'migration:00457')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Sézane (NEW row). NOTE the brand_key is 'szane', not 'sezane' — brandKey()
-- strips the accented "é" along with every other non-[a-z0-9] character, exactly
-- as it strips Stüssy's umlaut to 'stssy' (00456). Do NOT "fix" the spelling: the
-- resolver derives this same key from the canonical at read time, so a corrected
-- key would simply never be found. BOTH spellings are carried in the aliases so a
-- seller typing either one resolves.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('szane', 'Sézane',
  ARRAY['sezane','szane','maisonsezane','sezaneparis']::text[],
  ARRAY['contemporary womens','french','blouses','knits','dresses']::text[],
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Sézane item authentic. Flag inconsistencies in condition notes only."},{"tell":"FRENCH SIZING — the number is not a US number","detail":"THE Sézane call. Sézane is a Paris brand on FRENCH national sizing: FR 34/36/38/40/42/44, where FR 38 is a US 6. The tag carries a bare number that looks like it could be a US size and is not — an FR 38 read as anything else is a multi-size error on a garment whose fit is the whole point. This is the same national-system trap as Chanel's FR and Prada's IT tags, and it is why the US equivalent is written into the size chart labels."},{"tell":"Pieces are named with French given names","detail":"Informational, NOT a decoder: Sézane names its pieces (the Gaspard jumper and its siblings). The name is how the market searches, and it is NOT printed as a decodable code on the tag — it is resolved against a catalogue. Never infer a style name from the silhouette alone."},{"tell":"Online-first, so a store tell means little","detail":"Informational: Sézane sells primarily online and through a small number of 'l'Appartement' stores rather than wholesale. Absence of a retailer tag is therefore NORMAL and is not a counterfeit signal."}]$j$::jsonb,
  'FRENCH brand on FRENCH sizing — FR 34-44, where FR 38 is a US 6. The tag carries a bare number that is NOT a US size; this is the same trap as Chanel''s FR and Prada''s IT tags (00455), so every chart carries the US equivalent in the size label. Founded 2013 in Paris by Morgane Sézalory; online-first (l''Appartement stores), so no wholesale retailer tag is normal. Known for silk blouses, knitwear, leather and denim. NOTE the brand_key is "szane" — brandKey() strips the accent, exactly as it does for Stüssy. NEVER auto-authenticate.',
  'https://www.sezane.com/', 0.70, false, 'migration:00457')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Aritzia (NEW row). The other retailer-with-house-labels, and the one the story
-- calls out: the sub-labels ARE the identity and none of them says "Aritzia".
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('aritzia', 'Aritzia',
  ARRAY['aritzia','wilfred','wilfredfree','babaton','tna','sundaybest','talula','goldenbytna']::text[],
  ARRAY['contemporary womens','canadian','outerwear','blouses','knits']::text[],
  $j$[{"era":"Talula-era labelling","years":"before ~2018","description":"Talula and Talula Babaton were Aritzia house labels that were retired and folded into the surviving lines. A TALULA neck label therefore DATES a piece to the earlier era — which is a real provenance fact and the closest thing this group has to a tag generation. It is not an authenticity test and it does not fix a year precisely."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label an Aritzia item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE TAG SAYS THE SUB-LABEL, NOT ARITZIA","detail":"THE Aritzia call and the group's defining fact. Aritzia is a RETAILER whose garments are labeled with its in-house sub-brands — Wilfred, Wilfred Free, Babaton, TNA, Sunday Best — and the word 'Aritzia' is frequently nowhere on the garment. A Wilfred coat IS an Aritzia coat. Read the sub-label as the STYLE and list the brand as Aritzia: 'Aritzia Wilfred' is how the resale market actually searches, and the sub-labels sit in the SAME price band as each other, so folding them onto one brand does not mis-comp anything (contrast Fear of God mainline vs Essentials, which are 10x apart and are therefore seeded as two brands)."},{"tell":"The sub-labels are different DEPARTMENTS, not different tiers","detail":"Informational, and the reason the sub-label belongs in the style rather than being discarded: each line is a category, not a price rank. Wilfred is elevated/romantic; Wilfred Free is its more casual sibling; Babaton is workwear and tailoring; TNA is athletic and casual; Sunday Best is denim-led. A buyer searching 'Babaton blazer' will not find it if the line is dropped."},{"tell":"Aritzia runs SMALL and starts at 00","detail":"Aritzia's grade is CUT SMALL against a general US contemporary body and its range starts at 00/XXS — so an Aritzia S sits near a US 2-4. Within this same pack Eileen Fisher runs the OPPOSITE way (an EF M drapes like a US L). Both tags just say a letter. Measure the garment; do not carry one brand's grade onto the other."},{"tell":"'TNA' is three letters","detail":"CROSS-BRAND: TNA is a real Aritzia line and 'TNA' is also a three-letter string that means other things entirely. It resolves to Aritzia only as an exact whole-brand token — it must never be matched as a fragment inside other text."}]$j$::jsonb,
  'CANADIAN retailer; US women''s sizing (XXS-XL / 00-12) that RUNS SMALL and starts at 00 — an Aritzia S sits near a US 2-4. THE TAG SAYS THE SUB-LABEL, NOT "Aritzia": Wilfred and Wilfred Free (elevated/casual), Babaton (workwear/tailoring), TNA (athletic/casual), Sunday Best (denim). Fold the sub-label into `style` and list the brand as Aritzia — they share a price band, so folding costs nothing, and "Aritzia Wilfred" is how the market searches. The Super Puff is the brand''s signature garment. A TALULA label dates a piece to before ~2018 (retired line). NEVER auto-authenticate.',
  'https://www.aritzia.com/', 0.75, false, 'migration:00457')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Reformation (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('reformation', 'Reformation',
  ARRAY['reformation','thereformation','reformationjeans']::text[],
  ARRAY['contemporary womens','dresses','slip dresses','denim','sustainable']::text[],
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Reformation item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE STYLE NAME IS THE IDENTITY — and it is an ordinary given name","detail":"THE Reformation call, and the reason this group seeds no decoder. Reformation NAMES every dress with an ordinary woman's given name (Juliette, Kourtney, Wren and many more), and that name is the single most valuable listing token on the brand: buyers search the name, not the silhouette. It is also un-decodable. 'Juliette' is a first name — a pattern over it would mint Reformation from any tag or text carrying one. This is the Lee '101' rule (00454): True Religion earned a decoder only because 'Ricky Super T' is a COMPOUND, and a bare given name has no second part to make it safe. Use the name when the seller supplies it; NEVER infer it from the photos."},{"tell":"'Reformation' is an ordinary English noun","detail":"CROSS-BRAND: 'reformation' is a common English word. It should be read as this brand only when the garment actually carries Reformation branding — never from the word appearing in surrounding text."},{"tell":"Deadstock fabric is the design, not a fault","detail":"GRADING-RELEVANT: Reformation builds heavily on deadstock and limited-run fabrics, so a fabric that does not match any current catalogue entry is NORMAL for this brand and is not evidence of a fake. It also means a given style name can exist in fabrics that never repeat — the name identifies the CUT, not the material."}]$j$::jsonb,
  'US women''s sizing (0-12 / XS-XL); the house cut is fitted and dress-led. THE STYLE NAME IS THE IDENTITY — every dress carries an ordinary woman''s given name (Juliette, Kourtney, Wren) and buyers search that name, so it is the most valuable token on the brand. It is also why NO DECODER is seeded: a bare given name is not brand-unique (the 00454 "Ricky" rule). Use a name the seller supplies; never infer one from the photos. Known for silk slip dresses, deadstock/limited-run fabric (so an off-catalogue fabric is normal, not a fake) and denim. NOTE "reformation" is an ordinary English noun. NEVER auto-authenticate.',
  'https://www.thereformation.com/', 0.70, false, 'migration:00457')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Vince (NEW row). NO IN-CODE FALLBACK CHART IS MIRRORED FOR THIS BRAND — see the
-- header and the brand_size_charts section: the DB chart below is exact-keyed and
-- therefore safe, but an in-code brandMatch of ["vince"] would fire on every
-- "Vince Camuto" garment, which is a DIFFERENT COMPANY.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('vince', 'Vince',
  ARRAY['vince','vinceclothing']::text[],
  ARRAY['contemporary womens','cashmere','knits','minimalist','silk']::text[],
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Vince item authentic. Flag inconsistencies in condition notes only."},{"tell":"VINCE IS NOT VINCE CAMUTO","detail":"THE Vince call and the single most expensive error available on this brand. Vince (Vince Holding Corp) and VINCE CAMUTO (the Camuto Group footwear/apparel label) are TWO DIFFERENT COMPANIES that share a first name — they are not a mainline and a diffusion line, they are unrelated businesses at different price points. A 'Vince Camuto' tag is NOT this brand and must never be folded into it, and a bare 'Vince' token sitting next to 'Camuto' is the other company. This is the structural trap that 00456's Fear of God / Fear of God Essentials pair posed, made worse: there the two labels were at least one designer's work."},{"tell":"'Vince' is an ordinary given name","detail":"CROSS-BRAND: 'Vince' is a common given name (short for Vincent). It should be read as this brand only when the garment actually carries Vince branding — and never when the adjacent token is 'Camuto'."},{"tell":"The FABRIC is the identity, not a graphic","detail":"Informational: Vince has no logo graphic and no named signature style — its resale identity is the MATERIAL and the cut. Cashmere, wool and silk in a minimalist, largely unbranded silhouette. So the fibre content on the care label is the most valuable thing on the garment: a cashmere Vince piece and a cotton one are the same silhouette at very different values, and a photo cannot tell them apart. Read the care label; never infer the fibre from the drape."}]$j$::jsonb,
  'US women''s sizing (XS-XL / 00-12); relaxed minimalist cut. NOT VINCE CAMUTO — that is a SEPARATE COMPANY (Camuto Group) that merely shares a first name, not a diffusion line, and the two must never be folded or comped together. The FABRIC is this brand''s identity: it carries no logo graphic and no named signature style, so the fibre content on the care label (cashmere vs wool vs cotton) is the most valuable token on the piece and cannot be read off a photo. NOTE "vince" is an ordinary given name. NEVER auto-authenticate.',
  'https://www.vince.com/', 0.68, false, 'migration:00457')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Theory (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('theory', 'Theory',
  ARRAY['theory','theorynyc','theyskenstheory','theoryluxe']::text[],
  ARRAY['contemporary womens','suiting','tailoring','workwear','knits']::text[],
  $j$[{"era":"Theyskens' Theory","years":"~2011-2014","description":"Theyskens' Theory was a designer sub-line under Olivier Theyskens, since retired. A THEYSKENS' THEORY label therefore DATES a piece to that window and marks it as the designer line rather than mainline Theory. It is a Theory LINE — a line of this same brand, like Baby Milo is a BAPE line — so it belongs in the style, not in `brand`. It is a provenance fact, not an authenticity test."}]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label a Theory item authentic. Flag inconsistencies in condition notes only."},{"tell":"'Theory' is an ordinary English noun","detail":"CROSS-BRAND, and the worst of this group's ordinary-word traps because the word is so common: 'theory' is an everyday English noun. It should be read as this brand ONLY when the garment actually carries a Theory label — never from the word appearing in a title or description."},{"tell":"The FABRIC PLATFORM is the identity","detail":"Theory's proprietary fabric names are the closest thing it has to a signature, and they behave like the outdoor group's fabric tech (00453): Good Wool, Good Linen and Precision Ponte are Theory's own named materials and are printed/marketed as such. The fabric is what separates two otherwise identical blazers at different values, and — like fibre content generally — it cannot be read off a photo."},{"tell":"THEYSKENS' THEORY is a Theory LINE; VINCE CAMUTO is not a Vince line","detail":"CROSS-BRAND, and the pair is worth reading together because they look identical from outside and resolve OPPOSITE ways. Theyskens' Theory contains 'Theory' AND is genuinely a Theory line, so it folds into this brand with the line in the style. Vince Camuto contains 'Vince' and is a DIFFERENT COMPANY, so it must never fold into Vince. A name containing another brand's name proves nothing on its own — the corporate fact decides."},{"tell":"Fast Retailing is the parent","detail":"Informational: Theory is owned by Fast Retailing, Uniqlo's parent. Ordinary corporate provenance; not a tag tell and not a counterfeit signal."}]$j$::jsonb,
  'US women''s sizing (00-12 / XS-L); tailored, workwear-led cut. THE FABRIC PLATFORM IS THE IDENTITY — Good Wool, Good Linen and Precision Ponte are Theory''s own named materials and are what separate two otherwise identical blazers at different values. THEYSKENS'' THEORY is a Theory LINE (Olivier Theyskens, ~2011-2014, retired) and folds into this brand with the line in `style` — contrast Vince Camuto, which contains "Vince" but is a different company entirely and must NOT fold. Theory Luxe is the JAPANESE-market line and is sized on the Japanese grade, not this one. Owned by Fast Retailing (Uniqlo''s parent). NOTE "theory" is an ordinary English noun. NEVER auto-authenticate.',
  'https://www.theory.com/', 0.70, false, 'migration:00457')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- Eileen Fisher (NEW row).
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('eileenfisher', 'Eileen Fisher',
  ARRAY['eileenfisher','eileenfisherrenew']::text[],
  ARRAY['contemporary womens','knits','relaxed','sustainable','silk']::text[],
  $j$[]$j$::jsonb,
  $j$[{"tell":"NEVER auto-authenticate","detail":"NEVER label an Eileen Fisher item authentic. Flag inconsistencies in condition notes only."},{"tell":"THE RELAXED DRAPE IS THE DESIGN","detail":"GRADING-RELEVANT and the most likely way to grade this brand wrong. Eileen Fisher is cut deliberately loose and boxy — that silhouette is the brand's entire design language, not a fit error. An Eileen Fisher M drapes like a US L. A garment that hangs away from the body is INTACT and correctly labeled: do NOT grade the drape as stretching, do NOT read it as wear, and do NOT describe it as 'runs large' as though it were a mistake. This is the same rule as the Essentials drape (00456), on a brand nobody expects it from."},{"tell":"A RENEW tag means the brand already resold it","detail":"Unique in this KB and genuinely useful: EILEEN FISHER RENEW is the brand's OWN take-back and resale program. A RENEW tag means the garment was previously owned and was resold BY THE BRAND ITSELF. That is a PROVENANCE marker and an authenticity-adjacent positive — it is emphatically NOT a defect, not a second, and not a counterfeit signal. Renewed pieces are graded and comped as pre-owned, which they openly are."},{"tell":"Fibre content carries the value","detail":"Informational, the same shape as Vince in this pack: Eileen Fisher's silhouettes are minimal and largely unbranded, so the MATERIAL is what separates two identical-looking pieces at very different values (silk, merino, alpaca, organic cotton, Tencel). Read the care label; a photo cannot show fibre."}]$j$::jsonb,
  'US women''s sizing (XXS-XL, plus 1X-3X) that RUNS LARGE — the cut is deliberately relaxed and boxy, and an Eileen Fisher M drapes like a US L. THAT DRAPE IS THE DESIGN, not stretching, not wear and not a mislabel: do not grade it down. Within this same pack Aritzia runs the OPPOSITE way (an Aritzia S sits near a US 2-4) and both tags just say a letter. A RENEW tag means the brand''s OWN take-back program already resold the piece — a provenance marker, never a defect. Minimal, largely unbranded silhouettes, so the FIBRE on the care label carries the value. NEVER auto-authenticate.',
  'https://www.eileenfisher.com/', 0.72, false, 'migration:00457')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- The HOUSE LABELS carry this group's styles, because on the two retailers the
-- label IS what the garment says and the brand is not. Every one of them is a
-- `label` row (not a garment): the thing being identified is which line the piece
-- belongs to, which is what the market searches on.

insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values

  -- Anthropologie: the house labels, plus the retailer trap as a first-class row.
  ('anthropologie', 'Maeve', 'Women', 'label', 'House label',
   'NOT a garment — Anthropologie''s house DRESS and BLOUSE label, and its highest-volume line by a wide margin. The neck tag reads MAEVE and frequently does not say "Anthropologie" anywhere. A Maeve dress IS an Anthropologie dress: the brand is ANTHROPOLOGIE and "Maeve" belongs here in the style, which is how the resale market searches it. NOTE "Maeve" is also an ordinary given name — only an actual MAEVE neck label is this line.',
   ARRAY[]::text[], null, '$$', ARRAY['maeve','dress','blouse','house label']::text[],
   'https://www.anthropologie.com/', 0.68, false, 'migration:00457'),
  ('anthropologie', 'Pilcro', 'Women', 'label', 'House label',
   'NOT a garment — Anthropologie''s house DENIM label (Pilcro and the Letterpress). The tag reads PILCRO, not "Anthropologie". vs Maeve: Pilcro is the denim/bottoms line, Maeve is dresses and blouses — the label separates them, the silhouette does not.',
   ARRAY['denim']::text[], null, '$$', ARRAY['pilcro','denim','jeans','house label']::text[],
   'https://www.anthropologie.com/', 0.62, false, 'migration:00457'),
  ('anthropologie', 'Moth', 'Women', 'label', 'House label',
   'NOT a garment — Anthropologie''s house KNITWEAR label. CRITICAL READING ORDER: "moth" is a garment-DAMAGE term ("moth holes", "moth damage") far more often than it is this label, and that damage language appears constantly in condition text. A bare "moth" token is almost certainly DAMAGE. Only an actual MOTH neck label is the knit line — and if both are present, they are unrelated facts about the same garment.',
   ARRAY['knit']::text[], null, '$$', ARRAY['moth','knit','sweater','house label']::text[],
   'https://www.anthropologie.com/', 0.58, false, 'migration:00457'),
  ('anthropologie', 'Daily Practice', 'Women', 'label', 'House label',
   'NOT a garment — Anthropologie''s house LOUNGEWEAR/casual label. The tag reads DAILY PRACTICE. A lower band than Maeve.',
   ARRAY[]::text[], null, '$', ARRAY['daily practice','lounge','house label']::text[],
   'https://www.anthropologie.com/', 0.55, false, 'migration:00457'),
  ('anthropologie', 'Third-Party Brand at Anthropologie', 'Women', 'label', 'Retailer',
   'NOT a garment and NOT a line — the RETAILER TRAP, seeded as a first-class row because it is the most common way this brand is read wrong. Anthropologie is a MULTI-BRAND RETAILER as well as a house-brand family: it stocks many third-party labels. A garment BOUGHT at Anthropologie is only an Anthropologie garment if it carries a HOUSE label (Maeve, Pilcro, Moth, Daily Practice, Hei Hei). If the tag names some other brand, THAT is the brand — the store is not. Reading the store as the brand mis-comps the piece in both directions.',
   ARRAY[]::text[], null, null, ARRAY['retailer','third party','not a house label']::text[],
   'https://www.anthropologie.com/', 0.60, false, 'migration:00457'),

  -- Sézane: deliberately SPARSE. Sézane names its pieces, but the published,
  -- confidently-sourced style set is thin, and inventing French style names would
  -- be exactly the invention this epic forbids. The FRENCH SIZING fact carries
  -- this brand, and it lives in the charts.
  ('szane', 'Gaspard Jumper', 'Women', 'knit', 'Gaspard',
   'Sézane''s best-known knit: a crew-neck wool/alpaca-blend jumper, carried across seasons in many colors. The NAME is how the market searches it and the name is NOT on the tag as a code — it resolves against the catalogue. Use it only when the seller supplies it; do not infer it from a crew-neck silhouette, which is not distinctive on its own.',
   ARRAY['wool blend','alpaca blend']::text[], null, '$$', ARRAY['gaspard','jumper','sweater','knit']::text[],
   'https://www.sezane.com/', 0.55, false, 'migration:00457'),
  ('szane', 'Named French Style', 'Women', 'label', 'Naming convention',
   'NOT a garment — the NAMING CONVENTION, seeded as a fact because it is what a decoder would be tempted to parse. Sézane names each piece with a French given name. The name is the most valuable listing token on the brand AND it is un-decodable: a given name is not brand-unique, so a pattern over it would mint Sézane from any text carrying one. This is why the group seeds no decoder (the 00454 "Ricky" rule). Use a name the seller supplies; NEVER infer one from the photos.',
   ARRAY[]::text[], null, null, ARRAY['style name','naming','not a code']::text[],
   'https://www.sezane.com/', 0.58, false, 'migration:00457'),

  -- Aritzia: the sub-labels ARE the identity — the story's stated key
  -- disambiguation. Each is a DEPARTMENT rather than a price tier, which is
  -- exactly why they fold onto one brand and live here in the style.
  ('aritzia', 'Wilfred', 'Women', 'label', 'Sub-label',
   'NOT a garment — Aritzia''s ELEVATED/romantic sub-label, and one of its highest-volume lines. The neck tag reads WILFRED and does not say "Aritzia". A Wilfred coat IS an Aritzia coat: the brand is ARITZIA and "Wilfred" belongs here in the style ("Aritzia Wilfred" is the search). vs WILFRED FREE: a genuinely separate, more casual line whose tag reads WILFRED FREE — note it CONTAINS "Wilfred", so read the FULL label rather than the first word. Both fold onto Aritzia, so the containment is harmless here (contrast Vince/Vince Camuto, where the same shape spans two companies).',
   ARRAY[]::text[], null, '$$$', ARRAY['wilfred','sub-label','coat','blouse']::text[],
   'https://www.aritzia.com/', 0.70, false, 'migration:00457'),
  ('aritzia', 'Babaton', 'Women', 'label', 'Sub-label',
   'NOT a garment — Aritzia''s WORKWEAR and TAILORING sub-label. The tag reads BABATON. vs Wilfred: Babaton is the suiting/blazer/trouser line, Wilfred is the elevated/romantic one — a DEPARTMENT split, not a price rank, which is why both fold onto Aritzia at the same band. A buyer searching "Babaton blazer" will not find the piece if the line is dropped.',
   ARRAY[]::text[], null, '$$$', ARRAY['babaton','sub-label','blazer','trouser','workwear']::text[],
   'https://www.aritzia.com/', 0.68, false, 'migration:00457'),
  ('aritzia', 'TNA', 'Women', 'label', 'Sub-label',
   'NOT a garment — Aritzia''s ATHLETIC/casual sub-label. The tag reads TNA. NOTE it is a three-letter string that means other things entirely, so it identifies this line only as an exact whole-brand token on an actual TNA label — never as a fragment found inside other text (the AG hazard, 00454). Folding it onto Aritzia is what keeps the short token out of the brand matcher.',
   ARRAY[]::text[], null, '$$', ARRAY['tna','sub-label','athletic','sweatpant']::text[],
   'https://www.aritzia.com/', 0.65, false, 'migration:00457'),
  ('aritzia', 'Sunday Best', 'Women', 'label', 'Sub-label',
   'NOT a garment — Aritzia''s DENIM-led casual sub-label. The tag reads SUNDAY BEST. NOTE "sunday best" is also an ordinary English idiom for one''s good clothes — only an actual SUNDAY BEST neck label is this line.',
   ARRAY['denim']::text[], null, '$$', ARRAY['sunday best','sub-label','denim','jeans']::text[],
   'https://www.aritzia.com/', 0.60, false, 'migration:00457'),
  ('aritzia', 'Super Puff', 'Women', 'jacket', 'TNA',
   'Aritzia''s signature garment and the one piece in this pack that IS identifiable from a photo: a glossy, heavily-baffled goose-down puffer with wide horizontal channels, sold under the TNA line. It carries the brand''s strongest resale demand. vs the sub-label rows above: this is an actual GARMENT, not a line marker — the Super Puff is a Super Puff whatever the neck tag says. Length variants exist (cropped/mid/long) and are different pieces at different bands; the silhouette shows which.',
   ARRAY['goose down']::text[], null, '$$$', ARRAY['super puff','superpuff','puffer','down','tna']::text[],
   'https://www.aritzia.com/', 0.70, false, 'migration:00457'),
  ('aritzia', 'Talula', 'Women', 'label', 'Retired sub-label',
   'NOT a garment — a RETIRED Aritzia sub-label (Talula / Talula Babaton), folded into the surviving lines around 2018. A TALULA tag therefore DATES the piece to the earlier era, which is the closest thing this group has to a tag generation. It is a provenance fact only: it does not fix a year precisely and it never proves authenticity.',
   ARRAY[]::text[], 'before ~2018', '$$', ARRAY['talula','retired','vintage aritzia']::text[],
   'https://www.aritzia.com/', 0.58, false, 'migration:00457'),

  -- Reformation: the NAME is the identity and the naming convention is the reason
  -- this group seeds no decoder — so the convention itself is a first-class row.
  ('reformation', 'Named Dress', 'Women', 'label', 'Naming convention',
   'NOT a garment — the NAMING CONVENTION, and THE Reformation fact. Every Reformation dress carries an ordinary woman''s GIVEN NAME (Juliette, Kourtney, Wren and many more), and that name is the single most valuable listing token on the brand: buyers search the name, not the silhouette. It is also exactly why no decoder is seeded — a bare given name is not brand-unique, so a pattern over it would mint Reformation from any text carrying one (the 00454 "Ricky" rule: True Religion earned its decoder only because "Ricky Super T" is a COMPOUND). Use a name the seller supplies; NEVER infer one from the photos.',
   ARRAY[]::text[], null, null, ARRAY['style name','named dress','not a code']::text[],
   'https://www.thereformation.com/', 0.65, false, 'migration:00457'),
  ('reformation', 'Juliette Dress', 'Women', 'dress', 'Named Dress',
   'Reformation''s best-known named dress: a bias-cut silk-blend SLIP dress with thin straps and a straight neckline. The name is how it is searched. CAUTION — a bias slip dress is one of the least distinctive silhouettes in the catalogue and many Reformation dresses share it, so a slip silhouette alone does NOT identify this style. Take the name from the seller or the tag; do not infer it.',
   ARRAY['silk blend']::text[], null, '$$', ARRAY['juliette','slip dress','bias','silk']::text[],
   'https://www.thereformation.com/', 0.55, false, 'migration:00457'),
  ('reformation', 'Reformation Denim', 'Women', 'label', 'Denim',
   'NOT a garment — the brand''s DENIM line, a distinct department from the dresses that carry most of its resale volume. Also named by given name, with the same caveat.',
   ARRAY['denim']::text[], null, '$$', ARRAY['denim','jeans','reformation jeans']::text[],
   'https://www.thereformation.com/', 0.55, false, 'migration:00457'),
  ('reformation', 'Deadstock Fabric', 'Women', 'label', 'Sustainability',
   'NOT a garment — a GRADING-RELEVANT fact. Reformation builds heavily on DEADSTOCK and limited-run fabric, so a fabric or print that matches nothing in the current catalogue is NORMAL for this brand and is NOT evidence of a fake. It also means one style name can exist in fabrics that never repeat: the name identifies the CUT, not the material.',
   ARRAY[]::text[], null, null, ARRAY['deadstock','limited run','sustainable']::text[],
   'https://www.thereformation.com/', 0.58, false, 'migration:00457'),

  -- Vince: no logo, no named signature style — the FABRIC is the identity, which
  -- is what fabric_tech is for. Plus the sibling-company trap, which is the
  -- brand's defining fact.
  ('vince', 'Vince Cashmere Knit', 'Women', 'knit', 'Knitwear',
   'Vince''s core resale piece: a minimalist cashmere or wool sweater with little or no external branding. THE FIBRE IS THE VALUE and a photo cannot show it — a cashmere Vince sweater and a cotton one are very nearly the same silhouette at very different prices, so the CARE LABEL is the deciding evidence, not the drape. This brand has no logo graphic and no named signature style to fall back on.',
   ARRAY['cashmere','wool']::text[], null, '$$$', ARRAY['cashmere','sweater','knit','minimalist']::text[],
   'https://www.vince.com/', 0.60, false, 'migration:00457'),
  ('vince', 'Vince Silk Blouse', 'Women', 'blouse', 'Silk',
   'The silk/silk-blend blouse, largely unbranded, in the same minimalist register as the knits. Same rule: read the fibre off the care label — silk vs a synthetic is the whole value gap and is not visible in a photo.',
   ARRAY['silk']::text[], null, '$$', ARRAY['silk','blouse','minimalist']::text[],
   'https://www.vince.com/', 0.55, false, 'migration:00457'),
  ('vince', 'Vince Camuto is a Different Company', 'Women', 'label', 'Cross-brand',
   'NOT a garment and NOT a Vince line — the trap, seeded as a first-class row because it is this brand''s costliest error. VINCE CAMUTO (Camuto Group) is a SEPARATE COMPANY that merely shares a first name with Vince (Vince Holding Corp). It is not a diffusion line, not a sub-label and not a fake: it is an unrelated business at a different price point. A "Vince Camuto" tag must never be folded into Vince, and a "Vince" token next to "Camuto" is the other company. Contrast THEYSKENS'' THEORY in this same pack, which contains "Theory" and IS genuinely a Theory line — a name containing another brand''s name proves nothing on its own.',
   ARRAY[]::text[], null, null, ARRAY['vince camuto','not vince','different company']::text[],
   'https://www.vince.com/', 0.65, false, 'migration:00457'),

  -- Theory: the proprietary FABRIC PLATFORM is the identity, exactly as the
  -- outdoor group's fabric tech is (00453).
  ('theory', 'Good Wool', 'Women', 'label', 'Fabric platform',
   'NOT a garment — Theory''s own named WOOL platform, and the brand''s closest thing to a signature. It behaves like the outdoor group''s fabric tech: the FABRIC is what separates two otherwise identical Theory blazers at different values, and it is named on the garment/marketing rather than inferable from a photo. vs Good Linen and Precision Ponte: different named platforms, different seasons and drapes — read the label.',
   ARRAY['wool']::text[], null, '$$$', ARRAY['good wool','blazer','suiting','fabric']::text[],
   'https://www.theory.com/', 0.60, false, 'migration:00457'),
  ('theory', 'Good Linen', 'Women', 'label', 'Fabric platform',
   'NOT a garment — Theory''s named LINEN platform, the warm-weather sibling of Good Wool. Same rule: the platform is the value signal and it is not visible in a photo.',
   ARRAY['linen']::text[], null, '$$', ARRAY['good linen','linen','fabric']::text[],
   'https://www.theory.com/', 0.55, false, 'migration:00457'),
  ('theory', 'Precision Ponte', 'Women', 'label', 'Fabric platform',
   'NOT a garment — Theory''s named PONTE knit platform (a stable double-knit used for its tailored pieces). A ponte blazer and a Good Wool blazer can read identically at a glance and are different pieces.',
   ARRAY['ponte knit']::text[], null, '$$', ARRAY['precision ponte','ponte','knit','fabric']::text[],
   'https://www.theory.com/', 0.52, false, 'migration:00457'),
  ('theory', 'Theyskens'' Theory', 'Women', 'label', 'Designer line',
   'NOT a garment — the retired DESIGNER LINE under Olivier Theyskens (~2011-2014). The tag reads THEYSKENS'' THEORY, which DATES the piece to that window and marks it as the designer line rather than mainline Theory. It IS a Theory line — a line of this same brand, like Baby Milo is a BAPE line — so it folds into Theory with the line here in the style. Contrast Vince Camuto in this same pack: same containing-name shape, opposite answer, because that is a different company.',
   ARRAY[]::text[], '~2011-2014', '$$$', ARRAY['theyskens','designer line','retired']::text[],
   'https://www.theory.com/', 0.58, false, 'migration:00457'),
  ('theory', 'Theory Luxe', 'Women', 'label', 'Japan line',
   'NOT a garment — the JAPANESE-market line. It is a real Theory line, but it is sized on the JAPANESE grade rather than the US one seeded in this pack''s charts, so a Theory Luxe tag means the US chart does not apply to the piece. Same trap family as BAPE''s Japanese sizing (00456), on a brand that otherwise sizes US.',
   ARRAY[]::text[], null, '$$$', ARRAY['theory luxe','japan','japanese sizing']::text[],
   'https://www.theory.com/', 0.50, false, 'migration:00457'),

  -- Eileen Fisher: the drape is the design, and RENEW is a provenance marker
  -- unlike anything else in this KB.
  ('eileenfisher', 'Eileen Fisher Renew', 'Women', 'label', 'Renew',
   'NOT a garment — and the most useful row on this brand. EILEEN FISHER RENEW is the brand''s OWN take-back and resale program: a RENEW tag means this garment was previously owned and was resold BY THE BRAND ITSELF. It is a PROVENANCE marker and is emphatically NOT a defect, NOT a factory second and NOT a counterfeit signal — it is the only brand in this KB that resells its own pieces, so the tag that would look alarming anywhere else is a positive here. Grade and comp it as pre-owned, which it openly is.',
   ARRAY[]::text[], null, '$$', ARRAY['renew','take-back','resale','pre-owned']::text[],
   'https://www.eileenfisher.com/', 0.65, false, 'migration:00457'),
  ('eileenfisher', 'Relaxed Silhouette', 'Women', 'label', 'House cut',
   'NOT a garment — the HOUSE CUT, seeded as a first-class fact because it is the most likely way to grade this brand wrong. Eileen Fisher is cut deliberately loose and boxy across the whole line: dropped shoulders, straight bodies, generous ease. An Eileen Fisher M drapes like a US L. THAT IS THE DESIGN — a garment hanging away from the body is INTACT and correctly labeled. Do not grade the drape as stretching, do not read it as wear, do not call it "runs large" as though it were an error. Same rule as the Essentials drape (00456), on a brand nobody expects it from.',
   ARRAY[]::text[], null, null, ARRAY['relaxed','boxy','oversized','drape']::text[],
   'https://www.eileenfisher.com/', 0.68, false, 'migration:00457'),
  ('eileenfisher', 'Eileen Fisher Knitwear', 'Women', 'knit', 'Knitwear',
   'The brand''s core resale piece: a minimal, largely unbranded sweater or cardigan in merino, alpaca, silk or organic cotton. Same rule as Vince in this pack — THE FIBRE CARRIES THE VALUE and a photo cannot show it, so the care label is the deciding evidence.',
   ARRAY['merino','alpaca','silk','organic cotton']::text[], null, '$$', ARRAY['knit','sweater','cardigan','merino']::text[],
   'https://www.eileenfisher.com/', 0.58, false, 'migration:00457')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: NONE. ────────────────────────────────────────────────
-- The second group in the epic that seeds NO decoder — but for a DIFFERENT reason
-- than 00456's, which is why it is worth stating rather than cross-referencing.
--
-- 00456 refused because streetwear's identifier is a GRAPHIC: not on the tag, not
-- parseable. This group's identifier IS printed and IS regular — these brands NAME
-- their pieces, and the name is exactly what the market searches (a Reformation
-- Juliette, an Anthropologie Maeve, an Aritzia Wilfred, a Sézane Gaspard). It
-- fails the epic's THIRD test: brand-unique.
--
-- Every one of those names is an ordinary GIVEN NAME. 00454 seeded a True
-- Religion decoder only because "Ricky Super T" is a COMPOUND — "Ricky" alone is
-- a first name and would have been the Lee "101" mistake. "Juliette", "Maeve",
-- "Wilfred" and "Gaspard" have no second part to make them safe. A pattern over
-- any of them would mint the brand from any text carrying a common first name.
--
-- The Anthropologie/Aritzia item numbers on the tag are RETAILER SKUs, which the
-- J.Crew precedent (00450) already settled: an informational tell, never a
-- brand-recovering decoder.
--
-- The naming convention is therefore seeded as a first-class informational fact
-- (the 'Named Dress' / 'Named French Style' rows above) and locked in by
-- no-false-recovery cases in the golden set.

-- ── brand_colorways: NONE. ──────────────────────────────────────────────────
-- Seeded ONLY where a brand uses a STABLE PROPRIETARY name — the rule that kept
-- Chanel's seasonal colors out of 00455, the denim wash names out of 00454, and
-- Supreme/Stüssy/Kith/Palace out of 00456. This group's colors are seasonal
-- descriptive English words: "Ivory", "Sage", "Black", "Navy". There is nothing
-- proprietary to seed here, and inventing a palette would be invention.

-- ── brand_size_charts ───────────────────────────────────────────────────────
-- ALL VALUES ARE INCHES and are body-equivalent figures for the nominal
-- contemporary women's grade — not brand-published specs. The notes say so and
-- confidence is capped at 0.55 so the US-1715 verifier replaces them with
-- published numbers rather than rubber-stamping them.
--
-- THE GROUP'S SIGNATURE TRAP LIVES HERE, and this pack has THREE directions
-- rather than 00456's two, none of which announces itself on the tag:
--
--     Sézane          FR 38 = US 6   — French national sizing; the number lies.
--     Aritzia         runs SMALL     — starts at 00/XXS; an Aritzia S ≈ US 2-4.
--     Eileen Fisher   runs LARGE     — an EF M drapes like a US L.
--
-- So an "M" means different bodies on Aritzia and Eileen Fisher, and a "38" on
-- Sézane is a US 6 rather than anything a US buyer would guess. Each cross-map is
-- written INSIDE THE SIZE LABEL, where the model actually reads it — the 00455
-- lesson: a note alone does not survive into the rendered table.
--
-- NO IN-CODE FALLBACK CHART IS MIRRORED FOR 'vince' (the DB chart below is the
-- only one). This is deliberate and is the first time the epic has split the two:
-- DB charts are fetched by EXACT brand_key, so a 'vince' row can never reach
-- brandKey("Vince Camuto") = "vincecamuto"; but findSizingCharts matches
-- brandMatch by SUBSTRING, and "vince camuto".includes("vince") is TRUE — so an
-- in-code Vince chart would hand a DIFFERENT COMPANY's garments Vince's numbers.
-- No narrowing fixes it (there is no token unique to the shorter name — the 00456
-- finding). Asserted in contemporary-womens-content_test.ts.
--
-- All INSERTs — no UPDATE of an existing row. No shared-chart narrowing is
-- needed: no existing chart's brand_match claims any of these seven brands.

insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values

  ('anthropologie', 'Anthropologie', ARRAY['anthropologie']::text[], 'Women', 'Tops & dresses (US alpha)',
   ARRAY['top','tee','shirt','blouse','dress','knit','sweater','cardigan','jacket','long sleeve']::text[],
   $json$[{"size":"XS (US 0-2)","measurements":{"bust":"32-33.5","waist":"25-26.5"}},{"size":"S (US 4-6)","measurements":{"bust":"34.5-35.5","waist":"27-28.5"}},{"size":"M (US 8-10)","measurements":{"bust":"36.5-38","waist":"29.5-31"}},{"size":"L (US 12-14)","measurements":{"bust":"39.5-41","waist":"32.5-34"}},{"size":"XL (US 16)","measurements":{"bust":"42.5-44","waist":"35.5-37"}}]$json$::jsonb,
   'Anthropologie is US women''s sizing and grades close to a general US contemporary body — no national cross-map applies (contrast Sézane in this same group, whose FR 38 is a US 6). The US numeric equivalent is carried in the size label because Anthropologie labels BOTH ways depending on the house line. REMEMBER THE TAG USUALLY SAYS A HOUSE LABEL — Maeve, Pilcro, Moth, Daily Practice — and not "Anthropologie"; the house label is the STYLE, and this chart applies to all of them. It does NOT apply to a THIRD-PARTY brand bought at Anthropologie, which keeps its own brand and its own sizing. These are body-equivalent figures in inches for the nominal grade, not Anthropologie-published specs. Measure the garment flat (bust across the underarm seam, doubled) and treat the tag as a claim to check.',
   'https://www.anthropologie.com/', 0.55, false, 'migration:00457'),

  ('anthropologie', 'Anthropologie', ARRAY['anthropologie']::text[], 'Women', 'Bottoms (US numeric waist)',
   ARRAY['bottom','pant','jean','denim','short','trouser','skirt','legging']::text[],
   $json$[{"size":"US 24","measurements":{"waist":"24-25","hip":"34-35"}},{"size":"US 26","measurements":{"waist":"26-27","hip":"36-37"}},{"size":"US 28","measurements":{"waist":"28-29","hip":"38-39"}},{"size":"US 30","measurements":{"waist":"30-31","hip":"40-41"}},{"size":"US 32","measurements":{"waist":"32-33","hip":"42-43"}}]$json$::jsonb,
   'Anthropologie bottoms (largely the PILCRO house denim line — the tag says PILCRO, not "Anthropologie") are US NOMINAL WAIST: the label is a measurement, not a letter mapped onto a body (the denim rule from 00454). No national cross-map applies. These are nominal figures in inches, not published specs. Measure the flat waistband and double it.',
   'https://www.anthropologie.com/', 0.55, false, 'migration:00457'),

  ('szane', 'Sézane', ARRAY['sézane','sezane']::text[], 'Women', 'Tops & dresses (FRENCH sizing)',
   ARRAY['top','tee','shirt','blouse','dress','knit','sweater','cardigan','jacket','long sleeve']::text[],
   $json$[{"size":"FR 34 (US 2)","measurements":{"bust":"32-33","waist":"25-26"}},{"size":"FR 36 (US 4)","measurements":{"bust":"33.5-34.5","waist":"26.5-27.5"}},{"size":"FR 38 (US 6)","measurements":{"bust":"35-36","waist":"28-29"}},{"size":"FR 40 (US 8)","measurements":{"bust":"36.5-38","waist":"29.5-31"}},{"size":"FR 42 (US 10)","measurements":{"bust":"38.5-40","waist":"31.5-33"}},{"size":"FR 44 (US 12)","measurements":{"bust":"40.5-42","waist":"33.5-35"}}]$json$::jsonb,
   'Sézane is a Paris brand on FRENCH national sizing and it runs SMALL against a US body: FR 38 is a US 6 — the tag carries a BARE NUMBER that is not a US size and not an alpha, and nothing on it says "FR". This is the same national-system trap as Chanel''s FR and Prada''s IT tags (00455), which is why the US equivalent is written into the size label here rather than left in a note. Within this same pack Aritzia and Eileen Fisher are alpha-labeled and lie in two further directions, so no single "contemporary womens runs X" rule holds. These are body-equivalent figures in inches for the nominal FR grade, not Sézane-published specs. Measure the garment flat (bust across the underarm seam, doubled) and treat the tag as a claim to check.',
   'https://www.sezane.com/', 0.55, false, 'migration:00457'),

  ('aritzia', 'Aritzia', ARRAY['aritzia']::text[], 'Women', 'Tops & dresses (alpha, RUNS SMALL)',
   ARRAY['top','tee','shirt','blouse','dress','knit','sweater','cardigan','jacket','long sleeve','puffer']::text[],
   $json$[{"size":"XXS (US 00)","measurements":{"bust":"30.5-31.5","waist":"23.5-24.5"}},{"size":"XS (US 0-2)","measurements":{"bust":"32-33","waist":"25-26"}},{"size":"S (US 2-4)","measurements":{"bust":"33.5-35","waist":"26.5-28"}},{"size":"M (US 6-8)","measurements":{"bust":"35.5-37","waist":"28.5-30"}},{"size":"L (US 10-12)","measurements":{"bust":"38-39.5","waist":"31-32.5"}},{"size":"XL (US 14)","measurements":{"bust":"40.5-42","waist":"33.5-35"}}]$json$::jsonb,
   'Aritzia RUNS SMALL against a general US contemporary body and its range starts at 00/XXS — an Aritzia S sits near a US 2-4, roughly one size down. The US numeric equivalent is written into the size label because the tag says only a letter and gives no warning. THIS IS ONE OF THE GROUP''S TWO ALPHA DIRECTIONS: within this same pack an Eileen Fisher M drapes like a US L, the OPPOSITE way, and both tags just say "M". No national cross-map applies (contrast Sézane, whose FR 38 is a US 6). REMEMBER THE TAG SAYS THE SUB-LABEL — Wilfred, Wilfred Free, Babaton, TNA, Sunday Best — and not "Aritzia"; the sub-label is the STYLE and this chart applies to all of them. These are body-equivalent figures in inches for the nominal grade, not Aritzia-published specs. Measure the garment flat (bust across the underarm seam, doubled) and treat the tag as a claim to check.',
   'https://www.aritzia.com/', 0.55, false, 'migration:00457'),

  ('aritzia', 'Aritzia', ARRAY['aritzia']::text[], 'Women', 'Bottoms (US numeric waist)',
   ARRAY['bottom','pant','jean','denim','short','trouser','skirt','legging','sweatpant','jogger']::text[],
   $json$[{"size":"US 23","measurements":{"waist":"23-24","hip":"33-34"}},{"size":"US 24","measurements":{"waist":"24-25","hip":"34-35"}},{"size":"US 26","measurements":{"waist":"26-27","hip":"36-37"}},{"size":"US 28","measurements":{"waist":"28-29","hip":"38-39"}},{"size":"US 30","measurements":{"waist":"30-31","hip":"40-41"}},{"size":"US 32","measurements":{"waist":"32-33","hip":"42-43"}}]$json$::jsonb,
   'Aritzia bottoms (largely the SUNDAY BEST denim line — the tag says SUNDAY BEST, not "Aritzia") are US NOMINAL WAIST: the label is a measurement rather than a letter mapped onto a body, so the runs-small alpha caveat does NOT apply to them (the denim rule from 00454). The range starts at 23. No national cross-map applies. These are nominal figures in inches, not published specs. Measure the flat waistband and double it.',
   'https://www.aritzia.com/', 0.55, false, 'migration:00457'),

  ('reformation', 'Reformation', ARRAY['reformation']::text[], 'Women', 'Dresses & tops (US numeric)',
   ARRAY['dress','top','tee','shirt','blouse','knit','sweater','cardigan','jacket','long sleeve']::text[],
   $json$[{"size":"US 0","measurements":{"bust":"32-33","waist":"25-26"}},{"size":"US 2","measurements":{"bust":"33.5-34.5","waist":"26.5-27.5"}},{"size":"US 4","measurements":{"bust":"35-36","waist":"28-29"}},{"size":"US 6","measurements":{"bust":"36.5-37.5","waist":"29.5-30.5"}},{"size":"US 8","measurements":{"bust":"38-39.5","waist":"31-32.5"}},{"size":"US 10","measurements":{"bust":"40-41.5","waist":"33-34.5"}},{"size":"US 12","measurements":{"bust":"42-43.5","waist":"35-36.5"}}]$json$::jsonb,
   'Reformation is US women''s NUMERIC sizing (0-12) on a fitted, dress-led cut — no national cross-map applies (contrast Sézane in this same group, whose bare "38" is a US 6, not a US 38: the two look alike on a tag and are not). The house cut is close-fitting rather than relaxed, so a snug flat measurement is the intended silhouette and NOT a mislabel. These are body-equivalent figures in inches for the nominal grade, not Reformation-published specs. Measure the garment flat (bust across the underarm seam, doubled). The STYLE NAME changes the price, not the fit — a Juliette and any other named dress in the same size are the same grade.',
   'https://www.thereformation.com/', 0.55, false, 'migration:00457'),

  -- Vince: DB-ONLY, deliberately. This row is safe because the resolver fetches
  -- brand_size_charts by EXACT brand_key — brandKey("Vince Camuto") is
  -- "vincecamuto" and can never reach it. The matching in-code chart is
  -- deliberately NOT mirrored: findSizingCharts is a SUBSTRING test, so an
  -- in-code ["vince"] would fire on every Vince Camuto garment. See the header.
  ('vince', 'Vince', ARRAY['vince']::text[], 'Women', 'Tops & knits (US alpha)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','cardigan','dress','jacket','long sleeve']::text[],
   $json$[{"size":"XS (US 0-2)","measurements":{"bust":"32-33.5","waist":"25-26.5"}},{"size":"S (US 4-6)","measurements":{"bust":"34.5-35.5","waist":"27-28.5"}},{"size":"M (US 8-10)","measurements":{"bust":"36.5-38","waist":"29.5-31"}},{"size":"L (US 12-14)","measurements":{"bust":"39.5-41","waist":"32.5-34"}},{"size":"XL (US 16)","measurements":{"bust":"42.5-44","waist":"35.5-37"}}]$json$::jsonb,
   'Vince is US women''s sizing on a relaxed minimalist cut — no national cross-map applies (contrast Sézane in this same group, whose FR 38 is a US 6). THIS CHART IS FOR VINCE ONLY AND NOT FOR VINCE CAMUTO, which is a SEPARATE COMPANY sharing a first name — not a diffusion line, not a sub-label. If the tag reads "Vince Camuto", this chart does not apply to the garment. THE FIBRE, NOT THE FIT, IS THIS BRAND''S VALUE: cashmere vs wool vs cotton in the same silhouette is the whole price gap and is not visible in a photo, so read the care label. These are body-equivalent figures in inches for the nominal grade, not Vince-published specs. Measure the garment flat (bust across the underarm seam, doubled).',
   'https://www.vince.com/', 0.55, false, 'migration:00457'),

  ('theory', 'Theory', ARRAY['theory']::text[], 'Women', 'Tops & tailoring (US alpha)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','cardigan','blazer','jacket','suit','long sleeve']::text[],
   $json$[{"size":"XS (US 0-2)","measurements":{"bust":"32-33.5","waist":"25-26.5"}},{"size":"S (US 4-6)","measurements":{"bust":"34.5-35.5","waist":"27-28.5"}},{"size":"M (US 8-10)","measurements":{"bust":"36.5-38","waist":"29.5-31"}},{"size":"L (US 12-14)","measurements":{"bust":"39.5-41","waist":"32.5-34"}}]$json$::jsonb,
   'Theory is US women''s sizing on a TAILORED cut — no national cross-map applies (contrast Sézane in this same group, whose FR 38 is a US 6). BUT: a THEORY LUXE tag is the JAPANESE-market line and is sized on the Japanese grade, so this chart does NOT apply to it — read the full label. THEYSKENS'' THEORY does fold here (it is a Theory line). The tailored cut means a close flat measurement is the intended silhouette and not a mislabel. THE FABRIC PLATFORM changes the price, not the fit: a Good Wool blazer and a Precision Ponte blazer in the same size are the same grade. These are body-equivalent figures in inches for the nominal grade, not Theory-published specs. Measure the garment flat (bust across the underarm seam, doubled).',
   'https://www.theory.com/', 0.55, false, 'migration:00457'),

  ('theory', 'Theory', ARRAY['theory']::text[], 'Women', 'Bottoms (US numeric)',
   ARRAY['bottom','pant','trouser','short','skirt','jean','denim']::text[],
   $json$[{"size":"US 0","measurements":{"waist":"25-26","hip":"34-35"}},{"size":"US 2","measurements":{"waist":"26-27","hip":"35-36"}},{"size":"US 4","measurements":{"waist":"27.5-28.5","hip":"36.5-37.5"}},{"size":"US 6","measurements":{"waist":"29-30","hip":"38-39"}},{"size":"US 8","measurements":{"waist":"30.5-31.5","hip":"39.5-40.5"}},{"size":"US 10","measurements":{"waist":"32-33","hip":"41-42"}},{"size":"US 12","measurements":{"waist":"33.5-34.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'Theory bottoms are US women''s NUMERIC sizing (0-12) — a size number mapped onto a body, NOT a nominal waist measurement like the denim brands in 00454, so do not read a "4" as a 4-inch anything. No national cross-map applies. These are body-equivalent figures in inches, not published specs. Measure the flat waistband and double it.',
   'https://www.theory.com/', 0.55, false, 'migration:00457'),

  ('eileenfisher', 'Eileen Fisher', ARRAY['eileen fisher','eileenfisher']::text[], 'Women', 'Tops & knits (alpha, RUNS LARGE)',
   ARRAY['top','tee','shirt','blouse','knit','sweater','cardigan','dress','jacket','tunic','long sleeve']::text[],
   $json$[{"size":"XXS (drapes ≈US 0)","measurements":{"bust":"33-34","waist":"26-27"}},{"size":"XS (drapes ≈US 2-4)","measurements":{"bust":"35-36.5","waist":"28-29.5"}},{"size":"S (drapes ≈US 6-8)","measurements":{"bust":"37.5-39","waist":"30.5-32"}},{"size":"M (drapes ≈US 10-12)","measurements":{"bust":"40-41.5","waist":"33-34.5"}},{"size":"L (drapes ≈US 14-16)","measurements":{"bust":"42.5-44","waist":"35.5-37"}},{"size":"XL (drapes ≈US 18)","measurements":{"bust":"45-46.5","waist":"38-39.5"}}]$json$::jsonb,
   'Eileen Fisher RUNS LARGE: the cut is DELIBERATELY RELAXED and boxy across the whole line — dropped shoulders, straight bodies, generous ease — so an Eileen Fisher M drapes like a US L, roughly one size up. THAT DRAPE IS THE DESIGN: it is not stretching, not wear, not a mislabel, and it must NOT be graded as a defect — a garment hanging away from the body is INTACT and correctly labeled. The drape is written into the size label because nothing on the tag announces it: the tag says only "M", and an Aritzia M in this same group is a US 6-8, the OTHER direction. No national cross-map applies (contrast Sézane, whose FR 38 is a US 6). These are body-equivalent figures in inches for the nominal grade, not Eileen Fisher-published specs. Measure the garment flat (bust across the underarm seam, doubled) and treat the tag as a claim to check.',
   'https://www.eileenfisher.com/', 0.55, false, 'migration:00457'),

  ('eileenfisher', 'Eileen Fisher', ARRAY['eileen fisher','eileenfisher']::text[], 'Women', 'Bottoms (alpha, RUNS LARGE)',
   ARRAY['bottom','pant','trouser','short','skirt','legging','ankle pant']::text[],
   $json$[{"size":"XXS (drapes ≈US 0)","measurements":{"waist":"25-27"}},{"size":"XS (drapes ≈US 2-4)","measurements":{"waist":"27-29.5"}},{"size":"S (drapes ≈US 6-8)","measurements":{"waist":"29.5-32"}},{"size":"M (drapes ≈US 10-12)","measurements":{"waist":"32-34.5"}},{"size":"L (drapes ≈US 14-16)","measurements":{"waist":"34.5-37"}},{"size":"XL (drapes ≈US 18)","measurements":{"waist":"37-39.5"}}]$json$::jsonb,
   'Eileen Fisher bottoms are cut DELIBERATELY RELAXED and the volume is the design, not a fit error — do not grade it as wear. Most are pull-on with an elasticated waist, so the figures are a relaxed range rather than a nominal waist. No national cross-map applies. These are body-equivalent figures in inches, not published specs. Measure the flat waistband relaxed and double it.',
   'https://www.eileenfisher.com/', 0.55, false, 'migration:00457')
on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00457') on conflict do nothing;
