-- US-1989: Heritage & workwear brand knowledge (8 brands).
--
-- Dickies, Filson, Red Wing, Timberland, Duluth Trading Co., Pendleton, Barbour,
-- Orvis. Six were passthrough-only; DICKIES and PENDLETON carried only the
-- SHALLOW alias-only rows from 00389 (seed:brand-normalize.ts, verified) and are
-- PROMOTED to full packs here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS GROUP HANGS TOGETHER: THE TAG IS THE ASSET.
--
--   FOR A HERITAGE / WORKWEAR PIECE, THE TAG-ERA IS THE SINGLE LARGEST PRICE
--   DRIVER — a 1960s Pendleton board shirt or a Made-in-USA vintage Filson
--   Cruiser is worth a multiple of its modern equivalent, and the ONLY thing that
--   separates them in a photo is the interior LABEL.
--
-- That inverts the accessory group one pack over (00468), where a bag carried
-- LESS recoverable information than a garment. Here the garment carries MORE than
-- its modern retail spec: it carries its own DATE. So this pack's centre of
-- gravity is `tag_eras`, and the honest limit is stated per brand — a documented,
-- label-specific chronology exists for Pendleton, Barbour, Filson, Red Wing,
-- Timberland and Dickies, and DOES NOT for Duluth Trading (founded 1989, a modern
-- catalogue brand with no vintage tag corpus) or Orvis (a 1856 house, but not a
-- tag-dated resale category). Empty `tag_eras` on those two is CORRECT, not a
-- gap — the same call the athleisure pack (00452) made for Alo/Athleta.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE DECODER — **BARBOUR**, AND IT IS THE ONLY BRAND HERE WHOSE STYLE CODE
-- CLEARS THE BAR (00460): tag-printed AND regular AND brand-unique in FORMAT.
--
--   * BARBOUR `MWX0018` / `LWX0667` / `MQU0281` — the interior label of a Barbour
--     jacket carries the style code alongside the colour and size, and the format
--     is [M|L] + a 2-letter LINE code + 4 digits: M = men's, L = ladies'; WX =
--     WaX, QU = QUilt, CA = CAsual/cotton, KN = KNitwear, TN = Tailored. MWX0018 =
--     Bedale, MWX0017 = Beaufort, LWX0667 = Beadnell, MQU0281 = Powell. THE
--     DEPARTMENT LETTER IS THE WHOLE ARGUMENT — the exact Canada Goose case
--     (00460): a bare "0018" is four digits and is nothing (the Chanel rule,
--     US-1736), but "MWX0018" can only be a Barbour code. The M/L letter is
--     captured INSIDE styleCode and NOT mapped to a gender field: the shared
--     genderCode transform maps only W/M, so a captured "L" for LADIES' would emit
--     a raw "L" as a gender — so, like Canada Goose (00460) and Peter Millar
--     (00467), the decoder captures styleCode and documents M/L in prose only.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE REFUSALS ARE THE REST OF THE DELIVERABLE (all fixtured as negatives in
-- brand-knowledge-golden_test.ts — a refusal that isn't tested is a comment).
-- These are the BOOT/WORKWEAR brands whose "style number" is the household name
-- of the model, and each fails the SAME clause of the bar — it is a BARE DIGIT
-- RUN, so a pattern over it mints a false positive from any number on any tag
-- (the Chanel rule, US-1736; the Lee "101" rule, 00393):
--
--   * DICKIES `874` — the iconic Original Fit work pant, printed on the tag. But
--     "874" is three digits and is nothing on its own (and Dickies' own line runs
--     bare numbers like 874/85283/1922 AND prefixed ones like WP314/LP700, with no
--     single regular brand-unique shape). It is an excellent LISTING token and is
--     recorded as a style; it is not a decoder.
--   * RED WING `875` / `8875` / `9011` / `8111` / `3335` — the Heritage line's
--     4-digit style numbers ARE its canonical identifiers and appear on the box +
--     a paper tag, but a bare 3-4 digit run is exactly the costliest false
--     positive. Seeded as styles; refused as a decoder.
--   * TIMBERLAND `10061` — THE Original Yellow Boot, and the number is genuinely
--     the model's identity, but five bare digits is nothing. (Modern Timberland
--     SKUs carry a brand-unique `TB0…` prefix, but no source puts that prefix on a
--     PHYSICAL tag in a regular readable way — it is a web/box SKU — so it is a
--     listing token, not a decoder. The 00468 rule: physical presence is
--     necessary, and it is not established here.)
--   * FILSON / DULUTH / ORVIS / PENDLETON — plain web/catalogue SKUs with no
--     evidence of a regular tag-printed brand-unique format.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PACK'S HEADLINE REFUSAL: **A BARE "duluth" IS NOT DULUTH TRADING.**
--
-- This is the group's Longchamp-Fabrics trap (00468): a string that matches, a
-- real entity, and the WRONG company. "Duluth" alone is a Minnesota city AND
-- DULUTH PACK (est. 1882 — a SEPARATE, unrelated maker of waxed-canvas portage
-- packs and bags), while DULUTH TRADING CO. is a 1989 workwear catalogue brand.
-- Folding a bare "duluth" onto Duluth Trading would silently retitle a Duluth
-- Pack canoe pack as a Fire Hose work-pant company. Only "duluth trading" /
-- "duluthtrading" are aliased; a bare "duluth" passes through. Fixtured.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REGISTERED NUMBERS: NONE ARE SEEDED, AND THE REASON IS A REFUSAL, NOT A GAP.
-- Unlike the handbag pack (00468), these ARE textile products, so RNs genuinely
-- EXIST for them (a Made-in-USA Filson or Pendleton wool shirt carries one on the
-- care label). But an RN is a per-COMPANY federal registrant number, and none
-- could be sourced to a primary FTC record with confidence — and fabricating one
-- is the single most dangerous act in this KB (the RN 17257 lesson, 00468: a real
-- federal record for the WRONG company reads as an authoritative lie). So RN is
-- left EMPTY with the reason recorded, and the physical-tell weight goes to
-- `tag_eras` instead, which is where the value lives for this group anyway. This
-- is owed work for the US-1715 queue, flagged, not faked.
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00468
-- convention). Confidence is DELIBERATELY UNEVEN: a brand-published spec is
-- ~0.8; a collector-corroborated tag chronology is ~0.6 and says so in its note.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('dickies', 'Dickies',
   ARRAY['dickies','williamsondickie','williamsondickies','dickiesworkwear','dickies1922','dickiesgirl']::text[],
   ARRAY['work pants','work shirts','coveralls','bib overalls','duck jackets','industrial workwear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Vintage \"Williamson-Dickie Mfg. Co.\" union labels","years":"mid-20th century (approximate)","description":"⚠ COLLECTOR-CORROBORATED, NOT BRAND-PUBLISHED — treat as orientation. The company traded as Williamson-Dickie Manufacturing Co. of Fort Worth, Texas from 1922 until the 2017 VF Corporation acquisition, and the oldest tags read \"Williamson-Dickie\" rather than the modern standalone \"Dickies\" wordmark. Vintage examples are reported with a UNION-MADE stamp, TALON or Scovill zippers and \"Made in U.S.A.\" — all consistent with mid-century US production, none of it a precise dated chart. A \"Williamson-Dickie\" label is a strong vintage signal; it does not pin a year."},{"era":"The standalone \"Dickies\" arched wordmark","years":"modern","description":"The current logo era. NO tag-level date chronology beyond this is seeded — Dickies publishes none, and production largely moved offshore in the late 20th century, so \"Made in USA\" is itself a rough vintage prior for this brand rather than a guarantee."}]$j$::jsonb,
   $j$[{"pattern":"USA (vintage), then offshore","note":"⚠ COUNTRY IS A COARSE VINTAGE PRIOR ONLY FOR DICKIES: a \"Made in U.S.A.\" tag skews older, but Dickies has produced across many countries for decades and a modern USA-tagged line piece can exist. Do not date from it."}]$j$::jsonb,
   $j$[{"tell":"Grade condition, not authenticity — Dickies is a value brand","detail":"Dickies is mass-market workwear, not a luxury-tier fake target; there is no per-unit serial and no published authentication standard. The genuine risk is not counterfeits but MIS-DATING and FIT confusion (see the styles). Grade condition; route any authenticity question to human review."},{"tell":"The 874 fit family is a naming trap, not a defect","detail":"The 874 (Original Fit) has spawned WP314 (Slim Straight), 872 (Slim), and flex/tough-max variants that look near-identical in a photo — the STYLE NUMBER separates them, the silhouette often does not. A listing calling a slim-straight pant an \"874\" is a common honest error, not a fake."}]$j$::jsonb,
   'Founded 1922 in Bryan, Texas as the Williamson-Dickie Manufacturing Company (C.N. Williamson and E.E. Dickie); moved to Fort Worth; acquired by VF CORPORATION in 2017 (VF also owns The North Face, Timberland and Vans — a shared parent is NOT a signal). ⚠ **THIS ROW PROMOTES DICKIES FROM ITS SHALLOW 00389 ALIAS-ONLY SEED TO A FULL PACK.** The iconic style is the 874 Original Fit work pant (a straight-leg twill in a fixed waist x inseam grid); the 1922 line and the Eisenhower jacket are heritage references. ⚠ NO RN IS SEEDED: Dickies is a textile maker and a Made-in-USA piece carries an RN, but the specific registrant number could not be sourced to a primary FTC record, and fabricating one is the KB''s costliest error (the 00468 RN 17257 lesson). Flagged for the US-1715 queue. ⚠ "Dickies Girl" is a licensed juniors line, folded here as an alias. The 874''s CANONICAL identifier is the style NUMBER, but a bare "874" is not a decoder — three digits is nothing on its own.',
   'https://www.dickies.com/', 0.80, false, 'migration:00469'),

  ('filson', 'Filson',
   ARRAY['filson','ccfilson','ccfilsonco','filsonco']::text[],
   ARRAY['waxed tin cloth','mackinaw wool','field jackets','hunting apparel','luggage and bags','vests']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Older \"C.C. Filson Co. — Seattle\" labels + all Made in USA","years":"pre-2010s (approximate)","description":"⚠ DIRECTION, NOT A DATED CHART. C.C. Filson Co. (founded 1897, Seattle) built its reputation on Made-in-USA Tin Cloth and Mackinaw wool, and older labels emphasize \"Seattle, WA\" with US construction. This is the value core of vintage Filson. Treat a fully-USA-made oil-finish Tin Cloth garment as an older / higher-tier prior; it is not a precise year."},{"era":"Post-2012 mixed sourcing under Bedrock Manufacturing","years":"from ~2012","description":"⚠ SEEDED AS A REFUSAL OF THE \"ALWAYS USA\" MYTH. After Bedrock Manufacturing (the Shinola group) acquired Filson in 2012, some categories — notably bags/luggage and certain apparel — began to be produced offshore while flagship Tin Cloth stayed US-made. So a modern Filson with a non-USA tag is NOT automatically a fake, and \"Made in USA therefore genuine\" is an invertible over-simplification. The exact per-category cutover is not documented; do not date from country alone."}]$j$::jsonb,
   $j$[{"pattern":"USA (heritage), some categories offshore post-2012","note":"⚠ NOT AN AUTHENTICITY TELL IN EITHER DIRECTION for modern Filson: flagship Tin Cloth stays US-made while bags and some apparel moved offshore after 2012. Country dates a piece only coarsely."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Filson publishes no consumer authentication guide and no per-unit serial. The best structural signals are MATERIAL and CONSTRUCTION quality (dense oil-finish Tin Cloth, heavy Mackinaw wool, bridle-leather trim, brass hardware) rather than any printed mark — and those are the very things a photo grades well. Grade the material and the make."},{"tell":"The oval logo label + \"Might As Well Have The Best\" motto are brand-identification, not date tells","detail":"The oval C.C. Filson label and the registered motto identify the BRAND but carry no reliable date signal on their own. Do not convert their presence into an era."}]$j$::jsonb,
   'Founded 1897 in Seattle by Clinton C. Filson, outfitting Klondike Gold Rush prospectors. Signature materials: OIL-FINISH TIN CLOTH (waxed cotton duck) and MACKINAW WOOL; the Cruiser jacket''s utility-pocket layout was patented in 1914. Acquired by BEDROCK MANUFACTURING (the group behind Shinola) in 2012 — the ownership fact that explains the modern mixed sourcing above. ⚠ NO RN IS SEEDED: a Made-in-USA Filson wool/cotton garment carries an RN, but the registrant number could not be sourced to a primary FTC record and is not fabricated (the 00468 RN 17257 lesson). Flagged for the US-1715 queue. The vintage value driver is the TAG ERA + Made-in-USA construction, not any code.',
   'https://www.filson.com/', 0.80, false, 'migration:00469'),

  ('redwing', 'Red Wing',
   ARRAY['redwing','redwingshoes','redwingheritage','redwingshoecompany','irishsetter']::text[],
   ARRAY['work boots','heritage boots','moc toe boots','engineer boots','service boots','leather care']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"Red Wing Heritage\" line — reintroduced US-made vintage-spec boots","years":"from 2007","description":"Red Wing Shoe Company (founded 1905, Red Wing, Minnesota) reissued its archive as the RED WING HERITAGE line around 2007, US-made in Minnesota. The Heritage sub-brand vs the plain \"Red Wing Shoes\" work line is the most useful modern label distinction, and Heritage boots remaining MADE IN USA is a genuine value point. ⚠ Red Wing ALSO makes imported product (its Irish Setter hunting line moved offshore), so \"Red Wing\" on a boot does not by itself guarantee US construction — read the specific line + the interior/box label."},{"era":"The 4-digit style number on the box + a paper hangtag","years":"current + heritage","description":"Red Wing's canonical model identifiers are 4-digit style numbers (875 Oro Legacy moc toe, 877, 8875, 9011/8111 Iron Ranger, 3335 Blacksmith, 101 Postman). They appear on the BOX and a paper tag, not stamped into the boot in a durable way, so they are a listing/box token — NOT a decoder (a bare 4-digit run mints false positives; see the header). Use them to match comps, not to read off a worn boot."}]$j$::jsonb,
   $j$[{"pattern":"USA (Heritage/work), offshore (Irish Setter hunting)","note":"⚠ Red Wing splits US and imported production BY LINE. Heritage + core work boots are Minnesota-made; the Irish Setter hunting line is imported. Country reads the LINE, not a fake."}]$j$::jsonb,
   $j$[{"tell":"Grade condition + construction; route authenticity to human review","detail":"Red Wing publishes no consumer authentication portal. Structural signals — Goodyear welt construction, the leather (Oro Legacy / Amber Harness), the stitched moc toe — grade well from photos and are the real quality read. There is no per-unit serial."},{"tell":"\"Irish Setter\" is now a SEPARATE line, not a red flag","detail":"Irish Setter began as Red Wing's own hunting boot and is now a distinct (and imported) line. An Irish Setter boot is Red Wing GROUP heritage but should be titled as Irish Setter, not folded onto the Red Wing Heritage price ladder."}]$j$::jsonb,
   'Founded 1905 in Red Wing, Minnesota by Charles Beckman; still family-owned and Minnesota-headquartered. The Heritage line (reissued ~2007) is the collectible resale core; the Iron Ranger (8111/9011), the 875 moc toe and the 101 Postman are the flagship models. ⚠ **THE STYLE NUMBER IS THE MODEL''S IDENTITY BUT IS NOT A DECODER** — a bare 4-digit run (875, 8875) is exactly the Chanel/Lee-101 false-positive risk (US-1736); it is seeded as styles and box tokens, not as a tag decoder. ⚠ NO RN IS SEEDED (footwear leather is largely outside textile RN labeling anyway, and no registrant was sourced). ⚠ A BARE "red wing" IS DELIBERATELY EXCLUDED FROM FREE-TEXT BRAND DETECTION (DETECT_EXCLUDED_FROM_TEXT): "Detroit Red Wings" and the red-wing blackbird are common non-brand uses, so the boot house is reachable BY TAG but is never GUESSED from prose. Made-in-USA + the Heritage line drive value.',
   'https://www.redwingheritage.com/', 0.80, false, 'migration:00469'),

  ('timberland', 'Timberland',
   ARRAY['timberland','timberlands','timbs','timberlandpro','timberlandboot','abingtonshoe']::text[],
   ARRAY['boots','the yellow boot','work boots','outdoor apparel','pro safety footwear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"The Original Yellow Boot","years":"from 1973","description":"Timberland's defining product: the waterproof 6-inch wheat nubuck boot, introduced 1973 by the Abington Shoe Company (the Swartz family), which adopted the \"Timberland\" name in 1978. The yellow boot (style 10061) is the icon. ⚠ EARLY / MADE-IN-USA Timberland is a genuine vintage resale category — older tags predate the tree logo's current form and USA construction skews older — but no precise dated label chart is sourced here; treat country + logo style as a coarse prior only."},{"era":"VF Corporation ownership","years":"from 2011","description":"Timberland was acquired by VF Corporation in 2011 (a stablemate of Vans, The North Face and — since 2017 — Dickies). A CORPORATE date, not a tag tell; do not convert it into a label era."}]$j$::jsonb,
   $j$[{"pattern":"USA (vintage), broadly offshore (modern)","note":"⚠ COARSE VINTAGE PRIOR ONLY: a Made-in-USA Timberland tag skews older/collectible, but modern production is broadly offshore and this does not authenticate."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Timberland is one of the most counterfeited boot brands, but its published anti-counterfeit guidance is CHANNEL-based (buy from authorized retailers), not a set of photo tells. Structural reads — the die-cut tree logo quality, the hexagonal/anti-fatigue midsole, stitch density, the leather grain — are corroborators only. Route authenticity to human review; grade condition from the photos."},{"tell":"\"Timberland PRO\" is a separate work-safety line","detail":"Timberland PRO (steel/composite-toe safety footwear) is a distinct line from the Yellow Boot heritage range and comps separately. Title it as PRO rather than folding it onto the classic 6-inch price ladder."}]$j$::jsonb,
   'Founded as the Abington Shoe Company (Nathan Swartz); the injection-moulded waterproof Original Yellow Boot launched 1973 and the company adopted the Timberland name in 1978. Acquired by VF Corporation in 2011. ⚠ **THE STYLE NUMBER (10061 = the classic wheat 6-inch premium) IS THE MODEL''S IDENTITY BUT IS NOT A DECODER** — five bare digits is nothing on its own. Modern SKUs carry a brand-unique "TB0…" prefix, but no source places that prefix on a REGULAR physical tag (it is a web/box SKU), so it is a listing token, not a decoder (the 00468 physical-presence rule). ⚠ NO RN IS SEEDED (footwear; none sourced). Made-in-USA vintage is the resale premium.',
   'https://www.timberland.com/', 0.80, false, 'migration:00469'),

  ('duluthtradingco', 'Duluth Trading Co.',
   ARRAY['duluthtrading','duluthtradingco','duluthtradingcompany','duluthworkwear']::text[],
   ARRAY['work pants','fire hose canvas','longtail t','buck naked underwear','ballroom jeans','workwear']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Grade condition; there is no authentication surface","detail":"Duluth Trading Co. is a modern (1989) direct-to-consumer workwear brand sold almost entirely through its own channel — there is no meaningful counterfeit market, no per-unit serial and no authentication guide. Grade condition. The identifiable assets are its trademarked PRODUCT NAMES: Fire Hose (canvas work pants), Longtail T (extra-length tees), Buck Naked (underwear), Ballroom (gusseted jeans), Armachillo (cooling)."}]$j$::jsonb,
   'Founded 1989 as a mail-order catalogue (originally selling to the building trades), now Duluth Holdings Inc. (NASDAQ: DLTH), headquartered in Wisconsin. ⚠ **TAG ERAS ARE EMPTY ON PURPOSE — THIS IS A MODERN CATALOGUE BRAND WITH NO VINTAGE TAG CORPUS.** Unlike the heritage names in this pack, Duluth Trading has no documented, value-driving label chronology, so seeding one would be invention (the athleisure precedent, 00452). Identify it by its trademarked product names. ⚠ **THE PACK''S HEADLINE REFUSAL LIVES HERE: A BARE "duluth" IS NOT DULUTH TRADING.** "Duluth" is a Minnesota city AND DULUTH PACK (est. 1882), an unrelated waxed-canvas pack maker — folding a bare "duluth" would retitle a Duluth Pack canoe pack as a Fire Hose work-pant company. Only "duluth trading" / "duluthtrading" are aliased. ⚠ NO RN IS SEEDED (none sourced).',
   'https://www.duluthtrading.com/', 0.80, false, 'migration:00469'),

  ('pendleton', 'Pendleton',
   ARRAY['pendleton','pendletonwoolenmills','pendletonwoolen','sirpendleton']::text[],
   ARRAY['wool shirts','board shirts','blankets','western wear','the 49er','national park blankets']::text[],
   ARRAY[]::text[],
   $j$[{"era":"1950s-60s wool \"board shirts\" + the loop collar","years":"1950s-1960s (approximate)","description":"⚠ COLLECTOR-CORROBORATED, TREAT AS ORIENTATION. The most valuable vintage Pendleton is the mid-century pure-virgin-wool BOARD SHIRT (the surf-era plaid overshirt), often with a loop collar and a flap chest pocket. Older labels emphasize \"Pendleton\" script + \"Made in U.S.A.\" + \"100% Virgin Wool\" + Portland/Oregon. A wool board shirt with an early script label is the price-driving find; the exact year comes from the label style + details, not a published chart."},{"era":"\"Sir Pendleton\" men's line label","years":"~1960s onward","description":"The \"Sir Pendleton\" sub-label marked the men's tailored wool shirt line and is a recognizable era/line tell on the tag — a strong vintage men's signal. ⚠ Line label, not a precise year."},{"era":"\"High Grade Western Wear\" — the Western snap shirts","years":"mid-century","description":"Pendleton's Western snap-front wool shirts carried \"High Grade Western Wear\" branding; the phrase on a tag identifies the Western line and skews vintage."},{"era":"The \"49er\" jacket","years":"from 1949","description":"The women's 49er (a wool jacket-shirt introduced 1949 and made for decades) is a named heritage garment; \"49er\" identifies the model, and early examples with older labels are the collectible ones. The NAME dates the model line's origin, not the individual piece."}]$j$::jsonb,
   $j$[{"pattern":"USA — wool woven at the Washougal WA and Pendleton OR mills","note":"Pendleton still weaves wool in the USA, so \"Made in USA\" is common on genuine pieces old AND new and is NOT a date tell by itself — the LABEL STYLE dates the piece, not the country."}]$j$::jsonb,
   $j$[{"tell":"Grade condition + wool hand; route authenticity to human review","detail":"Pendleton publishes no per-unit authentication. The value read is MATERIAL (pure/virgin wool vs modern blends), the LABEL ERA (see tag_eras), and pattern. There is no serial. The blankets — the National Park series and the Chief Joseph — are a distinct, heavily-collected category with their own comps."},{"tell":"A blanket pattern NAME is the identity — and beware reissues","detail":"Pendleton's blanket designs (Yellowstone, Glacier, Yosemite, Grand Canyon National Park stripes; Chief Joseph) are named, durable and price-driving. But Pendleton REISSUES heritage designs, so a current-production Glacier Park blanket is genuine and far cheaper than a vintage one — date it by the LABEL, not by the pattern name."}]$j$::jsonb,
   'Founded on wool-mill roots dating to 1863; Pendleton Woolen Mills was incorporated in 1909 by the Bishop family in Oregon and remains FAMILY-OWNED, still weaving wool at its Washougal (WA) and Pendleton (OR) mills. ⚠ **THIS ROW PROMOTES PENDLETON FROM ITS SHALLOW 00389 ALIAS-ONLY SEED TO A FULL PACK, AND THE TAG ERA IS THE WHOLE POINT** — a 1950s-60s wool board shirt is worth a multiple of its modern equivalent, and only the LABEL separates them. ⚠ NO RN IS SEEDED: a Pendleton wool garment carries an RN, but the registrant number could not be sourced to a primary FTC record and is not fabricated (the 00468 lesson). Flagged for the US-1715 queue. ⚠ Note the place-name collision (Pendleton, Oregon; Camp Pendleton USMC) — the brand stays reachable by TAG; a "Camp Pendleton" USMC listing is not this brand. No decoder: Pendleton has no regular tag-printed style code.',
   'https://www.pendleton-usa.com/', 0.80, false, 'migration:00469'),

  ('barbour', 'Barbour',
   ARRAY['barbour','jbarbour','jbarboursons','barbourinternational','abarbour','barbourbeacon']::text[],
   ARRAY['waxed cotton jackets','quilted jackets','tartan-lined jackets','country apparel','knitwear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"The Royal Warrant count on the label","years":"warrants granted 1974 / 1982 / 1987","description":"⚠ THE GROUP'S BEST-SOURCED HERITAGE TELL, and it is DATED. J. Barbour & Sons holds three Royal Warrants, granted in sequence: HRH The Duke of Edinburgh (1974), HM The Queen (1982), and HRH The Prince of Wales (1987). Because the interior label historically displayed the warrant crests it then held, the NUMBER OF WARRANT CRESTS is a coarse date floor — a THREE-crest label cannot predate 1987, a two-crest label sits ~1982-1987, and a single/none skews earlier. ⚠ HONEST LIMIT: warrant display and label design have changed over time and warrants can lapse/renew (royal successions after 2022 affect current warrants), so read this as a FLOOR and orientation, not a precise year, and route high-value vintage to human review."},{"era":"\"A. Barbour & Sons\" / older interior label typography + the tartan lining","years":"vintage (approximate)","description":"⚠ COLLECTOR-CORROBORATED. Older Barbour wax jackets are dated by collectors on interior LABEL typography and the classic Barbour tartan lining, alongside the warrant crests above. The details (the label wording, the lining, the stud/zip hardware) order two jackets relative to each other far better than they pin an absolute year. Treat as a prior."}]$j$::jsonb,
   $j$[{"pattern":"United Kingdom (South Shields, England) for wax jackets","note":"Barbour's classic waxed cotton jackets are made in England (South Shields); some other categories are made elsewhere. \"Made in England\" on a wax jacket is expected and is not, by itself, a date tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition + re-waxing; route authenticity to human review","detail":"Barbour is counterfeited, but its guidance is channel-based; the durable positive is the interior STYLE-CODE label (see the decoder) plus the tartan lining and the warrant crests. ⚠ A RE-WAXED or patinated wax jacket is NORMAL and often desirable — heavy wax wear is not damage in the way it would be on a fashion coat; grade it in the workwear/heritage frame, and note that Barbour offers re-waxing as a service."},{"tell":"The MWX/LWX style code on the interior label is the real identifier","detail":"Unlike most of this pack, Barbour prints a REGULAR brand-unique style code on the interior label — [M|L] + line code + 4 digits (MWX0018 = Bedale). It identifies the model and the department (M = men's, L = ladies'). See the seeded decoder; it recovers the brand off a partial/cut label."}]$j$::jsonb,
   'Founded 1894 in South Shields, England by John Barbour; J. BARBOUR & SONS remains a family business, best known for waxed cotton country jackets. Flagship models: BEDALE (waxed, short riding cut), BEAUFORT (waxed, longer field cut), ASHBY, INTERNATIONAL (the Steve McQueen-associated motorcycle jacket), and — for women — the BEADNELL. Quilted classics: Liddesdale, Powell, Polarquilt. ⚠ **BARBOUR OWNS THE PACK''S ONLY DECODER**: the interior-label style code [M|L]+line+4 digits (MWX/LWX = wax, MQU/LQU = quilt, MCA = casual, MKN = knit) is tag-printed, regular and brand-unique — the exact Canada Goose department-letter case (00460). ⚠ NO RN IS SEEDED (a UK maker; US RN not applicable/sourced). ⚠ "Barbour International" is the motorcycle-heritage sub-brand and folds to the house here.',
   'https://www.barbour.com/', 0.80, false, 'migration:00469'),

  ('orvis', 'Orvis',
   ARRAY['orvis','theorvis','orviscompany','orvisco']::text[],
   ARRAY['fly fishing gear','field and hunting apparel','barn coats','tech vests','dog beds','waders']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Grade condition; route authenticity to human review","detail":"Orvis is a specialty outdoor/fly-fishing retailer, not a counterfeit-tier fashion label — there is no per-unit serial and no authentication guide. Grade condition. Identify by product line (the barn coat, tech/fishing vests, waxed and field jackets) and the Orvis wordmark; there is no reliable tag-era chronology to date a piece."}]$j$::jsonb,
   'Founded 1856 in Manchester, Vermont by Charles F. Orvis — the oldest mail-order retailer in the United States, rooted in fly fishing and now spanning field/hunting apparel, dog goods and home. ⚠ **TAG ERAS ARE EMPTY ON PURPOSE**: despite the 1856 heritage, Orvis is not a tag-dated vintage resale category the way Pendleton, Barbour or Filson are — no documented, value-driving label chronology is sourced, so none is invented (the athleisure/Duluth precedent). ⚠ NO RN IS SEEDED (none sourced). No decoder: Orvis has no regular tag-printed brand-unique style code.',
   'https://www.orvis.com/', 0.80, false, 'migration:00469')
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
-- prompt (US-1740). For this group the highest-value fingerprint is often the
-- ERA cue (the tag), so the style rows lead with what separates a model AND, where
-- relevant, what dates it.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- Dickies
  ('dickies', '874 Original Fit Work Pant', 'Men', 'pant', 'Work pants',
   'THE ICON: a straight-leg twill work pant with a permanent crease, a fixed WAIST x INSEAM grid and the arched Dickies tab. ⚠ **THE 874 IS A FIT NAME, AND ITS SLIM SIBLINGS LOOK NEAR-IDENTICAL IN A PHOTO** — WP314 (Slim Straight) and 872 (Slim) share the silhouette; the STYLE NUMBER on the tag separates them where the photo cannot. Grade to "Dickies work pant"; resolve the exact fit only if the tag is legible.',
   ARRAY['polyester/cotton twill']::text[], '1967-present', '$',
   ARRAY['874','work pant','original fit','twill','wp314']::text[],
   'https://www.dickies.com/', 0.80, false, 'migration:00469'),
  ('dickies', 'Eisenhower / Ike Jacket', 'Men', 'jacket', 'Workwear',
   'A short, waist-length twill work jacket (the "Ike" cut). Vintage examples with a Williamson-Dickie union label are the collectible ones — the JACKET CUT plus the LABEL ERA drive the value, not a code.',
   ARRAY['cotton/poly twill']::text[], 'heritage-present', '$',
   ARRAY['eisenhower','ike jacket','work jacket']::text[],
   'https://www.dickies.com/', 0.65, false, 'migration:00469'),
  ('dickies', 'Duck Canvas Chore Coat', 'Men', 'jacket', 'Workwear',
   'A duck-canvas utility/chore coat, often blanket- or quilt-lined. Separable from the twill Eisenhower by the heavier duck fabric. Comps with other workwear chore coats; grade the fabric and lining.',
   ARRAY['cotton duck canvas']::text[], 'current', '$',
   ARRAY['chore coat','duck canvas','work jacket']::text[],
   'https://www.dickies.com/', 0.60, false, 'migration:00469'),

  -- Filson
  ('filson', 'Mackinaw Cruiser', 'Men', 'jacket', 'Mackinaw wool',
   'THE FLAGSHIP: a heavy Mackinaw WOOL cruiser jacket whose utility-pocket layout (multiple front pockets + a full-width back "cruiser" pocket) descends from Filson''s 1914 patent. ⚠ A Made-in-USA Mackinaw Cruiser with an older C.C. Filson label is the price-driving vintage find — the WOOL WEIGHT + the LABEL ERA are the read.',
   ARRAY['Mackinaw virgin wool']::text[], '1914 patent-present', '$$$',
   ARRAY['mackinaw','cruiser','wool jacket','filson']::text[],
   'https://www.filson.com/', 0.80, false, 'migration:00469'),
  ('filson', 'Tin Cloth Jacket / Cruiser', 'Men', 'jacket', 'Tin Cloth',
   'OIL-FINISH TIN CLOTH (waxed cotton duck) — stiff, weatherproof, developing a patina. The Tin Cloth line is Filson''s waxed-cotton core and stayed US-made through the ownership change. Separable from the wool Mackinaw by the waxed-cotton surface. A well-worn Tin Cloth patina is desirable, not damage.',
   ARRAY['oil-finish tin cloth (waxed cotton)']::text[], 'heritage-present', '$$$',
   ARRAY['tin cloth','waxed cotton','oil finish','field jacket']::text[],
   'https://www.filson.com/', 0.75, false, 'migration:00469'),
  ('filson', 'Original Briefcase / Field Bag', 'Unisex', 'bag', 'Luggage',
   'Rugged Tin Cloth / twill bags with bridle-leather trim and brass hardware. ⚠ **BAGS ARE THE CATEGORY MOST LIKELY TO BE OFFSHORE-MADE post-2012** — so a non-USA tag on a modern Filson bag is not a fake. Grade the leather + hardware; comp against Filson bags specifically.',
   ARRAY['tin cloth','rugged twill','bridle leather']::text[], 'current', '$$$',
   ARRAY['briefcase','field bag','filson bag','tin cloth bag']::text[],
   'https://www.filson.com/', 0.65, false, 'migration:00469'),

  -- Red Wing
  ('redwing', '875 Classic Moc (Oro Legacy)', 'Men', 'boot', 'Heritage',
   'The 6-inch MOC TOE in oatmeal-toned Oro Legacy leather with a white Traction Tred wedge sole and the stitched moc seam. Style 875. ⚠ THE 4-DIGIT NUMBER (875) IS THE MODEL''S IDENTITY BUT IS A BOX/LISTING TOKEN, NOT A TAG DECODER. Heritage = Made in USA.',
   ARRAY['Oro Legacy leather','Traction Tred wedge']::text[], 'heritage', '$$$',
   ARRAY['875','moc toe','oro legacy','wedge sole','red wing heritage']::text[],
   'https://www.redwingheritage.com/', 0.80, false, 'migration:00469'),
  ('redwing', 'Iron Ranger (8111 / 9011)', 'Men', 'boot', 'Heritage',
   'A capped-toe service boot on a Goodyear-welted leather sole — the bump/toe cap is the cue. Amber Harness (8111) and Copper Rough & Tough (9011) are the signature leathers. Separable from the 875 by the CAP TOE + leather sole (vs the moc seam + wedge).',
   ARRAY['Amber Harness leather','Copper Rough & Tough leather']::text[], 'heritage', '$$$',
   ARRAY['iron ranger','8111','9011','cap toe','service boot']::text[],
   'https://www.redwingheritage.com/', 0.80, false, 'migration:00469'),
  ('redwing', 'Blacksmith (3335) / Postman (101)', 'Men', 'boot', 'Heritage',
   'Blacksmith 3335 = a round-toe roughout/oiled service boot. Postman 101 = a polished, minimalist chukka/oxford dress-work style. Two distinct silhouettes seeded together so a photo is graded to the right last; the 4-digit numbers are box tokens.',
   ARRAY['Charcoal Rough & Tough','Black Chaparral']::text[], 'heritage', '$$$',
   ARRAY['blacksmith','3335','postman','101','service boot']::text[],
   'https://www.redwingheritage.com/', 0.70, false, 'migration:00469'),

  -- Timberland
  ('timberland', 'Original 6-Inch Boot (Yellow Boot, 10061)', 'Men', 'boot', 'Classic',
   'THE ICON: the waterproof 6-inch WHEAT NUBUCK boot with padded collar, hexagonal lug outsole and the die-cut tree logo. Style 10061. ⚠ THE 5-DIGIT NUMBER IS THE MODEL''S IDENTITY BUT IS A BOX/WEB SKU, NOT A TAG DECODER. Made-in-USA vintage examples comp higher.',
   ARRAY['wheat nubuck','waterproof leather']::text[], '1973-present', '$$',
   ARRAY['yellow boot','10061','6 inch','wheat nubuck','timberland']::text[],
   'https://www.timberland.com/', 0.80, false, 'migration:00469'),
  ('timberland', 'Timberland PRO (work/safety)', 'Men', 'boot', 'PRO',
   '⚠ A SEPARATE LINE, seeded so it is not folded onto the Yellow Boot: steel/composite safety-toe work boots (Pit Boss, Boondock) with the PRO wordmark. Comps separately from the heritage 6-inch. Identify by the PRO branding + safety-toe construction.',
   ARRAY['leather','safety toe','anti-fatigue midsole']::text[], 'current', '$$',
   ARRAY['timberland pro','pit boss','work boot','safety toe']::text[],
   'https://www.timberland.com/', 0.70, false, 'migration:00469'),

  -- Duluth Trading Co.
  ('duluthtradingco', 'Fire Hose Work Pant', 'Men', 'pant', 'Fire Hose',
   'Duluth''s signature heavy CANVAS work pant (the "Fire Hose" fabric), gusseted/relaxed for movement. Identify by the trademarked FIRE HOSE name + heavy canvas. A trademarked product NAME is the identity here, not a code.',
   ARRAY['Fire Hose canvas (cotton)']::text[], 'current', '$$',
   ARRAY['fire hose','work pant','canvas','duluth trading']::text[],
   'https://www.duluthtrading.com/', 0.75, false, 'migration:00469'),
  ('duluthtradingco', 'Longtail T', 'Men', 'top', 'Longtail T',
   'A tee cut ~3in longer in the back (the trademarked "Longtail T" — "no more plumber''s butt"). The extra tail length is the cue; otherwise a plain crew tee. Identify by the Longtail name.',
   ARRAY['cotton']::text[], 'current', '$',
   ARRAY['longtail t','tee','extra length','duluth trading']::text[],
   'https://www.duluthtrading.com/', 0.70, false, 'migration:00469'),
  ('duluthtradingco', 'Ballroom Jeans', 'Men', 'pant', 'Ballroom',
   'Gusseted-crotch work jeans (the trademarked "Ballroom" gusset for range of motion). Identify by the Ballroom name; a photo alone will not separate them from ordinary work jeans.',
   ARRAY['denim']::text[], 'current', '$$',
   ARRAY['ballroom jeans','gusset','work jeans','duluth trading']::text[],
   'https://www.duluthtrading.com/', 0.60, false, 'migration:00469'),

  -- Pendleton
  ('pendleton', 'Wool Board Shirt', 'Men', 'shirt', 'Wool shirts',
   'THE VINTAGE PRICE DRIVER: a pure/virgin WOOL plaid overshirt (the surf-era "board shirt"), often with a loop collar and a flap chest pocket. ⚠ **THE TAG DATES IT** — an early "Pendleton" script + "100% Virgin Wool" + "Made in U.S.A." label on a board shirt is the collectible find; a modern label is genuine but far cheaper. Grade the wool + read the label era.',
   ARRAY['100% virgin wool']::text[], '1950s-present', '$$',
   ARRAY['board shirt','wool shirt','loop collar','plaid','pendleton']::text[],
   'https://www.pendleton-usa.com/', 0.80, false, 'migration:00469'),
  ('pendleton', 'The 49er Jacket', 'Women', 'jacket', 'Heritage',
   'The women''s 49er — a boxy wool jacket-shirt introduced 1949, with patch pockets and a fringe of era-specific styling. Early examples with older labels are the collectible ones; the NAME dates the model line, the LABEL dates the piece.',
   ARRAY['wool']::text[], '1949-present', '$$',
   ARRAY['49er','forty niner','wool jacket','pendleton']::text[],
   'https://www.pendleton-usa.com/', 0.70, false, 'migration:00469'),
  ('pendleton', 'National Park / Chief Joseph Blanket', 'Unisex', 'blanket', 'Blankets',
   '⚠ A DISTINCT, HEAVILY-COLLECTED CATEGORY with its own comps — NOT apparel. Named wool blankets: the NATIONAL PARK stripe series (Yellowstone, Glacier, Yosemite, Grand Canyon) and the Chief Joseph. ⚠ **PENDLETON REISSUES THESE**, so a current Glacier Park blanket is genuine and much cheaper than a vintage one — date by the LABEL, not the pattern name. See the colorways for the pattern list.',
   ARRAY['pure/virgin wool']::text[], 'heritage-present', '$$$',
   ARRAY['blanket','national park','glacier park','chief joseph','pendleton blanket']::text[],
   'https://www.pendleton-usa.com/', 0.75, false, 'migration:00469'),

  -- Barbour
  ('barbour', 'Bedale', 'Men', 'jacket', 'Waxed jackets',
   'A short, waist-length WAXED COTTON jacket (the original riding cut), corduroy collar, stud-and-zip front, tartan lining, bellows pockets. Style MWX0018. ⚠ Separable from the BEAUFORT by LENGTH (Bedale is shorter). Grade the wax patina in the heritage frame — heavy wax wear is normal.',
   ARRAY['6oz Sylkoil / Thornproof waxed cotton','Barbour tartan lining']::text[], 'classic', '$$$',
   ARRAY['bedale','waxed jacket','mwx0018','tartan lining','barbour']::text[],
   'https://www.barbour.com/', 0.80, false, 'migration:00469'),
  ('barbour', 'Beaufort', 'Men', 'jacket', 'Waxed jackets',
   'The longer FIELD cut waxed jacket (a game-pocket across the back), corduroy collar, tartan lining. Style MWX0017. Separable from the Bedale by its greater LENGTH + the rear game pocket.',
   ARRAY['6oz waxed cotton','Barbour tartan lining']::text[], 'classic', '$$$',
   ARRAY['beaufort','waxed jacket','mwx0017','game pocket','barbour']::text[],
   'https://www.barbour.com/', 0.80, false, 'migration:00469'),
  ('barbour', 'International', 'Men', 'jacket', 'International',
   'The motorcycle-heritage waxed jacket (Steve McQueen association): a slanted map/chest pocket, a diagonal front zip and belt loops. The ANGLED pocket + diagonal zip are the cues that separate it from the Bedale/Beaufort. Sub-brand: Barbour International.',
   ARRAY['waxed cotton']::text[], 'classic', '$$$',
   ARRAY['international','a7','steve mcqueen','waxed jacket','barbour international']::text[],
   'https://www.barbour.com/', 0.75, false, 'migration:00469'),
  ('barbour', 'Beadnell (ladies waxed)', 'Women', 'jacket', 'Waxed jackets',
   'The women''s counterpart to the Bedale — a fitted waxed cotton jacket, tartan lining, front zip + studs. Style LWX0667. ⚠ The L-prefix style code marks it LADIES'' (see the decoder); grade it in the women''s frame.',
   ARRAY['waxed cotton','Barbour tartan lining']::text[], 'classic', '$$$',
   ARRAY['beadnell','ladies waxed','lwx0667','womens barbour']::text[],
   'https://www.barbour.com/', 0.75, false, 'migration:00469'),
  ('barbour', 'Liddesdale / Powell (quilted)', 'Men', 'jacket', 'Quilted jackets',
   'Lightweight DIAMOND-QUILTED jackets (no wax): Liddesdale (box-quilt, snap front) and Powell (MQU0281). Separable from the waxed line by the quilted, non-waxed surface. The MQU/LQU line code marks quilt.',
   ARRAY['polyamide quilt','polyester wadding']::text[], 'classic', '$$',
   ARRAY['liddesdale','powell','quilted jacket','mqu0281','diamond quilt']::text[],
   'https://www.barbour.com/', 0.75, false, 'migration:00469'),

  -- Orvis
  ('orvis', 'Barn Coat / Field Coat', 'Men', 'jacket', 'Field apparel',
   'A canvas/cotton barn or field coat, often corduroy-collared and blanket/flannel-lined — Orvis''s outdoor-apparel staple. Grade the fabric + lining; comp against field/barn coats. The Orvis wordmark identifies it.',
   ARRAY['cotton canvas','flannel lining']::text[], 'current', '$$',
   ARRAY['barn coat','field coat','orvis','canvas jacket']::text[],
   'https://www.orvis.com/', 0.65, false, 'migration:00469'),
  ('orvis', 'Fishing / Tech Vest', 'Unisex', 'vest', 'Fly fishing',
   'A multi-pocket fly-fishing/tech vest — Orvis''s heritage fly-fishing category. Identify by the pocket array + Orvis branding; comps in the fishing/outdoor category, not fashion.',
   ARRAY['nylon','mesh']::text[], 'current', '$$',
   ARRAY['fishing vest','tech vest','fly fishing','orvis']::text[],
   'https://www.orvis.com/', 0.60, false, 'migration:00469')
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

-- ── brand_style_codes ──────────────────────────────────────────────────────
-- ONE DECODER — BARBOUR. The interior-label style code is tag-printed, regular
-- and brand-unique in FORMAT. The DEPARTMENT LETTER is the whole argument (the
-- Canada Goose case, 00460): a bare "0018" is nothing, but "MWX0018" can only be
-- Barbour. M/L is captured INSIDE styleCode and NOT mapped to a gender field,
-- because the shared genderCode transform maps only W/M — capturing "L" for
-- LADIES' would emit a raw "L" as a gender (same call as Canada Goose 00460 and
-- Peter Millar 00467). The line prefixes are anchored (WX/QU/CA/KN/TN/LI/GI/FL/
-- OL/SG) so a bare "M" + arbitrary letters can't over-match.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples,
   source_url, confidence, verified, updated_by)
values
  ('barbour', 'style_number',
   'Barbour interior-label style code: [M|L] + a 2-letter LINE code + 4 digits. M = men''s, L = ladies''; WX = WaX, QU = QUilt, CA = CAsual/cotton, KN = KNit, TN = Tailored, plus GI/FL/OL/SG/LI. MWX0018 = Bedale, MWX0017 = Beaufort, LWX0667 = Beadnell, MQU0281 = Powell. THE DEPARTMENT LETTER IS WHAT MAKES A BARE 4-DIGIT RUN BRAND-UNIQUE (the Canada Goose case, 00460) — "0018" is nothing, "MWX0018" can only be Barbour. The M/L letter is captured inside styleCode and NOT mapped to a gender field: the shared genderCode transform maps only W/M, so a captured "L" for LADIES'' would emit a raw "L" as a gender (same omission as Canada Goose 00460 / Peter Millar 00467). The line prefixes are ANCHORED so a bare "M" + arbitrary letters cannot over-match a non-Barbour code.',
   '^(?<style>[ML](?:WX|QU|CA|KN|TN|LI|GI|FL|OL|SG)\d{4})$',
   $j${"fieldMap": {"style": "styleCode"}, "transforms": {"style": "upper"}, "confidence": 0.6}$j$::jsonb,
   $j$[{"code":"MWX0018","expected":{"styleCode":"MWX0018"}},{"code":"MWX0017","expected":{"styleCode":"MWX0017"}},{"code":"LWX0667","expected":{"styleCode":"LWX0667"}},{"code":"MQU0281","expected":{"styleCode":"MQU0281"}}]$j$::jsonb,
   'https://www.barbour.com/', 0.65, false, 'migration:00469')
on conflict (brand_key, decoder_kind) do update set
  description      = excluded.description,
  pattern          = excluded.pattern,
  extraction_rules = excluded.extraction_rules,
  examples         = excluded.examples,
  source_url       = excluded.source_url,
  confidence       = excluded.confidence,
  updated_by       = excluded.updated_by;

-- ── brand_colorways ────────────────────────────────────────────────────────
-- TWO BRANDS QUALIFY. Barbour: a small set of DURABLE, house-standard colour
-- names that recur across models for decades (Sage/Olive/Rustic/Navy/Black/Bark)
-- — a true internal palette. Pendleton: its named BLANKET/PATTERN designs are the
-- identity and the price driver (the Vera Bradley rule, 00468) — but ⚠ THEY ARE
-- REISSUED, so a pattern name dates the DESIGN, never the individual piece.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  -- Barbour standard jacket colours (durable across models).
  ('barbour', 'Sage', ARRAY[]::text[], null, 'durable house colour — the classic Barbour wax green',
   'https://www.barbour.com/', 0.80, false, 'migration:00469'),
  ('barbour', 'Olive', ARRAY[]::text[], null, 'durable house colour', 'https://www.barbour.com/', 0.80, false, 'migration:00469'),
  ('barbour', 'Rustic', ARRAY['brown']::text[], null, 'durable house colour — the classic Barbour tan/brown wax',
   'https://www.barbour.com/', 0.80, false, 'migration:00469'),
  ('barbour', 'Navy', ARRAY[]::text[], null, 'durable house colour', 'https://www.barbour.com/', 0.80, false, 'migration:00469'),
  ('barbour', 'Black', ARRAY[]::text[], null, 'durable house colour', 'https://www.barbour.com/', 0.80, false, 'migration:00469'),
  ('barbour', 'Bark', ARRAY[]::text[], null, 'durable house colour (quilted line)', 'https://www.barbour.com/', 0.75, false, 'migration:00469'),

  -- Pendleton named patterns (blankets). ⚠ REISSUED — a name dates the DESIGN,
  -- not the piece; the LABEL dates the piece (see the blanket style row).
  ('pendleton', 'Glacier National Park', ARRAY['glacier park']::text[], null,
   '⚠ REISSUED DESIGN — the name is the pattern, NOT a date; a current Glacier Park blanket is genuine and far cheaper than a vintage one. The multi-stripe Glacier Park is Pendleton''s oldest National Park design.',
   'https://www.pendleton-usa.com/', 0.80, false, 'migration:00469'),
  ('pendleton', 'Yellowstone National Park', ARRAY['yellowstone park']::text[], null,
   '⚠ REISSUED DESIGN — name, not date.', 'https://www.pendleton-usa.com/', 0.80, false, 'migration:00469'),
  ('pendleton', 'Yosemite National Park', ARRAY['yosemite park']::text[], null,
   '⚠ REISSUED DESIGN — name, not date.', 'https://www.pendleton-usa.com/', 0.75, false, 'migration:00469'),
  ('pendleton', 'Grand Canyon National Park', ARRAY['grand canyon park']::text[], null,
   '⚠ REISSUED DESIGN — name, not date.', 'https://www.pendleton-usa.com/', 0.75, false, 'migration:00469'),
  ('pendleton', 'Chief Joseph', ARRAY[]::text[], null,
   '⚠ REISSUED DESIGN — a Pendleton heritage trade blanket pattern; the name is the design, not a date.',
   'https://www.pendleton-usa.com/', 0.80, false, 'migration:00469')
on conflict (brand_key, color_name) do update set
  aliases    = excluded.aliases,
  hex        = excluded.hex,
  years      = excluded.years,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  updated_by = excluded.updated_by;

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- A mix of APPAREL (waist x inseam / chest) and FOOTWEAR (US shoe) charts —
-- Red Wing and Timberland are boots, the rest are garments. formatSizingChartsFor
-- Prompt renders labels + note IN FULL and UNCAPPED (US-1740), so the fit caveats
-- live in the note. All numbers are approximate published guides; verify.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  ('dickies', 'Dickies', ARRAY['dickies']::text[], 'Men',
   'Work pants (WAIST x INSEAM, inches)',
   ARRAY['pant','bottom','trouser','work pant','874','jean','short']::text[],
   $j$[{"size":"30x32","measurements":{"waist":"30","inseam":"32"}},{"size":"32x32","measurements":{"waist":"32","inseam":"32"}},{"size":"34x32","measurements":{"waist":"34","inseam":"32"}},{"size":"36x32","measurements":{"waist":"36","inseam":"32"}},{"size":"38x32","measurements":{"waist":"38","inseam":"32"}},{"size":"40x30","measurements":{"waist":"40","inseam":"30"}}]$j$::jsonb,
   'Dickies men''s work pants use a numeric WAIST x INSEAM grid (the tag prints both). ⚠ THE 874 FIT FAMILY IS THE TRAP, NOT THE SIZE: 874 (Original), WP314 (Slim Straight) and 872 (Slim) share the size grid but differ in cut — read the STYLE NUMBER for fit. Waist runs ~28-44, inseam ~28-34. These are the labelled garment sizes, not body measurements.',
   'https://www.dickies.com/', 0.75, false, 'migration:00469'),

  ('filson', 'Filson', ARRAY['filson']::text[], 'Men',
   'Tops & outerwear (alpha, CHEST inches)',
   ARRAY['top','shirt','jacket','coat','vest','outerwear','mackinaw','cruiser','tin cloth']::text[],
   $j$[{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"39-41"}},{"size":"L","measurements":{"chest":"42-44"}},{"size":"XL","measurements":{"chest":"45-47"}},{"size":"XXL","measurements":{"chest":"48-50"}}]$j$::jsonb,
   'Filson men''s tops/outerwear run alpha S-XXL against a chest grid (approximate — verify against the specific garment). ⚠ WOOL MACKINAW and heavy Tin Cloth are cut for LAYERING, so a Filson garment often measures generously vs a fashion top of the same alpha size; measure the actual chest flat and double it. Filson also publishes numeric chest sizes on some shirts.',
   'https://www.filson.com/', 0.65, false, 'migration:00469'),

  ('redwing', 'Red Wing', ARRAY['red wing','redwing']::text[], 'Men',
   'Boots (US men''s shoe size)',
   ARRAY['boot','shoe','footwear','moc','iron ranger']::text[],
   $j$[{"size":"US 8","measurements":{"uk":"7","eu":"41"}},{"size":"US 9","measurements":{"uk":"8","eu":"42"}},{"size":"US 10","measurements":{"uk":"9","eu":"43"}},{"size":"US 11","measurements":{"uk":"10","eu":"44.5"}},{"size":"US 12","measurements":{"uk":"11","eu":"45"}}]$j$::jsonb,
   '⚠ RED WING HERITAGE BOOTS RUN LARGE: the common fit guidance is to go ~0.5 size DOWN from your Brannock/US sneaker size (some models a full size). The US↔UK↔EU conversions above are approximate and vary by last (the 875''s last differs from the Iron Ranger''s), so treat them as orientation. Widths run B-EE. Read the size off the boot/box, and note the fit caveat rather than "correcting" a listing.',
   'https://www.redwingheritage.com/', 0.70, false, 'migration:00469'),

  ('timberland', 'Timberland', ARRAY['timberland']::text[], 'Men',
   'Boots (US men''s shoe size)',
   ARRAY['boot','shoe','footwear','yellow boot','pro']::text[],
   $j$[{"size":"US 8","measurements":{"uk":"7.5","eu":"41.5"}},{"size":"US 9","measurements":{"uk":"8.5","eu":"43"}},{"size":"US 10","measurements":{"uk":"9.5","eu":"44.5"}},{"size":"US 11","measurements":{"uk":"10.5","eu":"45.5"}},{"size":"US 12","measurements":{"uk":"11.5","eu":"46.5"}}]$j$::jsonb,
   '⚠ THE ORIGINAL 6-INCH (YELLOW BOOT) RUNS LARGE — common guidance is to go ~0.5 size DOWN from a sneaker size. The US↔UK↔EU conversions are approximate. Timberland also makes women''s and kids'' versions of the boot at different numbering — read the department off the box. PRO safety boots use the same US grid.',
   'https://www.timberland.com/', 0.70, false, 'migration:00469'),

  ('duluthtradingco', 'Duluth Trading Co.', ARRAY['duluth trading','duluthtrading']::text[], 'Men',
   'Work pants (WAIST x INSEAM, inches)',
   ARRAY['pant','bottom','trouser','work pant','fire hose','jean','ballroom']::text[],
   $j$[{"size":"32x32","measurements":{"waist":"32","inseam":"32"}},{"size":"34x32","measurements":{"waist":"34","inseam":"32"}},{"size":"36x34","measurements":{"waist":"36","inseam":"34"}},{"size":"38x34","measurements":{"waist":"38","inseam":"34"}},{"size":"40x32","measurements":{"waist":"40","inseam":"32"}}]$j$::jsonb,
   '⚠ THE BRAND-MATCH IS "duluth trading", NEVER A BARE "duluth" — Duluth Pack (est. 1882) is a DIFFERENT company and a bare "duluth" must not reach this chart (the pack''s headline refusal). Duluth Trading men''s pants use a numeric WAIST x INSEAM grid; Fire Hose canvas is cut relaxed/gusseted. Approximate — verify against the labelled size.',
   'https://www.duluthtrading.com/', 0.65, false, 'migration:00469'),

  ('pendleton', 'Pendleton', ARRAY['pendleton']::text[], 'Men',
   'Wool shirts & tops (alpha, CHEST inches)',
   ARRAY['shirt','top','board shirt','wool shirt','overshirt','jacket']::text[],
   $j$[{"size":"S","measurements":{"chest":"35-37","neck":"14.5-15"}},{"size":"M","measurements":{"chest":"38-40","neck":"15.5-16"}},{"size":"L","measurements":{"chest":"41-43","neck":"16.5-17"}},{"size":"XL","measurements":{"chest":"44-46","neck":"17.5-18"}},{"size":"XXL","measurements":{"chest":"47-50","neck":"18.5-19"}}]$j$::jsonb,
   '⚠ VINTAGE PENDLETON WOOL SHIRTS OFTEN RUN SMALLER / BOXIER than the modern alpha grid above (mid-century sizing + wool shrinkage) — measure the actual chest flat rather than trusting the tag''s alpha letter. The chest/neck grid here is the modern approximation. ⚠ BLANKETS ARE NOT SIZED BY THIS CHART — they ship in fixed bed dimensions (throw / twin / queen / king). Remember the tag ERA, not the size, drives vintage value.',
   'https://www.pendleton-usa.com/', 0.65, false, 'migration:00469'),

  ('barbour', 'Barbour', ARRAY['barbour']::text[], 'Men',
   'Waxed & quilted jackets (UK alpha / CHEST inches)',
   ARRAY['jacket','coat','waxed jacket','quilted jacket','outerwear','gilet']::text[],
   $j$[{"size":"S","measurements":{"chest":"36-38","uk":"S"}},{"size":"M","measurements":{"chest":"38-40","uk":"M"}},{"size":"L","measurements":{"chest":"40-42","uk":"L"}},{"size":"XL","measurements":{"chest":"42-44","uk":"XL"}},{"size":"XXL","measurements":{"chest":"44-46","uk":"XXL"}}]$j$::jsonb,
   '⚠ BARBOUR IS UK-SIZED and its WAXED jackets are cut CLOSE / for country layering — many buyers size UP one from their usual jacket size to layer knitwear underneath, so a Barbour "L" is not a US "L". Barbour also labels some jackets by NUMERIC chest (C38/C40 = 38in/40in chest). Read the label; the interior style code (MWX/LWX, see the decoder) also carries the size. Approximate — verify.',
   'https://www.barbour.com/', 0.70, false, 'migration:00469'),

  ('orvis', 'Orvis', ARRAY['orvis']::text[], 'Men',
   'Tops & outerwear (alpha, CHEST inches)',
   ARRAY['top','shirt','jacket','coat','vest','barn coat','field coat']::text[],
   $j$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$j$::jsonb,
   'Orvis men''s tops/outerwear run alpha S-XXL against a chest grid (approximate — verify against the garment). Field/barn coats are cut for layering and measure generously; measure the actual chest flat. Orvis publishes garment-specific charts per item.',
   'https://www.orvis.com/', 0.60, false, 'migration:00469')
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
insert into public.applied_migrations (version) values ('00469') on conflict do nothing;
