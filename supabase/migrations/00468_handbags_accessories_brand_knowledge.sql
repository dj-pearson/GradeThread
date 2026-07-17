-- US-1988: Handbags & accessories brand knowledge (9 brands).
--
-- Longchamp, Marc Jacobs, Rebecca Minkoff, Fossil, Vera Bradley,
-- Dooney & Bourke, Brahmin, Tumi, Herschel Supply Co. ALL NINE WERE
-- PASSTHROUGH-ONLY. The first ACCESSORY-FIRST group in the KB: every pack from
-- 00443..00467 graded GARMENTS, and this one grades BAGS.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THAT CATEGORY SHIFT IS THE WHOLE PACK, AND NOT A COSMETIC DETAIL
--
--   A BAG CARRIES LESS RECOVERABLE INFORMATION ON ITS BODY THAN A GARMENT DOES.
--
-- That single sentence explains why BOTH of this story's stated premises died in
-- research, and it is why these nine belong together:
--
--   1. **RN IS A CATEGORY ERROR HERE, NOT A RESEARCH FAILURE.** Every prior pack
--      recorded "no RN — the FTC database is a JS shell that returns nothing to
--      automation" (00460/00466/00467). That is an ACCESS excuse. The real reason
--      is STATUTORY: an RN is issued to firms handling products covered by the
--      Textile / Wool / Fur Acts, and the FTC states that textiles used in
--      HANDBAGS AND LUGGAGE are EXCLUDED from textile labeling unless a fiber
--      claim is made. A leather handbag is not a covered product, so there is no
--      RN to find. Absence here is CORRECT and must never be read as a red flag.
--      ⚠ AND THE EXEMPTION IS PROVEN BY ITS OWN EXCEPTION — see Marc Jacobs
--      below, the ONLY brand in this pack with a sourced RN, and it has one
--      precisely because it sells READY-TO-WEAR. The RN lives where the TEXTILE
--      lives. It is not on the bag.
--
--   2. **THE STYLE CODE IS NOT ON THE BAG — IT LEFT WITH THE HANGTAG.** In
--      apparel the code is PRINTED ON THE SEWN TAG, which is why 00460 (Canada
--      Goose) and 00467 (Peter Millar) could ship cut-tag decoders: the care
--      label survives the collar tag being cut. A bag has no care label. Its code
--      lives on a REMOVABLE PAPER HANGTAG or only in the web catalogue — and
--      hangtags come off before resale. THIS IS CHECKABLE AGAINST OUR OWN KB
--      RATHER THAN MERELY ASSERTED: Coach (00398) SEWS a creed patch carrying the
--      style number INTO the bag, and it got a decoder. A bag CAN carry a code.
--      These nine (Coach excepted) simply do not.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PACK'S HEADLINE REFUSAL: **RN 17257 IS NOT LONGCHAMP.**
--
-- This is the single most dangerous fact in the group, and it is the exact
-- failure mode the sourcing policy exists to prevent — a REAL FEDERAL RECORD,
-- the RIGHT BRAND STRING, and COMPLETELY THE WRONG COMPANY. The FTC register
-- returns exactly one hit for "longchamp":
--     RN 17257 — LONGCHAMP FABRICS CORP — Product line: "Material" —
--     1412 Broadway, New York NY 10018 — a NYC garment-district FABRIC WHOLESALER.
-- The French maison's registrant would be S.A.S. Jean Cassegrain, which has NO RN.
-- A scraper that searched the register for "longchamp" and took the hit would
-- seed an authoritative-looking lie. Seeded as an explicit NEGATIVE, and fixtured.
-- This is the RN-layer twin of 00467's bare-"Brooks" refusal.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE DECODER — **FOSSIL**, AND IT IS THE ONLY BRAND HERE THAT ISN'T A BAG.
-- The bar (00460): tag-printed AND regular AND brand-unique in FORMAT.
--
--   * FOSSIL `ES5331` / `FS4736` / `FTW1234` — CLEARS IT, and note WHY it is the
--     lone survivor: A WATCH IS NOT A BAG. Its code is on the METAL CASE BACK.
--     Fossil's own support states the style number "is located on the back of the
--     watch" and gives ES1234 and FTW1234 as its OWN examples. And the string is
--     not merely a web SKU: fossil.com's structured product data emits
--     "sku":"ES5331" / "id":"ES5331" — the catalogue key and the physical mark are
--     THE SAME STRING. A case back cannot be removed the way a hangtag can, so
--     this is the pack's cut-tag case: an engraved code outlives the bracelet, the
--     box and the papers.
--
--     ⚠ **THE PATTERN IS DELIBERATELY PREFIX-ANCHORED, AND THAT IS THE SAFETY
--     MECHANISM, NOT A STYLISTIC CHOICE.** `^(?:ES|FS|FTW)\d{4,5}$` — NOT a
--     generic two-letters-plus-digits. FOSSIL GROUP MANUFACTURES ~47% OF ITS
--     OUTPUT UNDER OTHER BRANDS' NAMES (its own 10-K: licensed product = 47.3% of
--     net sales, MICHAEL KORS ALONE 19.2%), and those carry MK/AR/AX/DZ codes.
--     decodeTagCode runs specs INSIDE AN ALREADY-RESOLVED PACK, so a permissive
--     `[A-Z]{2}\d{4}` under the Fossil pack would decode a Michael Kors `MK8017`
--     and then spell the brand "Fossil" from pack.brand — silently retitling a
--     Michael Kors watch, which IS ALREADY A CANONICAL BRAND IN THIS KB. Anchoring
--     the prefixes makes that impossible BY CONSTRUCTION. Contrast Coach (00398),
--     whose `^F?[0-9]{4,6}$` is exactly the bare digit run the later bar forbids.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE REFUSALS ARE THE REST OF THE DELIVERABLE (all fixtured as negatives in
-- brand-knowledge-golden_test.ts — a refusal that isn't tested is a comment).
-- Each code below is REAL; each fails a different clause of the bar:
--
--   * TUMI's 20-digit TRACER — the story notes name it as a code to seed, and it
--     is REFUSED ON THE 00460 RULE: it is a BARE DIGIT RUN. Tumi documents it
--     precisely (a metal plate, "not all products have tracer numbers"), so it is
--     genuinely tag-borne — but a pattern over 20 digits mints a false positive
--     from any long number on any tag. Same call as Moncler's serial and Canada
--     Goose's hologram (the Chanel rule, US-1736): informational tell, not decoder.
--     ⚠ It is ALSO the pack's cleanest AUTHENTICATION INVERSION: Tumi says the
--     code "cannot be duplicated", but a plate is STAMPABLE and the number is
--     READABLE OFF A PHOTO. Only a DATABASE LOOKUP authenticates. A Tracer plate
--     visible in a listing photo proves NOTHING.
--   * DOONEY & BOURKE's REGISTRATION NUMBER — the story notes name this one too.
--     It is the pack's most interesting refusal because it is the ONLY code here
--     CONFIRMED PHYSICALLY PRESENT on a sewn tag (on the REVERSE of the red/white/
--     blue tag) — and it is refused anyway, on TWO independent grounds. (a) It is
--     a REGISTRATION number, not a style/size code: it identifies a UNIT, so
--     capturing it into styleCode would write a per-unit serial into a field that
--     names a MODEL. (b) ITS SEMANTICS ARE FLATLY CONTRADICTED: one collector
--     source says the six digits encode the YEAR, another says they are a plain
--     unique number with NO date. NEITHER cites Dooney, NEITHER decodes a worked
--     example, and one author explicitly disclaims expertise. A date field that is
--     right most of the time and silently wrong the rest is worse than none.
--     The country-letter prefix IS seeded as an informational tell (A/B = USA,
--     C = Costa Rica, H/J/K/L = China, I = Italy, M = Mexico) at low confidence.
--   * BRAHMIN `S10 151 00001` — the most decoder-SHAPED refusal in the pack, and
--     the best-evidenced: [style 3][material 3-4][colour 5], TRIPLE cross-validated
--     (00001 = Black across 3 styles AND 3 materials; 01316 = Tri-Color across 3
--     styles; 00050 = Multi across 2 materials). Refused anyway: every instance
--     came from a URL. SHAPE IS NOT PROVENANCE (the 00467 rule). It is an
--     excellent LISTING parser and is documented as such in the notes — it is not
--     a thing to read off a bag.
--   * LONGCHAMP `L2605 089 001` — [L][model 4][material 3][colour 3]. The 4-digit
--     model is provably brand-internal: LONGCHAMP PLEADS "Style 1623" IN ITS OWN
--     FEDERAL COMPLAINT. Still refused as a TAG code: nothing puts it on the bag,
--     and Longchamp's FAQ mentions interior labels ONLY for country of assembly.
--   * REBECCA MINKOFF `HS23MMBXBO` — refused, and the evidence is unusually sharp:
--     across forum threads where owners photograph and transcribe interior tags
--     constantly, NOBODY quotes a style code off a sewn tag; the only sellers
--     quoting codes are NWT listings. THE CODE IS ON THE HANGTAG. It is also not a
--     stable per-style key (one named style carries 5+ codes across seasons).
--   * MARC JACOBS — refused for a different reason again: there is no ONE format.
--     The site exposes at least FOUR incompatible shapes (M0016161 / H020L01FA21 /
--     2S3HCR500H03 / and an EAN-13 BARCODE 191267866253 that is not a style number
--     at all). MJ's FAQ does confirm a style number is "marked on the interior
--     tag" — but tag-string == web-SKU is UNPROVEN, so there is nothing to anchor.
--   * VERA BRADLEY `26468t77` and HERSCHEL `10014-00001-OS` — plain web SKUs.
--     Herschel's refusal has a positive tell behind it: its warranty flow is the
--     one place a code would be requested and it asks only for a PHOTO of the
--     liner/satin tag plus proof of purchase — it never asks the owner to READ a
--     number off the bag. That absence is evidence.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- COLORWAYS: THREE BRANDS QUALIFY, SIX DO NOT, AND THE TEST IS "CODE-BACKED OR
-- RULE-SHAPED", NOT "HAS NICE NAMES".
--   * LONGCHAMP + TUMI qualify because the colour is CODE-BACKED and the code is
--     durable ACROSS models and categories: Longchamp 001 = Black on L2605/L1899/
--     L1625; Tumi 1041 = Black across 13+ styles spanning luggage, a card case, an
--     umbrella and fabric cleaner. That is an internal colour master list made
--     externally visible — a true enum. Tumi's codes are ALPHANUMERIC (A639, T522,
--     B186): parse as string, never as int.
--   * VERA BRADLEY qualifies for the opposite reason and INVERTS THE PACK'S WHOLE
--     WEIGHTING: it has NO code at all, but THE PATTERN IS THE IDENTITY AND THE
--     PRICE DRIVER. VB protects ~1,000 COPYRIGHTS on its patterns and trademarks
--     only the NAME — the inverse of most fashion brands, and the reason its
--     silhouettes are near-duplicates while its patterns are hyper-identifiable.
--   * REFUSED: Brahmin (Melbourne is a MATERIAL, not a colour — see its notes),
--     Fossil (plain descriptive fields: "Strap Color: Silver"), Marc Jacobs,
--     Rebecca Minkoff and Herschel (per-season copy; RM's durable part is HARDWARE
--     FINISH — Antique Brass / Black Shellac — not colour).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY **NOT** RECORDED. This list is part of the deliverable.
--
--   * **VERA BRADLEY'S RETIRED-PATTERN REGISTER, AND THE URL THAT LIES.**
--     verabradley.com/collections/retired-patterns-archive DOES NOT SERVE RETIRED
--     PATTERNS. Its own metadata reads page_handle:"patterns", its <title> is
--     "Vera Bradley Patterns", the word "retired" appears NOWHERE in the body, and
--     the 20 names it renders are CURRENT-SEASON. An agent that trusts the slug
--     seeds CURRENT patterns LABELLED RETIRED — the exact inversion of the truth,
--     on the one field that drives this brand's price. The 20 current names ARE
--     seeded (sourced, 0.9); NO retirement date is, anywhere. Every circulating
--     "Java Blue retired Fall 2010"-style date traces to a FAN WIKI.
--   * **FOSSIL'S ES/FS/AM PREFIX MEANINGS.** fossil.com's "Fossil Brand Codes"
--     page ranks #1 for the query and DECODES NOTHING — it is about the Fossil
--     Crest, Signature Knurling and the Heritage D-Link. A second search trap. The
--     popular gloss "ES = Fossil Steel" is refuted by Fossil's own catalogue:
--     ES4343 is a LEATHER-strap Carlie. The ES/FS split tracks GENDER, and even
--     that is an OBSERVED correlation (0.55), not a sourced rule.
--   * **TAG-ERA CHRONOLOGIES FOR SIX OF THE NINE.** No source reaches the physical
--     tag of Longchamp (beyond country of assembly), Marc Jacobs, Fossil, Vera
--     Bradley, Brahmin or Herschel. Corporate dates are NOT tag tells: Vera
--     Bradley's 10-K shows NO manufacturing milestone at its 2010 IPO, so the
--     popular "China tag ⇒ post-IPO" is unsourced AND too clean — VB ran ~54-70%
--     China with the balance in Vietnam/Myanmar/Cambodia, so a contemporaneous bag
--     could read any of four countries.
--   * **"MADE IN CHINA ⇒ FAKE"** for Longchamp — REFUTED BY LONGCHAMP ITSELF,
--     which names Chinese partner workshops in its own FAQ. Seeded as an ACTIVE
--     FALSE TELL to suppress, alongside Herschel's identical "not Canada ⇒ fake"
--     (whose own source concedes 15 Chinese factories one sentence later).
--   * **THE DOONEY DATE DECODE** and **BRAHMIN'S USA→OFFSHORE CUTOVER YEAR** —
--     contradicted / forum-only respectively.
--   * **A FOSSIL "DEFENDER" WALLET.** It does not exist; the Derrick line does.
--     Recorded because the name is plausible enough to be confabulated on demand.
--   * **MARC JACOBS' SNAPSHOT DEBUT YEAR** — three-way split, and notably the
--     BRAND (2018) contradicts two retail sources (2016 / "Spring '16 runway"). A
--     brand is not automatically right about its own marketing history.
--   * **LONGCHAMP'S FOUNDER** — the Story page says Jean Cassegrain, the FAQ says
--     Philippe. Brand vs itself; both recorded, neither picked.
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00467
-- convention). Confidence is DELIBERATELY UNEVEN: a court-enumerated fingerprint
-- is 0.85; a brand whose site 403s everywhere is 0.4 and says so in its note.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('longchamp', 'Longchamp',
   ARRAY['longchamp','longchamps','longchamp paris','lepliage','lepliageoriginal','roseau','jeancassegrain']::text[],
   ARRAY['foldable nylon totes','leather handbags','travel bags','small leather goods','backpacks']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Interior label = COUNTRY OF ASSEMBLY, and nothing else","years":"current","description":"THE ONLY BRAND-SOURCED PHYSICAL-TAG FACT FOR LONGCHAMP, and it is worth having precisely because it BOUNDS what the tag can tell you. Longchamp's own FAQ: the maison is transparent about where its designs are assembled, \"displaying the information on the labels inside its bags\". So the interior label carries the ASSEMBLY COUNTRY — it does NOT carry a style number, a serial or a date. Production runs across six sites in western France (Mayenne, Vendée, Maine-et-Loire, Orne) plus Tunisia and Mauritius, plus partner workshops in France, China, Romania and Morocco."},{"era":"Recycled-canvas transition","years":"from 2019","description":"⚠ SEEDED AS A REFUSAL. Longchamp began transitioning to recycled synthetics in 2019 and the current Le Pliage Original is \"recycled polyamide canvas\" — both brand-sourced. But NO source describes the physical LABEL wording changing, so this is an INFERENCE about a composition label, not a tag tell. Do not date a bag from it."}]$j$::jsonb,
   $j$[{"pattern":"France, Tunisia, Mauritius, China, Romania, Morocco","note":"⚠ COUNTRY OF ORIGIN DATES NOTHING AND PROVES NOTHING FOR LONGCHAMP. The brand names Chinese partner workshops in its OWN FAQ — see the authentication tells, where \"made in China means fake\" is suppressed as an active false tell."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"Longchamp operates NO authentication service and NO serial lookup. Its FAQ says outright that it \"can neither guarantee nor verify the authenticity of an item bought outside of an official point of sale\" — the original invoice is the proof of purchase. There is nothing to authenticate against. Grade condition only; route authenticity to human review."},{"tell":"⚠ \"MADE IN CHINA MEANS FAKE\" IS AN ACTIVE FALSE TELL — suppress it","detail":"⚠ THE HIGHEST-FREQUENCY LONGCHAMP ERROR IN RESALE, and it is REFUTED BY LONGCHAMP ITSELF: the brand's own FAQ names partner workshops in China (alongside France, Romania and Morocco). Encoding this would accuse genuine bags. Country of origin is not an authenticity signal for this brand in either direction."},{"tell":"The distinctive features are enumerated BY A COURT — the best-sourced fingerprint in this pack","detail":"The Milan Court of First Instance (10280/2021) enforced Longchamp's 3D EU trade marks 013928528 / 014461958 over the Le Pliage shape and listed its characterizing elements: the trapezoid shape; the slightly circular leather element between the handles; the contour stitching on the front; the tubular handles ending in circular elements each side; the small leather tabs at the sides of the zipper; the leather/nylon contrast. Note the honest limit: COPYRIGHT protection was REJECTED — only the 3D marks were enforced. See the style row."},{"tell":"The circulating tag/serial checks are blog-only and invertible","detail":"⚠ NOT SOURCED: the AA = France / AE = China / AB = Tunisia \"country codes on the white tag\", the \"serial must match the plastic bag\" rule, font and stitch-count checks. None trace to Longchamp or any authenticator; all are trivially invertible; and the packaging match is unfalsifiable in resale, where the packaging is gone. Longchamp DOES litigate real counterfeits (the GMG Heartstrings and Amazon actions), so fakes exist — there is simply no published tell to check them against."}]$j$::jsonb,
   'Founded 1 February 1948 by JEAN CASSEGRAIN, starting with LEATHER-COVERED PIPES — the brand''s own Story page. Still privately owned and managed by the Cassegrain family (grandson Jean Cassegrain CEO; Sophie Delafontaine creative director); NO acquisition of or by Longchamp was found. Named for the PARIS LONGCHAMP RACECOURSE (singular) — which is why "Longchamps" with a trailing s is the highest-volume misspelling. The logo is a galloping horse by Turenne Chevallereau. Le Pliage arrived 1993, designed by Philippe Cassegrain, inspired by ORIGAMI. ⚠ LONGCHAMP CONTRADICTS ITSELF ON ITS FOUNDER: the Story page names JEAN as founder and Philippe as his son, while the FAQ calls PHILIPPE "the Maison''s founder". Both are brand copy; the disagreement is recorded, not resolved. ⚠ **NO RN IS SEEDED, AND THE REASON IS A TRAP RATHER THAN A GAP: RN 17257 EXISTS, MATCHES THE STRING "LONGCHAMP", AND IS NOT THIS COMPANY** — it is LONGCHAMP FABRICS CORP, product line "Material", 1412 Broadway New York, a garment-district FABRIC WHOLESALER. The maison''s registrant would be S.A.S. Jean Cassegrain (12 rue Saint-Florentin, Paris — the owner of record on its US trade marks), which has NO RN. Handbags are outside the Textile Act anyway, and Longchamp is French, so no RN is EXPECTED. Ingesting 17257 would seed an authoritative-looking lie. ⚠ MATCH ON THE 4-DIGIT MODEL NUMBER, NEVER THE SIZE LETTER — see the size chart.',
   'https://www.longchamp.com/', 0.85, false, 'migration:00468'),

  ('marcjacobs', 'Marc Jacobs',
   ARRAY['marcjacobs','markjacobs','marcjacob','themarcjacobs','marcjacobsinternational','littlemarcjacobs']::text[],
   ARRAY['canvas totes','camera bags','crossbody','small leather goods','ready-to-wear','footwear']::text[],
   ARRAY['RN 96919','RN 103927']::text[],
   $j$[{"era":"The Milton Glaser logotype on bags","years":"from 2019","description":"THE BRAND'S ONE DATED, PHYSICAL, BRAND-SOURCED PRODUCT TELL. \"The Marc Jacobs\" line launched May 2019 with a redesigned logo built on the NEW YORK MAGAZINE logotype drawn by Milton Glaser in 1968, and the brand's own release says it was applied \"across RTW, sandals and bags including The Snapshot\". So the oversized Glaser lettering is a floor: a bag carrying it should not predate 2019. Corroborated by the trademark record — THE MARC JACOBS (reg. 5953473) claims first use in commerce 3 December 2018."},{"era":"A \"Marc by Marc Jacobs\" label","years":"⚠ EXPIRING — do not treat as permanent","description":"⚠ A RULE WITH A LIVE EXPIRY DATE, WHICH IS WHY IT IS SEEDED AS A CAVEAT RATHER THAN A TELL. Marc by Marc Jacobs launched ~2001 and was discontinued after FW2015, folded into the main line — so \"MBMJ label ⇒ pre-2016\" is a tempting era rule. TWO REASONS NOT TO TRUST IT: (a) no source describes the physical TAG, only the LINE's end; (b) THE MARK WAS RE-FILED AT USPTO ON 15 JUNE 2026 (serial 99885050, classes 018/025/035, LIVE, awaiting examination) — one month after the WHP sale. A revived line would make every such inference wrong. Weak prior, needs a review date."},{"era":"Style number marked on the interior tag","years":"current","description":"Marc Jacobs' own help/warranty flow instructs customers to photograph \"the tag with the style number marked on the interior tag\" — so a style number IS physically present, unlike most of this pack. It is NOT decoded: see the notes and the golden negatives — the site exposes at least FOUR incompatible code shapes and tag-string == web-SKU is unproven, so there is nothing stable to anchor a pattern to."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"Marc Jacobs publishes no authentication guide, no serial system and no verification portal. The style number on the interior tag is a COMPLETENESS check, not an authenticity check. Grade condition only; route authenticity to human review."},{"tell":"The circulating \"real vs fake\" tells are authentication-service content marketing — reject them","detail":"⚠ NOT SOURCED: \"authentic letters are small and bold, pressed firmly into the leather\" vs replicas' \"blown up and skinny\" font, and the \"made in + season code under the interior pocket\" rule. Every instance traces to commercial legit-check services with a product to sell. All are subjective, unphotographable at seller-grade resolution, and directly invertible."},{"tell":"⚠ THE TOTE BAG is NOT a registered US mark — do not lean on trademark status","detail":"The applications for THE TOTE BAG (serials 98066613 / 98066554 / 98066629 and others, filed 30 June 2023 as class 035 SERVICE marks) were all ABANDONED for want of a Statement of Use. Combined with a generic silhouette, this is why the dupe market is rampant and why the LOGOTYPE — not the shape — is the only real cue. Expect low-confidence identification on this class. SNAPSHOT could not be found as an MJ mark at all; the one SNAPSHOT registration located belongs to an unrelated company."}]$j$::jsonb,
   'Founded 1984 by Marc Jacobs and Robert Duffy; LVMH took a majority stake in 1997 and stewarded it for nearly 30 years. ⚠ OWNERSHIP IS CHANGING RIGHT NOW AND THE DEAL HAS NOT CLOSED: on 14 May 2026 LVMH and WHP GLOBAL announced a definitive agreement for WHP to acquire the brand, with G-III Apparel Group joining as CO-OWNER operating certain DTC/wholesale segments; closing is expected before year-end 2026, so AS OF THIS SEED LVMH IS STILL THE OWNER OF RECORD. Marc Jacobs continues as founder and creative director. The $850M figure ($425M each) is Forbes/BoF reporting — THE OFFICIAL RELEASE DISCLOSES NO PRICE. WHP Global also owns Bonobos (00467), so a shared parent is not a signal. ⚠ **THE RNs ARE REAL AND THEY PROVE THE PACK''S RULE RATHER THAN BREAKING IT.** RN 96919 (MARC JACOBS INTERNATIONAL, LLC — product line CLOTHING) and RN 103927 (MARC JACOBS, INC. — WOMEN APPAREL), both traced to the FTC register at 72 Spring Street. MARC JACOBS IS THE ONLY BRAND IN THIS PACK WITH AN RN **BECAUSE IT IS THE ONLY ONE WHOSE RN-BEARING PRODUCTS ARE GARMENTS** — both product lines are apparel. ⚠ SO DO NOT EXPECT RN 96919 ON A SNAPSHOT: an RN belongs on a garment care label, and handbags are outside the Textile Act. Two live RNs for two entities also means an RN cannot disambiguate line or era. ⚠ THE IP SITS IN A THIRD ENTITY (Marc Jacobs Trademarks, L.L.C.) — three distinct legal entities for one brand. ⚠ "Marc by Marc Jacobs" is a SEPARATE NODE, not an alias: different line, different era, and possibly revived (serial 99885050, filed 15 Jun 2026).',
   'https://www.marcjacobs.com/', 0.75, false, 'migration:00468'),

  ('rebeccaminkoff', 'Rebecca Minkoff',
   ARRAY['rebeccaminkoff','rminkoff','rebeccaminkoffhandbags']::text[],
   ARRAY['handbags','crossbody','backpacks','small leather goods','contemporary rtw','footwear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Metal nameplate → leather tag","years":"~2011-2012 (approximate)","description":"⚠ COLLECTOR-SOURCED, NOT BRAND-SOURCED. Owners report the interior METAL NAMEPLATE giving way to a LEATHER tag around the blue/white polka-dot lining era. The direction is corroborated across owner threads; the YEAR is not. Treat as a prior, never as dispositive."},{"era":"Lining print sequence","years":"UNMAPPED — the years are NOT recoverable","description":"⚠ SEEDED AS A HALF-FACT, DELIBERATELY. Collectors date early RM bags by LINING: cheetah and \"X\" lining (both brown), then a dash lining (black with white dashes), then blue/white polka dot — and early linings reportedly changed every year or season. THE SEQUENCE IS REPORTED; THE YEAR MAPPING IS NOT RECOVERABLE (the forum's reference library 403s to automation). So a lining can ORDER two bags relative to each other but cannot DATE either. Do not invent the mapping."},{"era":"Country-of-origin tag presence","years":"direction only, NO date","description":"⚠ THE DIRECTION IS OWNER-CORROBORATED; THE DATE IS REFUSED. Owners report that Made-in-USA (NYC) bags carry NO country tag at all, while China-made bags carry a white sewn tag saying so, sewn into the seam. The popular \"moved to China in 2008/2009\" date traces ONLY to a bag-manufacturer's SEO blog and an AI-generated wiki — refused. Rebecca Minkoff's own current pages state origin only as \"Imported\", so the brand gives no granularity either."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"The brand publishes NO authentication guide and describes no physical marker. Its only relevant statement is that rebeccaminkoff.com \"is the only authorized online ecommerce site of authentic Rebecca Minkoff products\" — a channel claim, not a product tell. Grade condition only; route authenticity to human review."},{"tell":"⚠ THERE IS NO SERIAL AND NO DATE CODE — absence is NORMAL, never a fake signal","detail":"No serial numbers and no date codes are used, consistent with their total absence across every owner thread where interior tags are photographed and transcribed. So a Rebecca Minkoff bag WITHOUT a serial is simply a Rebecca Minkoff bag. Treating the absence as suspicious would flag the entire genuine population."},{"tell":"\"Heavily counterfeited\" is community-attested, not documented","detail":"Long-running \"authenticate this\" and \"fakes/knockoffs\" threads establish that the PRACTICE exists — but no news coverage, no brand statement and no counterfeiting lawsuit filed by Rebecca Minkoff could be found. Calibrate the risk accordingly rather than assuming a luxury-tier fake market."},{"tell":"The circulating tells are listicle-sourced and invertible","detail":"⚠ NOT SOURCED: \"should smell like leather / feel like butter\", \"real hardware is sturdy and heavy; fakes feel tinny\", \"stamping crisp not blurry, no typos, patch neatly centred\". Consumer SEO content; subjective, not photo-gradeable, and satisfied by any competent counterfeiter. One widely-returned \"spot a fake\" guide is published by a REPLICA-HANDBAG VENDOR — an adversarial source."}]$j$::jsonb,
   'Founded 2005 by Rebecca Minkoff and her brother Uri; RTW added 2009. ⚠ THE OWNERSHIP CHAIN IS WIDELY GOT WRONG AND THE CORRECTION MATTERS: THERE WAS NO PRIOR CORPORATE PARENT. TSG Consumer Partners (2012) and Swire Brands (which exited in 2017 at a HK$94M loss, per Swire''s own annual results) held MINORITY stakes only — the Minkoffs sold their OWN company to SUNRISE BRANDS (announced 16 February 2022), which was the FIRST majority owner. WWD calls it an "asset sale" at $13-19M "according to sources"; ⚠ NO bankruptcy, ABC, foreclosure or receivership filing for Rebecca Minkoff exists, so do NOT infer insolvency from the word. (The "prior parent''s difficulties" story is REAL BUT ABOUT OTHER BRANDS — Joie/Equipment/Current-Elliott reached Sunrise via The Collected Group''s 2021 bankruptcy, not RM''s chain.) The trademark moved to North Star IP Holdings LLC at Sunrise''s Vernon CA address in Sep 2022. From Sept 2025 the brand runs on ~12 LICENSING deals with handbags going to Concept One. ⚠ Forbes says the sale was 2021 while WWD/BoF/FashionUnited say Feb 2022 — unresolved. Rebecca Minkoff remains creative director; Uri''s status after the 2022 transition is unknown. ⚠ A BARE "minkoff" IS DELIBERATELY NOT AN ALIAS: **URI MINKOFF IS A DISTINCT LABEL** with its own collection page and its own Poshmark brand node, so folding the surname would mis-brand his menswear (the AYR rule, 00467). A bare "RM" is likewise not an alias — it is real collector shorthand but is not brand-unique. No RN could be sourced; handbags are outside the Textile Act.',
   'https://www.rebeccaminkoff.com/', 0.75, false, 'migration:00468'),

  ('fossil', 'Fossil',
   ARRAY['fossil','fossilgroup','fossilwatches','fossilinc']::text[],
   ARRAY['watches','smartwatches','wallets','handbags','jewelry','leather goods']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Style number on the CASE BACK","years":"current","description":"THE PACK'S ONLY TAG-PRINTED, REGULAR, DECODABLE CODE — and the reason it exists is that A WATCH IS NOT A BAG. Fossil's own support states the style number \"is located on the back of the watch\" and gives ES1234 and FTW1234 as its own examples. It is not merely a web SKU: fossil.com's structured product data emits \"sku\":\"ES5331\" — the catalogue key and the physical mark are the SAME STRING. The case back cannot be removed the way a hangtag can, so the code outlives the bracelet, the box and the papers. See the seeded decoder. ⚠ Whether the mark is ENGRAVED or printed is NOT stated by Fossil for Fossil-branded watches (it is stated as engraved for the sibling Michele brand), so the durability is inferred."},{"era":"Carlie's redesigned '90s-inspired T-bar","years":"~2023 or later","description":"A brand-stated, photo-visible product change: Fossil describes the current Carlie as having \"a redesigned '90s-inspired T-bar and stunning new bracelet design\". A floor for that variant, not a ceiling."},{"era":"⚠ The Fossil Crest / Signature Knurling / Heritage D-Link are NOT era tells","years":"NONE — \"since the beginning\"","description":"⚠ SEEDED AS A REFUSAL, because Fossil's own \"Brand Codes\" page invites exactly this error. The Crest, the Signature Knurling (the diamond-etched texture on the crowns), the Heritage D-Link and the Legacy Charm are brand-published, visually checkable DESIGN SIGNATURES — and Fossil says they have been used \"since the beginning\", so THEY CARRY NO DATE SIGNAL AT ALL. They are brand-identification hints. They are not era tells and they are not authentication tells."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"⚠ A LISTING NAMING BOTH FOSSIL AND A LICENSED BRAND IS THE LICENSED BRAND — this is the brand's biggest resale hazard","detail":"⚠ FOSSIL GROUP MAKES ~47% OF ITS OUTPUT UNDER OTHER BRANDS' NAMES — its own 10-K puts licensed product at 47.3% of net sales, with MICHAEL KORS ALONE AT 19.2% and ARMANI AT 10.1%. Sellers routinely title these \"MICHAEL KORS by FOSSIL\". A watch branded Michael Kors IS a Michael Kors watch (already a canonical brand here) — Fossil merely manufactured it. THE MODEL-CODE PREFIX IS AUTHORITATIVE OVER THE TITLE TEXT: MK = Michael Kors, AR = Emporio Armani, AX = Armani Exchange, DZ = Diesel. ES/FS/FTW = Fossil. The seeded decoder is prefix-anchored so a licensed code can never mint \"Fossil\"."},{"tell":"⚠ Skagen, Michele, Relic and Zodiac are Fossil GROUP but are NOT the Fossil BRAND","detail":"Fossil Group's 10-K lists its OWNED brands as FOSSIL, SKAGEN, MICHELE, RELIC and ZODIAC (Skagen is OWNED, not licensed — a common error). A shared corporate parent is not a shared brand: a Relic watch is a Relic, and folding it onto Fossil would be the Todd Snyder / American Eagle mistake from 00467. Relic in particular is a Fossil-owned budget line and is frequently mis-titled as Fossil."},{"tell":"Never auto-authenticate","detail":"Fossil publishes no consumer authentication guide. The only brand-adjacent mechanism is style + serial number for warranty validation, plus a clause voiding warranty if \"serial numbers or product date codes or other tracking marks have been removed, altered, or obliterated\" — which confirms such marks exist but not what they look like. Grade condition only. ⚠ The circulating Fossil \"serial number decoder\" guides are content-farm inventions."},{"tell":"A caseback ATM rating that contradicts the model's spec is a real inconsistency signal","detail":"Fossil's own watch-education page notes the water resistance is marked on the caseback or dial. Since the official ATM rating per style number is published, a caseback marking that disagrees with the model's spec is a genuine, checkable inconsistency — flag it in condition notes only, never as an authenticity verdict."}]$j$::jsonb,
   'Founded 1984; Fossil Group, Inc. (NASDAQ: FOSL), Delaware. THE ONLY NON-BAG-FIRST BRAND IN THIS PACK, and it is here because it is an ACCESSORY house: watches, wallets, handbags, jewelry, belts and sunglasses. ⚠ ITS DEFINING KB FACT IS THE LICENSED-BRAND HAZARD — see the tells; nearly half its output is not branded Fossil, and Michael Kors is contractually locked in through 2027, so the hazard is not going away. ⚠ THE UNIT SPLIT IS A REAL PARSER TRAP: **FOSSIL WATCHES ARE SPEC''D IN MILLIMETRES AND FOSSIL BAGS/WALLETS IN INCHES**, within one brand — a parser that does not branch on category will read a 44MM case as 44 inches. ⚠ A FOSSIL COLLECTION NAME DOES NOT DETERMINE CASE SIZE: ES5331 is a 28MM/5ATM Carlie and ES4341P is a 35mm/3ATM Carlie, both titled "Carlie Three-Hand Stainless Steel Watch" — and fossil.com indexes ES5331 under BOTH "Carlie" and "Carlie Mini". THE CODE IS RELIABLE; THE NAME ATTACHED TO IT IS NOT. ⚠ THERE IS NO FOSSIL "DEFENDER" WALLET — the wallet line is DERRICK; the name is plausible enough to be confabulated on demand and is recorded here so it is not. ⚠ "fossil" IS AN ORDINARY ENGLISH NOUN — see DETECT_EXCLUDED_FROM_TEXT; the brand is reachable by TAG but must never be guessed from prose, or every "fossil fuel" and paleontology listing mints the brand. No RN could be sourced, and Fossil Group''s owned-plus-licensed portfolio spans many entities, so a single RN would not generalize.',
   'https://www.fossil.com/', 0.80, false, 'migration:00468'),

  ('verabradley', 'Vera Bradley',
   ARRAY['verabradley','verabradly','verabradely','verabradleydesigns','verabradleysales']::text[],
   ARRAY['quilted cotton bags','travel luggage','campus backpacks','totes','crossbody','womens accessories']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"China, Vietnam, Myanmar, Cambodia","note":"⚠ COUNTRY OF ORIGIN DOES NOT DATE A VERA BRADLEY BAG, AND THE POPULAR RULE IS TOO CLEAN. VB's own 10-K puts finished goods with global manufacturers \"primarily in China, Vietnam, Myanmar, and Cambodia\", with China cut from ~70% (FY2018) to ~54% (FY2019) as deliberate tariff de-risking. So a CONTEMPORANEOUS bag could read any of four countries — \"Made in China therefore post-IPO\" is unsourced, and VB's own timeline shows NO manufacturing milestone at the 2010 IPO."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"⚠ VERA BRADLEY PUBLISHES NO PRODUCT-LEVEL AUTHENTICATION TELLS AT ALL. Its Brand Protection page is entirely about FRAUDULENT WEBSITES, not counterfeit goods — it warns that scam sites use VB's images and trademarks, take payment and ship nothing. That is a payment-fraud problem, not a bag-grading problem. Grade condition only; route authenticity to human review."},{"tell":"⚠ \"IF IT ISN'T ON VERABRADLEY.COM IT'S FAKE\" IS CATASTROPHIC FOR RESALE — suppress it","detail":"⚠ THE MOST HARMFUL CIRCULATING VB TELL. Vera Bradley RETIRES PATTERNS CONSTANTLY — its own 10-K books inventory reserves against \"retired patterns\" — so virtually every AUTHENTIC secondhand VB bag is ABSENT from the current site. Applying this rule would fail the entire genuine resale population. VB even operates its own thredUP resale shop."},{"tell":"The quilting/zipper-pull tells are content-farm sourced and confounded","detail":"⚠ NOT SOURCED: \"genuine bags have a softer quilted texture; fakes are stiffer with printed designs instead of quilting\" and \"newer bags have ribbon zipper pulls with the VB logo, older bags have pulls matching the lining\". Both are subjective, invertible, and the quilting one is CONFOUNDED BY VB'S OWN NON-QUILTED LINES (microfiber, Performance Twill, Featherweight, Iconic) — roughly half of VB's products are cotton-based, so the rest legitimately are not quilted cotton."},{"tell":"The counterfeit risk is real and pattern-centric — because the PATTERN is the protected asset","detail":"VB's 10-K reports ~1,000 COPYRIGHTS plus the \"Vera Bradley\" trademark, and says it files actions alleging trademark counterfeiting that \"often result in seizure of counterfeit merchandise\", while noting foreign IP regimes \"particularly China\" may not protect proprietary rights equally. Note what that IP structure means: VB protects its PATTERNS BY COPYRIGHT and only the NAME by trademark — the inverse of most fashion brands, and why VB counterfeiting is pattern-driven."}]$j$::jsonb,
   'Founded 1982 in Fort Wayne, Indiana by Barbara Bradley Baekgaard and Patricia R. Miller; NASDAQ: VRA; IPO 2010. ⚠ NAMED FOR A CO-FOUNDER''S MOTHER — Vera Bradley is not the designer''s own label, and a model will confabulate a designer biography here. ⚠ **THIS BRAND INVERTS THE PACK''S USUAL WEIGHTING AND THAT IS ITS HEADLINE FACT: THE PATTERN IS THE IDENTITY AND THE PRICE DRIVER; THE STYLE IS NEARLY NOISE.** VB silhouettes are near-duplicates of one another across a dozen variants and across every fabric line, so style disambiguation from a photo is WEAK — but pattern disambiguation is STRONG. Weight accordingly. ⚠ **NO RETIREMENT DATES ARE SEEDED, AND THE REASON IS A URL THAT LIES**: verabradley.com/collections/retired-patterns-archive DOES NOT SERVE RETIRED PATTERNS — its own metadata reads page_handle:"patterns", the word "retired" appears nowhere in its body, and the names it renders are CURRENT-SEASON. An agent trusting the slug would seed CURRENT patterns LABELLED RETIRED, inverting the one field that drives this brand''s price. Every circulating pattern-retirement date (the "Java Blue introduced Winter 2006, retired Fall 2010" corpus) traces to a FAN WIKI with no citations — refused. ⚠ **THE REVIVAL TRAP**: VB recolours heritage prints under NEW names — "Neutral Rhapsody" is a recolour of Blue Rhapsody (2009) and several current prints are recoloured from a 1993 Tea Garden — so a NAME-SIMILARITY matcher will misprice a cheap current revival as a valuable retired original. ⚠ ONE PATTERN CAN BE TWO PRINTS ON ONE BAG: VB''s 10-K says each new pattern includes "a primary print and sometimes a secondary coordinating print", so a classifier may read the lining as a separate pattern. Fragrance and jewelry were discontinued spring FY2019. No RN could be sourced; handbags are outside the Textile Act.',
   'https://verabradley.com/', 0.80, false, 'migration:00468'),

  ('dooneybourke', 'Dooney & Bourke',
   ARRAY['dooneybourke','dooneyandbourke','dooney','dooneyburke','dooneybourk','downeybourke','allweatherleather','ilovedooney']::text[],
   ARRAY['handbags','all-weather leather','pebbled leather','licensed collab','small leather goods','coated cotton']::text[],
   ARRAY[]::text[],
   $j$[{"era":"AWL PATCH vs AWL MEDALLION — the only era tell here with a federal-record backbone","years":"patch = 1983 first use; medallion = 1991 first use","description":"THE BRAND'S BEST DATING TELL, and the only one NOT resting on collector folklore. Dooney registered the All-Weather Leather logo presentation as CONFIGURATION marks: the OVAL LEATHER PATCH (reg. 2252280, first use 1983) and the METAL MEDALLION (reg. 2252278, first use 1991), both over the registered pebble-grain TEXTURE (first used 1983). So: patch = 1983-era design language; medallion = 1991+. ⚠ These are first-use dates from a register, not a published tag chart — treat as orientation, and note the reading is one-directional."},{"era":"Sewn tag sequence","years":"⚠ COLLECTOR-SOURCED — priors only","description":"⚠ THE DATES BELOW COME FROM COLLECTORS, NOT FROM DOONEY, and the most detailed source explicitly disclaims expertise (\"we're not Dooney & Bourke handbag experts or historians\"). Two independent sites agree on the SEQUENCE, which is why this clears at all. 1981-82: NO sewn tag — the DB logo (a stylized REVERSED D) is stamped directly into the leather, sometimes with a solid brass rectangle. 1983-84: a GREEN SATIN tag, red DB centre, \"Made in USA\" — short-lived, so a strong marker if genuine. Mid-1980s-1990s: the RED/WHITE/BLUE sewn tag, red border, \"Dooney & Bourke, Inc.\" + \"Made in U.S.A.\", WITH THE REGISTRATION NUMBER ON THE REVERSE. Post-offshoring: the tag drops \"Made in USA\"."},{"era":"Brass fob sequence","years":"⚠ COLLECTOR-SOURCED — and a fob proves little","description":"⚠ WEAK, AND SEEDED WITH ITS OWN LIMIT. Reported sequence: solid brass RECTANGLE (very early 1980s), solid brass OVAL with a BLANK BACK (early 1980s), the brass DUCK fob with \"All Weather Leather®\" (early 1990s+), then the same duck in NICKEL (late 1990s). ⚠ A FOB PROVES NOTHING EITHER WAY: collectors concede vintage bags are routinely missing fobs or wearing the wrong one, and loose fobs are openly sold. A correct fob is weak positive evidence; a wrong fob is NOT evidence of a fake."},{"era":"The \"346\"-shaped trap does not exist here, but the logo patch varies BY COLLECTION","years":"current","description":"Dooney's OWN logo guide is authoritative on WHAT the patches are and SILENT ON WHEN — it contains no dates at all. AWL: oval leather patch embossed with the duck. Nylon: the same duck patch WITHOUT the \"All Weather Leather\" wording. Wayfarer/Ostrich: a minimalist brown duck with a DETACHED ORANGE BEAK. Classic Ostrich: a gold-tone \"Since 1975\" plate. Pebble Grain/Florentine: a leather patch at the BOTTOM-LEFT, DYED TO MATCH THE BAG BODY. Logo Lock: the logo IS the closure."}]$j$::jsonb,
   $j$[{"pattern":"USA (A, B), Costa Rica (C), China (H, J, K, L), Italy (I), Mexico (M)","note":"⚠ THE PREFIX LETTER OF THE REGISTRATION NUMBER REPORTEDLY ENCODES THE FACTORY COUNTRY — collector-sourced (two agreeing sites), NOT from Dooney, so ~0.5 at best. It is corroborated INDIRECTLY by corporate history rather than by the code: Dooney's own about page confirms the shift to Italian design/leather, and a 2006-era record has Peter Dooney saying \"If I was forced to produce overseas I would close the company\" — so a NON-USA prefix implies a roughly post-2006 bag. That is a coarse date signal derived from the ownership story, NOT from the digits. See the notes: THE SIX DIGITS ARE NOT DECODED."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No published authentication standard exists. Dooney offers a \"Register My Dooney\" service, but ⚠ IT AUTHENTICATES THE CARD, NOT THE BAG: it reportedly keys on a number printed on an included paper GUARANTEE CARD, and cards are trivially reproduced, transposed or sold separately. Registration lookup is NOT a reliable resale authenticity signal and must not be weighted as one. Grade condition only."},{"tell":"The pebble-grain TEXTURE is itself registered trade dress — a rare non-invertible signal","detail":"Unusually for this pack, Dooney's All-Weather Leather TEXTURE and CONFIGURATION are registered marks, not just its logo. Reproducing the texture is itself infringing, so texture quality is a real structural signal rather than a copyable printed mark. Still informational only — never emit a verdict."},{"tell":"The duck-casting and hardware tells are collector-sourced and invertible","detail":"⚠ \"Sharp detailed eye on the duck, space between bill and body, textured background\" and \"solid brass hardware, rivets stamped Dooney & Bourke\" are published critiques — which makes them a SPEC SHEET FOR BETTER FAKES. Useful against lazy fakes only, and brass-vs-plated is not photo-assessable."},{"tell":"⚠ \"Louis Vuitton v. Dooney & Bourke\" is NOT evidence of counterfeiting","detail":"A naive text scrape inverts this. The 2004-06 Multicolore litigation was a TRADE-DRESS DISPUTE BETWEEN TWO LEGITIMATE HOUSES. It says nothing about authenticating a Dooney, and must not raise a counterfeit score."}]$j$::jsonb,
   'Founded 1975 in Norwalk CT by Peter Dooney and Frederic Bourke Jr. — starting with BELTS, SUSPENDERS AND SMALL LEATHER GOODS FOR MEN; handbags came ~1981. ⚠ **THE REGISTRATION NUMBER IS THE ONLY CODE IN THIS ENTIRE PACK CONFIRMED PHYSICALLY PRESENT ON A SEWN TAG — AND IT IS STILL NOT DECODED.** It sits on the REVERSE of the red/white/blue tag, format [letter][digit] + 6 digits (A5 179535, A1 777853). It is refused as a decoder on TWO independent grounds. (a) It is a REGISTRATION number identifying a UNIT, not a style/size code identifying a MODEL — capturing it into styleCode would write a serial into a field that names a model. (b) ⚠ ITS SEMANTICS ARE FLATLY CONTRADICTED: one collector source says the six digits encode the STYLE, PLACE **AND YEAR**; another says the prefix is the factory and the remaining six are a plain unique number with **NO DATE**. NEITHER cites Dooney, NEITHER decodes a worked example, and nobody produced two bags of known different years showing the pattern. A year that is right most of the time and silently wrong the rest is worse than an absent one. Store the raw string; expose the country prefix only, at low confidence. ⚠ THE STYLE NUMBERS (vintage R28/R730/P07; modern 8L980NA/Q150CWH) ARE CATALOGUE SKUs — no source shows them on the bag, and Dooney''s own registration form reportedly asks for the SKU from the GUARANTEE CARD, i.e. from PAPER. ⚠ "D&B" IS DELIBERATELY NOT AN ALIAS AND THE COLLISION IS FOUR-WAY: Dun & Bradstreet, Dolce & Gabbana in some seller usage, Dooney''s OWN DB monogram, and its own SKU prefix. ⚠ NOTE "Dooney & Bourke" KEYS TO `dooneybourke` BUT "Dooney and Bourke" KEYS TO `dooneyandbourke` — both are aliased; they look like a duplicate line and are not. No RN is seeded: handbags are outside the Textile Act, so a "Dooney RN" in a listing is copied from an unrelated garment or confused with the registration number above.',
   'https://www.dooney.com/', 0.75, false, 'migration:00468'),

  ('brahmin', 'Brahmin',
   ARRAY['brahmin','brahminleatherworks','brahminhandbags','bramin','brhamin']::text[],
   ARRAY['handbags','croc-embossed leather','satchels','chamois-lined','small leather goods','ombre finishes']::text[],
   ARRAY[]::text[],
   $j$[{"era":"\"Made in USA\" on an older bag","years":"⚠ DIRECTION ONLY — NO CUTOVER YEAR IS SOURCED","description":"⚠ SEEDED WITH ITS LIMIT BECAUSE THE LIMIT IS THE POINT. Brahmin began in Massachusetts and now manufactures offshore, so \"Made in USA ⇒ older\" is directionally usable. THE TRANSITION DATE IS REFUSED: the only evidence is a c.2007 forum thread whose participants OPENLY DISAGREE (\"not every Brahmin is made in China, perhaps only certain styles\"), and Brahmin's own page says only that bags are DESIGNED in Massachusetts with materials \"sourced globally\" — conspicuously never stating where they are ASSEMBLED. Do not ship a year."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"No per-unit serial and no published authentication standard could be sourced. ⚠ \"Brahmin serial number\" IS A CATEGORY ERROR: registration asks for purchase date, location, product name and STYLE NUMBER — and a style number identifies a MODEL, not a UNIT, so it cannot be a serial. Unlike Dooney, Brahmin appears to have NO per-unit identifier at all. Grade condition only."},{"tell":"The chamois lining is the best of the brand's three stated hallmarks","detail":"Brahmin's stated hallmarks are a hanging medallion or logo plaque, the CHAMOIS interior lining, and the registration card. ⚠ RANK THEM HONESTLY: the CHAMOIS LINING is the strongest — a material property, photo-visible, costly to fake, not a printed mark. The brass medallion is moderate and its \"thin/blurry lettering\" critiques are invertible. THE REGISTRATION CARD IS NEAR-USELESS IN RESALE: it is PAPER INSIDE THE BAG — separable, transferable, and sold standalone. A card is not evidence about a bag. ⚠ The hallmark wording itself is quoted identically by several secondary sites and could NOT be verified on brahmin.com — its first-person voice suggests brand authorship, but convergence among copycats is not corroboration. Flagged for the US-1715 queue."},{"tell":"The croc emboss is high recall and poor precision","detail":"The bold croc-embossed scale pattern is Brahmin's most recognisable trait AND its most copied — it identifies the BRAND well and authenticates nothing. The \"how to spot a fake Brahmin\" listicle corpus (mutually plagiarised, several AI-generated, with a vacuous \"date codes (if present)\" hedge that asserts and disclaims in one breath) is refused entirely."}]$j$::jsonb,
   'Founded October 1982 by Joan and Bill Martin in Hingham MA — a basement studio and a barn factory, with Italian leather; now a 22,000 sq ft Fairhaven MA facility (1994). Still family-owned; all bags still DESIGNED in Massachusetts. Named as a deliberate BOSTON BRAHMIN reference. ⚠ **THE SKU IS THE BEST-EVIDENCED CODE IN THIS PACK AND IT IS STILL REFUSED AS A DECODER — THE CLEANEST DEMONSTRATION THAT SHAPE IS NOT PROVENANCE.** Format [style 3][material 3-4][colour 5], TRIPLE cross-validated in both directions: 00001 = Black across S10/V49/L20 AND across Melbourne/Wilde/La Scala; 01316 = Tri-Color across V48/T15/T59; 00050 = Multi across two materials. Styles: S10 Lorelei, V48/K43 Duxbury, V49 Large Duxbury, N79 Priscilla, N69 Medium Asher, T15 Esme, T59 Shayna, U82 Moira, L20 All Day Convertible. Materials: 151 Melbourne, 1708 Ombre Melbourne, 1289 Wilde, 626 La Scala, 2588 Bennet, 2529 Sunbeam. IT IS AN EXCELLENT **LISTING** PARSER AND NOTHING MORE: every instance came from a URL, and nothing confirms it on an interior tag. ⚠ IF YOU DO PARSE IT, PARSE RIGHT-TO-LEFT — the material field is 3 OR 4 digits (151 vs 1708) and a fixed-offset parser WILL corrupt data; last 5 = colour, first 3 = style, remainder = material. And it has a real counterexample: v48263340000050 is 15 chars and breaks the scheme. ⚠ K43 AND V48 ARE BOTH DUXBURY (legacy vs current numbering) — do not dedupe them as different bags. ⚠ **"MELBOURNE" IS A MATERIAL, NOT A COLOUR** — Brahmin''s own words, "our signature croc-embossed leather", its signature since 1982. The grammar is [Colour] [Material]: "Black Melbourne", "Carnation Melbourne". So the MATERIAL axis is durable (44 years) and the COLOUR axis is seasonal — model them separately, and never treat Melbourne as a style. ⚠ "Brahman" is a cattle breed AND a leather term — real search pollution. No RN could be sourced; handbags are outside the Textile Act. (An FTC filing under Brahmin Leather Works LLC exists but is a non-party motion in an unrelated docket — NOT an RN record.)',
   'https://brahmin.com/', 0.75, false, 'migration:00468'),

  ('tumi', 'Tumi',
   ARRAY['tumi','tumiinc','tumiholdings','alphabravo','tumitracer']::text[],
   ARRAY['carry-on luggage','checked luggage','briefcases','backpacks','travel accessories','ballistic nylon']::text[],
   ARRAY[]::text[],
   $j$[{"era":"A TUMI TRACER metal plate","years":"1999 or later","description":"THE PACK'S BEST-SOURCED PHYSICAL TELL — brand AND register agreeing on a year. Tumi's own history dates the Tracer program to 1999, and the TUMI TRACER trademark claims first use in commerce 31 August 1999; the USPTO goods recitation (\"tracking services for retrieval of ENCODED luggage\") independently corroborates physical encoding. So a bag bearing a Tracer plate should not predate 1999. ⚠ THE LOGIC IS ONE-DIRECTIONAL: plate present ⇒ 1999+; PLATE ABSENT ⇒ NOTHING, because Tumi states outright that \"not all products have tracer numbers\" and the program covers primarily wheeled luggage and bags."},{"era":"Ballistic nylon","years":"from 1983","description":"Tumi's own history dates its ballistic nylon to 1983. A material era, not a label change — it does not date a specific bag on its own."},{"era":"⚠ Collection launch dates are NOT tag tells","years":"Alpha 2008 / Alpha Bravo 2010 / 19 Degree 2016 / Voyageur redesign 2023","description":"⚠ SEEDED AS A REFUSAL. These are brand-sourced CORPORATE/PRODUCT dates and are useful context, but NO source describes Tumi's leather logo patch or wordmark changing on any date. Do not convert a collection launch into a tag tell."}]$j$::jsonb,
   $j$[]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate — and TUMI TRACER is the pack's cleanest authentication INVERSION","detail":"⚠ TUMI SAYS THE TRACER CODE \"CANNOT BE DUPLICATED, so you can rest assured that you're carrying a genuine TUMI product\". READ THAT CAREFULLY: it is a BRAND MARKETING CLAIM, not a verified property. A counterfeiter can stamp A 20-digit plate, and the number is READABLE OFF A PHOTO — so it is trivially copyable. The claim only holds if the number is CHECKED AGAINST TUMI'S DATABASE. **A TRACER PLATE VISIBLE IN A LISTING PHOTO IS NOT PROOF OF AUTHENTICITY.** This is the most likely way a naive rule misfires on this brand. Grade condition only."},{"tell":"Tracer ABSENCE is not evidence of a fake","detail":"Tumi states \"not all products have tracer numbers\" — accessories, older stock and some categories legitimately lack one. Tracer is also not valid in Hong Kong, Macau, Mainland China, Japan or Korea. Absence is normal."},{"tell":"Tumi's own counterfeit guidance is about fake WEBSITES, not fake bags","detail":"Tumi's fraud page covers spoofed domains and email, not product artifacts. THE BRAND PUBLISHES NO SPOT-THE-FAKE TELLS. Its authenticity test is CHANNEL + REGISTRATION — the Tracer ID can substitute for a receipt in warranty validation, and warranty applies only to authorized retailers. That is a database lookup and a document, neither of which a photo grader can reproduce."},{"tell":"⚠ The Tracer number and the STYLE number are DIFFERENT things","detail":"A 20-digit Tracer on a metal plate is not the 6-digit style number. Search-engine synthesis CONFLATES them (one result asserts \"the Tumi style/tracer number is a 20-digit number\") — that is wrong, and is exactly the kind of AI slop the KB exists to keep out."}]$j$::jsonb,
   'Founded 1975 by Charlie Clifford; named for the Peruvian TUMI ceremonial knife (Peace Corps Peru — the etymology is secondary-sourced, the 1975 founding is brand-sourced and corroborated by a first-use-in-commerce date of 1 May 1975). ⚠ OWNERSHIP: acquired by SAMSONITE — and get the date right, because Wikipedia conflates two: the deal was ANNOUNCED 4 March 2016 and COMPLETED 1 AUGUST 2016 (Samsonite''s own press release and the SEC filing), at US$1.8bn / $26.75 per share. Prior: Doughty Hanson 2004-2012, then NYSE:TUMI 2012-2016. ⚠ **THE 20-DIGIT TRACER IS REFUSED AS A DECODER ON THE 00460 BARE-DIGIT-RUN RULE** — it is genuinely tag-borne (a metal plate, in an interior pocket lining or on the exterior of some travel pieces), but a pattern over 20 digits would mint a false positive from any long number on any tag. Informational tell only; the same call as Moncler''s serial and Canada Goose''s hologram (the Chanel rule). ⚠ THE STYLE NUMBER IS ALSO REFUSED, AND ITS ABSENCE IS EVIDENCE: Tumi''s FAQ documents ONLY the Tracer plate location and has NO entry for finding a style number on the product — exactly where such an entry would live. ⚠ **TUMI RUNS THREE INCOMPATIBLE CODE FORMATS ON ITS OWN REGIONAL SITES**: NNNNNN-CCCC (uk/be/es/de), 0NNNNNNCCCC concatenated (US), and 464.NNNNNNNND (gr) — a parser keyed on one silently fails on the others. ⚠ SPECS DRIFT BY ERA AND BY REGION: the flagship 117154 carry-on is published as BOTH 35 L / 4.604 kg and 35/45 L / 4.946 kg on brand-owned sites. Do not pick a winner; era-scope spec equality. ⚠ NO AIRLINE-COMPLIANCE CLAIM IS SEEDED: Tumi publishes none, markets by regional cabin CONVENTION ("International" ~56cm), and expansion pushes a bag OUT of spec. No RN could be sourced; luggage is outside the Textile Act.',
   'https://www.tumi.com/', 0.80, false, 'migration:00468'),

  ('herschelsupplyco', 'Herschel Supply Co.',
   ARRAY['herschel','hershel','herschell','herschelsupply','herschelsupplyco','herschelsupplycompany','littleamerica']::text[],
   ARRAY['backpacks','duffles','hardshell luggage','totes','hip packs','wallets']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"China","note":"⚠ GENUINE HERSCHEL IS CHINA-MADE. See the authentication tells: \"not made in Canada therefore fake\" is an ACTIVE FALSE TELL whose own source concedes 15 Chinese factories one sentence later. The company is Canadian (Vancouver BC); its manufacturing is not."}]$j$::jsonb,
   $j$[{"tell":"Never auto-authenticate","detail":"⚠ HERSCHEL PUBLISHES NO SPOT-THE-FAKE TELLS. Its brand-protection position is entirely CHANNEL-BASED: it warns against \"flea markets, discount websites and third-party marketplaces\", says such goods \"cannot guarantee the quality or authenticity\" and are ineligible for warranty. The only brand-sanctioned signal is proof of purchase from an authorized retailer — a DOCUMENT, not a photo feature. Grade condition only."},{"tell":"⚠ \"NOT MADE IN CANADA MEANS FAKE\" IS AN ACTIVE FALSE TELL — suppress it","detail":"⚠ FALSE AND ACTIVELY HARMFUL, and it would misgrade the entire genuine population. The one source asserting it SELF-CONTRADICTS ONE SENTENCE LATER by noting manufacturing in 15 factories in China. Herschel is a Vancouver COMPANY; its bags are China-made. Refused with prejudice."},{"tell":"The woven patch and striped liner are the MOST-copied features, not the best tells","detail":"⚠ AN INVERTIBILITY WARNING ON THE BRAND'S OWN ARTIFACTS: the front woven label and the striped liner are Herschel's signatures, which is exactly why counterfeiters reproduce them first. A liner-stripe check is WEAK evidence of authenticity and near-ZERO evidence of fakeness. Corroborator only, never a decider. \"Consistent sewing means real\" is invertible and unfalsifiable from a photo."}]$j$::jsonb,
   'Founded 2009; Herschel Supply Company Ltd., Vancouver BC (first use in commerce 30 September 2009, corroborating the year). NAMED FOR HERSCHEL, SASKATCHEWAN — the brand''s own words, "a small town where three generations of the family grew up". ⚠ THE FOUNDERS (Jamie and Lyndon Cormack) ARE NOT NAMED ON HERSCHEL''S OWN ABOUT PAGE — that attribution is secondary, so hold it loosely. ⚠ **TAG ERAS ARE EMPTY ON PURPOSE AND THIS IS A REAL GAP, NOT AN OVERSIGHT**: no source describes any dated physical tag/patch change. What IS confirmed is that a physical interior tag EXISTS — Herschel calls it the "SATIN TAG" and its warranty flow requires a "Photo of Inside of Liner Showing Satin Tag" — but ITS PRINTED CONTENTS ARE UNKNOWN. The tempting liner tell (older bags reportedly used high-contrast multi-colour stripes; the current spec says "tonal stripe... 100% recycled polyester") IS UNSOURCED AND DELIBERATELY NOT SEEDED — resolving it needs Wayback captures, not more assertion. ⚠ **THE STYLE CODE IS REFUSED AND THE ABSENCE IS EVIDENCE**: 10014-00001-OS-format codes trace only to URLs and retailer listings, and Herschel''s warranty flow — the ONE place a code would naturally be requested — asks only for a PHOTO of the liner/satin tag plus proof of purchase. It NEVER asks the owner to read a number off the bag, and no Herschel page says where one would be. ⚠ **CAPACITY IS NOT A MODEL IDENTIFIER AND THIS IS A RESALE-MATCHING TRAP**: the Little America is published as 30L today and 25L in cached/older listings, the Mid as 21L vs 17L, and "Classic XL" names BOTH a 30L and a 26L bag. A 2015 and a 2025 Little America are BOTH genuine and DIFFERENTLY SIZED. Never grade a listing "misdescribed" on capacity alone; era-scope it. No RN could be sourced — and note a CA number (Canadian) would be the likelier artifact for this company than an RN, though neither was found.',
   'https://herschel.com/', 0.75, false, 'migration:00468')
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
-- prompt and collapses every authentication tell to ONE GENERIC LINE — so a fact
-- that must reach IDENTIFICATION belongs here or in a chart note, never in a tell
-- (US-1740). That is why the NON-SEPARABILITY warnings are seeded as first-class
-- style rows: in a pack of bags, "you cannot tell these two apart from a photo"
-- is the single most decision-relevant thing we know, and an un-warned model will
-- confidently name any quilted crossbody, because the names are in its weights.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- Longchamp — the court-enumerated fingerprint is the best-sourced row in the pack.
  ('longchamp', 'Le Pliage Original', 'Unisex', 'bag', 'Le Pliage',
   'THE PACK''S BEST-SOURCED FINGERPRINT, AND IT WAS ENUMERATED BY A COURT. The Milan Court of First Instance (10280/2021), enforcing Longchamp''s 3D EU trade marks 013928528/014461958, listed the Le Pliage''s characterizing elements: **the TRAPEZOID shape**; **a slightly circular LEATHER ELEMENT BETWEEN THE HANDLES** (the flap); **contour STITCHING ON THE FRONT**; **TUBULAR HANDLES ENDING IN CIRCULAR ELEMENTS** at each side; **small LEATHER TABS at the sides of the zipper**; and the leather/nylon contrast. **IT FOLDS FLAT** — the strongest single tell. Note the honest limit: the court REJECTED copyright protection and enforced only the 3D marks, so this is a list of distinctive features, not a certificate. Designed 1993 by Philippe Cassegrain, inspired by ORIGAMI. ⚠ THE SIZE NAME IS NOT RELIABLE — see the chart: match on the 4-digit model.',
   ARRAY['recycled polyamide canvas','Russian leather (cowhide) trim']::text[], '1993-present; recycled canvas from ~2019', '$$',
   ARRAY['le pliage','foldable tote','nylon tote','longchamp tote','origami']::text[],
   'https://www.longchamp.com/', 0.85, false, 'migration:00468'),
  ('longchamp', 'Le Pliage Green', 'Unisex', 'bag', 'Le Pliage',
   '⚠ SEEDED AS A NEVER-GUESS ROW. **LE PLIAGE GREEN IS NOT PHOTO-SEPARABLE FROM LE PLIAGE ORIGINAL.** It is the same trapezoid, the same flap, the same tubular handles. The ONLY separator found is the MIDDLE SLOT OF THE REFERENCE — 919 (Green) vs 089 (Original) — which is a catalogue string, not a photograph. Read the listing reference or decline; do not infer Green from a photo.',
   ARRAY['recycled canvas']::text[], 'current', '$$',
   ARRAY['le pliage green','919','never guess']::text[],
   'https://www.longchamp.com/', 0.70, false, 'migration:00468'),
  ('longchamp', 'Le Pliage Xtra', 'Unisex', 'bag', 'Le Pliage',
   'The ALL-LEATHER Le Pliage — and note what that does to identification: **it removes the leather/nylon contrast**, which is one of the court-enumerated cues, so the Original''s fingerprint does NOT transfer. The brand''s own tell is "contrasting edges on the leather for added depth and dimension". Calfskin. ⚠ It appears to occupy the slot formerly held by Le Pliage CUIR / NEO, both of which are absent from current navigation — THE RENAME COULD NOT BE SOURCED, so Cuir and Néo are kept as historical names (they remain high-volume in resale) rather than folded.',
   ARRAY['calfskin']::text[], 'current', '$$$',
   ARRAY['le pliage xtra','le pliage cuir','neo','leather le pliage']::text[],
   'https://www.longchamp.com/', 0.75, false, 'migration:00468'),
  ('longchamp', 'Roseau', 'Women', 'bag', 'Roseau',
   'A DISTINCT LINE — **NOT a Le Pliage**, and seeded mainly so it is not collapsed into one. Leather; dates to 1993 per the brand''s own story page, the same year as Le Pliage. No brand-published fingerprint or MSRP could be sourced, so no separability claim is made here: read the tag or the listing.',
   ARRAY['leather']::text[], '1993-present', null,
   ARRAY['roseau']::text[],
   'https://www.longchamp.com/', 0.60, false, 'migration:00468'),

  -- Marc Jacobs
  ('marcjacobs', 'The Tote Bag', 'Women', 'bag', 'The Marc Jacobs',
   'THE MOST DUPED BAG IN THIS PACK, AND THE FINGERPRINT IS THE TYPE, NOT THE SHAPE. **The OVERSIZED BOLD LOGOTYPE ACROSS THE FACE is the only real cue** — it is the NEW YORK MAGAZINE logotype drawn by Milton Glaser in 1968, adopted by the brand in 2019, so it also acts as a date floor. The body is a flat, unstructured, dual-top-handle tote. ⚠ **THE SILHOUETTE IS GENERIC AND UNPROTECTED**: the THE TOTE BAG trademark applications were ABANDONED (no Statement of Use), so nothing stops a lookalike. Grade on LOGOTYPE EXECUTION + material and expect this class to be LOW CONFIDENCE — a plain canvas tote is a plain canvas tote.',
   ARRAY['canvas','leather','shearling','jacquard','denim']::text[], '2019+ (the Glaser logotype)', '$$',
   ARRAY['the tote bag','marc jacobs tote','canvas tote','logotype']::text[],
   'https://www.marcjacobs.com/', 0.70, false, 'migration:00468'),
  ('marcjacobs', 'The Snapshot', 'Women', 'bag', 'The Marc Jacobs',
   'Tells: the **"DOUBLE J" / J MARC HARDWARE on the front**, **COLOURBLOCKED PANELS**, **DOUBLE-ZIP TWIN COMPARTMENTS**, saffiano grain, removable webbing strap. ⚠ THE DEBUT YEAR IS DISPUTED THREE WAYS AND THE BRAND IS NOT AUTOMATICALLY RIGHT: Marc Jacobs'' own site says 2018, while Bustle says 2016 and Shopbop (an official stockist) says "straight from the Spring ''16 runway". The 2018 date may refer to the relaunch under the new logo rather than first appearance. Do not assert a year.',
   ARRAY['saffiano leather']::text[], '⚠ disputed: 2016 vs 2018', '$$',
   ARRAY['snapshot','camera bag','crossbody','double j','saffiano']::text[],
   'https://www.marcjacobs.com/', 0.70, false, 'migration:00468'),
  ('marcjacobs', 'The Snapshot DTM', 'Women', 'bag', 'The Marc Jacobs',
   'The tonal ("down-the-middle") Snapshot: **the COLOURBLOCKING IS REMOVED and the hardware is matched to the body.** So it is separable from the standard Snapshot in a photo by exactly ONE cue — the ABSENCE of contrast panels. If the panels are not clearly visible in frame, do not disambiguate DTM from standard.',
   ARRAY['leather']::text[], 'current', '$$',
   ARRAY['snapshot dtm','tonal snapshot','down the middle']::text[],
   'https://www.marcjacobs.com/', 0.70, false, 'migration:00468'),
  ('marcjacobs', 'Marc by Marc Jacobs (LINE, not a style)', 'Women', 'line', 'Marc by Marc Jacobs',
   '⚠ NOT A GARMENT — A LINE, AND AN ERA RULE WITH AN EXPIRY DATE. Launched ~2001, discontinued after FW2015 and folded into the main line, so an MBMJ label is a tempting "pre-2016" marker. TWO REASONS TO HOLD IT LOOSELY: no source describes the physical TAG (only the line''s end), and **THE MARK WAS RE-FILED AT USPTO ON 15 JUNE 2026** (serial 99885050, LIVE, awaiting examination) one month after the WHP sale — a revived line would make the inference wrong. Keep as a SEPARATE node, never as an alias of Marc Jacobs.',
   ARRAY[]::text[], '~2001-2015; ⚠ possibly revived from 2026', null,
   ARRAY['marc by marc jacobs','mbmj','line']::text[],
   'https://www.marcjacobs.com/', 0.70, false, 'migration:00468'),

  -- Rebecca Minkoff
  ('rebeccaminkoff', 'Morning After Bag (MAB / MAM / MAMM)', 'Women', 'bag', 'Signature',
   'THE BRAND''S FLAGSHIP, AND THE FINGERPRINT IS ERA-DEPENDENT — which is the trap. VINTAGE (2005-2012): twin top handles, zip top, **TWO LONG LEATHER TASSELS** (the single strongest photo tell), side zip pockets, front pleats. ⚠ **THE 2023+ REVIVAL DROPPED THE SIGNATURE TASSEL PAIR ON SEVERAL SKUs** and is described only as "slouchy, slightly structured... subtle front pleats and soft drape" — so a TASSEL-BASED RULE WILL MISDATE (not misbrand) a current MAB. Sizes MAB (full) / MAM (mini) / MAMM (mini mini) are COMMUNITY nomenclature, not brand-documented.',
   ARRAY['genuine leather']::text[], '2005 original; ⚠ 2023+ revival is a REDESIGN', '$$',
   ARRAY['mab','mam','morning after bag','tassel','hobo']::text[],
   'https://www.rebeccaminkoff.com/', 0.75, false, 'migration:00468'),
  ('rebeccaminkoff', 'Love Crossbody', 'Women', 'bag', 'Love (discontinued)',
   '⚠ **NOT PHOTO-SEPARABLE FROM THE EDIE ON QUILTING ALONE** — the pack''s sharpest confusable pair. Both are CHEVRON-QUILTED. The discriminator is HARDWARE: **LOVE = CHAIN STRAP + the "love" SCRIPT PLAQUE; EDIE = DOG-CLIP closure.** If the plaque and hardware are not visible in frame, RETURN AMBIGUOUS — do not guess. The Love Collection is DISCONTINUED (its collection page returns no products), so it is resale-only. ⚠ NO CANONICAL SIZE IS SEEDED: three mutually incompatible dimension sets circulate and the brand''s own page is dead.',
   ARRAY['quilted leather']::text[], 'discontinued — resale only', '$$',
   ARRAY['love crossbody','chevron quilted','love plaque','chain strap']::text[],
   'https://www.rebeccaminkoff.com/', 0.70, false, 'migration:00468'),
  ('rebeccaminkoff', 'Edie', 'Women', 'bag', 'Edie',
   '⚠ SEEDED AS A NEVER-GUESS ROW, AND THE REASON IS COUNTERINTUITIVE: **QUILTING IS NO LONGER DEFINITIONAL FOR THE EDIE.** The line is described as "distinguished by the quilted leather chevron pattern" — but the live Edie Medium Crossbody is WOVEN STRAW (90% paper / 10% faux leather) with no quilting at all, and others are nylon. So a quilt-based Edie rule produces FALSE NEGATIVES on current stock AND confuses Edie with Love on vintage stock. Grade to BRAND, not to style, on this one.',
   ARRAY['quilted leather','nylon','woven straw (paper)']::text[], 'current', '$$',
   ARRAY['edie','chevron quilted','dog clip','never guess']::text[],
   'https://www.rebeccaminkoff.com/', 0.65, false, 'migration:00468'),
  ('rebeccaminkoff', 'Darren', 'Women', 'bag', 'Darren',
   'THE BEST PHOTO-SEPARABLE STYLE IN THE LINE — the brand''s own words: the Darren collection "locks things up with **signature TURN LOCK hardware**". The turn lock is a clean, high-signal cue. ⚠ BUT THE FAMILY SPRAWLS (~50 live SKUs: Carryall, Shoulder, Feed, Sling, Crescent, Slim Hobo, Metro, Continental Wallet): **SUB-STYLE resolution from a photo is unreliable; BRAND + FAMILY is achievable.** Resolve to "Darren", not to "Darren Small Crescent Crossbody".',
   ARRAY['leather','suede']::text[], 'current', '$$',
   ARRAY['darren','turn lock','carryall','feed bag','crescent']::text[],
   'https://www.rebeccaminkoff.com/', 0.80, false, 'migration:00468'),
  ('rebeccaminkoff', 'Julian Backpack', 'Women', 'bag', 'Julian',
   'The brand''s own tell: "topped off with **DOG-CLIP HARDWARE and SWINGY ZIP TASSELS**", plus a top handle, 1 exterior back slip pocket and 2 side zip pockets. ⚠ HONEST LIMIT: Rebecca Minkoff sells other backpacks — **the DOG-CLIP + ZIP-TASSEL COMBINATION is the discriminator, not "is a backpack"**. No introduction date could be sourced; the brand calls it "an instant best-seller" and dates nothing.',
   ARRAY['pebbled leather','washed nylon']::text[], 'undated', '$$',
   ARRAY['julian','backpack','dog clip','pebbled leather','zip tassel']::text[],
   'https://www.rebeccaminkoff.com/', 0.75, false, 'migration:00468'),

  -- Fossil
  ('fossil', 'Carlie', 'Women', 'watch', 'Fossil watches',
   'Women''s three-hand: **floating T-BAR LUGS**, crystal bezel, sunray dial. The current generation has "a redesigned ''90s-inspired T-bar and stunning new bracelet design" — a brand-stated, photo-visible era cue (~2023+). ⚠ **CARLIE vs CARLIE MINI IS NOT PHOTO-SEPARABLE** — identical design, differing only in case diameter, and fossil.com itself indexes the SAME code ES5331 under BOTH "Carlie" and "Carlie Mini" titles. ⚠ AND THE COLLECTION NAME DOES NOT FIX THE SIZE: ES5331 is 28MM/5ATM while ES4341P is 35mm/3ATM, both titled "Carlie Three-Hand Stainless Steel Watch". **READ THE CASE-BACK CODE — the code is reliable, the name is not.**',
   ARRAY['stainless steel','leather','mineral crystal']::text[], 'current; T-bar redesign ~2023+', '$$',
   ARRAY['carlie','t-bar','womens fossil watch','es5331']::text[],
   'https://www.fossil.com/', 0.80, false, 'migration:00468'),
  ('fossil', 'Grant', 'Men', 'watch', 'Fossil watches',
   'Men''s **44MM CHRONOGRAPH: THREE SUB-DIALS**, stick/Roman indices, prominent knurled crown. Separable from the Carlie by case size + the sub-dials — one of the few clean separations in this pack. FS-prefixed (FS4736, FS4812/4813, FS4832, FS5061, FS6131), 5 ATM.',
   ARRAY['stainless steel','leather']::text[], 'current', '$$',
   ARRAY['grant','chronograph','mens fossil watch','fs4736']::text[],
   'https://www.fossil.com/', 0.75, false, 'migration:00468'),
  ('fossil', 'Derrick (wallets)', 'Men', 'small leather goods', 'Fossil leather',
   'The men''s wallet line — **and the row exists partly to record that FOSSIL HAS NO "DEFENDER" WALLET**, a plausible-sounding name a model will confabulate; Derrick is the real one. Sub-variants are SIZE-separable but not STYLE-separable: RFID Passcase (removable bifold, 3.75 x 0.25 x 2.75in), Bifold (4.5 x 0.75 x 3.7in), Card Holder (2.75 x 0.4 x 3.81in), and the outlier **Executive Checkbook (3.5 x 0.5 x 6.75in — clearly taller)**. ML-prefixed.',
   ARRAY['leather','RFID lining']::text[], 'current', '$',
   ARRAY['derrick','bifold','rfid wallet','ml3771001']::text[],
   'https://www.fossil.com/', 0.65, false, 'migration:00468'),
  ('fossil', 'Rachel Tote', 'Women', 'bag', 'Fossil bags',
   'Structured leather tote, ~14 x 4 x 13in. ⚠ **WEAKLY SEPARABLE** from Fossil''s other totes (Willa, Harwell, Jayda) in a photo. ⚠ AND ITS CODE IS NOT A STYLE KEY: the same Rachel Tote carries ZB7507263 (US), ZB1829015 (AU) and ZB7991080 elsewhere — **ZB codes are per-colourway and per-region, not per-style**, so do not key a style on one.',
   ARRAY['leather']::text[], 'current', '$$',
   ARRAY['rachel tote','leather tote','zb']::text[],
   'https://www.fossil.com/', 0.60, false, 'migration:00468'),

  -- Vera Bradley — the pattern IS the identity; the silhouettes are near-duplicates.
  ('verabradley', 'Pattern (NOT a style — the brand''s actual identity axis)', 'Women', 'pattern', 'Vera Bradley patterns',
   '⚠ NOT A GARMENT — THE MOST IMPORTANT ROW FOR THIS BRAND, AND IT INVERTS THE USUAL WEIGHTING. **VERA BRADLEY''S PRICE IS DRIVEN BY THE PATTERN, NOT THE STYLE.** VB protects ~1,000 COPYRIGHTS on its patterns and trademarks only the NAME — the inverse of most fashion brands. Its silhouettes are near-duplicates across a dozen variants and every fabric line, so STYLE disambiguation from a photo is WEAK while PATTERN disambiguation is STRONG. ⚠ **ONE PATTERN CAN BE TWO PRINTS ON ONE BAG**: VB''s own 10-K says each pattern includes "a primary print and sometimes a secondary coordinating print" — so do NOT classify the lining as a separate pattern. ⚠ **THE REVIVAL TRAP**: VB recolours heritage prints under NEW names (Neutral Rhapsody is a recolour of Blue Rhapsody, 2009; several current prints recolour a 1993 Tea Garden) — a name-similarity matcher will misprice a cheap current revival as a valuable retired original. ⚠ NO RETIREMENT DATE IS SEEDED ANYWHERE — see the colorways and the migration header.',
   ARRAY['quilted cotton','microfiber','Performance Twill','Featherweight']::text[], 'current', null,
   ARRAY['pattern','print','paisley','floral','retired pattern']::text[],
   'https://verabradley.com/', 0.85, false, 'migration:00468'),
  ('verabradley', 'Campus Backpack', 'Women', 'bag', 'Vera Bradley bags',
   'Tall, narrow, slouched; a single large front slip pocket + side water-bottle pockets; 32.0in adjustable strap, 2.75in handle drop. ⚠ **NOT PHOTO-SEPARABLE FROM THE XL CAMPUS** — the same silhouette scaled up, so it needs a scale reference or the tag. ⚠ AND THE MATERIAL IS NOT PHOTO-SEPARABLE EITHER at listing-photo resolution: it ships in cotton, microfiber, Performance Twill and recycled cotton, and roughly half of VB''s products are cotton-based, so "not quilted" does not mean "not VB".',
   ARRAY['quilted cotton','microfiber','Performance Twill']::text[], 'current', '$$',
   ARRAY['campus backpack','bookbag','quilted backpack']::text[],
   'https://verabradley.com/', 0.70, false, 'migration:00468'),
  ('verabradley', 'Weekender Travel Bag', 'Women', 'bag', 'Vera Bradley travel',
   'Wide barrel duffel, trapezoid profile; 18.5 x 12.5 x 7.5in, **6.5in strap drop**, 52.5in removable strap. The strap drop is the separator from the Iconic Compact Weekender (4.5in) — but only if the strap is visible in frame.',
   ARRAY['quilted cotton','Performance Twill']::text[], 'current', '$$',
   ARRAY['weekender','overnight bag','duffel']::text[],
   'https://verabradley.com/', 0.70, false, 'migration:00468'),
  ('verabradley', 'Iconic Compact Weekender', 'Women', 'bag', 'Iconic',
   'Genuinely separable from the full Weekender, and here is the actual cue: **4.50in handle drop vs the Weekender''s 6.5in**, and a visibly squatter height-to-width ratio (0.62 vs 0.68). 16.25 x 10.00 x 7.25in. The Iconic cotton collection was introduced 2017 per VB''s own timeline.',
   ARRAY['Iconic cotton']::text[], '2017+', '$$',
   ARRAY['compact weekender','iconic']::text[],
   'https://verabradley.com/', 0.70, false, 'migration:00468'),
  ('verabradley', 'Original Zip Hipster', 'Women', 'bag', 'Vera Bradley bags',
   '⚠ SEEDED AS A NEVER-GUESS ROW. A small flat crossbody with a top zip, a front slip pocket and a long adjustable strap — **POORLY PHOTO-SEPARABLE from VB''s many other small crossbodies** (Carson, Little Crossbody, Triple Zip), and the Hipster family alone runs ~4 sub-variants. NO DIMENSIONS ARE SEEDED — VB''s page did not yield specs and none is invented. Read the tag or decline.',
   ARRAY['quilted cotton']::text[], 'current', '$',
   ARRAY['hipster','crossbody','zip hipster','never guess']::text[],
   'https://verabradley.com/', 0.55, false, 'migration:00468'),

  -- Dooney & Bourke
  ('dooneybourke', 'All-Weather Leather (AWL) Satchel', 'Women', 'bag', 'All-Weather Leather',
   'Pebble-grain body with **CONTRASTING BRITISH-TAN TRIM/PIPING**, a brass duck fob, the oval duck patch, suede interior. The AWL pebble-grain TEXTURE is itself a REGISTERED mark (first used 1983), which makes texture quality a rare non-invertible signal. ⚠ The PATCH does not separate AWL from Florentine or Pebble Grain — see the Florentine row.',
   ARRAY['AWL shrunken cowhide']::text[], '1983-present (patch era; medallion from 1991)', '$$',
   ARRAY['awl','all weather leather','norfolk','duck','british tan']::text[],
   'https://www.dooney.com/', 0.75, false, 'migration:00468'),
  ('dooneybourke', 'Florentine Satchel', 'Women', 'bag', 'Florentine',
   '⚠ **NOT SEPARABLE FROM AWL OR PEBBLE GRAIN BY THE PATCH — Dooney''s OWN logo guide says Florentine and Pebble Grain BOTH carry the colour-matched bottom-left leather patch.** THE SEPARATOR IS THE SURFACE, NOT THE LOGO: Florentine is SMOOTH, GLOSSY, ANILINE, with visible grain variation and patina; AWL is a UNIFORM PEBBLE TEXTURE. That is a leather-character read, which needs resolution and even lighting — **in a low-res photo these are NOT reliably separable, and the model must not claim high confidence here.**',
   ARRAY['full-grain veg-tanned Italian leather','aniline']::text[], '2000s-present', '$$$',
   ARRAY['florentine','italian leather','aniline','8l980']::text[],
   'https://www.dooney.com/', 0.75, false, 'migration:00468'),
  ('dooneybourke', 'Logo Lock', 'Women', 'bag', 'Logo Lock',
   'THE HIGHEST PHOTO-SEPARABILITY OF ANY DOONEY IN THIS PACK, and the cue is unmistakable: **THE LOGO *IS* THE CLOSURE** — a polished lock. Ships in Pebble, Belvedere and Samba leathers. Where every other Dooney line needs a leather-surface read, this one needs a glance.',
   ARRAY['pebble grain','Belvedere','Samba']::text[], 'modern', '$$',
   ARRAY['logo lock','pebble grain']::text[],
   'https://www.dooney.com/', 0.85, false, 'migration:00468'),
  ('dooneybourke', 'Signature / Gretta (coated cotton)', 'Women', 'bag', 'Signature',
   'Allover printed monogram on COATED COTTON with leather trim — the visual opposite of the AWL/Florentine leather lines and easily separable from them. ⚠ This is the line that drew the Louis Vuitton Multicolore litigation (2004-06) — a TRADE-DRESS DISPUTE BETWEEN TWO LEGITIMATE HOUSES, NOT a counterfeit signal.',
   ARRAY['Italian coated cotton']::text[], '2000s-present', '$',
   ARRAY['signature','monogram','gretta','coated cotton']::text[],
   'https://www.dooney.com/', 0.75, false, 'migration:00468'),
  ('dooneybourke', 'Licensed collabs (Disney / NFL / MLB / NCAA)', 'Women', 'bag', 'Licensed',
   'Licensed artwork or team marks — **and they STILL carry the duck patch**, so the patch does not distinguish them; the ARTWORK does. The Disney partnership is reported from around Oct 2009 (secondary-sourced — treat the year loosely). These comp separately from mainline and are a real share of Dooney resale supply.',
   ARRAY['varies']::text[], '~2009-present', '$$',
   ARRAY['disney','nfl','mlb','ncaa','collegiate','licensed']::text[],
   'https://www.dooney.com/', 0.65, false, 'migration:00468'),

  -- Brahmin
  ('brahmin', 'Melbourne (a MATERIAL, not a style)', 'Women', 'material', 'Melbourne',
   '⚠ NOT A STYLE — **"MELBOURNE" IS BRAHMIN''S SIGNATURE CROC-EMBOSSED LEATHER**, in the brand''s own words "our signature since our start in 1982". It CUTS ACROSS EVERY SILHOUETTE, so "Melbourne" in a title tells you the LEATHER, not the bag — never resolve it as a style. The grammar is [Colour] [Material]: "Black Melbourne", "Carnation Melbourne". ⚠ The bold croc emboss is Brahmin''s most recognisable trait AND its most copied: HIGH RECALL, POOR PRECISION. ⚠ Ombre Melbourne is a distinct material (code 1708) with its own colourways (Teak, Infusion, Tri-Color).',
   ARRAY['croc-embossed leather','ombre croc-embossed leather']::text[], '1982-present — 44 years of continuity', null,
   ARRAY['melbourne','croc','croc embossed','ombre melbourne','material']::text[],
   'https://brahmin.com/', 0.85, false, 'migration:00468'),
  ('brahmin', 'Duxbury Satchel', 'Women', 'bag', 'Duxbury',
   'Structured satchel, dual rolled handles + a removable strap that converts it to a crossbody. ⚠ **NOT PHOTO-SEPARABLE FROM THE LARGE DUXBURY** — the same silhouette and the same finish, 1.5in apart (12.75in vs 14.2in wide). **Without a scale reference the model must ABSTAIN**, not guess. ⚠ K43 AND V48 ARE BOTH DUXBURY (legacy vs current numbering) — do not dedupe them as two different bags.',
   ARRAY['Melbourne','Ombre Melbourne']::text[], 'current', '$$$',
   ARRAY['duxbury','satchel','croc','v48','k43']::text[],
   'https://brahmin.com/', 0.70, false, 'migration:00468'),
  ('brahmin', 'Priscilla Satchel', 'Women', 'bag', 'Priscilla',
   'The **WIDEST** bag in the line at ~15in — which is the only reliable separator from the Duxbury family, and it still needs a scale reference. Code N79. Ships across materials (Melbourne 151, Wilde 1289, La Scala 626, Bennet 2588, Sunbeam 2529).',
   ARRAY['Melbourne','Wilde','La Scala']::text[], 'current', '$$$',
   ARRAY['priscilla','satchel','n79']::text[],
   'https://brahmin.com/', 0.65, false, 'migration:00468'),
  ('brahmin', 'Lorelei Shoulder Bag', 'Women', 'bag', 'Lorelei',
   'The small end of the line — zip top, removable strap, ~10.5in strap drop. Code S10. ⚠ ITS PUBLISHED AXIS LABELS LOOK WRONG (see the chart note): "6.0L x 9.0D x 2.25H" implies a bag deeper than it is long, and is almost certainly 9in L x 6in H x 2.25in D. Flagged rather than silently corrected.',
   ARRAY['Melbourne']::text[], 'current', '$',
   ARRAY['lorelei','shoulder bag','s10']::text[],
   'https://brahmin.com/', 0.60, false, 'migration:00468'),

  -- Tumi
  ('tumi', 'Alpha / Alpha 3', 'Unisex', 'bag', 'Alpha',
   '**FXT BALLISTIC NYLON + LEATHER TRIM + WEBBING TOP HANDLES WITH A LEATHER WRAP**; softside; monogram patch. ⚠ **ALPHA vs ALPHA BRAVO IS HARD AND THE MATERIAL WILL NOT SETTLE IT** — both are FXT + leather. **SEPARATE ON FORM, NOT MATERIAL**: Alpha = travel/business (wheeled cases, garment bags); Alpha Bravo = backpacks/slings. ⚠ ALPHA GENERATION NUMBERING (Alpha / Alpha 2 / Alpha 3) HAS NO SOURCED DATE MAPPING — only "Alpha 2008" is sourced; do not date a generation.',
   ARRAY['FXT ballistic nylon','leather trim']::text[], '2008+', '$$$$',
   ARRAY['alpha','alpha 3','ballistic nylon','fxt','117154']::text[],
   'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', 'Alpha Bravo', 'Unisex', 'bag', 'Alpha Bravo',
   'Military-inspired; FXT ballistic OR coated canvas/mesh; **backpack-led** — which is the actual discriminator from the Alpha, because in a close crop the two are NOT reliably separable. Decide on SILHOUETTE, not on material.',
   ARRAY['FXT ballistic nylon','coated canvas']::text[], '2010+', '$$$',
   ARRAY['alpha bravo','navigation','backpack','sling']::text[],
   'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', '19 Degree', 'Unisex', 'bag', '19 Degree',
   '**HARDSIDE WITH SCULPTED/ANGLED SHELL CONTOURS** — cleanly separable from every softside Tumi, the best separation in this brand. **ALUMINIUM vs POLYCARBONATE IS ALSO PHOTO-SEPARABLE**: anodized metal + Lever Lock latches vs a zip closure. ⚠ WHAT "19 DEGREE" REFERS TO IS NOT BRAND-SOURCED — the collection page never explains the name or the angle. Do not assert it.',
   ARRAY['anodized aircraft-grade aluminium','recycled polycarbonate']::text[], '2016+ (aluminium)', '$$$$',
   ARRAY['19 degree','hardside','aluminum','lever lock','124851']::text[],
   'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', 'Voyageur', 'Women', 'bag', 'Voyageur',
   'Brand-described as a WOMEN''S collection: "lightweight, versatile", **dual-tone colourways with hardware accents** (Black/Gunmetal, Black/Gold), a lighter nylon "with subtle sheen" rather than FXT on all pieces. The dual-tone is the cue that separates it from the FXT-and-leather Alpha families.',
   ARRAY['nylon','FXT ballistic nylon']::text[], '2023 redesign', '$$$',
   ARRAY['voyageur','celina','womens','146566']::text[],
   'https://www.tumi.com/', 0.70, false, 'migration:00468'),

  -- Herschel
  ('herschelsupplyco', 'Little America', 'Unisex', 'bag', 'Heritage',
   '⚠ **THE BRIEF-OBVIOUS DISCRIMINATOR IS WRONG AND THIS ROW EXISTS TO SAY SO: LITTLE AMERICA AND RETREAT ARE *NOT* SEPARABLE BY CLOSURE OR STRAP HARDWARE.** Both are, verbatim, "Easy U-pull drawcord closure" + "Magnet fastened straps with metal pin buckles" — **any rule keyed on "magnetic snap ⇒ Little America" MISFIRES ON RETREAT.** THE REAL CUES: Little America has a **TOP-LID ZIPPER** (Retreat does not) and is the **DEEPEST (7.09in) and HEAVIEST (2.43 lb)**. Signature mountain-peak front with the woven label. ⚠ CAPACITY IS NOT AN IDENTIFIER — 30L today, 25L on older stock; both genuine.',
   ARRAY['100% recycled 600D polyester','tonal recycled-poly stripe liner']::text[], 'current spec; capacity differs by era', '$$$$',
   ARRAY['little america','drawcord','top lid zip','30l','25l']::text[],
   'https://herschel.com/', 0.85, false, 'migration:00468'),
  ('herschelsupplyco', 'Retreat', 'Unisex', 'bag', 'Heritage',
   'Shares the Little America''s drawcord + magnet-and-pin-buckle straps exactly — **so separate it ON THE SIDE PROFILE, NOT THE FRONT**: Retreat is 5.91in deep vs Little America''s 7.09in, has a **SIDE-ENTRY ZIP** and **DUAL EXPANDING BOTTLE POCKETS**, has NO top-lid zip, and is a pound lighter (1.63 lb).',
   ARRAY['100% recycled 600D polyester']::text[], 'current', '$$$',
   ARRAY['retreat','side entry zip','bottle pocket','23l']::text[],
   'https://herschel.com/', 0.85, false, 'migration:00468'),
  ('herschelsupplyco', 'Heritage', 'Unisex', 'bag', 'Heritage',
   'Cleanly separable from Little America and Retreat: **ZIPPERED TOP, NO DRAWCORD, NO BUCKLES**, EVA-padded straps, "Signature diamond detail". ⚠ **HERITAGE vs SETTLEMENT IS THE HARDEST PAIR IN THIS BRAND** — both zippered, both the 23-24L class, near-identical feature lists; separable ONLY on proportion (Heritage is wider and deeper). **ROUTE THAT PAIR TO HUMAN REVIEW** rather than guessing.',
   ARRAY['100% recycled 600D polyester']::text[], 'current', '$$',
   ARRAY['heritage','zip top','diamond detail','24l']::text[],
   'https://herschel.com/', 0.80, false, 'migration:00468'),
  ('herschelsupplyco', 'Novel Duffle', 'Unisex', 'bag', 'Novel',
   'THE ONE UNAMBIGUOUS HERSCHEL: the **"SIGNATURE SHOE COMPARTMENT"** — an end-panel shoe pocket that is unique in the line — plus a waterproof zippered closure. 43L. If the end panel is visible, this is a positive identification.',
   ARRAY['100% recycled 600D polyester']::text[], 'current', '$$$',
   ARRAY['novel','duffle','shoe compartment','43l']::text[],
   'https://herschel.com/', 0.85, false, 'migration:00468'),
  ('herschelsupplyco', 'Settlement', 'Unisex', 'bag', 'Settlement',
   '⚠ SEEDED AS A NEVER-GUESS ROW — see the Heritage row. Zippered, 23L, 1.37 lb, with the "Herschel Supply DNA shoulder tab". **NOT reliably separable from the Heritage in a photo**: same closure class, same capacity class, near-identical features, differing only in proportion. Resolve to brand and route the pair to review.',
   ARRAY['100% recycled 600D polyester']::text[], 'current', '$$',
   ARRAY['settlement','dna shoulder tab','never guess','23l']::text[],
   'https://herschel.com/', 0.60, false, 'migration:00468')
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
-- ONE DECODER — FOSSIL, AND IT IS THE ONLY BRAND HERE THAT ISN'T A BAG. See the
-- migration header for why the other eight are refused: a bag's code left with
-- the paper hangtag, while a watch's code is on the metal case back.
--
-- THE PREFIX ANCHOR IS THE SAFETY MECHANISM, NOT A STYLE CHOICE. decodeTagCode
-- runs specs INSIDE AN ALREADY-RESOLVED PACK, so a permissive [A-Z]{2}\d{4} under
-- the Fossil pack would decode a Michael Kors MK8017 and spell the brand "Fossil"
-- from pack.brand — silently retitling a Michael Kors watch, which is ALREADY a
-- canonical brand in this KB. Fossil Group's own 10-K puts licensed product at
-- 47.3% of net sales (Michael Kors alone 19.2%), so this is a high-frequency
-- hazard, not a hypothetical. Anchoring ES|FS|FTW makes it impossible.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples,
   source_url, confidence, verified, updated_by)
values
  ('fossil', 'style_number',
   'Fossil style number, on the METAL CASE BACK of the watch — Fossil''s own support states the style number "is located on the back of the watch" and gives ES1234 and FTW1234 as its own examples. It is NOT merely a web SKU: fossil.com''s structured product data emits "sku":"ES5331" / "id":"ES5331", so the catalogue key and the physical mark are THE SAME STRING. Two letters (or FTW) + 4-5 digits. ES5331 = Carlie Three-Hand (women''s), FS4736 = Grant Chronograph (men''s), FTW = smartwatches/wearables. THE PACK''S CUT-TAG CASE: a case back cannot be removed the way a paper hangtag can, so the code outlives the bracelet, the box and the papers — which is exactly why this is the ONLY decoder in a pack of bags. ⚠ THE PREFIXES ARE ANCHORED ON PURPOSE AND THIS IS A SAFETY MECHANISM: Fossil Group makes ~47% of its output under LICENSED brands (Michael Kors MK, Emporio Armani AR, Armani Exchange AX, Diesel DZ), and a permissive two-letter pattern would decode an MK8017 under the Fossil pack and then spell the brand "Fossil" — mis-titling a Michael Kors watch onto the wrong canonical. Restricting to ES|FS|FTW makes that impossible by construction. ⚠ WHAT IS DELIBERATELY NOT DECODED: THE PREFIX MEANING. Fossil publishes NO decoder for ES/FS/AM anywhere — its "Fossil Brand Codes" page is about design motifs (the Crest, the Knurling, the D-Link) and decodes nothing, despite ranking first for the query. The popular gloss "ES = Fossil Steel" is REFUTED by Fossil''s own catalogue (ES4343 is a LEATHER-strap Carlie); the ES/FS split tracks GENDER, and even that is an OBSERVED correlation, not a sourced rule. So the decoder captures only styleCode and asserts nothing about what the letters mean. ⚠ The code identifies the MODEL where the NAME does not: ES5331 is indexed by Fossil under BOTH "Carlie" and "Carlie Mini", and ES5331 (28MM) and ES4341P (35mm) share one collection name.',
   '^(?<style>(?:ES|FS|FTW)\d{4,5})$',
   $j${"fieldMap": {"style": "styleCode"}, "transforms": {"style": "upper"}, "confidence": 0.6}$j$::jsonb,
   $j$[{"code":"ES5331","expected":{"styleCode":"ES5331"}},{"code":"FS4736","expected":{"styleCode":"FS4736"}},{"code":"FTW1234","expected":{"styleCode":"FTW1234"}},{"code":"ES1234","expected":{"styleCode":"ES1234"}}]$j$::jsonb,
   'https://support.fossilgroup.com/', 0.60, false, 'migration:00468')
on conflict (brand_key, decoder_kind) do update set
  description      = excluded.description,
  pattern          = excluded.pattern,
  extraction_rules = excluded.extraction_rules,
  examples         = excluded.examples,
  source_url       = excluded.source_url,
  confidence       = excluded.confidence,
  updated_by       = excluded.updated_by;

-- ── brand_colorways ────────────────────────────────────────────────────────
-- THREE BRANDS QUALIFY AND SIX DO NOT. The test is "CODE-BACKED OR RULE-SHAPED",
-- not "has nice names" — see the migration header.
--   • LONGCHAMP + TUMI: the colour is CODE-BACKED and the code is durable ACROSS
--     models and categories. Longchamp 001 = Black on L2605/L1899/L1625; Tumi
--     1041 = Black across 13+ styles spanning luggage, a card case, an umbrella
--     and fabric cleaner. That is an internal colour master list made externally
--     visible — a true enum. ⚠ NEITHER BRAND PUBLISHES A DECODER: both tables are
--     reconstructed from observed pairings on the brands' own pages, which is why
--     they sit at 0.80/0.85 rather than higher.
--   • VERA BRADLEY: no code at all, but THE PATTERN IS THE IDENTITY AND THE PRICE
--     DRIVER. ⚠ THESE 20 ARE **CURRENT-SEASON, NOT RETIRED** — see the header: the
--     retired-patterns-archive URL serves the CURRENT patterns landing page, and
--     seeding them as retired would invert the truth on the field that drives this
--     brand's price. NO RETIREMENT DATE IS SEEDED FOR ANY PATTERN, ANYWHERE.
--   • REFUSED: Brahmin (Melbourne is a MATERIAL — see its style row), Fossil
--     (plain descriptive fields: "Strap Color: Silver"), Marc Jacobs, Rebecca
--     Minkoff (its durable axis is HARDWARE FINISH — Antique Brass / Black
--     Shellac — not colour) and Herschel (an additive per-season vocabulary).
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  -- Longchamp: the trailing 3 chars of the reference. Proven across models.
  ('longchamp', 'Black', ARRAY['001','le pliage 001']::text[], null,
   'durable — proven across L2605 / L1899 / L1625', 'https://www.longchamp.com/', 0.80, false, 'migration:00468'),
  ('longchamp', 'Navy', ARRAY['p68']::text[], null,
   'durable — proven across L2605 / L1899', 'https://www.longchamp.com/', 0.80, false, 'migration:00468'),
  ('longchamp', 'Paper', ARRAY['p71']::text[], null,
   'durable — proven across L2605 / L1899', 'https://www.longchamp.com/', 0.75, false, 'migration:00468'),
  ('longchamp', 'Pebble', ARRAY['349']::text[], null,
   'durable — proven across L2605 / L1899', 'https://www.longchamp.com/', 0.75, false, 'migration:00468'),
  ('longchamp', 'Cognac', ARRAY['504']::text[], null,
   'durable — proven across L2605 / L1899', 'https://www.longchamp.com/', 0.75, false, 'migration:00468'),
  ('longchamp', 'Celadon', ARRAY['p99']::text[], null,
   'observed on L1899', 'https://www.longchamp.com/', 0.70, false, 'migration:00468'),
  ('longchamp', 'Fawn', ARRAY['p86']::text[], null,
   'observed on L1899', 'https://www.longchamp.com/', 0.70, false, 'migration:00468'),
  ('longchamp', 'Graphite', ARRAY['p66']::text[], null,
   'observed on the Green line (L2605-919)', 'https://www.longchamp.com/', 0.70, false, 'migration:00468'),

  -- Tumi: the 4-char suffix. ⚠ ALPHANUMERIC — parse as string, never as int.
  ('tumi', 'Black', ARRAY['1041']::text[], null,
   'durable — 1041 proven across 13+ styles spanning luggage, a card case, an umbrella and fabric cleaner',
   'https://www.tumi.com/', 0.85, false, 'migration:00468'),
  ('tumi', 'Charcoal', ARRAY['1174']::text[], null, 'durable', 'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', 'Navy', ARRAY['1596']::text[], null, 'durable', 'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', 'Dark Brown', ARRAY['1251']::text[], null, 'durable', 'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', 'Silver', ARRAY['1776']::text[], null, 'durable', 'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  -- ⚠ The codes are ALPHANUMERIC (A639, T522, B186) — an int parse silently fails.
  ('tumi', 'Black/Gold', ARRAY['2693']::text[], null, 'dual-tone (Voyageur)', 'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', 'Black/Gunmetal', ARRAY['t522']::text[], null, 'dual-tone (Voyageur) — ⚠ ALPHANUMERIC code',
   'https://www.tumi.com/', 0.75, false, 'migration:00468'),
  ('tumi', 'Thyme', ARRAY['a639']::text[], null, '⚠ ALPHANUMERIC code', 'https://www.tumi.com/', 0.70, false, 'migration:00468'),
  ('tumi', 'Deep Pine', ARRAY['b186']::text[], null, '⚠ ALPHANUMERIC code', 'https://www.tumi.com/', 0.70, false, 'migration:00468'),
  ('tumi', 'Hunter Green', ARRAY['1428']::text[], null, 'observed', 'https://www.tumi.com/', 0.70, false, 'migration:00468'),

  -- Vera Bradley: ⚠ CURRENT-SEASON PATTERNS. NOT RETIRED. No retirement date is
  -- seeded for any pattern — see the header and the brand's notes.
  ('verabradley', 'All the Pretty Wildflowers', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Cabbage Roses', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Cambridge Blues', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Cherry Picking', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Cottage Shells', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Flourishing Garden', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Flying Geese Patchwork', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Gardenia Garden', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Hollyhock Paisley', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Maison Blue', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  -- ⚠ THE REVIVAL TRAP, seeded explicitly: this is a RECOLOUR of Blue Rhapsody
  -- (2009). A name-similarity matcher will misprice it as the retired original.
  ('verabradley', 'Neutral Rhapsody', ARRAY[]::text[], null,
   'current season — ⚠ A RECOLOURED HERITAGE PRINT: Vera Bradley''s own description calls it "a recolored heritage print from 2009 (blue rhapsody)". THE 2009 DATE BELONGS TO THE ORIGINAL, NOT TO THIS PATTERN. A name-similarity matcher will misprice this cheap current revival as the valuable retired Blue Rhapsody.',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Poppy Fields', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Rachel Ditsy', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Riverside Denim', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Sherbet', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Slow Dance', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Trellis Patchwork', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Vibrant Paisley', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Vineyard Green Chambray', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468'),
  ('verabradley', 'Wildflower Sprigs', ARRAY[]::text[], null, 'current season — NOT a retirement date',
   'https://verabradley.com/', 0.90, false, 'migration:00468')
on conflict (brand_key, color_name) do update set
  aliases    = excluded.aliases,
  hex        = excluded.hex,
  years      = excluded.years,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  updated_by = excluded.updated_by;

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- A "SIZE CHART" FOR A BAG IS A DIMENSION TABLE, NOT A BODY-MEASUREMENT GRID —
-- the first such pack in the KB. `formatSizingChartsForPrompt` renders size
-- LABELS + the note IN FULL and UNCAPPED (US-1740), which makes the note the only
-- uncapped channel and therefore the right home for this pack's axis-order and
-- era-drift warnings.
--
-- ⚠ AXIS ORDER IS THE PACK'S SILENT DATA-QUALITY HAZARD: Dooney publishes H x D x
-- L, Tumi publishes H x D x W (not H x W x D), Brahmin is internally inconsistent,
-- and Fossil splits UNITS within one brand (watches MM, bags inches). Every chart
-- below names its axis order and its unit in `garment` because of it.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  ('longchamp', 'Longchamp', ARRAY['longchamp','longchamps']::text[], 'Unisex',
   'Le Pliage bag dimensions (INCHES, L x H x W)',
   ARRAY['bag','tote','handbag','travel bag','purse','shoulder bag','backpack']::text[],
   $j$[{"size":"S Handbag (L1621)","measurements":{"dimensions_in":"9.1 x 8.7 x 5.5","dimensions_cm":"23.1 x 22.1 x 14","handle_drop_in":"3.5","weight":"178 g"}},{"size":"M Tote (L2605)","measurements":{"dimensions_in":"11 x 10.4 x 6.1","dimensions_cm":"28 x 26.4 x 15.5","handle_drop_in":"8.3","weight":"220 g"}},{"size":"L Tote (L1899)","measurements":{"dimensions_in":"12.2 x 11.8 x 7.5","dimensions_cm":"31 x 30 x 19","handle_drop_in":"9.8"}},{"size":"L Travel (L1624)","measurements":{"dimensions_in":"17.7 x 13.8 x 9.1","dimensions_cm":"45 x 35 x 23"}},{"size":"XL Travel (L1625)","measurements":{"dimensions_in":"21.7 x 15.7 x 9.1","dimensions_cm":"55 x 40 x 23","handle_drop_in":"3.5","capacity":"42 L","weight":"445 g"}}]$j$::jsonb,
   '⚠ **MATCH ON THE 4-DIGIT MODEL NUMBER, NEVER THE SIZE LETTER — THIS IS THE HIGHEST-OPERATIONAL-IMPACT FACT ABOUT LONGCHAMP.** Longchamp renamed the range to XS/S/M/L/XL while retailers and sellers still use legacy short-handle/long-handle naming, so THE SAME REFERENCE L2605 089 IS SOLD AS "Le Pliage Original M Tote" (longchamp.com), "Le Pliage Shoulder Bag S" AND "Le Pliage Original Shoulder Bag M" by different sellers. A seller''s "Small" and Longchamp''s "S" are frequently DIFFERENT BAGS. The 4-digit model is stable enough that LONGCHAMP PLEADS IT IN ITS OWN FEDERAL COMPLAINT ("Style 1623"). ⚠ HANDLE DROP IS THE SEPARATOR for the classic ambiguity: the M Tote (8.3in drop) and the S Handbag (3.5in drop) are DIFFERENT MODELS, not a handle option on one model. ⚠ THERE IS NO OFFICIAL LE PLIAGE SIZE CHART TO CONSULT — Longchamp''s "Le Pliage by Size" hub lists size NAMES ONLY with no dimensions; these rows were assembled from individual product pages. L is measured AT THE BASE of the bag. ⚠ NO APPAREL/SHOE SIZING IS SEEDED: Longchamp sells RTW and shoes but publishes no chart that could be sourced. Reference format: [L][model 4][material 3][colour 3] — L2605 089 001 = M Tote / recycled canvas / Black. IT IS A CATALOGUE REFERENCE, NOT A TAG CODE — nothing puts it on the bag.',
   'https://www.longchamp.com/', 0.85, false, 'migration:00468'),

  ('marcjacobs', 'Marc Jacobs', ARRAY['marc jacobs','marcjacobs','the marc jacobs']::text[], 'Women',
   'Bag dimensions (INCHES, L x D x H)',
   ARRAY['bag','tote','handbag','crossbody','purse','camera bag','shoulder bag']::text[],
   $j$[{"size":"The Tote Bag — Small","measurements":{"dimensions_in":"10 x 5 x 8","dimensions_cm":"26 x 13 x 21"}},{"size":"The Tote Bag — Medium","measurements":{"dimensions_in":"13 x 6 x 11","dimensions_cm":"34 x 15 x 27"}},{"size":"The Tote Bag — Large","measurements":{"dimensions_in":"17 x 6 x 13","dimensions_cm":"42 x 16 x 34"}},{"size":"The Snapshot (M0012007)","measurements":{"dimensions_in":"7 x 2 x 4","dimensions_cm":"18 x 6 x 11","strap_adjustable_in":"8-57","strap_drop_in":"27"}}]$j$::jsonb,
   '⚠ **THESE NUMBERS ARE SNIPPET-SOURCED, NOT FETCHED — marcjacobs.com BLOCKS AUTOMATED FETCHING ON EVERY LOCALE**, so the official Tote Bag size guide could not be read directly. The S/M/L rows reproduced identically across two independent passes, which is why they clear 0.7 rather than being refused. ⚠ ONE UNRESOLVED CONTRADICTION FROM THE SAME PAGE: a further snippet returned "7in L x 6in D x 13in H", which fits none of the three rows — possibly a Mini or vertical variant. FLAGGED, NOT DISCARDED, and not silently reconciled. ⚠ HANDLE DROP FOR THE TOTES IS NOT PUBLISHED and is not invented here. ⚠ NO APPAREL SIZING IS SEEDED for the same access reason. ⚠ THE STYLE NUMBER IS NOT DECODED: Marc Jacobs'' own FAQ confirms one is "marked on the interior tag", but the site exposes at least FOUR incompatible shapes — M0016161 (M + 7 digits), H020L01FA21 (an H-form carrying what looks like a SEASON code SP/FA/PF/RE + year), 2S3HCR500H03, and EAN-13 BARCODES like 191267866253 which are not style numbers at all. The season-code reading is an INFERENCE from URL patterns, MJ publishes no decoder, and tag-string == web-SKU is unproven. Getting a real chart requires a browser session — flagged as owed work for the US-1715 queue.',
   'https://www.marcjacobs.com/', 0.70, false, 'migration:00468'),

  ('rebeccaminkoff', 'Rebecca Minkoff', ARRAY['rebecca minkoff','rebeccaminkoff']::text[], 'Women',
   'Bag dimensions (INCHES, W x H x D)',
   ARRAY['bag','tote','handbag','crossbody','purse','backpack','shoulder bag']::text[],
   $j$[{"size":"M.A.B. Crossbody (HS23MMBXBO)","measurements":{"dimensions_in":"11.5 x 8 x 4","strap_in":"15","hardware":"Black Shellac"}},{"size":"M.A.B. Hobo (HU22MMBH74)","measurements":{"dimensions_in":"12.5 x 11 x 4","strap_in":"19"}},{"size":"M.A.B. Mini Shoulder (HH25TMBXMI)","measurements":{"dimensions_in":"9.25 x 5.5 x 2.625","strap_drop_in":"21.5","handle_drop_in":"4.625","hardware":"Antique Brass"}},{"size":"M.A.B. Medium Crossbody (HH25TMBXMD)","measurements":{"dimensions_in":"13.125 x 7.25 x 3.375","strap_drop_in":"19.5","handle_drop_in":"7.5"}},{"size":"Julian Backpack (HF21MPBB01)","measurements":{"dimensions_in":"11.25 x 12 x 6","strap":"not published"}},{"size":"Darren Shoulder Bag (HF25TDDD28)","measurements":{"dimensions_in":"9.625 x 10.75 x 4.5","strap_drop_in":"13","hardware":"Antique Brass turn lock"}},{"size":"Edie Medium Crossbody (HU23TWSXMD)","measurements":{"dimensions_in":"10.75 x 6 x 3","strap_in":"11.5","material":"90% paper / 10% faux leather (woven straw)"}}]$j$::jsonb,
   'Brand-published, fetched from live product pages. ⚠ THE STYLE CODE IS A HANGTAG/WEB CODE, NOT A TAG CODE, AND THE EVIDENCE IS UNUSUALLY SHARP: across owner threads where interior tags are photographed and TRANSCRIBED constantly, NOBODY quotes a style code off a sewn tag — the sewn seam tag carries COUNTRY OF ORIGIN + "genuine leather" and nothing more. The only sellers quoting codes are NWT listings. **DO NOT BUILD A FLOW THAT ASSUMES A SELLER CAN READ A STYLE CODE OFF A USED REBECCA MINKOFF BAG.** ⚠ The code is also NOT a stable per-style key: "Darren Small Crescent Crossbody" alone appears as RVHS26TDDXBY, HF25TDNXBD, HS26TDDXBY, HS26EDDXBY and RVFB0104 — it identifies a SEASON/MATERIAL/COLOUR RUN, not a style. ⚠ HANDLE DROP IS INCONSISTENTLY PUBLISHED and often omitted; country of origin on every current page is only "Imported". ⚠ THE DURABLE NAMED AXIS IS HARDWARE FINISH, NOT COLOUR — "Antique Brass" and "Black Shellac" recur across styles, seasons and years and are photo-verifiable; colour names are per-season copy (a small durable core: Black, Caramello, Stone, Fondant).',
   'https://www.rebeccaminkoff.com/', 0.85, false, 'migration:00468'),

  ('rebeccaminkoff', 'Rebecca Minkoff', ARRAY['rebecca minkoff','rebeccaminkoff']::text[], 'Women',
   'Apparel (US 0-12 — BODY measurements, INCHES)',
   ARRAY['top','dress','jacket','pant','bottom','skirt','rtw','apparel','denim','blouse']::text[],
   $j$[{"size":"0 (XXS)","measurements":{"bust":"32","waist":"25","hip":"35","denim":"23","uk_fr_it":"4/34/36"}},{"size":"2 (XS)","measurements":{"bust":"33","waist":"26","hip":"36","denim":"24-25","uk_fr_it":"6/36/38"}},{"size":"4 (S)","measurements":{"bust":"34","waist":"27","hip":"37","denim":"25-27","uk_fr_it":"8/38/40"}},{"size":"6 (M)","measurements":{"bust":"35","waist":"28","hip":"39","denim":"27-28","uk_fr_it":"10/40/42"}},{"size":"8 (L)","measurements":{"bust":"36","waist":"29","hip":"39","denim":"29-30","uk_fr_it":"12/42/44"}},{"size":"10 (XL)","measurements":{"bust":"37","waist":"30","hip":"40","denim":"31-32","uk_fr_it":"14/44/46"}},{"size":"12 (XXL)","measurements":{"bust":"38.5","waist":"31.5","hip":"41.5","denim":"32-33","uk_fr_it":"16/46/48"}}]$j$::jsonb,
   'THE ONLY BODY-MEASUREMENT CHART IN THIS PACK, and it exists because Rebecca Minkoff is the one brand here that sells real RTW (added 2009). Brand-published, verbatim from its own size guide. ⚠ **PRESERVED AS-PUBLISHED WITH A KNOWN BRAND TYPO: US 6 AND US 8 BOTH LIST A 39in HIP.** US 6 should almost certainly read ~38in given the otherwise regular 1in grade. IT IS NOT SILENTLY CORRECTED — the brand''s own chart is the source of record, and quietly "fixing" a published number is how a fabrication enters a KB. Flag on ingest; the US-1715 queue owns the correction. (The shoe chart carries the same shape of error: JP 9.5 = "26.6", almost certainly 26.5.) These are BODY measurements, not flat-garment. Shoes run US 6-10 / FR 37-41 / IT 36-40 / UK 3-7.',
   'https://www.rebeccaminkoff.com/', 0.85, false, 'migration:00468'),

  ('fossil', 'Fossil', ARRAY['fossil']::text[], 'Unisex',
   'Watches (case diameter in MILLIMETRES — ⚠ NOT inches)',
   ARRAY['watch','smartwatch','chronograph','wearable']::text[],
   $j$[{"size":"ES5331 — Carlie Three-Hand SS","measurements":{"case_mm":"28","strap_width_mm":"12","water_resistance":"5 ATM","strap_inner_circumference_mm":"185 +/-5","crystal":"mineral","battery":"SR621SW"}},{"size":"ES4341P — Carlie Three-Hand SS","measurements":{"case_mm":"35","water_resistance":"3 ATM","note":"marked discontinued"}},{"size":"ES4343P — Carlie Three-Hand Sand Leather","measurements":{"case_mm":"35","thickness_mm":"9","water_resistance":"3 ATM"}},{"size":"FS4736 / FS4812 / FS4832 / FS5061 / FS6131 — Grant Chronograph","measurements":{"case_mm":"44","water_resistance":"5 ATM"}}]$j$::jsonb,
   '⚠ **THE UNIT SPLIT IS WITHIN ONE BRAND AND IT IS A REAL PARSER TRAP: FOSSIL WATCHES ARE SPEC''D IN MILLIMETRES AND FOSSIL BAGS/WALLETS IN INCHES.** A parser that does not branch on category will read a 44MM case as 44 inches. ⚠ **A FOSSIL COLLECTION NAME DOES NOT DETERMINE CASE SIZE — READ THE CASE-BACK CODE.** ES5331 is 28MM/5ATM and ES4341P is 35mm/3ATM, and BOTH are titled "Carlie Three-Hand Stainless Steel Watch": same collection name, different diameter AND different water resistance. Worse, fossil.com indexes ES5331 under BOTH "Carlie" and "Carlie Mini". THE CODE IS RELIABLE; THE NAME ATTACHED TO IT IS NOT — which is exactly why this brand has the pack''s only decoder. ⚠ CARLIE vs CARLIE MINI IS NOT PHOTO-SEPARABLE (identical design, differing only by diameter). The ATM rating is marked on the caseback or dial, so a caseback marking that contradicts the model''s published spec is a genuine inconsistency — flag in condition notes only, never as an authenticity verdict.',
   'https://www.fossil.com/', 0.85, false, 'migration:00468'),

  ('fossil', 'Fossil', ARRAY['fossil']::text[], 'Men',
   'Bags & wallets (INCHES — ⚠ note the unit differs from Fossil watches)',
   ARRAY['bag','tote','wallet','card holder','small leather goods','handbag']::text[],
   $j$[{"size":"Rachel Tote (ZB)","measurements":{"dimensions_in":"14 x 4 x 13"}},{"size":"Derrick RFID Passcase","measurements":{"dimensions_in":"3.75 x 0.25 x 2.75","note":"removable bifold"}},{"size":"Derrick Bifold","measurements":{"dimensions_in":"4.5 x 0.75 x 3.7"}},{"size":"Derrick Executive Checkbook","measurements":{"dimensions_in":"3.5 x 0.5 x 6.75","note":"the outlier — clearly taller"}},{"size":"Derrick Card Holder","measurements":{"dimensions_in":"2.75 x 0.4 x 3.81"}}]$j$::jsonb,
   '⚠ INCHES HERE, MILLIMETRES ON THE WATCH CHART — same brand. See the watches row. ⚠ CONFIDENCE IS DELIBERATELY 0.6: these numbers are a search-read of fossil.com mixed with retailer listings and could NOT be cleanly isolated to fossil.com for every figure. MEASURE THE ITEM. ⚠ **THERE IS NO FOSSIL "DEFENDER" WALLET — the line is DERRICK.** The name is plausible enough to be confabulated on demand, and is recorded here so it is not. ⚠ A ZB CODE IS NOT A STYLE KEY: the same Rachel Tote carries ZB7507263 (US), ZB1829015 (AU) and ZB7991080 elsewhere — ZB codes are per-colourway and per-region. The seeded decoder deliberately covers ES|FS|FTW only (watches), NOT ZB or ML, because only the watch code is sourced to a physical mark.',
   'https://www.fossil.com/', 0.60, false, 'migration:00468'),

  ('verabradley', 'Vera Bradley', ARRAY['vera bradley','verabradley']::text[], 'Women',
   'Bag dimensions (INCHES, W x H x D)',
   ARRAY['bag','tote','backpack','travel bag','duffel','crossbody','handbag','purse']::text[],
   $j$[{"size":"Campus Backpack","measurements":{"dimensions_in":"12.0 x 16.5 x 7.5","strap_adjustable_in":"32.0","handle_drop_in":"2.75"}},{"size":"Weekender Travel Bag","measurements":{"dimensions_in":"18.5 x 12.5 x 7.5","strap_drop_in":"6.5","removable_strap_in":"52.5"}},{"size":"Iconic Compact Weekender","measurements":{"dimensions_in":"16.25 x 10.00 x 7.25","handle_drop_in":"4.50","removable_strap_in":"52.50"}},{"size":"Miller Travel Bag","measurements":{"dimensions_in":"16 x 14 x 8","strap_drop_in":"13"}}]$j$::jsonb,
   '⚠ CONFIDENCE 0.70 AND CURRENT-VERSION-ONLY: VB''s product pages render specs client-side, so these were read through a search engine rather than fetched, and they describe the CURRENT version of each style — VB has re-specced silhouettes over time (the Campus Backpack also circulates as 11 x 17 x 8). ⚠ **THE STRAP DROP IS THE ONLY RELIABLE SEPARATOR IN THIS TABLE**: Weekender 6.5in vs Iconic Compact Weekender 4.50in vs Miller 13in. Campus vs XL CAMPUS is the same silhouette scaled up and is NOT photo-separable without a scale reference. ⚠ **REMEMBER THIS BRAND INVERTS THE USUAL WEIGHTING — THE PATTERN IS THE IDENTITY, NOT THE STYLE** (see the pattern style row): VB silhouettes are near-duplicates across a dozen variants and every fabric line, so do NOT spend confidence on style resolution here. ⚠ NO DIMENSIONS ARE SEEDED FOR THE ORIGINAL ZIP HIPSTER — VB''s page did not yield specs and none is invented. ⚠ NO STYLE CODE EXISTS: VB''s URLs carry numeric Shopify IDs (26468t77) with no evidence of any tag printing.',
   'https://verabradley.com/', 0.70, false, 'migration:00468'),

  ('dooneybourke', 'Dooney & Bourke', ARRAY['dooney & bourke','dooney and bourke','dooneybourke','dooney']::text[], 'Women',
   'Bag dimensions (INCHES — ⚠ NORMALISED to L x D x H; Dooney publishes H x D x L)',
   ARRAY['bag','tote','handbag','satchel','crossbody','purse','shoulder bag']::text[],
   $j$[{"size":"Florentine Satchel (8L980)","measurements":{"dimensions_in":"12 x 4.75 x 7","handle_drop_in":"4.5","strap_drop_in":"19"}},{"size":"AWL 2 Duck Bag (Q150C)","measurements":{"dimensions_in":"6 x 3 x 6","strap_drop_in":"25"}},{"size":"Vintage R03 Doctor Bag","measurements":{"dimensions_in":"11 x 7 x 5.5","note":"axis order NOT stated by the source — do not assume"}},{"size":"Vintage R710 Small Satchel","measurements":{"dimensions_in":"10 x 7 x 4.5","note":"axis order NOT stated"}},{"size":"Vintage R28 Medium Satchel","measurements":{"dimensions_in":"10.5 x 8.5 x 5.5","note":"axis order NOT stated"}},{"size":"Vintage R730 Large Satchel","measurements":{"dimensions_in":"12 x 10 x 6","note":"axis order NOT stated"}}]$j$::jsonb,
   '⚠ **AXIS ORDER IS A LIVE DATA-QUALITY RISK HERE: DOONEY PUBLISHES ITS FIELDS AS H x D x L AND THE ROWS ABOVE ARE NORMALISED TO L x D x H.** Mis-ordering these silently produces a wrong bag. ⚠ THE VINTAGE ROWS ARE COLLECTOR-SOURCED (0.6) AND THEIR AXIS ORDER IS NOT STATED BY THE SOURCE AT ALL — they are seeded for rough orientation only; measure the bag. ⚠ THE VINTAGE STYLE NUMBER''S LETTER PREFIX REPORTEDLY ENCODES TRIM COLOUR (R = British Tan, B = Burnt Cedar, P = matching trim) — internally consistent across the model list, but collector-sourced and NOT verified. ⚠ MODERN STYLE NUMBERS carry a 2-letter COLOUR SUFFIX (8L980NA = Natural, Q150CWH = White). ⚠ **NONE OF THESE STYLE NUMBERS IS CONFIRMED ON THE BAG** — no source shows 8L980 or R730 printed on a Dooney, and Dooney''s own registration form reportedly asks for the SKU from the paper GUARANTEE CARD. Do NOT instruct a seller to look for a style number on the bag. The ONE code that IS on the bag is the REGISTRATION NUMBER on the reverse of the sewn tag — and it is deliberately not decoded (see the brand notes: its date semantics are flatly contradicted).',
   'https://www.dooney.com/', 0.70, false, 'migration:00468'),

  ('brahmin', 'Brahmin', ARRAY['brahmin']::text[], 'Women',
   'Bag dimensions (INCHES — ⚠ AXIS ORDER IS INTERNALLY INCONSISTENT, see note)',
   ARRAY['bag','tote','handbag','satchel','crossbody','purse','shoulder bag']::text[],
   $j$[{"size":"Lorelei Shoulder (S10)","measurements":{"dimensions_in_as_published":"6.0 L x 9.0 D x 2.25 H","strap_in":"10.5","warning":"⚠ THE AXIS LABELS LOOK WRONG — this implies a bag deeper than it is long; almost certainly 9in L x 6in H x 2.25in D"}},{"size":"Duxbury Satchel (K43 / V48)","measurements":{"dimensions_in":"12.75 W x 9.75 H x 5.0 D","handle_drop_in":"4","strap_in":"25","confidence":"0.5 — snippet-derived, product page 404'd"}},{"size":"Large Duxbury (V49)","measurements":{"dimensions_in":"14.2 W x 12 H x 5.0 D","handle_drop_in":"4","strap_in":"13","confidence":"0.5 — snippet-derived"}},{"size":"Priscilla Satchel (N79)","measurements":{"dimensions_in":"15.0 W x 10.25 H x 5.5 D","confidence":"0.6"}}]$j$::jsonb,
   '⚠ **CONFIDENCE 0.55 AND DELIBERATELY LOW: BRAHMIN''S OWN AXIS ORDERING IS INTERNALLY INCONSISTENT** — the Lorelei is published L x D x H while the Duxbury family is W x H x D, and the Lorelei''s numbers are self-evidently mislabelled (6.0L x 9.0D x 2.25H describes a bag deeper than it is long). THE PUBLISHED LABELS ARE PRESERVED RATHER THAN SILENTLY CORRECTED, with the discrepancy flagged for the US-1715 queue. ⚠ THE DUXBURY ROWS ARE SNIPPET-DERIVED (the product pages 404''d) — VERIFY BEFORE RELYING. ⚠ **DUXBURY vs LARGE DUXBURY IS NOT PHOTO-SEPARABLE**: same silhouette, same finish, 1.5in apart — without a scale reference the model must ABSTAIN. ⚠ BRAHMIN MEASURES "at the widest and tallest points, excluding handles" — a METHODOLOGY note worth keeping, because it makes these numbers NON-COMPARABLE to brands that measure the base. ⚠ THE SKU DECODES CLEANLY BUT IS A **LISTING** PARSER, NOT A TAG CODE: [style 3][material 3-4][colour 5], parsed RIGHT-TO-LEFT (last 5 = colour, first 3 = style, remainder = material) because the material field is 3 OR 4 digits — a fixed-offset parser WILL corrupt data. ⚠ MELBOURNE IS A MATERIAL, NOT A COLOUR OR A STYLE.',
   'https://brahmin.com/', 0.55, false, 'migration:00468'),

  ('tumi', 'Tumi', ARRAY['tumi']::text[], 'Unisex',
   'Luggage & bags (⚠ Tumi publishes CENTIMETRES as H x D x W — inches below are DERIVED)',
   ARRAY['bag','luggage','carry-on','suitcase','backpack','briefcase','duffel','travel bag']::text[],
   $j$[{"size":"Alpha 3 International Expandable Carry-On (117154)","measurements":{"dimensions_cm_hdw":"56 x 23 x 35.5 (expanded 56 x 28 x 35.5)","dimensions_in_derived":"~22 x 9 x 14","capacity":"⚠ CONTRADICTED: 35 L or 35/45 L","weight":"⚠ CONTRADICTED: 4.604 kg or 4.946 kg"}},{"size":"19 Degree Aluminium International Carry-On (124851)","measurements":{"dimensions_cm_hdw":"56 x 23 x 35.5","dimensions_in_derived":"~22 x 9 x 14","capacity":"31 L","weight":"5.076 kg"}},{"size":"Alpha 3 Short Trip Expandable Packing Case (117165)","measurements":{"dimensions_cm_hdw":"66 x 33 x 48.5","dimensions_in_derived":"~26 x 13 x 19","capacity":"83 L","weight":"7.365 kg"}},{"size":"Alpha 3 Extended Trip Expandable (117167)","measurements":{"height_cm":"78.5","capacity":"126 L"}},{"size":"Alpha 3 Worldwide Trip Expandable (117168)","measurements":{"height_cm":"86.5","capacity":"138 L"}},{"size":"Voyageur Celina Backpack (146566)","measurements":{"dimensions_cm_hdw":"40.5 x 16.5 x 27","dimensions_in_derived":"~16 x 6.5 x 10.6","capacity":"32.12 L","weight":"0.91 kg"}},{"size":"Alpha Bravo Navigation Backpack (142497)","measurements":{"dimensions_cm_hdw":"40.5 x 18.5 x 35.5 (expanded 40.5 x 25.5 x 35.5)","dimensions_in_derived":"~16 x 7.3 x 14","weight":"1.273 kg"}}]$j$::jsonb,
   '⚠ **TUMI PUBLISHES H x D x W, NOT H x W x D** — transcribing as H x W x D silently SWAPS DEPTH AND WIDTH. ⚠ THE INCH FIGURES ARE DERIVED FROM TUMI''S PUBLISHED CENTIMETRES, not sourced — Tumi''s EU pages do not publish inches at all. ⚠ **DO NOT ASSERT "AIRLINE COMPLIANT": TUMI PUBLISHES NO COMPLIANCE GUARANTEE.** It markets by regional cabin CONVENTION ("International" ~56cm / ~22in, "Continental"/"Domestic" larger) and confirms only a TSA-approved lock — and EXPANSION PUSHES THE BAG OUT OF SPEC (up to 2in / 5cm additional). ⚠ **SPEC DRIFT IS REAL AND UNRESOLVED**: the flagship 117154 is published as BOTH 35 L / 4.604 kg AND 35/45 L / 4.946 kg on BRAND-OWNED sites (possibly a variant or regional drift). Neither is picked. ERA-SCOPE SPEC EQUALITY; never grade a listing "misdescribed" on capacity or weight alone. ⚠ THE STYLE NUMBER IS A CATALOGUE CODE, NOT A TAG CODE — and Tumi runs THREE INCOMPATIBLE FORMATS on its own regional sites: NNNNNN-CCCC (uk/be/es), 0NNNNNNCCCC concatenated (US), 464.NNNNNNNND (gr). The 4-char SUFFIX IS A DURABLE COLOUR CODE (1041 = Black across 13+ styles) and is seeded as colorways — ⚠ IT IS ALPHANUMERIC (A639, T522, B186): parse as string, never as int. ⚠ Style-number blocks appear to cluster by collection (Alpha 3 = 1171xx) but the pattern BREAKS (139685 is a Short Trip, not 19 Degree) — NOT seeded as a rule.',
   'https://www.tumi.com/', 0.80, false, 'migration:00468'),

  ('herschelsupplyco', 'Herschel Supply Co.',
   ARRAY['herschel','herschel supply','herschel supply co','herschelsupplyco']::text[], 'Unisex',
   'Backpacks & duffles (INCHES, H x W x D — Herschel publishes native inches)',
   ARRAY['bag','backpack','duffel','luggage','tote','travel bag','hip pack']::text[],
   $j$[{"size":"Little America","measurements":{"dimensions_in":"19.09 x 11.22 x 7.09","capacity":"⚠ 30 L current / 25 L on older stock","weight":"2.43 lb","laptop_sleeve_in":"12.5 x 11.25"}},{"size":"Little America Mid","measurements":{"dimensions_in":"16.93 x 11.02 x 5.32","capacity":"⚠ 21 L current / 17 L cached","weight":"2.09 lb","laptop_sleeve_in":"12.5 x 11"}},{"size":"Retreat","measurements":{"dimensions_in":"18.11 x 11.02 x 5.91","capacity":"23 L","weight":"1.63 lb"}},{"size":"Settlement","measurements":{"dimensions_in":"17.13 x 11.42 x 5.91","capacity":"23 L","weight":"1.37 lb","laptop_sleeve_in":"11.25 x 11"}},{"size":"Heritage","measurements":{"dimensions_in":"18.11 x 12.21 x 6.5","capacity":"24 L","weight":"1.43 lb","laptop_sleeve_in":"9.5 x 10.5"}},{"size":"Classic","measurements":{"dimensions_in":"16.73 x 12.21 x 6.3","capacity":"26 L","weight":"1.1 lb"}},{"size":"Classic XL","measurements":{"dimensions_in":"17.72 x 12.8 x 6.5","capacity":"⚠ 30 L — but a \"Classic Backpack XL 26L\" page also exists"}},{"size":"Novel Duffle","measurements":{"dimensions_in":"11.73 x 20.51 x 10.98","capacity":"43 L","weight":"2.21 lb"}}]$j$::jsonb,
   '⚠ **CAPACITY IS NOT A MODEL IDENTIFIER AND THIS IS THE BRAND''S HEADLINE RESALE TRAP: THE SAME MODEL NAME SHIPS AT DIFFERENT SPECS ACROSS ERAS.** Little America 30L (current) vs 25L (older stock and its own Amazon listing); Mid 21L vs 17L; and "Classic XL" names BOTH a 30L and a 26L bag. **A 2015 and a 2025 Little America are BOTH GENUINE AND DIFFERENTLY SIZED** — never grade a listing "misdescribed" on capacity alone, and era-scope any spec equality check. ⚠ **THE OBVIOUS DISCRIMINATOR IS WRONG: LITTLE AMERICA AND RETREAT ARE NOT SEPARABLE BY CLOSURE OR STRAP HARDWARE** — both are verbatim "Easy U-pull drawcord closure" + "Magnet fastened straps with metal pin buckles". Separate them on the SIDE PROFILE (7.09in vs 5.91in depth), the TOP-LID ZIP (LA only) or the SIDE-ENTRY ZIP (Retreat only). ⚠ HERITAGE vs SETTLEMENT is the hardest pair — both zippered, same capacity class, separable only on proportion; ROUTE TO HUMAN REVIEW. ⚠ Herschel publishes NATIVE INCHES, so unlike Tumi no conversion is involved. ⚠ NO STYLE CODE IS SEEDED: 10014-00001-OS traces only to URLs, and Herschel''s warranty flow never asks the owner to read a number off the bag.',
   'https://herschel.com/', 0.85, false, 'migration:00468')
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
insert into public.applied_migrations (version) values ('00468') on conflict do nothing;
