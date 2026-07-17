-- US-1990: Footwear (tier 2) brand knowledge (10 brands).
--
-- Clarks, Merrell, KEEN, Sorel, Brooks, Saucony, Steve Madden, Sam Edelman,
-- Allen Edmonds, Crocs. ALL TEN were passthrough-only — not even the bare
-- alias-only shells 00389 left for some groups — so a "merrell" or "sam edelman"
-- tag rendered the seller's own casing into the prompt block and the eBay Brand
-- aspect. This is the tier-2 footwear pack; it sits beside 00459 (New Balance,
-- Dr. Martens, UGG, Birkenstock, Converse, Vans, Cole Haan), which is NOT
-- re-touched, and beside 00465's ASICS/HOKA/On Running running shoes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT BINDS THIS GROUP: THE SIZE IS STAMPED, NOT MEASURED — AND THE STYLE IS A
-- NAME, NOT A CODE.
--
--   The story note puts it exactly: "Style code + US/UK/EU size system are the
--   key signal." Of those two, ONLY THE SIZE SYSTEM SURVIVES CONTACT WITH THE
--   EVIDENCE. A shoe's size cannot be measured off a photo (00459's inversion) —
--   it is stamped on the tongue label / insole / footbed and READ — so the charts
--   here are TRANSLATORS (the brand's own number → every other system's number),
--   not estimators, and the US/UK/EU cross-map lives INSIDE the size label where
--   the model reads it (the 00455/00459 lesson).
--
--   The STYLE side, by contrast, collapses to a NAME for all ten. Desert Boot,
--   Moab, Newport, Caribou, Ghost, Kinvara, Park Avenue, Classic Clog — the
--   model is identified by a coined or trademarked product NAME printed on the
--   box and often the insole, never by a regular brand-unique code on a sewn tag.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ZERO DECODERS, DELIBERATELY — and every candidate is fixtured as a REFUSAL
-- negative in brand-knowledge-golden_test.ts (a refusal that is not tested is a
-- comment). This is the 00466 call (fast-fashion): the honest state of the
-- evidence is that not one of these ten prints a code that clears the bar
-- (tag-printed AND regular AND brand-unique in FORMAT — the 00460 test).
--
--   * BROOKS `110411` / `120363` — the running line's 6-digit style numbers are
--     genuine, printed on the box, and regular. They are a BARE DIGIT RUN, so a
--     pattern over one mints the KB's costliest false positive from any number on
--     any tag (the Chanel rule, US-1736; the Lee "101" rule, 00393). Seeded as a
--     listing token via the styles; refused as a decoder.
--   * SAUCONY `S20600` (men) / `S10600` (women) — a REAL Saucony convention (the
--     S2xxxx / S1xxxx / S294xx families), and it even encodes the department in
--     the second digit the way New Balance's prefix letter does (00459). It is
--     refused anyway, and on the SHARPEST possible ground: `S` + 5 digits is
--     EXACTLY adidas's one-letter + five-digit style-code shape (`S79166`, the
--     `brandFromStyleFormat` adidas branch in brand-normalize.ts). A pattern over
--     it would let a FORMAT guess override the tag's own brand — the Reebok/adidas
--     shared-format hazard from 00465, here between Saucony and adidas.
--   * MERRELL `J036755` — the `J`-prefixed article number is printed on the
--     tongue label, but a single leading letter is not a brand (the Dr. Martens
--     "1460" argument, 00459 — a prefix has to be a KNOWN CLOSED SET like New
--     Balance's M/W/U to make a digit run brand-unique, and one bare "J" is not),
--     and the evidence that it is a REGULAR tag string rather than a box/web SKU
--     is not established. Refused; seeded as a style/listing token.
--   * CLARKS / KEEN / SOREL / STEVE MADDEN / SAM EDELMAN / ALLEN EDMONDS / CROCS
--     — the model is a NAME, and the article numbers are plain web/catalogue SKUs
--     with no regular tag-printed brand-unique format.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PACK'S TWO NAME COLLISIONS (both carried in brand-normalize.ts, not here):
--
--   1. BROOKS (running) IS NOT BROOKS BROTHERS. A bare "brooks" is DELIBERATELY
--      NOT an alias (the 00467 rule — the two companies litigated the name), so a
--      "Brooks" tag passes through unchanged; it happens to equal the canonical
--      the running brand needs anyway, so the pack (brand_key 'brooks') is still
--      reachable. "Brooks" is ALSO added to DETECT_EXCLUDED_FROM_TEXT — it is an
--      ordinary English word ("babbling brooks") and would otherwise be minted out
--      of prose. Reachable by TAG, never guessed from text.
--   2. KEEN is an ordinary English ADJECTIVE ("keen interest"). "KEEN" is added to
--      DETECT_EXCLUDED_FROM_TEXT for the same reason — reachable by tag, never
--      guessed from prose. Both verified by mutation in the content test.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REGISTERED NUMBERS: NONE ARE SEEDED. Footwear leather/rubber uppers sit largely
-- OUTSIDE textile RN labeling (the 00468 category-error lesson: an RN lives where
-- the TEXTILE lives), and for the fabric-lined shoes here no registrant could be
-- sourced to a primary FTC record. Fabricating one is the KB's costliest error
-- (the RN 17257 lesson, 00468) — so RN is left empty, owed to the US-1715 queue.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TAG ERAS: DOCUMENTED for the two HERITAGE makers (Clarks Originals + Allen
-- Edmonds, whose Made-in-England / Made-in-USA construction is a genuine value
-- prior), EMPTY for the eight modern performance/fashion brands with no vintage
-- tag corpus (the athleisure precedent, 00452 — empty is CORRECT, not a gap).
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00469
-- convention). Confidence is DELIBERATELY UNEVEN: a brand-published spec is ~0.8;
-- a collector-corroborated tell is ~0.6 and says so.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('clarks', 'Clarks',
   ARRAY['clarks','clark','cjclark','candjclark','clarksoriginals','clarksengland','clarksshoes','bostonian']::text[],
   ARRAY['desert boots','moccasins','wallabees','comfort shoes','dress shoes','sandals']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Older \"Clarks — Made in England\" Originals labels","years":"pre-2000s (approximate)","description":"COLLECTOR-CORROBORATED, NOT A DATED CHART. C. & J. Clark (founded 1825, Street, Somerset) built the Desert Boot (1950, Nathan Clark) and the Wallabee (1967) as its Originals line. Older examples carry Made-in-England construction; production has since moved largely to Asia. A Made-in-England Originals crepe-sole boot skews older and higher-tier, but no precise dated label chronology is sourced — treat country as a coarse prior only, not a year."}]$j$::jsonb,
   $j$[{"pattern":"England (heritage Originals), broadly Asia (modern)","note":"COARSE VINTAGE PRIOR ONLY: a Made-in-England Clarks skews older/collectible, but the vast majority of modern Clarks is made in Asia and that does not authenticate or precisely date a piece."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Clarks is a mass-market comfort brand, not a luxury counterfeit target; there is no per-unit serial and no published authentication standard. Grade condition. The value read is the LINE (Originals — Desert Boot / Wallabee — vs the ordinary comfort/dress range) plus construction."},{"tell":"The CREPE SOLE is the product and its state is the grade","detail":"The Originals Desert Boot and Wallabee ride on a raw natural CREPE (gum) sole that YELLOWS, hardens and crumbles with age and sun. A yellowed/ambered crepe is normal patina on a vintage pair, but a CRACKED or CRUMBLING crepe edge and a delaminated sole ARE defects — do not conflate them. Require a sole photo."}]$j$::jsonb,
   'Founded 1825 in Street, Somerset, England by Cyrus and James Clark; still headquartered there. The resale-relevant core is the CLARKS ORIGINALS line: the DESERT BOOT (a 2-eyelet chukka on a crepe sole, introduced 1950 by Nathan Clark) and the WALLABEE (a moccasin-construction shoe/boot on crepe, 1967). Bostonian is a Clarks-group dress line. Clarks uses LETTER WIDTH FITTINGS (G = standard, H = wide, etc. on UK-market stock) — see the size chart. NO RN IS SEEDED (footwear; none sourced). NO DECODER: the model is a NAME (Desert Boot, Wallabee, Desert Trek, Bushacre), not a regular tag-printed code — Clarks article numbers are web/catalogue SKUs.',
   'https://www.clarks.com/', 0.80, false, 'migration:00470'),

  ('merrell', 'Merrell',
   ARRAY['merrell','merrells','merrellfootwear']::text[],
   ARRAY['hiking shoes','hiking boots','trail runners','slip-ons','outdoor sandals','water shoes']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Merrell (a Wolverine Worldwide brand) produces broadly offshore; country is not a date tell or an authenticity signal for this brand."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; there is no meaningful counterfeit surface","detail":"Merrell is an outdoor-performance brand, not a luxury counterfeit target — no per-unit serial and no authentication guide. Grade condition. Identify by the MODEL name (Moab, Jungle Moc, Chameleon) and the Vibram outsole; the J-prefixed article number on the tongue is a LISTING token, not a decoder (see notes)."},{"tell":"The OUTSOLE and midsole are the grade on a hiking shoe","detail":"A hiker lives or dies on its outsole tread depth and midsole integrity. Worn-smooth lugs, a compressed/creased EVA midsole and a delaminated sole are the real defects and they need a SOLE photo — the three-quarter product shot hides all of it. Say the sole is UNSEEN rather than grading the upper and calling it the shoe."}]$j$::jsonb,
   'Founded 1981 (Randy Merrell / Clark Matis / John Schweizer); now a WOLVERINE WORLDWIDE brand (a stablemate of Saucony, also in this pack, and Hush Puppies — a shared parent is NOT a signal). The flagship is the MOAB hiking shoe/boot ("Mother Of All Boots"); the JUNGLE MOC is the iconic bungee slip-on; Chameleon is the other core hiker. NO RN IS SEEDED (footwear; none sourced). NO DECODER: the "J"-prefixed article number (e.g. J036755) is refused — a single leading letter is not a brand-unique prefix the way New Balance''s M/W/U closed set is (00459), and it is not established as a regular tag-printed code rather than a box/web SKU.',
   'https://www.merrell.com/', 0.80, false, 'migration:00470'),

  ('keen', 'KEEN',
   ARRAY['keen','keenfootwear','keenshoes']::text[],
   ARRAY['hybrid sandals','hiking boots','hiking shoes','work boots','water shoes']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"USA (some assembled in Portland) + offshore","note":"KEEN assembles some product in Portland, Oregon and makes others offshore. Country is not a reliable date or authenticity tell on its own."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"KEEN is an outdoor brand with no consumer authentication portal and no per-unit serial. Grade condition. Identify by the PATENTED TOE BUMP (the reinforced rubber over-toe that defines the Newport sandal) and the model name."},{"tell":"KEEN runs roomy — a fit note, not a defect","detail":"KEEN's footbeds and toe boxes are cut WIDE and roomy by design; a generous-feeling fit is the brand, not a sizing error. Report the stamped size plus the runs-roomy guidance rather than adjusting the number."}]$j$::jsonb,
   'Founded 2003 in Portland, Oregon; defined the modern HYBRID SANDAL with the NEWPORT (2003, the closed-toe sport sandal with the signature protective toe bump). Other core models: TARGHEE (hiking), Uneek (the cord sandal), Utility work boots. NO RN IS SEEDED (footwear; none sourced). ⚠ "KEEN" IS AN ORDINARY ENGLISH ADJECTIVE ("keen interest") and is added to DETECT_EXCLUDED_FROM_TEXT (brand-normalize.ts) so it is reachable BY TAG but never GUESSED from prose. NO DECODER: the model is a NAME, and KEEN article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — a 2003 brand with no vintage tag corpus (the athleisure precedent, 00452).',
   'https://www.keenfootwear.com/', 0.80, false, 'migration:00470'),

  ('sorel', 'Sorel',
   ARRAY['sorel','sorels','sorelfootwear','kaufmansorel']::text[],
   ARRAY['winter boots','pac boots','wedge boots','rain boots','sneakers']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Canada (heritage Kaufman), broadly offshore (modern Columbia era)","note":"COARSE PRIOR ONLY: the original Kaufman-era Canadian Caribou/pac boots skew vintage, but modern Sorel (a Columbia Sportswear brand) is broadly offshore. Country does not authenticate or precisely date a piece."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the removable liner is part of the product","detail":"Sorel has no consumer authentication and no per-unit serial. Grade condition. On the classic pac boots the FELT LINER is REMOVABLE and part of the value — a missing, matted or heavily-compressed liner is a real defect; a present, lofted liner is a plus. Check the rubber shell for cracking at the flex point and the seam between the rubber lower and the fabric/leather upper."},{"tell":"The wedge/Kinetic line is FASHION, not the pac boot","detail":"Sorel now spans two very different products: the heritage insulated PAC BOOT (Caribou, 1964 Pac) and a FASHION line (Joan of Arctic wedge, Kinetic sneaker, Out N About). They comp separately — do not price a fashion wedge off the technical winter-boot ladder or vice versa."}]$j$::jsonb,
   'Founded on the Kaufman Rubber Co. roots (Kitchener, Ontario); the CARIBOU pac boot (a rubber shell + leather upper + removable felt liner) and the 1964 PAC are the heritage core, and SOREL is now a COLUMBIA SPORTSWEAR brand. The women''s line (JOAN OF ARCTIC wedge, Kinetic, Out N About) is the modern fashion driver. NO RN IS SEEDED (footwear; none sourced). NO DECODER: the model is a NAME, and Sorel article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — no documented, value-driving dated label chronology is sourced (the athleisure precedent, 00452).',
   'https://www.sorel.com/', 0.80, false, 'migration:00470'),

  ('brooks', 'Brooks',
   ARRAY['brooksrunning','brooksshoes','brookssports','brooksrunninginc']::text[],
   ARRAY['running shoes','road running','trail running','stability shoes','walking shoes']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Brooks running shoes are produced broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; a running shoe is graded on its MILEAGE","detail":"Brooks is a running-performance brand with no consumer authentication and no per-unit serial. Grade condition — and on a running shoe the decisive read is WEAR: outsole tread loss, a compressed/creased midsole (the DNA Loft/DNA Amp foam packs out), and heel-counter breakdown. A running shoe that looks clean on top can be functionally dead underfoot; require a SOLE photo and say the midsole is UNSEEN rather than grading the mesh upper."},{"tell":"The GTS / GuideRails vs neutral distinction is the model, not the size","detail":"Brooks splits into NEUTRAL (Ghost, Glycerin, Launch) and SUPPORT/STABILITY (Adrenaline GTS, Addiction — GuideRails). They look near-identical in a photo and comp differently; read the model name off the shoe, do not infer support from the silhouette."}]$j$::jsonb,
   'Brooks Running (founded 1914; a BERKSHIRE HATHAWAY company). Core models: GHOST (neutral daily trainer), ADRENALINE GTS (support, GuideRails), GLYCERIN (max cushion), Launch (lightweight). ⚠ **BROOKS (RUNNING) IS NOT BROOKS BROTHERS** — a DIFFERENT COMPANY (00467), and the two litigated the name. A bare "brooks" is DELIBERATELY NOT an alias (it is genuinely ambiguous), so a "Brooks" tag passes through unchanged and still reaches this pack (brand_key ''brooks''); "Brooks" is ALSO in DETECT_EXCLUDED_FROM_TEXT (an ordinary word — "babbling brooks"), reachable by tag but never guessed from prose. NO RN IS SEEDED. NO DECODER: the 6-digit style number (110411) is a BARE DIGIT RUN and is refused (the Chanel rule) — seeded as a listing token via the styles.',
   'https://www.brooksrunning.com/', 0.80, false, 'migration:00470'),

  ('saucony', 'Saucony',
   ARRAY['saucony','sauconys','sauconyoriginals']::text[],
   ARRAY['running shoes','trail running','sportstyle sneakers','racing flats']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Saucony (a Wolverine Worldwide brand) produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; a running shoe is graded on its MILEAGE","detail":"Saucony is a running-performance brand with no consumer authentication and no per-unit serial. Grade condition — outsole tread loss, a packed-out PWRRUN midsole and heel-counter breakdown are the real defects and need a SOLE photo. The SPORTSTYLE reissues (Jazz Original, Shadow 6000) are graded as fashion sneakers, the performance line (Kinvara, Triumph, Endorphin, Peregrine) on mileage."},{"tell":"The style number is refused as a decoder — read the MODEL name","detail":"Saucony numbers style codes S2xxxx (men) / S1xxxx (women), which even encodes the department in the second digit. It is REFUSED as a decoder because S + 5 digits is exactly adidas's style-code shape (S79166), so a pattern over it would let a format guess override the tag's own brand (the 00465 adidas/Reebok shared-format hazard). Identify by the model name printed on the box/insole, not the number."}]$j$::jsonb,
   'Founded 1898 near the Saucony Creek in Kutztown, Pennsylvania; now a WOLVERINE WORLDWIDE brand (a stablemate of Merrell in this pack). Performance core: KINVARA (lightweight), TRIUMPH (max cushion), Endorphin (racing/Speed), PEREGRINE (trail). Sportstyle/heritage: JAZZ ORIGINAL and SHADOW 6000 (retro-running reissues). NO RN IS SEEDED (footwear; none sourced). NO DECODER: the S2xxxx/S1xxxx style number is refused on the adidas-format collision (see the tell). TAG ERAS EMPTY ON PURPOSE — the heritage models are CURRENT reissues, not a dated vintage corpus (the athleisure precedent, 00452).',
   'https://www.saucony.com/', 0.80, false, 'migration:00470'),

  ('stevemadden', 'Steve Madden',
   ARRAY['steve madden','stevemadden','stevemaddens','smadden']::text[],
   ARRAY['fashion sneakers','heeled sandals','boots','loafers','platform shoes','flats']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"Steve Madden is a fashion-footwear house producing broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Steve Madden is high-volume fashion footwear with no per-unit serial and no consumer authentication portal — it is counterfeited, but the guidance is channel-based, not a set of photo tells. Grade condition and route authenticity to human review. Identify by the model NAME printed on the insole/box; the value is trend-driven (the chunky/platform silhouettes) rather than construction-driven."},{"tell":"MADDEN GIRL / STEVE MADDEN are different price tiers","detail":"Madden Girl is a lower-priced juniors diffusion line and comps well below mainline Steve Madden. Read the exact label and do not price a Madden Girl shoe off the Steve Madden ladder; it is left as its own passthrough rather than folded (a comp-accuracy call)."}]$j$::jsonb,
   'Founded 1990 in New York by Steve Madden; a high-volume fashion-footwear house known for on-trend women''s and men''s shoes — chunky/platform sneakers, heeled sandals, boots and loafers that track the season. NO RN IS SEEDED (footwear; none sourced). NO DECODER: the model is a NAME on the insole/box, not a regular tag-printed code. TAG ERAS EMPTY ON PURPOSE — a fashion brand whose value is current-trend, not a dated vintage tag corpus.',
   'https://www.stevemadden.com/', 0.80, false, 'migration:00470'),

  ('samedelman', 'Sam Edelman',
   ARRAY['sam edelman','samedelman','samedelmans']::text[],
   ARRAY['ballet flats','loafers','heels','pumps','boots','sandals']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"Sam Edelman (a Caleres brand) produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Sam Edelman is a contemporary women's fashion-footwear label (part of Caleres) with no per-unit serial and no consumer authentication portal. Grade condition. Identify by the model NAME (Loraine, Felicia, Hazel, Yaro) and the brand's signature hardware; the value is trend/season-driven."},{"tell":"Leather/heel condition is the grade on a fashion flat or heel","detail":"On a ballet flat or a pump the decisive read is the LEATHER (scuffing, creasing at the vamp), the HEEL (heel-tip wear, a scuffed heel) and the SOLE — none of which shows in the standard three-quarter shot. Require a sole/heel photo before pricing."}]$j$::jsonb,
   'Founded 2004 by Sam Edelman (a footwear-industry veteran, co-founder of Sam & Libby); now part of CALERES. Contemporary women''s fashion footwear — signature models include the LORAINE bit loafer, the Felicia ballet flat, the Hazel pump and the Yaro sandal. "Circus by Sam Edelman" is a lower-priced diffusion line (left as its own passthrough, not folded — a comp-accuracy call). NO RN IS SEEDED (footwear; none sourced). NO DECODER: the model is a NAME. TAG ERAS EMPTY ON PURPOSE — a 2004 fashion label with no vintage tag corpus.',
   'https://www.samedelman.com/', 0.80, false, 'migration:00470'),

  ('allenedmonds', 'Allen Edmonds',
   ARRAY['allen edmonds','allenedmonds','allenedmond']::text[],
   ARRAY['dress shoes','oxfords','brogues','loafers','dress boots','goodyear welted']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Older Made-in-USA (Port Washington) labels + script logo","years":"heritage-present (approximate)","description":"COLLECTOR-CORROBORATED, NOT A DATED CHART. Allen Edmonds (founded 1922) has made Goodyear-welted dress shoes in Port Washington, Wisconsin for its whole history, and the Made-in-USA construction is the value core. Older logo/label styles skew vintage but no precise dated chronology is sourced — treat as a coarse prior. The RECRAFTING (factory resole/refurbish) program means a genuine pair may carry a newer sole than its upper; that is not a fake, it is a serviced shoe."}]$j$::jsonb,
   $j$[{"pattern":"USA (Port Washington, Wisconsin) for the core line","note":"Allen Edmonds' flagship dress line is Made in USA; some newer/imported product exists. Made-in-USA is expected on the core Goodyear-welted models and is not, by itself, a precise date tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition + construction; route authenticity to human review","detail":"Allen Edmonds has no per-unit serial and no consumer authentication portal. The durable value read is CONSTRUCTION: the core line is GOODYEAR-WELTED, which is RESOLEABLE and holds value even worn (AE runs a factory RECRAFTING program). The tell is the WELT STITCH at the sole EDGE — require a sole-edge photo; if unphotographed, say the construction is UNCONFIRMED rather than assuming welted."},{"tell":"The SOLE and HEEL are the grade on a dress shoe","detail":"Heel-cap wear, sole thinning at the ball, a broken-down heel counter and vamp creasing decide a dress shoe's grade and none of it appears in the three-quarter product shot. Require a SOLE photo and a HEEL-ON photo, and say the sole is UNSEEN rather than grading the upper and calling it the shoe. A recraftable welted shoe with a worn sole is still valuable; a cemented shoe with a worn sole is not."}]$j$::jsonb,
   'Founded 1922 in Belgium, Wisconsin; makes GOODYEAR-WELTED men''s dress shoes in Port Washington, Wisconsin. Flagship models: PARK AVENUE (cap-toe oxford), STRAND (cap-toe brogue), Fifth Avenue, Dalton (dress boot), Higgins Mill. Sold in US sizes WITH WIDTHS (A narrow → EEE extra wide). The RECRAFTING resole program is a genuine value/authenticity nuance (a newer sole on an older upper is a serviced shoe, not a fake). NO RN IS SEEDED (leather footwear; none sourced). NO DECODER: the model is a NAME and AE uses NAMED LASTS (65, 5, 511, ...) rather than a tag-printed brand-unique code.',
   'https://www.allenedmonds.com/', 0.80, false, 'migration:00470'),

  ('crocs', 'Crocs',
   ARRAY['crocs','crocsinc','crocband','crocsclassic']::text[],
   ARRAY['foam clogs','slides','sandals','flip-flops','work clogs']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore","note":"Crocs are produced broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Crocs are mass-market foam footwear — counterfeited, but the guidance is channel-based, not a set of reliable photo tells; there is no per-unit serial. Grade condition. Identify by the CROSLITE foam clog silhouette and the model (Classic Clog, LiteRide, Bistro, Baya). Note the JIBBITZ charm holes on the Classic Clog — missing charms are not a defect; the shoe ships without them."},{"tell":"The foam is the grade, and it deforms with heat/wear","detail":"Croslite foam SHRINKS and warps with heat and can compress with heavy wear — a heat-shrunk or misshapen clog is a real defect, but ordinary footbed impression is normal wear. Collab/limited drops (the value driver on Crocs) trade on the graphic and the box; grade the condition and never guess the drop."}]$j$::jsonb,
   'Founded 2002 in Boulder, Colorado; the CLASSIC CLOG (a one-piece CROSLITE foam clog with ventilation ports and a heel strap) is the icon, joined by LiteRide, Bistro (work), Baya and the Jibbitz charm ecosystem. ⚠ CROCS ARE DUAL M/W SIZED and run ROOMY (see the size chart): the classic is sold in whole sizes with a "relaxed" fit and dual men''s/women''s numbering. NO RN IS SEEDED (footwear; none sourced). NO DECODER: the model is a NAME. TAG ERAS EMPTY ON PURPOSE — a 2002 brand whose value is current-drop, not a dated vintage tag corpus.',
   'https://www.crocs.com/', 0.80, false, 'migration:00470')
on conflict (brand_key) do update set
  canonical_brand      = excluded.canonical_brand,
  aliases              = excluded.aliases,
  category_focus       = excluded.category_focus,
  registered_numbers   = excluded.registered_numbers,
  tag_eras             = excluded.tag_eras,
  country_patterns     = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells,
  notes                = excluded.notes,
  source_url           = excluded.source_url,
  confidence           = excluded.confidence,
  updated_by           = excluded.updated_by;

-- ── brand_styles ───────────────────────────────────────────────────────────
-- brandPackPromptBlock renders visual_fingerprint VERBATIM into the extract
-- prompt (US-1740). For footwear the highest-value fingerprint is the SILHOUETTE
-- + SOLE cue that separates lookalike models and the "the sole is the grade"
-- instruction, so the style rows lead with those.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- Clarks
  ('clarks', 'Desert Boot', 'Unisex', 'boot', 'Clarks Originals',
   'THE ICON: a 2-eyelet chukka boot in suede (or leather) on a raw natural CREPE (gum) sole, plain toe, minimal stitching. Introduced 1950 by Nathan Clark. ⚠ Separable from the Wallabee by the CLEAN CHUKKA toe (the Wallabee has a moccasin apron seam). The crepe sole yellows/hardens with age — patina, not damage, unless cracked.',
   ARRAY['suede','crepe rubber sole']::text[], '1950-present', '$$',
   ARRAY['desert boot','chukka','crepe sole','clarks originals','beeswax']::text[],
   'https://www.clarks.com/', 0.80, false, 'migration:00470'),
  ('clarks', 'Wallabee', 'Unisex', 'shoe', 'Clarks Originals',
   'A moccasin-construction shoe/boot with a wraparound APRON SEAM over the toe, on a raw crepe sole. ⚠ The moccasin apron is the cue that separates it from the plain-toe Desert Boot. Comes as a low (Wallabee) and a boot (Wallabee Boot). Crepe patina is normal.',
   ARRAY['suede','crepe rubber sole']::text[], '1967-present', '$$',
   ARRAY['wallabee','moccasin','apron toe','crepe sole','clarks originals']::text[],
   'https://www.clarks.com/', 0.80, false, 'migration:00470'),
  ('clarks', 'Desert Trek / Bushacre', 'Men', 'shoe', 'Clarks Originals',
   'The Desert Trek is a moccasin-front derby with a distinctive CENTRE SEAM up the vamp on a crepe sole; Bushacre is a modern chukka. Seeded together as the other recognizable Originals-adjacent silhouettes; comp against the specific model.',
   ARRAY['suede','leather','crepe rubber sole']::text[], 'heritage-present', '$$',
   ARRAY['desert trek','bushacre','centre seam','crepe sole','clarks']::text[],
   'https://www.clarks.com/', 0.60, false, 'migration:00470'),

  -- Merrell
  ('merrell', 'Moab (2 / 3)', 'Unisex', 'shoe', 'Hiking',
   'THE FLAGSHIP hiker ("Mother Of All Boots"): a suede + mesh hiking shoe or mid boot with a Vibram outsole and a bellows tongue. Sold as a low (Moab) and a mid (Moab Mid), waterproof (GTX/WP) or vented. Grade the OUTSOLE tread and midsole; the model name is on the tongue.',
   ARRAY['suede','mesh','Vibram outsole']::text[], 'current', '$$',
   ARRAY['moab','hiking shoe','vibram','mother of all boots','merrell']::text[],
   'https://www.merrell.com/', 0.80, false, 'migration:00470'),
  ('merrell', 'Jungle Moc', 'Unisex', 'shoe', 'Slip-on',
   'The iconic BUNGEE SLIP-ON: a moc-toe slip-on with no laces (a hidden elastic gore), a padded collar and an air-cushion sole. ⚠ Separable from the Moab by the LACELESS slip-on construction. A perennial work/casual seller.',
   ARRAY['leather','suede','air cushion sole']::text[], 'current', '$',
   ARRAY['jungle moc','slip-on','bungee','moc toe','merrell']::text[],
   'https://www.merrell.com/', 0.75, false, 'migration:00470'),
  ('merrell', 'Chameleon', 'Unisex', 'shoe', 'Hiking',
   'A hiking shoe/boot line (Chameleon) with a Vibram outsole; separable from the Moab mostly by the model name on the tongue and the specific tread. Comp against the exact model and generation.',
   ARRAY['suede','mesh','Vibram outsole']::text[], 'current', '$$',
   ARRAY['chameleon','hiking shoe','vibram','merrell']::text[],
   'https://www.merrell.com/', 0.60, false, 'migration:00470'),

  -- KEEN
  ('keen', 'Newport', 'Unisex', 'sandal', 'Hybrid sandal',
   'THE ICON: the closed-toe SPORT SANDAL that defined the hybrid category — a webbing/leather upper with a PROTECTIVE RUBBER TOE BUMP (KEEN''s patented over-toe cap) and a bungee lace. The toe bump is the unmistakable cue. Newport (leather) and Newport H2 (webbing) are the core.',
   ARRAY['leather','polyester webbing','rubber toe bump']::text[], '2003-present', '$$',
   ARRAY['newport','toe bump','sport sandal','keen','h2']::text[],
   'https://www.keenfootwear.com/', 0.80, false, 'migration:00470'),
  ('keen', 'Targhee', 'Unisex', 'shoe', 'Hiking',
   'A hiking shoe/boot (Targhee) with a leather upper, KEEN.DRY membrane options and a protective toe. ⚠ Separable from the Newport by being a CLOSED HIKING SHOE, not a sandal. Grade the outsole; the model is on the tongue/insole.',
   ARRAY['leather','KEEN.DRY membrane','rubber outsole']::text[], 'current', '$$',
   ARRAY['targhee','hiking shoe','keen.dry','keen']::text[],
   'https://www.keenfootwear.com/', 0.70, false, 'migration:00470'),

  -- Sorel
  ('sorel', 'Caribou / 1964 Pac', 'Unisex', 'boot', 'Pac boots',
   'THE HERITAGE ICON: an insulated winter PAC BOOT — a waterproof rubber SHELL lower, a leather (Caribou) or nylon (1964 Pac) upper, and a REMOVABLE FELT LINER. ⚠ The removable liner is part of the product: a missing/matted liner is a defect. Check the rubber shell for cracking at the flex point.',
   ARRAY['waterproof rubber shell','leather','removable felt liner']::text[], 'heritage-present', '$$',
   ARRAY['caribou','1964 pac','pac boot','felt liner','sorel']::text[],
   'https://www.sorel.com/', 0.80, false, 'migration:00470'),
  ('sorel', 'Joan of Arctic', 'Women', 'boot', 'Fashion winter',
   'The women''s FASHION winter boot: a tall, faux-fur-cuffed wedge/lug winter boot. ⚠ This is the FASHION line, NOT the technical Caribou pac boot — it comps separately. Joan of Arctic (tall) and the Joan of Arctic Wedge (a wedge bootie) are the recognizable silhouettes.',
   ARRAY['waterproof suede/leather','faux fur','felt/wedge']::text[], 'current', '$$',
   ARRAY['joan of arctic','wedge','fashion winter boot','sorel']::text[],
   'https://www.sorel.com/', 0.75, false, 'migration:00470'),
  ('sorel', 'Kinetic / Out N About', 'Women', 'shoe', 'Sneaker-wedge',
   'The modern sneaker-adjacent line: Kinetic (a sneaker with a wedge/lug sole) and Out N About (a rain-boot bootie). Seeded so the fashion line is not folded onto the pac boot; comp against the model, not the Caribou ladder.',
   ARRAY['leather','textile','molded EVA/rubber']::text[], 'current', '$$',
   ARRAY['kinetic','out n about','wedge sneaker','sorel']::text[],
   'https://www.sorel.com/', 0.60, false, 'migration:00470'),

  -- Brooks
  ('brooks', 'Ghost', 'Unisex', 'shoe', 'Neutral running',
   'THE core NEUTRAL daily trainer: a cushioned road-running shoe (DNA Loft midsole) with an engineered-mesh upper, numbered by generation (Ghost 15, 16...). ⚠ Neutral — separable from the Adrenaline GTS by the ABSENCE of GuideRails support. Grade the OUTSOLE + midsole (a clean upper can hide a dead midsole). The model name is on the shoe.',
   ARRAY['engineered mesh','DNA Loft midsole']::text[], 'current', '$$',
   ARRAY['ghost','neutral','daily trainer','dna loft','brooks']::text[],
   'https://www.brooksrunning.com/', 0.80, false, 'migration:00470'),
  ('brooks', 'Adrenaline GTS', 'Unisex', 'shoe', 'Support running',
   'The core SUPPORT/stability trainer: GuideRails holistic support, numbered by generation. ⚠ Looks near-identical to the neutral Ghost in a photo — the GTS / GuideRails distinction is the model, read it off the shoe, do not infer support from the silhouette. Grade on mileage (sole + midsole).',
   ARRAY['engineered mesh','DNA Loft midsole','GuideRails']::text[], 'current', '$$',
   ARRAY['adrenaline','gts','guiderails','support','brooks']::text[],
   'https://www.brooksrunning.com/', 0.80, false, 'migration:00470'),
  ('brooks', 'Glycerin', 'Unisex', 'shoe', 'Max-cushion running',
   'The MAX-CUSHION neutral trainer (DNA Loft/DNA Tuned), plusher than the Ghost, numbered by generation. Separable from the Ghost mostly by the taller/softer midsole stack and the model name. Grade on mileage.',
   ARRAY['engineered mesh','DNA Loft/Tuned midsole']::text[], 'current', '$$',
   ARRAY['glycerin','max cushion','neutral','brooks']::text[],
   'https://www.brooksrunning.com/', 0.65, false, 'migration:00470'),

  -- Saucony
  ('saucony', 'Kinvara', 'Unisex', 'shoe', 'Lightweight running',
   'The heritage LIGHTWEIGHT daily trainer (low drop, PWRRUN midsole), numbered by generation. A perennial performance seller. Grade on mileage (sole + midsole); the model is on the shoe.',
   ARRAY['mesh','PWRRUN midsole']::text[], 'current', '$$',
   ARRAY['kinvara','lightweight','low drop','pwrrun','saucony']::text[],
   'https://www.saucony.com/', 0.75, false, 'migration:00470'),
  ('saucony', 'Triumph', 'Unisex', 'shoe', 'Max-cushion running',
   'The MAX-CUSHION neutral trainer (PWRRUN+ midsole), numbered by generation. Separable from the lightweight Kinvara by the taller/softer stack. Grade on mileage.',
   ARRAY['engineered mesh','PWRRUN+ midsole']::text[], 'current', '$$',
   ARRAY['triumph','max cushion','pwrrun','saucony']::text[],
   'https://www.saucony.com/', 0.70, false, 'migration:00470'),
  ('saucony', 'Jazz Original / Shadow 6000', 'Unisex', 'shoe', 'Sportstyle',
   '⚠ THE SPORTSTYLE reissues, graded as FASHION sneakers not performance: the Jazz Original (a suede/nylon retro-running low with the S logo) and the Shadow 6000 (a chunkier retro-runner). Comp against the sportstyle market, not the running-shoe ladder.',
   ARRAY['suede','nylon']::text[], 'heritage-reissue', '$$',
   ARRAY['jazz original','shadow 6000','sportstyle','retro runner','saucony']::text[],
   'https://www.saucony.com/', 0.65, false, 'migration:00470'),

  -- Steve Madden
  ('stevemadden', 'Platform / Chunky Sneaker', 'Women', 'sneaker', 'Fashion sneakers',
   'Steve Madden''s signature trend footwear: chunky/PLATFORM sneakers (Maxima and the dad-shoe silhouettes). Trend-driven; identify by the model NAME on the insole. Grade condition; value tracks the current silhouette.',
   ARRAY['synthetic','leather','platform sole']::text[], 'current', '$$',
   ARRAY['platform sneaker','chunky','maxima','steve madden']::text[],
   'https://www.stevemadden.com/', 0.65, false, 'migration:00470'),
  ('stevemadden', 'Heeled Sandal / Boot', 'Women', 'shoe', 'Fashion',
   'The other core Steve Madden categories: on-trend heeled sandals and boots. Read the model NAME off the insole; grade the leather/heel and sole. Value is season/trend-driven.',
   ARRAY['leather','synthetic']::text[], 'current', '$$',
   ARRAY['heeled sandal','boot','steve madden','fashion']::text[],
   'https://www.stevemadden.com/', 0.55, false, 'migration:00470'),

  -- Sam Edelman
  ('samedelman', 'Loraine Loafer', 'Women', 'shoe', 'Loafers',
   'A signature Sam Edelman model: the LORAINE bit loafer (a horsebit-hardware penny/bit loafer). Identify by the bit hardware + the model name; grade the leather, the heel and the sole (require a sole/heel photo).',
   ARRAY['leather']::text[], 'current', '$$',
   ARRAY['loraine','bit loafer','horsebit','sam edelman']::text[],
   'https://www.samedelman.com/', 0.70, false, 'migration:00470'),
  ('samedelman', 'Felicia Flat / Hazel Pump', 'Women', 'shoe', 'Flats & heels',
   'Two core models seeded together: the FELICIA ballet flat (a pointed-toe scrunch flat) and the HAZEL pump (a pointed-toe stiletto). Distinct silhouettes; read the model name and grade the leather/heel/sole.',
   ARRAY['leather','suede']::text[], 'current', '$$',
   ARRAY['felicia','hazel','ballet flat','pump','sam edelman']::text[],
   'https://www.samedelman.com/', 0.60, false, 'migration:00470'),

  -- Allen Edmonds
  ('allenedmonds', 'Park Avenue', 'Men', 'shoe', 'Dress oxfords',
   'THE FLAGSHIP: a CAP-TOE OXFORD on a Goodyear welt, closed lacing, made in USA. ⚠ Separable from the Strand by the PLAIN cap toe (the Strand''s cap is BROGUED/perforated). The value is in the welt (resoleable) — require a SOLE-EDGE photo to confirm construction and a sole/heel photo for wear.',
   ARRAY['calf leather','Goodyear welt','leather sole']::text[], 'heritage-present', '$$$',
   ARRAY['park avenue','cap toe','oxford','goodyear welt','allen edmonds']::text[],
   'https://www.allenedmonds.com/', 0.80, false, 'migration:00470'),
  ('allenedmonds', 'Strand', 'Men', 'shoe', 'Dress brogues',
   'A CAP-TOE BROGUE oxford: the Park Avenue silhouette with a PERFORATED/pinked cap-toe wingtip detail. ⚠ The brogueing is the cue that separates it from the plain-cap Park Avenue. Goodyear-welted, resoleable; grade the sole/heel.',
   ARRAY['calf leather','Goodyear welt','leather sole']::text[], 'current', '$$$',
   ARRAY['strand','cap toe brogue','oxford','goodyear welt','allen edmonds']::text[],
   'https://www.allenedmonds.com/', 0.75, false, 'migration:00470'),
  ('allenedmonds', 'Fifth Avenue / Dalton', 'Men', 'shoe', 'Dress',
   'Fifth Avenue = a plain-toe blucher/derby dress shoe; Dalton = a wingtip dress BOOT. Two distinct silhouettes seeded together so a photo grades to the right model; both Goodyear-welted. Grade the sole/heel.',
   ARRAY['calf leather','Goodyear welt','leather sole']::text[], 'current', '$$$',
   ARRAY['fifth avenue','dalton','dress boot','goodyear welt','allen edmonds']::text[],
   'https://www.allenedmonds.com/', 0.60, false, 'migration:00470'),

  -- Crocs
  ('crocs', 'Classic Clog', 'Unisex', 'shoe', 'Foam clogs',
   'THE ICON: the one-piece CROSLITE foam CLOG with ventilation ports, a pivoting heel strap and Jibbitz charm holes. ⚠ Runs ROOMY, dual M/W sized, whole sizes. Missing charms are not a defect. Grade for heat-shrink/warping and footbed wear.',
   ARRAY['Croslite foam']::text[], '2002-present', '$',
   ARRAY['classic clog','croslite','clog','jibbitz','crocs']::text[],
   'https://www.crocs.com/', 0.80, false, 'migration:00470'),
  ('crocs', 'LiteRide / Bistro', 'Unisex', 'shoe', 'Foam',
   'LiteRide = a softer, sneaker-adjacent foam line (clogs and slides); Bistro = the enclosed-top WORK clog (no ventilation ports, a slip-resistant sole). Seeded so a photo grades to the right model; comp against the specific line.',
   ARRAY['LiteRide foam','Croslite foam']::text[], 'current', '$',
   ARRAY['literide','bistro','work clog','crocs']::text[],
   'https://www.crocs.com/', 0.60, false, 'migration:00470')
on conflict (brand_key, style_name, department) do update set
  category           = excluded.category,
  product_line       = excluded.product_line,
  visual_fingerprint = excluded.visual_fingerprint,
  fabric_tech        = excluded.fabric_tech,
  era                = excluded.era,
  msrp_band          = excluded.msrp_band,
  keywords           = excluded.keywords,
  source_url         = excluded.source_url,
  confidence         = excluded.confidence,
  updated_by         = excluded.updated_by;

-- ── brand_colorways ────────────────────────────────────────────────────────
-- ONE BRAND QUALIFIES. Clarks Originals uses a small set of DURABLE, proprietary
-- named suede/leather colours (Beeswax, Sand, Cola, Oakwood) that recur across the
-- Desert Boot / Wallabee for decades and are searched BY NAME — a true internal
-- palette (the UGG Chestnut / Dr. Martens Cherry Red precedent, 00459). The other
-- nine ship ordinary descriptive colour words that rotate per season and form no
-- stable dictionary, so none are seeded (the 00456/00462 rule — a colour table is
-- only for a proprietary NAMED palette, not for ordinary words).
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('clarks', 'Beeswax', ARRAY[]::text[], null,
   'The classic Clarks Originals LEATHER colour — a warm tan/amber waxed leather, the iconic Desert Boot finish. A proprietary NAMED colourway searched by name, checkable by eye against the photo.',
   'https://www.clarks.com/', 0.75, false, 'migration:00470'),
  ('clarks', 'Sand Suede', ARRAY['sand']::text[], null,
   'The classic Desert Boot SUEDE colour — a pale sand/oatmeal suede. A durable named Originals finish.',
   'https://www.clarks.com/', 0.75, false, 'migration:00470'),
  ('clarks', 'Cola', ARRAY['cola suede']::text[], null,
   'A dark brown suede Originals colourway (Desert Boot / Wallabee). Named and durable across seasons.',
   'https://www.clarks.com/', 0.70, false, 'migration:00470'),
  ('clarks', 'Oakwood', ARRAY['oakwood suede']::text[], null,
   'A mid-brown suede Originals colourway. Named and durable.',
   'https://www.clarks.com/', 0.65, false, 'migration:00470')
on conflict (brand_key, color_name) do update set
  aliases    = excluded.aliases,
  hex        = excluded.hex,
  years      = excluded.years,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  updated_by = excluded.updated_by;

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- THE STORY'S KEY SIGNAL ("US/UK/EU size system"), and the reason these charts
-- are shaped like 00459's rather than a garment chart: a shoe's size is STAMPED,
-- not measured, so these are TRANSLATORS (brand number → every other system) and
-- the cross-map lives INSIDE the size label where the model reads it. The
-- foot-length inches are a sanity check for a shoe in hand, not the primary path.
-- Body-equivalent approximations, not brand-published specs — hence the modest
-- confidence. formatSizingChartsForPrompt renders labels + note IN FULL (US-1740),
-- so the fit caveats live in the note.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  -- Clarks — UK brand, letter WIDTH FITTINGS (G/H). Unisex dual-department rows.
  ('clarks', 'Clarks', ARRAY['clarks']::text[], 'Unisex',
   'Footwear (US/UK/EU + letter width fittings)',
   ARRAY['shoe','shoes','footwear','boot','desert boot','wallabee','loafer','sandal']::text[],
   $j$[{"size":"UK 6 = US M7 / US W8.5 = EU 39.5","measurements":{"footLength":"9.6"}},{"size":"UK 7 = US M8 / US W9.5 = EU 41","measurements":{"footLength":"9.95"}},{"size":"UK 8 = US M9 / US W10.5 = EU 42","measurements":{"footLength":"10.3"}},{"size":"UK 9 = US M10 / US W11.5 = EU 43","measurements":{"footLength":"10.6"}},{"size":"UK 10 = US M11 = EU 44.5","measurements":{"footLength":"10.95"}},{"size":"UK 11 = US M12 = EU 46","measurements":{"footLength":"11.25"}},{"size":"UK 12 = US M13 = EU 47","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   'CLARKS IS A UK BRAND and much of its stock is UK-stamped; the US market uses US medium numbering, so read the label carefully and state the UK number for the buyer to check. THE WIDTH IS A LETTER FITTING, not a US-style letter: G = standard, H = wide (and D/E/F narrower on some lines) — Clarks'' own fitting system, printed beside the size on UK stock. THE SIZE IS STAMPED, NOT MEASURED. The US<->UK<->EU conversions are approximate and the men''s/women''s split is written into each label because a Clarks shoe is often unisex-referenced. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.clarks.com/', 0.55, false, 'migration:00470'),

  -- Merrell — US hiking sizing, men + women split by chart.
  ('merrell', 'Merrell', ARRAY['merrell']::text[], 'Men',
   'Footwear (US/UK/EU — hiking, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','boot','hiking','moab','trail','sneaker','sneaker']::text[],
   $j$[{"size":"US M8 = UK 7.5 = EU 41.5","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8.5 = EU 43","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9.5 = EU 44.5","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10.5 = EU 45.5","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11.5 = EU 46.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12.5 = EU 48","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   'Merrell men''s hikers use US numbering; the US<->UK<->EU conversions are approximate. WIDTHS: Merrell offers a WIDE (W) width on many hikers — read it off the tongue label and put it in the listing. THE SIZE IS STAMPED, NOT MEASURED — read it off the tongue/insole. The OUTSOLE is the grade on a hiking shoe (worn lugs, packed-out midsole) and needs a sole photo. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.merrell.com/', 0.55, false, 'migration:00470'),
  ('merrell', 'Merrell', ARRAY['merrell']::text[], 'Women',
   'Footwear (US/UK/EU — hiking, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','boot','hiking','moab','trail','sneaker']::text[],
   $j$[{"size":"US W6 = UK 4 = EU 37","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 5 = EU 38","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 6 = EU 39","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 7 = EU 40.5","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 8 = EU 41.5","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 9 = EU 43","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   'Merrell women''s hikers use US numbering; the US<->UK<->EU conversions are approximate. WIDTHS: a WIDE (W) width is offered on many models — read it off the tongue label. THE SIZE IS STAMPED, NOT MEASURED. The OUTSOLE + midsole are the grade and need a sole photo. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.merrell.com/', 0.55, false, 'migration:00470'),

  -- KEEN — US, runs roomy. Men + Women.
  ('keen', 'KEEN', ARRAY['keen']::text[], 'Men',
   'Footwear (US/UK/EU — RUNS ROOMY, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','sandal','boot','newport','targhee','hiking']::text[],
   $j$[{"size":"US M8 = UK 7 = EU 41","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8 = EU 42","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9 = EU 43","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10 = EU 44","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11 = EU 45","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12 = EU 46","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   '⚠ KEEN RUNS ROOMY / WIDE in the toe box by design — common guidance is that some models fit large, so report the STAMPED size plus the runs-roomy note rather than adjusting the number. US numbering; the US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED — read it off the footbed/label. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.keenfootwear.com/', 0.55, false, 'migration:00470'),
  ('keen', 'KEEN', ARRAY['keen']::text[], 'Women',
   'Footwear (US/UK/EU — RUNS ROOMY, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','sandal','boot','newport','targhee','hiking']::text[],
   $j$[{"size":"US W6 = UK 3.5 = EU 36.5","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 4.5 = EU 37.5","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 5.5 = EU 38.5","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 6.5 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 7.5 = EU 41","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 8.5 = EU 42","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   '⚠ KEEN RUNS ROOMY / WIDE in the toe box by design — report the STAMPED size plus the runs-roomy note rather than adjusting it. US numbering; the US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.keenfootwear.com/', 0.55, false, 'migration:00470'),

  -- Sorel — US winter boots. Women (fashion-led) + Men.
  ('sorel', 'Sorel', ARRAY['sorel']::text[], 'Women',
   'Footwear (US/UK/EU — winter boots, the size is STAMPED)',
   ARRAY['boot','boots','shoe','shoes','footwear','wedge','caribou','joan of arctic','kinetic']::text[],
   $j$[{"size":"US W6 = UK 4 = EU 37","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 5 = EU 38","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 6 = EU 39","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 7 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 8 = EU 41","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 9 = EU 42","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   'Sorel women''s boots use US numbering; the US<->UK<->EU conversions are approximate. ⚠ TWO DIFFERENT PRODUCTS SHARE THIS BRAND: the technical CARIBOU pac boot (with a removable felt liner — a missing/matted liner is a defect) and the FASHION line (Joan of Arctic wedge, Kinetic) — they comp SEPARATELY, so read the model. Winter pac boots are often bought with room for thick socks. THE SIZE IS STAMPED, NOT MEASURED. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.sorel.com/', 0.55, false, 'migration:00470'),
  ('sorel', 'Sorel', ARRAY['sorel']::text[], 'Men',
   'Footwear (US/UK/EU — winter boots, the size is STAMPED)',
   ARRAY['boot','boots','shoe','shoes','footwear','caribou','1964 pac','pac']::text[],
   $j$[{"size":"US M8 = UK 7 = EU 41","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8 = EU 42.5","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9 = EU 44","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10 = EU 45","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11 = EU 46.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12 = EU 48","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   'Sorel men''s pac boots use US numbering; the US<->UK<->EU conversions are approximate. ⚠ THE REMOVABLE FELT LINER on the Caribou/1964 pac boots is part of the product — a missing/matted liner is a real defect; check for cracking at the rubber shell flex point. Often bought with room for thick socks. THE SIZE IS STAMPED, NOT MEASURED. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.sorel.com/', 0.55, false, 'migration:00470'),

  -- Brooks — US running sizing. Men + Women. brandMatch "brooks" (see the note).
  ('brooks', 'Brooks', ARRAY['brooks']::text[], 'Men',
   'Footwear (US/UK/EU — running, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','running','ghost','adrenaline','glycerin','trainer','sneaker']::text[],
   $j$[{"size":"US M8 = UK 7 = EU 41.5","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8 = EU 42.5","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9 = EU 44","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10 = EU 45","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11 = EU 46.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12 = EU 47.5","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   '⚠ THIS IS BROOKS RUNNING, NOT BROOKS BROTHERS — a different company (findSizingCharts matches "brooks" as a leading word, but Brooks Brothers charts match the longer "brooks brothers" and category narrowing separates the two). Brooks running shoes use US numbering; the US<->UK<->EU conversions are approximate. WIDTHS: Brooks offers Narrow (B/2A), Medium (D), Wide (2E) and Extra-Wide (4E) on many models — read the width off the tongue label. THE SIZE IS STAMPED, NOT MEASURED, and a running shoe is graded on MILEAGE (outsole + midsole) — require a sole photo. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.brooksrunning.com/', 0.55, false, 'migration:00470'),
  ('brooks', 'Brooks', ARRAY['brooks']::text[], 'Women',
   'Footwear (US/UK/EU — running, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','running','ghost','adrenaline','glycerin','trainer','sneaker']::text[],
   $j$[{"size":"US W6 = UK 3.5 = EU 36.5","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 4.5 = EU 38","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 5.5 = EU 39","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 6.5 = EU 40.5","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 7.5 = EU 42","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 8.5 = EU 43","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   '⚠ THIS IS BROOKS RUNNING, NOT BROOKS BROTHERS. Brooks women''s running shoes use US numbering; the US<->UK<->EU conversions are approximate. WIDTHS: Narrow (2A), Medium (B), Wide (D) and Extra-Wide (2E) are offered on many models — read the width off the tongue label. THE SIZE IS STAMPED, NOT MEASURED, and the shoe is graded on MILEAGE (outsole + midsole) — require a sole photo. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.brooksrunning.com/', 0.55, false, 'migration:00470'),

  -- Saucony — US running sizing. Men + Women.
  ('saucony', 'Saucony', ARRAY['saucony']::text[], 'Men',
   'Footwear (US/UK/EU — running, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','running','kinvara','triumph','peregrine','jazz','shadow','sneaker']::text[],
   $j$[{"size":"US M8 = UK 7 = EU 41","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8 = EU 42.5","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9 = EU 44","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10 = EU 45","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11 = EU 46.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12 = EU 47.5","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   'Saucony men''s running shoes use US numbering; the US<->UK<->EU conversions are approximate. WIDTHS: a WIDE (2E) width is offered on many models — read it off the tongue label. ⚠ THE STYLE NUMBER (S2xxxx) IS NOT A DECODER — it collides with adidas''s style-code format; identify by the model NAME. THE SIZE IS STAMPED, NOT MEASURED, and a running shoe is graded on MILEAGE — require a sole photo. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.saucony.com/', 0.55, false, 'migration:00470'),
  ('saucony', 'Saucony', ARRAY['saucony']::text[], 'Women',
   'Footwear (US/UK/EU — running, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','running','kinvara','triumph','peregrine','jazz','shadow','sneaker']::text[],
   $j$[{"size":"US W6 = UK 4 = EU 37","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 5 = EU 38","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 6 = EU 39","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 7 = EU 40.5","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 8 = EU 42","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 9 = EU 43","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   'Saucony women''s running shoes use US numbering; the US<->UK<->EU conversions are approximate. WIDTHS: a WIDE (D on women''s) width is offered on many models — read it off the tongue label. ⚠ THE STYLE NUMBER (S1xxxx) IS NOT A DECODER — identify by the model NAME. THE SIZE IS STAMPED, NOT MEASURED, and the shoe is graded on MILEAGE — require a sole photo. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.saucony.com/', 0.55, false, 'migration:00470'),

  -- Steve Madden — US women's fashion sizing.
  ('stevemadden', 'Steve Madden', ARRAY['steve madden','stevemadden']::text[], 'Women',
   'Footwear (US/UK/EU — women''s fashion, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','sneaker','sandal','heel','boot','bootie','platform','loafer','flat']::text[],
   $j$[{"size":"US W6 = UK 3.5 = EU 36","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 4.5 = EU 37.5","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 5.5 = EU 38.5","measurements":{"footLength":"9.5"}},{"size":"US W8.5 = UK 6 = EU 39","measurements":{"footLength":"9.7"}},{"size":"US W9 = UK 6.5 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 7.5 = EU 41","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 8.5 = EU 42","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   'Steve Madden women''s fashion footwear uses US numbering; the US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole. Read the MODEL name off the insole/box. On a heel/sandal the HEEL and SOLE are the grade (heel-tip wear, scuffing) and need a sole/heel photo. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.stevemadden.com/', 0.55, false, 'migration:00470'),

  -- Sam Edelman — US women's fashion sizing.
  ('samedelman', 'Sam Edelman', ARRAY['sam edelman','samedelman']::text[], 'Women',
   'Footwear (US/UK/EU — women''s fashion, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','flat','loafer','heel','pump','sandal','boot','bootie']::text[],
   $j$[{"size":"US W6 = UK 3.5 = EU 36","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 4.5 = EU 37.5","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 5.5 = EU 38.5","measurements":{"footLength":"9.5"}},{"size":"US W8.5 = UK 6 = EU 39","measurements":{"footLength":"9.7"}},{"size":"US W9 = UK 6.5 = EU 40","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 7.5 = EU 41","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 8.5 = EU 42","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   'Sam Edelman women''s fashion footwear uses US numbering; the US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole. Read the MODEL name (Loraine, Felicia, Hazel, Yaro). On a flat/loafer/heel the LEATHER, HEEL and SOLE are the grade (vamp creasing, heel-tip wear) and need a sole/heel photo. Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.samedelman.com/', 0.55, false, 'migration:00470'),

  -- Allen Edmonds — US men's dress sizing + widths (like Cole Haan, 00459).
  ('allenedmonds', 'Allen Edmonds', ARRAY['allen edmonds','allenedmonds']::text[], 'Men',
   'Footwear (US/UK/EU + width — dress, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','dress shoe','oxford','loafer','wingtip','brogue','boot','park avenue','strand']::text[],
   $j$[{"size":"US M8 = UK 7.5 = EU 41","measurements":{"footLength":"9.95"}},{"size":"US M8.5 = UK 8 = EU 41.5","measurements":{"footLength":"10.1"}},{"size":"US M9 = UK 8.5 = EU 42","measurements":{"footLength":"10.3"}},{"size":"US M9.5 = UK 9 = EU 42.5","measurements":{"footLength":"10.45"}},{"size":"US M10 = UK 9.5 = EU 43","measurements":{"footLength":"10.6"}},{"size":"US M10.5 = UK 10 = EU 44","measurements":{"footLength":"10.8"}},{"size":"US M11 = UK 10.5 = EU 44.5","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11.5 = EU 45.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12.5 = EU 47","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   'US men''s dress sizing PLUS WIDTHS (A/AA narrow -> B -> D standard -> E -> EEE extra wide) — the width is stamped beside the size and belongs in the listing. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole. ⚠ THE CONSTRUCTION SETS THE VALUE: the core line is GOODYEAR-WELTED and therefore RESOLEABLE (Allen Edmonds runs a RECRAFTING program), so a welted pair with a worn sole is still valuable — the tell is the WELT STITCH at the sole EDGE and it needs a SOLE-EDGE photo; if unphotographed say the construction is UNCONFIRMED. THE SOLE AND HEEL ARE THE GRADE (heel-cap wear, sole thinning, a broken-down heel counter, vamp creasing) and none of it shows in the three-quarter shot — require a sole photo and a heel-on photo and say the sole is UNSEEN rather than grading the upper. A recrafted pair (newer sole, older upper) is a serviced shoe, not a fake. Body-equivalent approximations, not brand-published specs.',
   'https://www.allenedmonds.com/', 0.55, false, 'migration:00470'),

  -- Crocs — dual M/W, runs large, whole sizes. Unisex.
  ('crocs', 'Crocs', ARRAY['crocs']::text[], 'Unisex',
   'Footwear (dual US M/W — RUNS LARGE / roomy, whole sizes)',
   ARRAY['clog','shoe','shoes','footwear','sandal','slide','classic clog','literide','bistro']::text[],
   $j$[{"size":"M4 / W6 = UK 3 = EU 36-37","measurements":{"footLength":"8.75"}},{"size":"M5 / W7 = UK 4 = EU 37-38","measurements":{"footLength":"9.1"}},{"size":"M6 / W8 = UK 5 = EU 38-39","measurements":{"footLength":"9.45"}},{"size":"M7 / W9 = UK 6 = EU 39-40","measurements":{"footLength":"9.8"}},{"size":"M8 / W10 = UK 7 = EU 41-42","measurements":{"footLength":"10.15"}},{"size":"M9 / W11 = UK 8 = EU 42-43","measurements":{"footLength":"10.5"}},{"size":"M10 / W12 = UK 9 = EU 43-44","measurements":{"footLength":"10.85"}},{"size":"M11 = UK 10 = EU 45","measurements":{"footLength":"11.2"}},{"size":"M12 = UK 11 = EU 46-47","measurements":{"footLength":"11.55"}}]$j$::jsonb,
   'CROCS DUAL-TAGS men''s AND women''s on ONE label (a Crocs "M8 / W10" is one size), in WHOLE SIZES ONLY — there is no half-size run on the Classic Clog, which is exactly why the EU column here is a RANGE. ⚠ CROCS RUN LARGE / ROOMY — the classic has a "relaxed" fit; report the stamped size plus the runs-roomy note rather than adjusting it. THE SIZE IS STAMPED, NOT MEASURED — read the M/W numbers off the strap/footbed. The FOAM is the grade: heat-shrink/warping and a heavily compressed footbed are defects; missing Jibbitz charms are NOT (the shoe ships without them). Foot-length inches are a sanity check. Body-equivalent approximations, not brand-published specs.',
   'https://www.crocs.com/', 0.55, false, 'migration:00470')
on conflict (brand_key, department, garment) do update set
  brand_label    = excluded.brand_label,
  brand_match    = excluded.brand_match,
  category_match = excluded.category_match,
  rows           = excluded.rows,
  note           = excluded.note,
  source_url     = excluded.source_url,
  confidence     = excluded.confidence,
  updated_by     = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00470') on conflict do nothing;
