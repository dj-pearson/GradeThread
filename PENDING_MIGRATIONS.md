# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

> **00435–00442 were applied to prod + pushed on 2026-07-12** (user confirmed).
> The sections below for those are historical; the only NEW held migration is
> **00443** at the top.

## ⏳ PENDING: 00472_outdoor_technical_tier2_brand_knowledge.sql (US-1992 outdoor & technical tier 2 brand KB, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the tier-2 outdoor/technical
tier: **Fjällräven, Salomon, Cotopaxi, Kühl, Helly Hansen, Mammut, Rab, Outdoor
Research.** **All eight were passthrough-only.** Sits beside 00453 (Arc'teryx,
Patagonia, The North Face, Columbia, Marmot) and 00460's luxury outerwear (Canada
Goose, Moncler), neither re-touched.

**The through-line: THE VALUE IS THE MODEL NAME + THE FABRIC TECHNOLOGY — never a
tag-printed brand-unique code.** A jacket, fleece or pack lists precisely when it
is grounded by the MODEL (Kånken, XT-6, Allpa, Renegade, Alpha, Eiger Extreme,
Microlight, Foray) and the FABRIC TECH on the hangtag/membrane (GORE-TEX, G-1000,
LIFA, Pertex, Primaloft, Contagrip, down FILL-POWER) — both halves are NAMES, so
the fabric tech leads every style fingerprint.

- **ZERO DECODERS, deliberately** (the 00470 call) — NO decoder clears the bar;
  every candidate is fixtured as a REFUSAL in `brand-knowledge-golden_test.ts`.
  Salomon's article number (`L41252600`) is a bare alphanumeric web SKU (the Chanel
  rule); Fjällräven/Helly Hansen product numbers are web/catalogue SKUs.
- **TWO NAME/WORD COLLISIONS in `brand-normalize.ts` (not data):**
  - **"Rab" is added to `DETECT_EXCLUDED_FROM_TEXT`** — an ordinary short token / a
    given name (the KEEN/Brooks precedent). Reachable by tag, never minted from prose.
  - **"Kühl" is added to `DETECT_EXCLUDED_FROM_TEXT`** — the German word for "cool".
    Both the accented (`khl`) and unaccented (`kuhl`) alias keys resolve a tag; both
    verified by mutation in `outdoor-technical-content_test.ts`. (⚠ `brandKey()`
    strips diacritics, so Fjällräven keys as `fjllrven` / `fjallraven`.)
- **NO RN IS SEEDED** — largely imported technical outerwear; no registrant sourced
  to a PRIMARY FTC record (RN 17257, 00468). Owed to the US-1715 queue.
- **TAG ERAS documented for the two heritage makers** — Helly Hansen (1877) and
  Fjällräven (1960) — **empty for the six modern brands** (Salomon, Cotopaxi 2014,
  Kühl 1993, Mammut, Rab, Outdoor Research) — the athleisure precedent, 00452.
- **COLORWAYS: Fjällräven-only.** The Kånken ships a stable NAMED palette (UN Blue,
  Ox Red, Frost Green, Graphite, Royal Blue, Ochre). ⚠ **Cotopaxi is the INVERSION**:
  Del Día is intentionally one-of-a-kind (remnant fabric, no stable palette) → **ZERO
  Cotopaxi colorways, by design.**

`brand_knowledge` ×**8**; `brand_styles` ×**30**; `brand_colorways` ×**6**
(Fjällräven Kånken only); `brand_style_codes` ×**0**; `brand_size_charts` ×**16**
(EU-numeric apparel for the European brands, US-alpha for the US brands, a STAMPED
US/UK/EU footwear translator for Salomon), all mirrored 1:1 into the
`sizing-charts.ts` in-code fallback. Every fact carries `source_url` + `confidence`
and lands `verified=false` for the US-1715 admin queue. Idempotent
(`on conflict do update`).

Apply **after 00471** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00472**). Bumps `EXPECTED_SCHEMA_VERSION` → **00472**. Risk: LOW — data-only, no
schema change, no DDL, no frontend reads the new rows (the edge resolver falls back
to the in-code tables when a pack is absent).

## ⏳ PENDING: 00471_intimates_loungewear_shapewear_brand_knowledge.sql (US-1991 intimates/loungewear/shapewear brand KB, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the intimates / loungewear /
shapewear tier: **SKIMS, Spanx, Victoria's Secret, PINK, Aerie, Savage X Fenty,
Calvin Klein, Tommy John.** Six were passthrough-only; **Calvin Klein is PROMOTED**
from its shallow 00389 alias-only shell to a full pack.

**The through-line: THE FIT + THE SIZE SYSTEM IS THE PRODUCT, and the size system
is NOT one system.** Unlike footwear's single stamped number, an intimates listing
spans THREE incompatible size systems — **BRA (band 30-44 + cup A-DDD/G, a two-axis
system where the cup letter is RELATIVE to the band), SHAPEWEAR (alpha XS-4X, graded
on compression), and APPAREL/underwear (alpha XS-XXL / a waist run)** — with the
system named IN the label and the cup-difference math written into the chart note.
The style is a NAMED FABRIC LINE for all eight (Fits Everybody, Faux Leather
Leggings, Bombshell, Modern Cotton, Second Skin), never a tag-printed code.

- **ZERO DECODERS, deliberately** (the 00470 call) — every candidate is fixtured as
  a REFUSAL in `brand-knowledge-golden_test.ts`. Calvin Klein's underwear U-number
  (U2664G) is a web/packaging SKU across licensed product (the Fossil hazard,
  00468); Spanx's style number (10005R) is a bare digit run (the Chanel rule). **A
  BRA SIZE IS NOT A STYLE CODE** — "34DDD" is captured by the size charts, never a
  decoder.
- **TWO SUB-BRAND CODE CHANGES in `brand-normalize.ts` (not data):**
  - **AERIE is PROMOTED to its own canonical, reversing the US-1739 fold** onto
    American Eagle. The mall "same band → fold" call is wrong for intimates: eBay
    has a first-class Aerie brand and Aerie bralettes/OFFLINE leggings comp on their
    own ladder. **"Aerie" is added to `DETECT_EXCLUDED_FROM_TEXT`** (an ordinary
    noun — an eagle's nest; now on the prose-scan path for the first time).
  - **PINK is its OWN canonical, NOT folded onto Victoria's Secret** — a lower-band,
    separately-searched collegiate line (the Hollister rule, 00458). **"PINK" is
    added to `DETECT_EXCLUDED_FROM_TEXT`** (an ordinary colour word). Both verified
    by mutation in `intimates-loungewear-content_test.ts`.
- **NO RN IS SEEDED** — these ARE textile products so an RN would be in-scope, but
  no registrant was sourced to a PRIMARY FTC record; fabricating one is the KB's
  costliest error (RN 17257, 00468). Owed to the US-1715 queue.
- **TAG ERAS documented for the two brands with a genuine vintage chronology**
  (Victoria's Secret "Gold Label" gold-script Made-in-USA lingerie; vintage 90s
  Calvin Klein / one-logo), **empty for the six modern brands** (Skims 2019, Savage
  X 2018, Aerie 2006, PINK 2004, Spanx 2000, Tommy John 2008) — the athleisure
  precedent, 00452.

`brand_knowledge` ×8 (Calvin Klein promoted via on-conflict); `brand_styles` ×23;
`brand_colorways` ×**8** (SKIMS' proprietary nude/skin-tone palette — Sand/Sienna/
Clay/Cocoa/Umber/Onyx/Oxide/Ochre, the only NAMED palette in the pack);
`brand_style_codes` ×**0**; `brand_size_charts` ×**11** (bra band+cup translators +
shapewear/apparel alpha + underwear waist runs), all mirrored 1:1 into the
`sizing-charts.ts` in-code fallback. Every fact carries `source_url` + `confidence`
and lands `verified=false` for the US-1715 admin queue. Idempotent
(`on conflict do update`).

Apply **after 00470** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00471**). Bumps `EXPECTED_SCHEMA_VERSION` → **00471**. Risk: LOW — data-only, no
schema change, no DDL, no frontend reads the new rows (the edge resolver falls back
to the in-code tables when a pack is absent).

## ⏳ PENDING: 00470_footwear_tier2_brand_knowledge.sql (US-1990 footwear tier 2 brand KB, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the tier-2 footwear tier:
**Clarks, Merrell, KEEN, Sorel, Brooks, Saucony, Steve Madden, Sam Edelman,
Allen Edmonds, Crocs.** **ALL TEN were passthrough-only.** Sits beside 00459 (New
Balance, Dr. Martens, UGG, Birkenstock, Converse, Vans, Cole Haan) and 00465's
ASICS/HOKA/On Running, none re-touched.

**The through-line: THE SIZE IS STAMPED, NOT MEASURED — and the STYLE IS A NAME,
NOT A CODE.** The story note's "Style code + US/UK/EU size system are the key
signal" resolves, on the evidence, to the SIZE SYSTEM: the charts are US/UK/EU
TRANSLATORS with the cross-map written INTO the size label (the 00459 shape), and
every model is identified by a coined/trademarked NAME (Desert Boot, Moab,
Newport, Caribou, Ghost, Kinvara, Park Avenue, Classic Clog), never a regular
tag-printed brand-unique code.

- **ZERO DECODERS, deliberately** (the 00466 call) — every candidate is fixtured
  as a REFUSAL negative in `brand-knowledge-golden_test.ts`. Brooks' 6-digit style
  number (110411) is a BARE DIGIT RUN (the Chanel rule). Saucony's `S2xxxx`/`S1xxxx`
  is refused on the SHARPEST ground: `S` + 5 digits is EXACTLY adidas's style-code
  shape (`S79166`, the `brandFromStyleFormat` adidas branch), so a pattern would let
  a format guess override the tag's own brand (the 00465 adidas/Reebok hazard).
  Merrell's `J`-prefixed article number is a single-letter prefix (not a closed set
  like New Balance's M/W/U) and not established as tag-printed vs a box/web SKU.
- **TWO NAME-COLLISION CODE CHANGES in `brand-normalize.ts` (not data):**
  - **A bare "brooks" is NOT aliased** — Brooks Running (this pack, Berkshire
    Hathaway) and Brooks Brothers (00467) are DIFFERENT companies that litigated the
    name, so a bare "Brooks" is genuinely ambiguous (the 00467 rule). It passes
    through unchanged, which equals the running brand's eBay canonical, so the pack
    (brand_key `brooks`) stays reachable. **"Brooks" is added to
    `DETECT_EXCLUDED_FROM_TEXT`** (an ordinary word — "babbling brooks").
  - **"KEEN" is added to `DETECT_EXCLUDED_FROM_TEXT`** — an ordinary English
    adjective ("keen interest"); reachable BY TAG, never GUESSED from prose. Both
    verified by mutation in `footwear-tier2-content_test.ts`.
- **NO RN IS SEEDED** — footwear uppers sit largely outside textile RN labeling
  (the 00468 category-error lesson) and no registrant was sourced; fabricating one
  is the KB's costliest error (RN 17257). Owed to the US-1715 queue.
- **TAG ERAS documented for the two HERITAGE makers** (Clarks Originals
  Made-in-England, Allen Edmonds Made-in-USA), **empty for the eight modern brands**
  with no vintage tag corpus (the athleisure precedent, 00452).

`brand_knowledge` ×10; `brand_styles` ×26; `brand_colorways` ×**4** (Clarks
Originals leathers — Beeswax/Sand/Cola/Oakwood, the only proprietary NAMED palette
in the pack); `brand_style_codes` ×**0**; `brand_size_charts` ×**15** (US/UK/EU
footwear translators), all mirrored 1:1 into the `sizing-charts.ts` in-code
fallback. Every fact carries `source_url` + `confidence` and lands `verified=false`
for the US-1715 admin queue. Idempotent (`on conflict do update`).

Apply **after 00469** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00470**). Bumps `EXPECTED_SCHEMA_VERSION` → **00470**. Risk: LOW — data-only, no
schema change, no DDL, no frontend reads the new rows (the edge resolver falls back
to the in-code tables when a pack is absent).

⚠ **Docker was unavailable on the authoring host, so `verify:db` could not run**
(same as 00465..00469). The seed was instead validated by
`scripts/ralph/validate-seed-sql.py` (pglast — the real PostgreSQL parser): parses
(5 statements), every tuple matches its column list (10×13, 26×14, 4×9, 15×12,
1×1), no duplicate `on conflict` key in any INSERT, and all 45 dollar-quoted `$j$`
bodies scanned for the `''`-inside-`$j$` trap and JSON validity — clean, with the
scanner self-tested against three planted bugs (all caught). **Still run
`npm run verify:db` before applying to prod.**

## ⏳ PENDING: 00469_heritage_workwear_brand_knowledge.sql (US-1989 heritage & workwear brand KB, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the heritage / workwear tier:
**Dickies, Filson, Red Wing, Timberland, Duluth Trading Co., Pendleton, Barbour,
Orvis.** Six were passthrough-only; **Dickies and Pendleton are PROMOTED** from
their shallow alias-only 00389 rows to full packs.

**For this group the TAG IS THE ASSET** — the interior label ERA is the single
largest price driver (a 1950s-60s Pendleton board shirt or a Made-in-USA vintage
Filson Cruiser is worth a multiple of its modern twin), so the pack's centre of
gravity is `tag_eras`. A documented, value-driving chronology exists for
Pendleton/Barbour/Filson/Red Wing/Timberland/Dickies and DOES NOT for Duluth
Trading (1989, modern) or Orvis — empty `tag_eras` on those two is correct, not a
gap (the athleisure precedent, 00452).

- **ONE DECODER — BARBOUR.** The interior-label style code `[M|L]` + a 2-letter
  line code + 4 digits (`MWX0018` = Bedale, `LWX0667` = Beadnell) is tag-printed,
  regular and brand-unique — the exact Canada Goose department-letter case
  (00460). The boot brands' household-name style numbers (Dickies 874, Red Wing
  875, Timberland 10061) are REFUSED as bare digit runs (the Chanel rule).
- **HEADLINE REFUSAL: a bare "duluth" is NOT Duluth Trading.** "Duluth" is a
  Minnesota city AND DULUTH PACK (est. 1882), an unrelated waxed-canvas pack
  maker. Only "duluth trading" / "duluthtrading" are aliased (the Longchamp
  Fabrics trap, 00468).
- **NO RN IS SEEDED.** These ARE textiles so RNs genuinely exist, but none could
  be sourced to a primary FTC record and fabricating one is the KB's costliest
  error (the RN 17257 lesson) — refused with the reason recorded, owed to the
  US-1715 queue.
- **"Red Wing" added to `DETECT_EXCLUDED_FROM_TEXT`** — reachable BY TAG, never
  guessed from prose ("Detroit Red Wings" / the red-wing blackbird).

Ships with: the migration; `brand-normalize.ts` aliases (+ the Red Wing exclusion
+ the Duluth-Pack refusal); `sizing-charts.ts` in-code mirrors (8 charts, apparel
+ footwear); `schema-version.ts` bump to `00469`; and two edge tests
(`brand-knowledge-golden_test.ts` Barbour decoder + refusals,
`heritage-workwear-content_test.ts`). All seed facts land `verified=false` for the
US-1715 admin verify queue. **Docker was unavailable on the authoring host, so
`verify:db` could not run; the seed is validated by
`scripts/ralph/validate-seed-sql.py` (pglast parse + tuple arity + `''`-in-`$j$`
+ JSON validity). Still run `verify:db` before applying to prod.**

## ⏳ PENDING: 00468_handbags_accessories_brand_knowledge.sql (US-1988 handbags & accessories brand KB, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the handbags / accessories
tier: **Longchamp, Marc Jacobs, Rebecca Minkoff, Fossil, Vera Bradley, Dooney &
Bourke, Brahmin, Tumi, Herschel Supply Co.** **ALL NINE WERE PASSTHROUGH-ONLY.**

**This is the KB's first ACCESSORY-FIRST group** — 00443..00467 all graded
GARMENTS; this one grades BAGS, and that shift is the whole pack rather than a
cosmetic detail, because **a bag carries less recoverable information on its body
than a garment does.** Both of the story's stated premises died in research:

- **RN is a CATEGORY ERROR here, not a research failure.** Prior packs recorded
  "no RN — the FTC database is a JS shell". That is an ACCESS excuse; the real
  reason is STATUTORY. Textiles in handbags/luggage are EXCLUDED from textile
  labeling absent a fiber claim, so a leather handbag has no RN to find. Absence
  is CORRECT and must never read as a red flag. The exemption is proven by its own
  exception: **Marc Jacobs is the only brand here with a sourced RN, precisely
  because it sells ready-to-wear.** The RN lives where the TEXTILE lives.
- **The style code left with the hangtag.** In apparel the code is printed on the
  sewn care label, which is why 00460/00467 could ship cut-tag decoders. A bag has
  no care label — its code is on a REMOVABLE PAPER HANGTAG. Checkable against our
  own KB rather than asserted: Coach (00398) SEWS a creed patch carrying the style
  number *into* the bag and got a decoder. A bag CAN carry a code; these nine do not.

**The headline refusal: RN 17257 IS NOT LONGCHAMP.** The exact failure the sourcing
policy exists to prevent — a REAL federal record, the RIGHT brand string, the WRONG
company. The register's only "longchamp" hit is *LONGCHAMP FABRICS CORP*, a NYC
garment-district fabric wholesaler at 1412 Broadway. The maison's registrant would
be S.A.S. Jean Cassegrain, which has no RN. Seeded as an explicit refusal.

`brand_knowledge` ×9; `brand_styles` ×40; `brand_size_charts` ×**11**, all mirrored
1:1 into the `sizing-charts.ts` in-code fallback; `brand_style_codes` ×**1**
(Fossil); `brand_colorways` ×**38** (Longchamp 8, Tumi 10, Vera Bradley 20). Every
fact carries `source_url` + `confidence` and lands `verified=false` for the US-1715
admin queue. Idempotent (`on conflict do update`).

**The one decoder is a watch, not a bag:** Fossil's `ES|FS|FTW` + 4-5 digits, on the
metal CASE BACK (Fossil's own support). It is the pack's cut-tag case — a case back
cannot come off the way a hangtag can. **The prefixes are anchored as a SAFETY
MECHANISM:** ~47% of Fossil Group's net sales are LICENSED brands (Michael Kors
alone 19.2%), so a permissive two-letter pattern would decode an `MK8017` under the
Fossil pack and spell the brand "Fossil". Anchoring makes that impossible by
construction. It captures **only `styleCode`** and asserts nothing about what the
letters mean — the popular "ES = Fossil Steel" gloss is refuted by Fossil's own
catalogue (ES4343 is leather-strap).

**Two brands carry TWO charts on one `brand_key`** (Fossil watches-in-MM vs
bags-in-INCHES; Rebecca Minkoff bags vs apparel), where `category_match` is the only
discriminator — the US-1985 trap. The unit system is named in `garment` so the model
sees which chart it got.

**⚠ Vera Bradley's 20 patterns are seeded as CURRENT-SEASON, NOT RETIRED, and NO
retirement date is seeded for any pattern.** The retired-patterns-archive URL serves
the *current* patterns landing page; seeding them as retired would invert the truth
on the single field that drives this brand's price.

Apply **after 00467** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00468**). Bumps `EXPECTED_SCHEMA_VERSION` → **00468**. Risk: LOW — data-only, no
schema change, no DDL, no frontend reads the new rows (the edge resolver falls
back to the in-code tables when a pack is absent).

⚠ `verify:db` could NOT run for this migration (Docker unresponsive on the
authoring host — same as 00465, 00466 and 00467). The SQL was instead validated
against the real PostgreSQL parser via **pglast**: parses (6 statements), every
tuple matches its column list (9×13, 40×14, 1×10, 38×9, 11×12, 1×1), no duplicate
`on conflict` key in any INSERT, and all 40 dollar-quoted `$j$` bodies scanned for
the `''`-inside-`$j$` trap and JSON validity — clean. The scanner was self-tested
against three planted bugs (a planted `''`, planted malformed JSON, and a planted
dropped column) and caught all three. **Still run `npm run verify:db` before
applying to prod.**

---

## ⏳ PENDING: 00467_preppy_contemporary_mens_brand_knowledge.sql (US-1987 preppy & contemporary men's brand KB, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the preppy / contemporary
menswear tier: **Vineyard Vines, Brooks Brothers, Bonobos, Faherty, Peter Millar,
Todd Snyder, Buck Mason, UNTUCKit, Johnnie-O**. The menswear counterpart to
00466's fast-fashion/mall tier and 00458's basics tier, neither re-touched.

**ALL NINE WERE PASSTHROUGH-ONLY** — a "peter millar" tag rendered the seller's
own casing into the prompt block and the eBay Brand aspect on some of the
highest sell-through menswear in resale.

`brand_knowledge` ×9; `brand_styles` ×34; `brand_size_charts` ×16, all mirrored
1:1 into the `sizing-charts.ts` in-code fallback; `brand_style_codes` ×**1**
(Peter Millar); `brand_colorways` ×**5** (Bonobos only). Every fact carries
`source_url` + `confidence` and lands `verified=false` for the US-1715 admin
queue. Idempotent (`on conflict do update`).

**The pack's headline fact:** the FIT NAME is the garment-defining attribute and
it is **TAG-ONLY**. Unlike 00466 (where the dispute was the size SYSTEM), the size
grade here is not in dispute — a Bonobos 32x32 is a 32x32 in every fit. What
changes is the CUT, by up to **5 inches** of chest/waist, and the only thing that
says which is a word printed on the tag: not in the photo, not in the number, not
recoverable by measuring the label.

**And two brands' fit ladders run BACKWARDS from what the open web says**, each
refuted by the brand's own published chart: Bonobos' **Tailored is TRIMMER than
Slim**, and Brooks Brothers' **Madison is the ROOMIEST suit fit** (+3" chest, +5"
waist over Regent). Aggregators split or state the inverse outright, so retrieval
does not save a model here — seeding the popular version would have inverted both
ladders. BB also runs five shirt rungs vs three suit rungs, so "Madison" is 4th of
5 in one category and roomiest of 3 in the other.

**One decoder, brand-sourced:** Peter Millar's `ME0EK01`/`LE0B46` style number,
which PM's own help centre places "together with care instructions, on the inside
of the garment" — the pack's **cut-tag case** (the care label survives the collar
tag being cut). It captures **only `styleCode`** and deliberately does not map
gender (the shared `genderCode` transform maps W/M; PM's ladies' letter is L, so
capturing it would emit a raw "L" as a gender). The **season is deliberately not
decoded**: `ME0S24` is an evergreen sweater whose body merely contains "S24", so a
naive Spring-2024 parse is silently wrong.

**Eight decoder refusals, all fixtured as negatives** in
`brand-knowledge-golden_test.ts`. The instructive one is Buck Mason's `B007`/`D018`
— refused **on evidence, not principle**: `B007` appears on both a Ford Standard
and a Maverick Slim, so the code identifies the DENIM FABRIC LOT, not the style.
The rest are web/Shopify SKUs harvested from URLs (shape is not provenance).

**RN for eight of the nine is deliberately absent** — the FTC database is a JS
shell that returns nothing to automation. Only Peter Millar's 100308 is seeded
(from PM's own help centre, not the registry). The widely-circulated Vineyard
Vines "RN 134578" and Brooks Brothers "RN 93986" trace only to eBay sellers'
free-text and are refused — BB especially, whose registrant almost certainly
changed across six ownership regimes.

Apply **after 00466** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00467**). Bumps `EXPECTED_SCHEMA_VERSION` → **00467**. Risk: LOW — data-only, no
schema change, no DDL, no frontend reads the new rows (the edge resolver falls
back to the in-code tables when a pack is absent).

⚠ `verify:db` could NOT run for this migration (Docker unresponsive on the
authoring host — same as 00465 and 00466). The SQL was instead validated against
the real PostgreSQL parser via **pglast**: parses (6 statements), every tuple
matches its column list (9×13, 34×14, 1×10, 5×9, 16×12, 1×1), no duplicate
`on conflict` key in any INSERT, and all 45 dollar-quoted `$j$` bodies scanned for
the `''`-inside-`$j$` trap and JSON validity — clean. The scanner was self-tested
against three planted bugs (a planted `''`, planted malformed JSON, and a planted
dropped column) and caught all three. **Still run `npm run verify:db` before
applying to prod.**

## ⏳ PENDING: 00466_fast_fashion_mall_brand_knowledge.sql (US-1986 fast-fashion & mall brand KB tier 2, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the high-VOLUME staples tier:
**Zara, H&M, Urban Outfitters, Express, LOFT, Ann Taylor, Talbots, Lucky Brand,
Brandy Melville, PacSun**. Sits beside 00458 (basics/mall) and 00457
(contemporary women's), neither re-touched.

**ALL TEN WERE PASSTHROUGH-ONLY** — not even the bare alias-only shells 00389
left for the activewear group — so a "brandy melville" tag rendered the seller's
own casing into the prompt block and the eBay Brand aspect.

`brand_knowledge` ×10; `brand_styles` ×30; `brand_size_charts` ×16, all mirrored
1:1 into the `sizing-charts.ts` in-code fallback; `brand_style_codes` ×**0** and
`brand_colorways` ×**0** (both deliberate — see below). Every fact carries
`source_url` + `confidence` and lands `verified=false` for the US-1715 admin
queue. Idempotent (`on conflict do update`).

**The pack's headline fact:** the same NUMBER is two different size systems and
only the brand says which — a Zara/H&M "38" is an EU size (~27.5in waist) while
an Express/Lucky "38" is a waist in inches. ~10 inches apart, and nothing on
either tag distinguishes them. **And the EU→US conversion is itself disputed by a
full size** across sources (EU 38 = US 6 via the UK grade, or US 8 via EU = US+30),
so every EU label is seeded as a RANGE rather than a false point.

**Zero decoders, deliberately** — all four candidates are fixtured as REFUSAL
negatives in `brand-knowledge-golden_test.ts`. The notable one: Urban Outfitters'
`OB######` is real and primary-sourced (URBN's own vendor manual) and still
refused, because the code is **URBN-wide** — it cannot tell Urban Outfitters from
Anthropologie (00457) or Free People (00449), so a decoder would spell the wrong
sibling's name with decoder authority. This is US-1985's Reebok refusal exactly.

**Confidence is deliberately uneven and honest** (0.85 brand-published BDG → 0.5
for H&M and Brandy Melville, where no trustworthy published chart exists at all).
Notably **no RN is recorded for 8 of the 10** — the FTC database is auth-gated, so
only URBN's 66170 (its own vendor manual) and Lucky's 80318 (FTC record) are
seeded, and Zara's 77302 carries an explicit hedge.

Apply **after 00465** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00466**). Bumps `EXPECTED_SCHEMA_VERSION` → **00466**. Risk: LOW — data-only, no
schema change, no DDL, no frontend reads the new rows (the edge resolver falls
back to the in-code tables when a pack is absent).

⚠ `verify:db` could NOT run for this migration (Docker unresponsive on the
authoring host — same as 00465). The SQL was instead validated against the real
PostgreSQL parser via **pglast**: parses (4 statements), every tuple matches its
column list (10×13, 30×14, 16×12, 1×1), no duplicate `on conflict` key in any
INSERT (which would fail at apply time with "cannot affect row a second time"),
and all 46 dollar-quoted `$j$` bodies scanned for the `''`-inside-`$j$` trap and
JSON validity — clean. The scanner was self-tested against three planted bugs
(a planted `''`, planted malformed JSON, and a planted dropped column) and caught
all three. **Still run `npm run verify:db` before applying to prod.**

## ⏳ PENDING: 00465_activewear_brand_knowledge.sql (US-1985 activewear brand KB tier 2, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the high-volume athletic /
athleisure tier: **Champion, Fila, PUMA, Reebok, ASICS, On Running, HOKA, Outdoor
Voices, Girlfriend Collective**. Sits beside the athleisure packs (00452 et al.)
and the footwear pack (00459), none of which are re-touched.

**FIVE OF THE NINE ALREADY HAD A ROW AND IT WAS A STUB.** 00389 seeded
`champion`/`fila`/`puma`/`reebok`/`asics` as bare shells — canonical + one alias,
no styles, no charts, no tells, no eras — so they canonicalized and then
contributed **nothing** to the prompt. This promotes all five to full packs. The
other four were passthrough-only (a "hoka one one" tag rendered the seller's own
casing into the prompt block and the eBay Brand aspect).

`brand_knowledge` ×9; `brand_styles` ×36; `brand_style_codes` ×**1** (ASICS);
`brand_colorways` ×7; `brand_size_charts` ×19, all mirrored 1:1 into the
`sizing-charts.ts` in-code fallback. Every fact carries `source_url` +
`confidence` and lands `verified=false` for the US-1715 admin queue. Idempotent
(`on conflict do update` / `do nothing`).

Apply **after 00464** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00465**). Bumps `EXPECTED_SCHEMA_VERSION` → **00465**. Risk: LOW — data-only, no
schema change, no frontend reads the new rows (the edge resolver falls back to
the in-code seeds until the SQL lands, so an unapplied migration degrades rather
than breaks).

**One code change ships with it and it is NOT data:** `DETECT_EXCLUDED_FROM_TEXT`
(brand-normalize.ts) gains **`On Running`** — the worst ordinary-word case in the
epic and the only brand needing **two** defences. The canonical is already the
long form (a bare `On` would be regex-scanned over every listing in the
catalogue), and the long form is *still* ordinary prose: "great grip **on
running** trails". Longest-first ordering makes that actively harmful rather than
noisy — `On Running` (10 chars) BEATS a real `Nike` (4) in the same string.
Verified empirically: removing the entry turns the assertion red (mutation-tested,
not argued). The brand stays reachable by TAG, which is what the eBay aspect and
the comp filter read.

> ⚠ **`verify:db` did NOT run for this migration — Docker was unresponsive on the
> authoring host** (`docker info` hung past its timeout), so the throwaway-stack
> lane was skipped. As with 00461/00462/00464, the SQL was validated statically
> against **libpg_query (the real PostgreSQL parser, via `pglast`)**: it parses (6
> statements); every VALUES tuple matches its column list (9×12, 36×15, 1×10,
> 7×9, 19×12); all column names and `ON CONFLICT` targets resolve against the
> 00389 DDL; and no `VALUES` list repeats a conflict key (which would abort an
> `ON CONFLICT DO UPDATE` apply). The dollar-quoted bodies were separately scanned
> for the US-1981 `''`-inside-`$j$` trap and for JSON validity (48 blocks, clean),
> with the scanner **self-tested against planted bugs** — the first two attempts
> at that scan were silently vacuous (the Bash tool ate a backslash level, exactly
> the documented `new RegExp("\\$j\\$")` trap). Still run `npm run verify:db`
> before the prod apply if Docker is available.

## ⏳ PENDING: 00464_premium_denim_brand_knowledge.sql (US-1984 premium denim brand KB tier 2, 2026-07-17)

Data-only seed of the `brand_knowledge*` tables for the premium-denim tier beside
00454 (Wrangler/Lee/7FAM/True Religion/AG/Citizens, which is NOT re-touched):
**Diesel, G-Star RAW, PAIGE, FRAME, MOTHER, Rag & Bone, Hudson Jeans, Joe's
Jeans**. **All eight were passthrough-only** — no row, no alias, no chart — so a
"mother" tag rendered the seller's own casing into the prompt block and the eBay
Brand aspect. `brand_knowledge` ×8; `brand_styles` ×39; `brand_style_codes` ×**1**
(Diesel); `brand_colorways` ×3; `brand_size_charts` ×17, all mirrored 1:1 into the
`sizing-charts.ts` in-code fallback. Every fact carries `source_url` +
`confidence` and lands `verified=false` for the US-1715 admin queue. Idempotent
(`on conflict do update` / `do nothing`).

**NOTE THE NUMBERING:** this seed is **00464**, not 00463 — `00463` is taken by
`00463_social_video.sql` (the video-distribution merge renumbered its own
migration into that slot and bumped the boot guard to 00463). Apply **after
00462 and 00463** via `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00464**). Bumps `EXPECTED_SCHEMA_VERSION` → **00464**. Risk: LOW — data-only, no
schema change, no frontend reads the new rows (the edge resolver falls back to
the in-code seeds until the SQL lands, so an unapplied migration degrades rather
than breaks).

One code change ships with it and it is NOT data: **`DETECT_EXCLUDED_FROM_TEXT`
(brand-normalize.ts) gains `MOTHER` and `FRAME`.** Both are real denim houses AND
ordinary English words. `CANONICAL_BRANDS` is built from alias VALUES and
`detectBrandInText` regex-scans those over prose, so an ordinary-word alias KEY is
safe but an ordinary-word VALUE is not — and longest-first ordering makes the
false positive BEAT the real brand in the same string ("Gap blouse with mother of
pearl buttons" → **MOTHER**, not Gap). Verified empirically: removing the
exclusion turns that assertion red. Both stay reachable by TAG, which is what the
eBay aspect and the comp filter read.

> ⚠ **`verify:db` did NOT run for this migration — Docker was unresponsive on the
> authoring host** (`docker info` hung until killed), so the throwaway-stack lane
> was skipped. As with 00461/00462, the SQL was validated statically against
> **libpg_query (the real PostgreSQL parser, via `pglast`)**: it parses (6
> statements); every VALUES tuple matches its column list (8×12, 39×15, 1×10,
> 3×9, 17×12); all column names and `ON CONFLICT` targets resolve against the
> 00389 DDL; and no `VALUES` list repeats a conflict key (which would abort an
> `ON CONFLICT DO UPDATE` apply). The seeded **Diesel decoder was additionally
> exercised end-to-end**: its pattern/fieldMap/8 examples were parsed back out of
> the SQL and run through the real `decoderSpecsFromPack` → `decodeTagCode` path
> — all 8 pass, including the three negatives (wash code `0688H`, the ordinary
> word `Slim`, and the bare digit run `3301`). Still run `npm run verify:db`
> before the prod apply if Docker is available.

## ⏳ PENDING: 00463_social_video.sql (video distribution for social posts, 2026-07-17)

Adds video posting to the content module so clips fan out to TikTok / Instagram
Reels / Facebook video through the existing Make.com social webhook.

- **New PUBLIC bucket `content-videos`** (public read; admin write mirrors
  content-images; real writes go via a service-role signed upload URL).
  mp4/mov/webm/m4v, 500 MB cap.
- **`social_posts` gains `media_type text NOT NULL DEFAULT 'image'`** (CHECK in
  `('image','video')`), **`video_url text`**, **`video_path text`**. Default
  keeps every existing row an unchanged still-card post.

Idempotent (`IF NOT EXISTS` / `ON CONFLICT` / `DROP POLICY IF EXISTS` /
drop-then-add the CHECK). **Risk: low** — additive columns + a new bucket; no
backfill, no data migration. Apply after 00462 via
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
then redeploy the edge (boot guard now expects **00463**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00463**.

⚠️ **Client-side read in the same change:** the frontend (`social-editor.tsx`,
`use-content.ts`, `database.ts`) reads `media_type` / `video_url` off
`social_posts` and calls `/api/content/images/video`. On a push to `main`
Cloudflare Pages auto-deploys the frontend immediately — so the SQL + edge
deploy MUST land first, or the editor's video panel and the new endpoint 500.
On this feature branch there's no prod deploy, so the branch push is safe; hold
the prod apply-then-merge order per this file's rule.

## ⏳ PENDING: 00462_hype_streetwear_brand_knowledge.sql (US-1983 new-gen streetwear & hype brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the current-generation hype
tier (after 00456 took the established canon — Supreme/Stüssy/BAPE/Palace/Kith/
Fear of God): **Off-White, Chrome Hearts, Aimé Leon Dore, Gallery Dept., Denim
Tears, Rhude, Sp5der, Hellstar, Anti Social Social Club**. **All nine were
passthrough-only** — no row, no alias, no chart — so a "sp5der" tag rendered the
seller's own casing into the prompt block and the eBay Brand aspect on some of the
fastest-moving garments in resale. `brand_knowledge` ×9; `brand_styles` ×33;
`brand_style_codes` ×**1** (Off-White); `brand_colorways` ×**0** (deliberate — see
below); `brand_size_charts` ×10, all mirrored 1:1 into the `sizing-charts.ts`
in-code fallback. Every fact carries `source_url` + `confidence` and lands
`verified=false` for the US-1715 admin queue. Idempotent (`on conflict do
update`). Apply after 00461 via `scripts/apply-prod-migrations.sh`,
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects
**00462**). Bumps `EXPECTED_SCHEMA_VERSION` → **00462**. Risk: LOW — data-only, no
schema change, no frontend reads the new rows (the edge resolver falls back to the
in-code seeds until the SQL lands, so an unapplied migration degrades rather than
breaks).

> ⚠ **`verify:db` did NOT run for this migration — Docker was unresponsive on the
> authoring host** (`docker info` and `docker version` both hung until killed), so
> the throwaway-stack lane was skipped. As with 00461, the SQL was validated
> statically against **libpg_query (the real PostgreSQL parser, via `pglast`
> v8.2)**: it parses (5 statements); every INSERT's column count matches every one
> of its value tuples (9×12, 33×15, 1×10, 10×12); every column name and every `on
> conflict` target resolves against the actual 00389 DDL; no VALUES list contains a
> duplicate conflict key (the "cannot affect row a second time" error); all 39
> dollar-quoted JSON blocks parse; and no `''` appears inside one (the 00460 trap —
> `''` is not an escape there). The seeded Off-White decoder spec was exercised
> against the real `decodeTagCode` engine: both examples decode (`OMAA038R21FAB001`
> → styleCode + gender "Men" + season "R21"; `OWAA049S23FAB002` → "Women") and
> every negative is rejected. That is strong but is **not** a substitute for a real
> apply — **run `npm run verify:db` once Docker is up, before applying to prod.**

**THE GRAPHIC IS THE GARMENT AND THE DROP IS THE PRICE.** The through-line, and it
makes this tier different in KIND from every group before it. A Birkin has a
leather grade to read (00461); a Moncler has a down fill (00460). Most of this tier
is a blank hoodie with a print — strip the graphic and a Hellstar, a Sp5der and a
bootleg of either are the same cotton hoodie. So the price lives in WHICH DROP a
piece is from, which is frequently not on the tag at all, and the pack's job is
mostly NEGATIVE: never guess the drop (a drop attribution is a scarcity claim),
never authenticate, never read the design as damage.

**Authentication tells are informational only**, and this tier is bootlegged
hardest for a structural reason the pack names: when the graphic is the whole
product, the bootleg reproduces the whole product — there is no saddle-stitch to
fall short of. None of these brands authenticates for third parties and several
(Sp5der, Hellstar, Gallery Dept.) publish nothing at all. The
"never auto-authenticate" tell is ordered FIRST on all nine.

**THE DESIGN IS NOT DAMAGE** — the most consequential grading rule in the pack, and
it is carried in style FINGERPRINTS (not tells, which the grading block truncates —
the US-1740/US-1981 lesson). Gallery Dept. is hand-distressed per garment and
Hellstar's prints are cracked from new: a grader who reads either as wear marks a
mint piece down to Poor, inverting the price of a garment worth more precisely
because it looks destroyed.

**One decoder — Off-White, and only it qualifies.** Its care-label season code
(`OMAA038R21FAB001`) is tag-printed, regular and brand-unique in FORMAT; the
gendered OM/OW prefix is the argument, as the hyphenated triplet was for Dior
(00461). The gender group captures the SECOND character so the EXISTING `genderCode`
transform maps M/W → Men/Women with no code change. It matters because the
Off-White **logo did not change when Abloh died in 2021**, so only the code places a
piece either side of the ladder. Seven of the other eight print no regular
garment-side code AT ALL; Aimé Leon Dore's SKU fails the regular-and-brand-unique
bar.

**No `brand_colorways`, deliberately.** AC3 seeds colorways "where the brand uses
proprietary named colors" — a conditional this tier does not meet. These brands ship
ordinary colour words that rotate per drop and form no stable dictionary the way
Hermès's Etoupe/Rouge H do. What this tier names is the DROP, and a drop name is a
scarcity claim that belongs in the never-guess rule, not in a colour table that
would license the model to mint it.

**⚠ CODE CHANGE (not data): the Off-White colour-word guard.** `brand-normalize.ts`
gains `DETECT_EXCLUDED_FROM_TEXT`, filtered out of `CANONICAL_BRANDS`. "Off-White"
is a real hype brand AND the most common neutral colour word in clothing, and the
hazard is structural: `CANONICAL_BRANDS` is built from BRAND_ALIASES' VALUES, which
`detectBrandInText` regex-scans over prose. An ordinary-word alias KEY is safe (exact
whole-field lookup — the "ag"/"spider" play), but an ordinary-word VALUE is not, and
the word-boundary guard cannot help because an off-white garment's title contains the
brand name EXACTLY. Worse, CANONICAL_BRANDS is sorted longest-first, so "Off-White"
would beat the real "Nike" in the same string. The brand stays fully reachable by TAG
(`canonicalizeBrand`/`isKnownBrand` — what the eBay Brand aspect and comp filter
need) but is never guessed from prose. Opt-in and additive: no other brand's behavior
changes. (The KB already treats the phrase as a colour — 00455 seeds "off-white" as
an alias of Prada's Talco colorway.)

**Two size traps.** DENIM TEARS is the only WAIST chart in the pack: the Cotton
Wreath signature is printed on an ACTUAL LEVI'S 501 under an official
collaboration, so the piece legitimately carries LEVI'S tags and a LEVI'S waist
size — both brands are true at once, and resolving it to "Levi's 501" throws away
an order of magnitude of value. OFF-WHITE runs TWO systems (Milan house: alpha tees,
ITALIAN-numbered tailoring). And the FIT INTENT SPLITS across the tier — Hellstar/
Gallery Dept. are oversized by design while Sp5der/Chrome Hearts/ASSC run small — so
the two poles name each other, as the FR/IT charts do in 00461.

## ⏳ PENDING: 00461_luxury_rtw_leather_brand_knowledge.sql (US-1982 luxury RTW & leather brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the luxury RTW & leather tier
(tier 2, after 00455 took Chanel/Prada/Burberry/MK/Kate Spade/Tory Burch):
**Hermès, Dior, Saint Laurent, Balenciaga, Bottega Veneta, Fendi, Versace,
Celine**. Seven of the eight were passthrough-only, and Versace had only the bare
alias-only row from 00389 (**promoted** to a full pack here) — so a "balenciaga"
tag rendered the seller's own casing into the prompt block and the eBay Brand
aspect on the most expensive garments the KB touches. `brand_knowledge` ×8;
`brand_styles` ×33; `brand_style_codes` ×**1** (Dior); `brand_colorways` ×9
(Hermès ×7, Bottega Veneta ×2); `brand_size_charts` ×16, all mirrored into the
`sizing-charts.ts` in-code fallback. Every fact carries `source_url` + `confidence`
and lands `verified=false` for the US-1715 admin queue. Idempotent (`on conflict do
update`). Apply after 00460 via `scripts/apply-prod-migrations.sh`,
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects
**00461**). Bumps `EXPECTED_SCHEMA_VERSION` → **00461**. Risk: LOW — data-only, no
schema change, no frontend reads the new rows (the edge resolver falls back to the
in-code seeds until the SQL lands, so an unapplied migration degrades rather than
breaks).

> ⚠ **`verify:db` did NOT run for this migration — Docker was down on the authoring
> host, so the throwaway-stack lane was skipped.** In its place the SQL was
> validated statically against **libpg_query (the real PostgreSQL parser, via
> `pglast`)**: it parses (6 statements); every INSERT's column count matches its
> value tuples; every column name and every `on conflict` target resolves against
> the actual DDL; no VALUES list contains a duplicate conflict key (the "cannot
> affect row a second time" error); all 42 dollar-quoted JSON blocks parse; and no
> `''` appears inside one (the 00460 trap — `''` is not an escape there). The
> seeded Dior decoder spec was extracted from the SQL itself and exercised against
> `decodeTagCode`: both examples decode and every negative is rejected. That is
> strong but is **not** a substitute for a real apply — **run `npm run verify:db`
> once Docker is up, before applying to prod.**

**FRENCH OR ITALIAN — THE SAME NUMBER IS TWO DIFFERENT SIZES.** The through-line,
and worth more than every style fingerprint in the pack combined. Every house here
sizes its women's RTW in a European system its tag never names, and the group
SPLITS: the **French** houses (Hermès, Dior, Saint Laurent, Balenciaga, Celine)
subtract 32; the **Italian** ones (Bottega Veneta, Fendi, Versace) subtract 36. So
a **"42" is a US 10 on a Dior and a US 6 on a Fendi** — two dark designer dresses
that photograph identically, two sizes apart. That is strictly worse than 00460's
unnamed-system trap, which at least broke the same way on every brand in its pack:
here the seller who correctly learns "42 = US 6" from a Fendi and carries it to a
Dior is wrong _because_ they learned the rule. The cross-map is therefore written
into the size **LABEL** of every chart (the only uncapped channel that reaches the
model — the US-1731/1740 lesson), and the Dior and Fendi notes name each other
explicitly. **Menswear is exempt and every men's note says so** (French and Italian
tailoring run the same EU numbers — drop 10), because a reader who over-generalizes
starts "correcting" menswear sizes that were already right.

Three of the French houses (**Saint Laurent, Balenciaga, Celine**) manufacture in
**Italy**, so their origin tag actively points at the _wrong_ size system — the one
place in the pack where a real, printed, correct fact on the garment leads the
seller astray. Each note defuses it explicitly.

**Authentication tells are informational only.** This is the most counterfeited
tier that exists; every house here is seeded with the never-auto-authenticate guard
ordered FIRST, and none of them authenticates for third parties. A test asserts no
seeded tell claims a garment can be verified authentic.

**One decoder — Dior**, the only code in the group that is tag-printed AND regular
AND brand-unique in format (`\d{2}-[A-Z]{2}-\d{4}`, heat-stamped on an interior
leather tab; the LV SD1160 precedent with hyphens on top). It carries the group's
cut-tag golden fixtures. **Hermès is the instructive refusal**: its blind stamp is a
bare LETTER and the house ships no serial number at all, so a pattern over it would
recover the pack's most valuable label from any tag (the Chanel rule at its limit).

⚠ **Two brand_key traps worth knowing before editing this seed.** `brandKey()`
strips accents, so canonical **"Hermès" keys as `herms`** — not `hermes`. The row is
seeded under `herms` on purpose (the 00389 `stssy`/Stüssy precedent); a row seeded
under `hermes` would never be found. **Celine is the opposite call**: the house
itself dropped the accent in Hedi Slimane's 2018 rebrand, so the canonical is
unaccented and keys cleanly as `celine`, with the accented "Céline" spelling carried
as a _tag_era dating tell_ (the Burberrys-with-an-S play). Both spellings are
aliased either way.

⚠ **The Versace diffusion labels get their own canonicals and do NOT fold onto
Versace** (`brand-normalize.ts`). Versace Jeans Couture / Versus Versace / Versace
Collection sell an **order of magnitude** below mainline and are the most common
Versace-marked items in resale — this is the AGOLDE/Miu Miu rule, not the
Fire+Ice/MK one. Folding them would silently retitle a $150 VJC tee as "Versace": a
misrepresentation, and a comp catastrophe once the eBay Brand aspect prices it
against mainline. They _do_ deliberately share the Versace size chart (same Italian
system, different price), and the chart note says the size never tells you the
ladder.

## ⏳ PENDING: 00460_luxury_outerwear_brand_knowledge.sql (US-1981 luxury outerwear brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the luxury outerwear & down
tier: **Moncler, Canada Goose, Mackage, Herno, Woolrich, Bogner**. ALL SIX were
passthrough-only — none had even a bare alias-only row from 00389 — so a "moncler"
tag rendered the seller's own casing into the prompt block and the eBay Brand
aspect on the most expensive garments the KB touches. `brand_knowledge` ×6;
`brand_styles` ×22; `brand_style_codes` ×**1** (Canada Goose); `brand_colorways`
×4; `brand_size_charts` ×12, all mirrored into the `sizing-charts.ts` in-code
fallback. Every fact carries `source_url` + `confidence` and lands `verified=false`
for the US-1715 admin queue. Idempotent (`on conflict do update`). Apply after
00459 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects **00460**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00460**. Risk: LOW — data-only, no schema change, no
frontend reads the new rows (the edge resolver falls back to the in-code seeds
until the SQL lands, so an unapplied migration degrades rather than breaks).

**THE SIZE IS A NUMBER IN A SYSTEM THE TAG DOES NOT NAME.** The through-line, and
worth more than every style fingerprint in the pack combined. FOUR of the six size
in a system the garment never identifies: **Moncler is 0-5** — its OWN proprietary
scale, not US/EU/alpha; **Herno** is Italian (a men's "50" is IT 50 = US 40 / L);
**Bogner** is German (a women's "38" is DE 38 = US 8); **Woolrich** depends on the
ERA (US alpha on the Pennsylvania-mill heritage wool, EU on the Italian-era
outerwear — one label, two systems). This is 00459's footwear trap on a garment:
the number is real, the photo does not contradict it, and the result is a WRONG
LISTING rather than a pricing refinement. So the cross-map is written INTO the size
LABEL of every row — the only uncapped channel that reaches the model.

**MONCLER WOMEN'S IS THE WORST CASE IN THE WHOLE CHART FILE**, because the numbers
COLLIDE with US women's numeric sizing. A women's Moncler tagged "2" is a **US 6-8 /
MEDIUM** — and "2" is a real US size too, so nothing looks wrong to anyone. That is
a THREE-SIZE error on a $1,500 coat that no photo reasoning can catch. Contrast
Dr. Martens' "7" (00459), where the wrong read at least produces an implausible
listing; here it produces a perfectly plausible one.

**AUTHENTICATION TELLS ARE INFORMATIONAL — NEVER AUTO-AUTHENTICATE**, per the story
note, and this is the tier where that matters most. Moncler ships a QR ("Moncler
Code") and Canada Goose a holographic disc; both are MANUFACTURER-side verification
services and neither is evidence we can act on — a scannable QR and a rainbow
hologram are exactly what a competent counterfeit reproduces. Every tell is seeded
as a description/consistency aid that routes to human review, and each brand's tell
list LEADS with the never-auto-authenticate guard.

**ONE DECODER — CANADA GOOSE, AND THE DEPARTMENT LETTER IS THE WHOLE ARGUMENT.**
The care-label style number is 4 digits + M/L (+ optional suffix): `4660MA`
Expedition, `7950M` Chilliwack, `2506L` Kensington. A bare "4660" is four digits and
is nothing — the letter is what makes the format brand-unique (the LV `SD1160`
precedent). It carries the group's CUT-TAG case: the style number lives on the CARE
label, which survives the brand tag being cut out of the collar. The M/L group is
deliberately NON-CAPTURING — `genderCode` maps only M/W, so a captured "L" for
LADIES' would pass through raw as "L" (the US-1740 New Balance "U" precedent).
Everything else is decoder-less by design: Moncler's serial and the CG hologram
number are BARE DIGIT RUNS (the Chanel rule, US-1736 — a pattern over one mints the
KB's costliest false positive from any tag with 8 digits), and the
Herno/Mackage/Woolrich/Bogner article numbers are catalog SKUs.

Verified: `deno test` 3918 passed (incl. 12 new `luxury-outerwear-content_test.ts`
cases + 8 new golden cases — Canada Goose recovers 3/3), `deno lint`, `deno check
src/main.ts`, `tsc --noEmit`, `build:locked`, web vitest 2091 passed, and
`verify:db` (all migrations apply on a fresh schema). Facts stay `verified=false`
for the US-1715 admin queue, per the group convention.

## ⏳ PENDING: 00459_footwear_brand_knowledge.sql (US-1740 footwear brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the footwear (apparel-adjacent)
tier: **New Balance, Dr. Martens, UGG, Birkenstock, Converse, Vans, Cole Haan**.
New Balance, Vans and Converse had a bare alias-only row from 00389; Dr. Martens,
UGG, Birkenstock and Cole Haan are NEW rows (passthrough-only before this, so a
"doc martens" tag rendered the seller's own casing into the prompt block and the
eBay Brand aspect). `brand_knowledge` ×7; `brand_styles` ×29; `brand_style_codes`
×**1** (New Balance); `brand_colorways` ×**8** — the FIRST colorways in four
groups; `brand_size_charts` ×10, all mirrored into the `sizing-charts.ts` in-code
fallback. Every fact carries `source_url` + `confidence` and lands `verified=false`
for the US-1715 admin queue. Idempotent (`on conflict do nothing` / `do update`).
Apply after 00458 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload
schema';`, redeploy the edge (boot guard now expects **00459**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00459**.

**THE SIZE IS NOT MEASURABLE — IT IS STAMPED.** The first non-garment pack in the
epic, and it INVERTS what a size chart is for. Every prior group's chart is an
ESTIMATOR (measure the bust, double it, read the row). A shoe's size cannot be
measured off a photo — it is stamped on the tongue label/insole/footbed and must be
READ. So these charts are **TRANSLATORS**: the brand's own number → every other
system's number. Which is exactly why the story note puts "US/UK/EU cross-maps are
the priority" ahead of decoders.

**AND THE NUMBER IS IN A SYSTEM THE TAG DOES NOT NAME** — the highest-value fact in
the pack. A Dr. Martens stamped "7" is a **UK 7** (= US M8 = US W9 = EU 41); a
Birkenstock stamped "38" is an **EU 38** (= US W7-7.5). Neither says "UK" or "EU"
anywhere. A seller reads "7", lists a US 7, and is a FULL SIZE wrong — and the photo
will not contradict them, because the photo is not wrong: the shoe really does say 7. That is not a pricing refinement like 00457/00458's era/line traps. It is a WRONG
LISTING and a guaranteed return.

**CONVERSE AND VANS ARE THE SAME SHOE AND DO NOT SIZE THE SAME** — the quiet trap.
Same black canvas lace-up, same band, same shelf, both dual-tagged M/W on one label,
and the offsets DIFFER: Converse M8 = W10 (offset 2); Vans M8 = W9.5 (offset 1.5).
No photo catches it, and a model that learns one applies it to the other. Both are
written into the size LABELS, and each brand's note names the OTHER by number.

**THE WIDTH LETTER FLIPS MEANING BY DEPARTMENT.** "D" is STANDARD on men's New
Balance and WIDE on women's — the same character is correct in both readings and
only the department decides. A women's D listed as plain is a wide shoe sold as a
regular one.

**ONE DECODER — New Balance, and the PREFIX is the whole argument.** `[MWU]` + 3-4
digits + optional suffix. A bare "990" is three digits and is nothing; "M990" can
only be New Balance. It is the first decoder in the epic to capture a SECOND field:
the prefix encodes the department (M→Men, W→Women), which is a required eBay aspect
on footwear. "U" (unisex) matches but deliberately does NOT capture — unisex is not
a gender, and `genderCode` only maps M/W, so a captured "U" would pass through raw.

**DR. MARTENS GETS NO DECODER — the hardest refusal in the epic**, and it is the
prefix argument read backwards. 1460/1461/2976 are the most famous numbers in
footwear, genuinely printed, genuinely a regular closed set — and they are FOUR
DIGITS WITH NO PREFIX. Four digits is not a brand; it is a year, a lot number, a
price, another brand's cut code. They ship as `brand_styles`, naming the PIECE.

**FOUND AND FIXED — a real, live, pre-existing bug**, surfaced by wiring the decoder
rather than reasoned about. `brandFromStyleFormat` infers "New Balance" from ANY
M+4-digit code — and **Converse's classic style codes are also M + 4 digits**
(M9160 is a Chuck Taylor). Since `ai-listing.ts` takes `styleResolution?.brand ??
canonicalBrand`, the format GUESS was overriding the brand read off the actual tag:
a Converse Chuck with a legible M-code was silently relisted as a New Balance,
taking the eBay Brand aspect and the comp filter with it. Fixed by precedence, not
by a bigger table (Converse's codes cannot be enumerated here with a citation): an
explicit canonical sneaker brand now outranks a mere format inference, while the
curated `STYLE_CODE_PRODUCTS` table still outranks both. The DB decoder path was
never exposed — decoders are PACK-SCOPED, so NB's is only ever run against a shoe
already resolved to New Balance.

**FOUR COLORWAYS BRANDS, the first in four groups.** 00456/00457/00458 seeded none:
their colours are seasonal English words ("Ivory", "Sage", "Heather Grey"). Footwear
is the structural opposite — a small, STABLE, named palette reissued for decades and
searched BY NAME: UGG **Chestnut**, Dr. Martens **Cherry Red** (an oxblood, not a
red), Birkenstock **Habana** (a dark brown). These ship where Uniqlo's colour NUMBER
could not (00458) for a stated reason: a mis-decoded NUMBER is silent and
uncheckable, while a NAMED colourway is checkable BY EYE against the photo — so it
can go to the US-1715 queue at modest confidence. Converse/Vans/New Balance/Cole
Haan are omitted entirely (ordinary descriptive words).

**Verified:** deno test 3906 green (0 failed), deno lint + `deno check src/main.ts`;
web tsc + build:locked + vitest 2091 green. **`verify:db` could NOT run — the Docker
engine is hung** (`docker ps` timed out at 60s, as at 00452–00458). Validated
statically instead: `$j$`/`$json$` tags balance (16 + 10 pairs), all 26 JSON blocks
parse, all 80 size-chart rows carry a size label + footLength, all 55 confidences sit
in the numeric(3,2) 0..1 range, no row seeded `verified=true`, all 11 on-conflict
targets match real 00389 unique indexes, no conflict-key collisions (29 styles / 8
colorways / 10 charts), and all 7 brand_keys equal `brandKey(canonical_brand)`. The
shipped decoder pattern was compiled and exercised against its match/no-match sets,
and all 80 DB size labels were diffed against the `sizing-charts.ts` mirror (0
missing). **Still needs `verify:db` before push.**

Facts stay `verified=false` for the US-1715 admin queue, per the group convention.

## ⏳ PENDING: 00458_basics_mall_brand_knowledge.sql (US-1739 basics/mall brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the basics, mall &
fast-fashion tier: **Uniqlo, Gap, Banana Republic, Old Navy, American Eagle,
Abercrombie & Fitch, Tommy Hilfiger**. Unlike every prior group in this epic, all
seven ALREADY have a bare alias-only row from 00389 — so this migration is mostly
an **UPDATE** that fills the empty `category_focus` / `tag_eras` /
`authentication_tells` / `notes`, and the `on conflict do update` clauses are
load-bearing rather than defensive. `brand_knowledge` ×7 (all updates);
`brand_styles` ×25; `brand_style_codes` ×**1** (Uniqlo — the first decoder in
three groups); `brand_colorways` ×**0**; `brand_size_charts` ×14, all mirrored
into the `sizing-charts.ts` in-code fallback. Every fact carries `source_url` +
`confidence` and lands `verified=false` for the US-1715 admin queue. Idempotent
(`on conflict do nothing` / `do update`). Apply after 00457 via
`scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`, redeploy the
edge (boot guard now expects **00458**). Bumps `EXPECTED_SCHEMA_VERSION` →
**00458**.

**THE TAG SAYS THE BRAND, AND THE BRAND IS NOT THE QUESTION — the exact inverse of 00457.** There the piece was easy and the BRAND was the puzzle (a WILFRED tag is an
Aritzia coat). Here the tag says GAP on a crewneck tee: both facts are free and
neither is worth money. What actually decides the price of a staple is **the LINE**
(mainline vs made-for-outlet) and **the ERA** — both printed on the tag, both
invisible in the silhouette.

**THE OUTLET LINES FOLD, AND THE FOLD IS DISCLOSED.** Gap Factory / BR Factory are
made FOR the outlet at a lower spec and a lower band — NOT overstock. That lower
band is the 00456 argument for splitting; they fold anyway for a reason 00456 did
not have: **eBay's Brand aspect for a BR Factory shirt IS "Banana Republic"** —
there is no separate catalogue brand, so a split would invent one and mis-map the
aspect on every listing. The band gap is ~2x, not 10x, so folding costs less than
the invention. The line is seeded as a `brand_style` + a tell so it is DISCLOSED,
never silently comped as mainline.

**THE ERA SPREAD IS ~10x AND STILL EARNS NO SPLIT — LINE vs ERA is the rule.** 90s
flag Tommy, pre-1977 A&F (a _different company_: Roosevelt's expedition outfitter,
bankrupt 1977, name later bought), safari-era Banana Republic. 00456 split Fear of
God at exactly this magnitude — but an ERA has no second brand to key. Vintage
Tommy IS Tommy. So the spread rides in `tag_eras` + styles.

**ONE DECODER — Uniqlo, and it gives the group the CUT-TAG case the last two could
not have.** 00456 refused (identifier is a GRAPHIC: not on the tag, not parseable);
00457 refused (identifier IS printed and regular, but is an ordinary GIVEN NAME:
not brand-unique). Uniqlo's `HEATTECH / AIRism / BLOCKTECH / DRY-EX` pass all three
— they are **COINED** words that mean nothing in English. Brand tag cut, care label
reads HEATTECH ⇒ brand recovers to Uniqlo. **"ULTRA LIGHT DOWN" is deliberately
excluded** from the pattern: it is a DESCRIPTIVE ENGLISH PHRASE (any brand may call
a jacket that), so it fails brand-unique for exactly the reason the other four pass
it. Old Navy's "Powersoft" / AE's "AirFlex" are the same coined shape and are
omitted because their trademark SETS cannot be cited here — a decoder firing on a
half-remembered token list is worse than no decoder.

**ZERO COLORWAYS, third group running, third distinct reason.** Six of the seven use
ordinary descriptive words ("Heather Grey") — nothing to seed. **Uniqlo is the
exception and is omitted anyway:** it prints a genuine proprietary 2-digit COLOR
NUMBER, exactly the system this table is for, but the MAPPING cannot be cited here
and a colour decoder built from recall would mislabel silently and confidently. The
honest half — _that the number exists and must not be guessed_ — is seeded as a
tell. Same rule that kept Chanel's colours out of 00455.

**"gap" is the worst ordinary-word token in the epic** — worse than 00457's "moth",
because "moth" is only a house label that could be refused outright while **"Gap" is
a real canonical brand that MUST resolve**. It is a condition word this product's own
text emits constantly ("a gap in the waistband", "gaping at the bust"). It can only
be CONTAINED, and the containment already exists in two places this migration must
not break: `detectBrandInText` is regex-bounded on BOTH sides (so "gaps"/"gaping"
never fire) and is only ever fed an eBay TITLE; `findSizingCharts` is leading-bounded
and is only ever fed the BRAND field. Never widen "gap" past a whole-brand-field
match; never feed condition text to a brand detector.

**babyGap / GapKids / GapFit are listed explicitly in `brand_match`** — the first bill
come due from 00457's leading-boundary fix. `"babygap".indexOf("gap")` is preceded by
"y", a word char, so a bare "gap" does NOT fire on it and babyGap would silently miss
Gap's charts. The concatenated forms are how the tags print.

**Hollister does NOT fold into A&F** (separately branded, separately searched, lower
band ⇒ its own canonical) and **a bare "Tommy" is never aliased** (Tommy Bahama is a
different company — 00457's Vince/Vince Camuto shape, but since neither FULL name
contains the other, full-name matching separates them and no protective canonical
entry is needed). The corporate parent never decides a fold; the price band and the
eBay catalogue do.

`registered_numbers` omitted throughout as UNSOURCED (the 00448/00449/00457 call) —
several of these brands have well-known RNs, but "well-known" is not a citation and a
near-miss RN is a false authentication signal.

**Verification:** `deno test` 3869 green (0 failed), `deno lint`, `deno check
src/main.ts`; web `tsc -b` + `build:locked` + vitest 2091 green. **The `verify:db`
lane could NOT run — the Docker engine is hung (`docker version` timed out at 60s,
as at 00452–00457).** Validated statically instead: all 30 dollar-quoted JSON blocks
parse, both dollar-quote tags balance, all 47 confidences sit in the `numeric(3,2)`
0..1 range, no row is seeded `verified=true`, the self-record footer is present, all
4 on-conflict targets match real unique indexes from the 00389 DDL, no two rows
collide on a conflict key (25 styles / 14 charts, zero dupes), and all 7 `brand_key`s
equal `brandKey(canonical_brand)`. The shipped decoder pattern was compiled and
exercised against its match/no-match sets (incl. the "Ultra Light Down" exclusion).
**Still needs `verify:db` before push.**

## ⏳ PENDING: 00457_contemporary_womens_brand_knowledge.sql (US-1738 contemporary women's brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the contemporary women's tier:
**Anthropologie, Sézane, Aritzia, Reformation, Vince, Theory, Eileen Fisher**. All
seven are NEW rows — none had even a bare alias-only row in 00389, so every one of
them previously rendered the seller's own casing into the prompt block and the eBay
Brand aspect. `brand_knowledge` ×7; `brand_styles` ×28; `brand_style_codes` ×**0**;
`brand_colorways` ×**0**; `brand_size_charts` ×11, of which **10** are mirrored into
the `sizing-charts.ts` in-code fallback (Vince is deliberately DB-only — see below).
Every fact carries `source_url` + `confidence` and lands `verified=false` for the
US-1715 admin queue. Idempotent (`on conflict do nothing` / `do update`). Apply
after 00456 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects **00457**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00457**.

**THE TAG DOES NOT SAY THE BRAND — the group's defining fact and the inverse of the
usual one.** Anthropologie and Aritzia are RETAILERS whose house labels print their
OWN names: the tag reads MAEVE / PILCRO / MOTH or WILFRED / BABATON / TNA and the
parent is frequently nowhere on the garment. The piece is easy; the BRAND is the
puzzle. They fold onto ONE canonical with the label in `style` — the **Michael Kors
precedent (00455)**, NOT the Fear of God one (00456), because these labels share a
price band with each other, so folding costs no comp accuracy. Folding also keeps
the short tokens out of CANONICAL_BRANDS ("TNA" would be an AG-grade hazard as a
canonical). **Anthropologie is ALSO a multi-brand RETAILER** — a third-party garment
bought there keeps its own brand; only the house labels are Anthropologie.

**VINCE IS SEEDED WITH A DB CHART AND NO IN-CODE FALLBACK CHART** — the first brand
in the epic given one and not the other, and the judgement call worth re-reading.
**Vince Camuto (Camuto Group) is a DIFFERENT COMPANY** from Vince (Vince Holding
Corp) — not a diffusion line, just a shared first name — and "Vince Camuto" CONTAINS
"Vince". The two lookups do not match the same way: `brand_size_charts` is fetched by
EXACT `brand_key` (`brandKey("Vince Camuto")` = `vincecamuto`, so the 'vince' row can
never reach it — SAFE), but `findSizingCharts` matches `brand_match` by SUBSTRING
(`"vince camuto".includes("vince")` is TRUE — LEAKS). No narrowing fixes the in-code
side (no token is unique to the shorter name — the 00456 finding). So Vince falls
through to the generics in-code and gets its real chart from the DB, and Vince Camuto
correctly falls to the generics in both states. Asserted in
`contemporary-womens-content_test.ts`.

**ZERO DECODERS, for a NEW reason** (not a repeat of 00456's). There the identifier
was a GRAPHIC — not on the tag, not parseable. Here the identifier IS printed and IS
regular: these brands NAME their pieces and the name is what the market searches. It
fails the epic's THIRD test — brand-unique — because every name is an ordinary GIVEN
NAME (Juliette, Maeve, Wilfred, Gaspard). 00454 seeded True Religion only because
"Ricky Super T" is a COMPOUND; a bare first name has no second part. **ZERO
COLORWAYS**: this group's colors are seasonal descriptive English words ("Ivory",
"Sage"), so there is nothing proprietary to seed (the rule that kept Chanel's colors
out of 00455).

**Sézane's brand_key is `szane`**, not `sezane` — `brandKey()` strips the accented
"é" with every other non-`[a-z0-9]` char, exactly as it strips Stüssy's umlaut to
`stssy` (00456). Do not "correct" it; the resolver re-derives the same key at read
time. Both spellings are seeded as aliases, and the in-code chart's `brand_match`
carries the ACCENTED form (sizing-charts' `norm()` only lowercases — it does NOT
strip accents — and the canonical is what the resolver passes in).

**All INSERTs — no UPDATE of an existing row.** No shared-chart narrowing is needed:
no existing chart's `brand_match` claims any of these seven brands.

**⚠️ ALSO IN THIS COMMIT — a real, pre-existing SIZING-CHART BUG, found by this
story's own test and fixed in `sizing-charts.ts` (NOT a data change):**
`findSizingCharts` matched `brandMatch` with a bare `b.includes(m)`, so
`"eileen fisher".includes("lee")` was TRUE — **"ei·LEE·n"** — and every Eileen Fisher
garment resolved **Lee's DENIM charts** (waist-and-inseam numbers for a silk tunic)
alongside its own. It is not fixable in the data: any `brandMatch` that still matches
its own canonical "lee" is necessarily also a substring of "eileen". The matcher now
requires the token to START a word (`brandTextMatches`, `\p{L}`-based so the accented
canonicals are unaffected). The boundary is **LEADING-ONLY** on purpose: a trailing
letter is legitimate and load-bearing — the pre-1999 **"Burberrys"** spelling is
"Burberry" + s and must still reach Burberry's charts (US-1736 depends on exactly
that, which a both-sides boundary silently broke — caught by `luxury-content_test.ts`).
Proven safe by the FULL edge suite: 3847 tests green, including every prior brand
group's content test.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema change.
**No CLIENT read** — edge resolver only (`brand-knowledge.ts` + the
`sizing-charts.ts` in-code fallback this commit also extends), so the Cloudflare
auto-deploy on push cannot break on it.

**⚠️ verify:db NOT run locally — the Docker engine is still hung** (`docker version`
timed out at 60s, same as at 00452–00456). The SQL was instead validated
STATICALLY: all 25 embedded JSON blocks parse, both dollar-quote tags balance
(28 `$j$` / 22 `$json$`), single-quote parity holds outside the dollar-quoted
regions, all 46 confidences sit in the `numeric(3,2) CHECK (0..1)` range, no row is
seeded `verified=true`, every seeded column exists in the 00389 DDL (11/14/12), all
9 `on conflict` targets match real unique indexes, no two rows collide on a conflict
key (which `do nothing` would silently drop), and **all 7 `brand_key`s equal
`brandKey(canonical_brand)`** — the check that proves the Sézane `szane` row is
actually reachable. **Prove it APPLIES with a Docker-up `npm run verify:db` before
pushing.**

## ⏳ PENDING: 00456_streetwear_brand_knowledge.sql (US-1737 streetwear brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the streetwear & hype tier:
**Supreme, Stüssy, BAPE, Kith, Palace, Fear of God / Essentials**. `brand_knowledge`
×7 (Supreme + Stüssy enrich their bare 00389 alias-only rows; the rest are new —
seven rows for six brands because Fear of God mainline and Essentials each get
their own, see below); `brand_styles` ×27; `brand_style_codes` ×**0**;
`brand_colorways` ×9 (BAPE's named camos + the Essentials seasonal colors — the
only stable proprietary names in the pack); `brand_size_charts` ×8, all mirrored
into the `sizing-charts.ts` in-code fallback. Every fact carries `source_url` +
`confidence` and lands `verified=false` for the US-1715 admin queue. Idempotent
(`on conflict do nothing` / `do update`). Apply after 00455 via
`scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`, redeploy the
edge (boot guard now expects **00456**). Bumps `EXPECTED_SCHEMA_VERSION` → **00456**.

**ZERO DECODERS — the first group in the epic with none, and it is a finding
rather than a gap.** The epic's rule is tag-printed AND regular AND brand-unique.
Streetwear identity is carried by a GRAPHIC (box logo, shark mouth, Tri-Ferg),
which is not on the tag and is not parseable. The season notation (SS20 / FW17) is
genuinely regular and IS the price, but it is not tag-printed — it is resolved
against a release archive — so it is an informational tell exactly like the
Beyond Yoga / Sweaty Betty web codes (00452), never a decoder. A pattern over it
would mint a Supreme from any tag reading "FW17": the Lee "101" mistake (00454) on
the most-counterfeited brand in the KB. Locked in by no-false-recovery golden cases.

**FEAR OF GOD IS SEEDED AS TWO BRAND KEYS** (`fearofgod` + `fearofgodessentials`),
which is the judgement call worth re-reading before verifying. Mainline and
Essentials are one designer's two lines an ORDER OF MAGNITUDE apart in price. The
Michael Kors precedent (00455) folds every tier onto one eBay brand and puts the
tier in `style`; that would comp a $90 Essentials hoodie against a $900 mainline
piece. This follows the AGOLDE precedent instead — a sibling label earns its own
canonical. `detectBrandInText` is safe because CANONICAL_BRANDS sorts longest-first,
so "Fear of God Essentials" is tested before the "Fear of God" it contains
(asserted directly, not assumed).

**MAINLINE `fearofgod` IS DELIBERATELY CHARTLESS**, for two independent reasons:
its sizing is collection-specific and unpublished (a chart would be invention),
AND `findSizingCharts` matches `brand_match` by SUBSTRING — "fear of god
essentials" CONTAINS "fear of god", so a mainline chart would ALSO fire on every
Essentials garment and hand the oversized line the wrong numbers. Mainline falls
through to the generics, as Coach/LV/Gucci do. Asserted in `streetwear-content_test.ts`.

**All INSERTs — no UPDATE of an existing row.** No shared-chart narrowing is
needed: no existing chart's `brand_match` claims any of these brands.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema change.
**No CLIENT read** — edge resolver only (`brand-knowledge.ts` + the
`sizing-charts.ts` in-code fallback this commit also extends), so the Cloudflare
auto-deploy on push cannot break on it.

**⚠️ verify:db NOT run locally — the Docker engine is still hung** (`docker
version` timed out at 30s, same as at 00452–00455's authoring; the local
PostgreSQL 18 service IS running but its credentials are unknown, so it is not a
substitute). The SQL was instead validated STATICALLY: all 22 embedded JSON blocks
parse as JSON, both dollar-quote tags balance, single-quote parity holds, all 51
confidences sit in the `numeric(3,2) CHECK (0..1)` range, no row is seeded
`verified=true`, every column exists in the 00389 DDL, all four `on conflict`
targets match real unique indexes (`brand_knowledge.brand_key`,
`brand_styles_key_idx`, `brand_colorways_key_idx`, `brand_size_charts_key_idx`),
and no two rows collide on a conflict key (which `do nothing` would silently
drop). **Prove it APPLIES with a Docker-up `npm run verify:db` before pushing.**

## ⏳ PENDING: 00455_luxury_brand_knowledge.sql (US-1736 luxury brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the luxury & designer tier
beside the three flagships already seeded (Coach 00398, Louis Vuitton 00399, Gucci
00400, none re-touched): **Chanel, Burberry, Prada, Michael Kors, Kate Spade, Tory
Burch**. `brand_knowledge` ×6 (Burberry/Michael Kors/Kate Spade enrich their bare
00389 alias-only rows; Chanel, Prada and Tory Burch are new); `brand_styles` ×27
(the Chanel chain/lock separators, Burberry's three same-fabric trenches + the
pre-2016 tier label, Prada's Re-Nylon/Saffiano/Linea Rossa, and the American
brands' LINE labels — which are the price on those three); `brand_style_codes` ×1
(**Kate Spade only** — its 4-letter-prefix PXRU/WKRU style number is the group's
only regular, brand-unique, garment-printed code); `brand_colorways` ×9 (only
STABLE proprietary names — Burberry's checks, Prada's Italian color words, Tory
Red; Chanel/Kate Spade colors are seasonal and deliberately absent);
`brand_size_charts` ×12, all mirrored into the `sizing-charts.ts` in-code
fallback. Every fact carries `source_url` + `confidence` and lands `verified=false`
for the US-1715 admin queue. Idempotent (`on conflict do nothing` / `do update`).
Apply after 00454 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload
schema';`, redeploy the edge (boot guard now expects **00455**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00455**.

**All INSERTs — no UPDATE of an existing row** (contrast 00453, which had to narrow
the shared outerwear chart). No shared-chart narrowing is needed: no existing
chart's `brand_match` claims any of these six brands, and the three luxury
flagships carry no charts at all, so they still fall through to the generics.
Asserted in `luxury-content_test.ts`.

**CHANEL IS DELIBERATELY DECODER-LESS** and this is the one judgement call worth
re-reading before verifying: the interior serial sticker is tag-printed and
regular, and LV's informational date code (00399) is the obvious precedent — but
LV's is `2 letters + 4 digits` while Chanel's is a BARE 7-8 DIGIT RUN. A decoder
over an ordinary digit run would mint a Chanel (the KB's most expensive false
positive) from any tag carrying 8 digits — the Lee "101" mistake with a far wider
blast radius. The serial's real content (digit count → era) is seeded as
`tag_eras` + an authentication tell instead. Locked in by a no-false-recovery
golden case.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema change.
**No CLIENT read** — edge resolver only (`brand-knowledge.ts` + the
`sizing-charts.ts` in-code fallback this commit also extends), so the Cloudflare
auto-deploy on push cannot break on it.

## ⏳ PENDING: 00454_denim_brand_knowledge.sql (US-1735 denim brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the premium & vintage denim
tier beside Levi's (00393, not re-touched): **Wrangler, Lee, 7 For All Mankind,
True Religion, AG Jeans, Citizens of Humanity**. `brand_knowledge` ×6 (Wrangler +
Lee enrich their bare 00389 alias-only rows; the four premium brands are new);
`brand_styles` ×24 (the Cowboy Cut numbers, Lee's 101/Storm Rider, and the premium
FIT names that are the actual product — Slimmy/Ricky/Graduate/Rocket);
`brand_style_codes` ×2 (**Wrangler + True Religion only** — Wrangler's tag-printed
MW family (13MWZ) and True Religion's MODEL + stitch-weight compound ("Ricky Super
T") are the only regular, brand-unique garment-printed identifiers; Lee's 101 is a
model not a code, and 7FAM/AG/Citizens print a fit NAME, so all four are
deliberately decoder-less); `brand_colorways` ×4 (denim "color" is a seasonal WASH
name, so only the stable rigid/indigo terms are seeded); `brand_size_charts` ×14,
all mirrored into the `sizing-charts.ts` in-code fallback. Every fact carries
`source_url` + `confidence` and lands `verified=false` for the US-1715 admin queue.
Idempotent (`on conflict do nothing` / `do update`). Apply after 00453 via
`scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`, redeploy the
edge (boot guard now expects **00454**). Bumps `EXPECTED_SCHEMA_VERSION` → **00454**.

**All INSERTs — no UPDATE of an existing row** (contrast 00453, which had to narrow
the shared outerwear chart). No shared-chart narrowing is needed: Levi's and
Madewell already carry their own denim charts from 00389 and neither claims these
six brands, and the generic men's-pants fallback has an empty `brand_match` so it
is only selected when no brand chart matched. Asserted in `denim-content_test.ts`.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema change.
**No CLIENT read** — edge resolver only (`brand-knowledge.ts` + the
`sizing-charts.ts` in-code fallback this commit also extends), so the Cloudflare
auto-deploy on push cannot break on it.

## ⏳ PENDING: 00453_outdoor_brand_knowledge.sql (US-1734 outdoor brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the outdoor/technical tier
beside the two flagships already seeded (Patagonia 00395 / The North Face 00396):
**Columbia, Arc'teryx, Marmot, REI Co-op, L.L.Bean, Mountain Hardwear**.
`brand_knowledge` ×6 (Columbia/Arc'teryx/Marmot/L.L.Bean enrich their bare 00389
alias-only rows; REI Co-op + Mountain Hardwear are new); `brand_styles` ×24 (the
fabric tech that IS identity here — Columbia's Omni- family + the two Interchange
parkas, Arc'teryx's Gore-Tex/insulation lines, Marmot's MemBrain-vs-Gore-Tex
shells, REI's house models, the Bean Boot, Ghost Whisperer); `brand_style_codes`
×1 (**Arc'teryx only** — its MODEL + weight-class SUFFIX naming system is the sole
regular, garment-printed identifier in the group; the Columbia/Marmot/REI/Bean
item numbers are retailer SKUs and are deliberately NOT seeded as decoders);
`brand_colorways` ×5; and `brand_size_charts` ×14 (all BODY inches, each note
saying so; the `sizing-charts.ts` in-code fallback carries the 10 highest-traffic).
Every fact carries `source_url` + `confidence` and lands `verified=false` for the
US-1715 admin queue. Idempotent (`on conflict do nothing` / `do update`). Apply
after 00452 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload
schema';`, redeploy the edge (boot guard now expects **00453**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00453**.

**Contains one UPDATE of an existing row** (the only non-insert in the file):
Columbia and Arc'teryx now have their own `brand_size_charts`, so the shared 00389
`thenorthfacepatagoniaouterwear` row's `brand_match` narrows to
`{north face, patagonia}`. Without it the resolver returns BOTH the shared row and
the brand row for one brand — two charts with the same numbers competing for the
3-chart prompt budget. The North Face + Patagonia still reach the shared chart
(asserted in `outdoor-content_test.ts`). Mirrored in the in-code fallback.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema
change. **No CLIENT read** — edge resolver only (`brand-knowledge.ts` + the
`sizing-charts.ts` in-code fallback this commit also extends), so the Cloudflare
auto-deploy on push cannot break on it.

**⚠️ verify:db NOT run locally (the Docker engine is STILL hung — `docker ps`
timed out at 25s, same as at 00452's authoring).** The SQL was instead validated
STATICALLY against 00389's table definitions: every column exists, all five
`on conflict` targets match real unique indexes (`brand_knowledge.brand_key`,
`brand_styles_key_idx`, `brand_style_codes_key_idx`, `brand_colorways_key_idx`,
`brand_size_charts_key_idx`), every `confidence` sits in the `numeric(3,2)
CHECK (0..1)` range, and a lexical pass confirmed quote/dollar-quote parity with
all 34 embedded JSON blocks parsing. The Arc'teryx decoder pattern is
additionally fixtured VERBATIM in `brand-knowledge-golden_test.ts` (3/3 recovery,
including the cut-tag case), so the shipped spec is proven to decode. Prove the
file APPLIES with a Docker-up `npm run verify:db` before pushing.

## ⏳ PENDING: 00452_athleisure_brand_knowledge.sql (US-1733 athleisure brand KB, 2026-07-16)

Data-only seed of the `brand_knowledge*` tables for the athleisure/activewear
tier below the flagships: **Under Armour, Vuori, Gymshark, Fabletics, Beyond
Yoga, Sweaty Betty**. `brand_knowledge` ×6 (Under Armour + Gymshark enrich their
bare 00389 rows; the other four are new); `brand_styles` ×29 (the fabric
platforms that ARE identity in this group — UA GEAR trio, Vuori knit-vs-woven,
Gymshark Vital-marl vs Adapt-print, the Fabletics compression ladder, Beyond Yoga
Spacedye, Sweaty Betty Power/Zero Gravity); `brand_style_codes` ×1 (**Under
Armour only** — the sole tag-printed, regular code in this group; the Beyond Yoga
SD/HR/IT and Sweaty Betty SB web codes are recorded as informational tells, NOT
decoders, because they are not tag-printed); `brand_colorways` ×8; and
`brand_size_charts` ×18 (all BODY inches, each note saying so; the
`sizing-charts.ts` in-code fallback carries the 15 highest-traffic of those).
Every fact
carries `source_url` + `confidence` and lands `verified=false` for the US-1715
admin queue. Idempotent (`on conflict do nothing` / `do update`). Apply after
00451 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects **00452**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00452**.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema
change. **No CLIENT read** — edge resolver only (`brand-knowledge.ts` +
the `sizing-charts.ts` in-code fallback this commit also extends), so the
Cloudflare auto-deploy on push cannot break on it.

**⚠️ verify:db NOT run locally (the Docker engine was hung at author time —
`docker ps` timed out; a local psql was present but credentials were unknown).**
The SQL was instead validated STATICALLY against 00389's table definitions: every
column exists, all five `on conflict` targets match real unique indexes
(`brand_knowledge.brand_key`, `brand_styles_key_idx`, `brand_style_codes_key_idx`,
`brand_colorways_key_idx`, `brand_size_charts_key_idx`), and every `confidence`
sits in the `numeric(3,2) CHECK (0..1)` range. Prove it applies with a Docker-up
`npm run verify:db` (or on the prod apply, which is idempotent) before pushing.

## ⏳ PENDING: 00451_rls_initplan_perf.sql (US-1927 RLS initplan perf, 2026-07-15)

Pure PLANNER optimization of the high-traffic per-user RLS policies — **no
schema change, no semantic change, no tenant-isolation change (US-268)**.
Rewrites the hot-path policies to the Supabase-recommended initplan form
(`(select auth.uid())`) so the caller identity is hoisted to a single per-
statement initplan instead of being re-evaluated per candidate row, and gives
every workspace-member-helper policy a cheap owner fast-path disjunct
(`(select auth.uid()) = user_id OR is_workspace_member…`) so the SECURITY
DEFINER helper is never CALLED for owner rows on a single-tenant scan. Tables
covered: submissions, submission_images, grade_reports, inventory_items,
listings, sales, shipments, item_photos (both the owner and workspace-member
policies on each). Also `CREATE OR REPLACE`s `is_workspace_member` /
`is_workspace_member_with_role` (internal `auth.uid()` → `(select auth.uid())`,
owner OR-branch kept as the short-circuit) and adds the covering index
`idx_workspace_members_owner_member_role (owner_id, member_id, role)`.

**Set membership is provably unchanged:** `(select auth.uid())` returns the
identical value as `auth.uid()`, and the added owner disjunct is already implied
by the helper's first OR branch. Every policy is `DROP … IF EXISTS` +
`CREATE` (CREATE POLICY has no OR REPLACE) so the file is idempotent/re-runnable;
DDL is transactional so there is no window without a policy.

**Risk: LOW** — RLS logic identical; only the plan shape changes. **No CLIENT
read impact** (no columns/tables added or removed; the frontend's existing
PostgREST reads behave identically, just faster). Apply after 00450 via
`scripts/apply-prod-migrations.sh` (idempotent), then `NOTIFY pgrst, 'reload
schema';` (policies/functions changed), then redeploy the edge (boot guard now
expects **00451**). Bumps `EXPECTED_SCHEMA_VERSION` → **00451**.

**⚠️ verify:db / live EXPLAIN NOT run locally (Docker down at author time)** —
AC3 (EXPLAIN confirming the initplan `InitPlan … $0 = auth.uid()` form on a
representative large per-user SELECT) must be confirmed either in a Docker-up
`npm run verify:db` run or against prod after apply.

## ⏳ PENDING: 00450_madewell_jcrew_brand_knowledge.sql (US-1730 Madewell & J.Crew brand KB, 2026-07-15)

Data-only seed of the `brand_knowledge*` tables for the two J.Crew-Group banners
in one pack: `brand_knowledge` for Madewell (new) + J.Crew (enriches the bare
00389 row); `brand_styles` = Madewell fits (Perfect Vintage tapered / Roadtripper
skinny / Curvy contour block) + J.Crew numbered fits (484 Slim / 770 Straight /
1040 Athletic) + Ludlow suiting + Tilly; 2 `brand_colorways`; 2 `brand_size_charts`
(J.Crew men's chinos numeric + men's shirts alpha — Madewell women's denim already
in 00389). The generic letter+digit item code is captured as an informational tell,
NOT a brand-recovering decoder (format isn't unique). Every fact `source_url` +
`confidence`, `verified=false`. Idempotent. Apply after 00449 via
`scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`, redeploy the
edge (boot guard now expects **00450**). Bumps `EXPECTED_SCHEMA_VERSION` → **00450**.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema change.
**No CLIENT read** — edge resolver only (`brand-knowledge.ts` + `sizing-charts.ts`
in-code fallback this commit also adds).

## ⏳ PENDING: 00449_free_people_brand_knowledge.sql (US-1729 Free People brand KB, 2026-07-15)

Data-only seed of the `brand_knowledge*` tables for Free People (URBN): one
`brand_knowledge` row (sub-line-on-the-tag identity, imported/URBN country note —
RN omitted as unsourced), 5 `brand_styles` = the SUB-LINES (We The Free denim /
Intimately lingerie / FP Movement activewear / FP One elevated / Endless
Summer≡free-est), 2 `brand_colorways` (Black+hex, Ivory), and 2 `brand_size_charts`
(women's tops/dresses alpha XS-XL from the published guide + We-The-Free denim
numeric 24-31). Every fact `source_url` + `confidence`, `verified=false`.
Idempotent. Apply after 00448 via `scripts/apply-prod-migrations.sh`,
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects
**00449**). Bumps `EXPECTED_SCHEMA_VERSION` → **00449**.

**Risk: LOW** — data-only into deny-all global-reference tables; no schema change.
**No CLIENT read** — read only by the edge resolver (`brand-knowledge.ts`, with the
`sizing-charts.ts` in-code fallback this commit also adds, so it works before the
SQL lands).

## ⏳ PENDING: 00448_athleta_brand_knowledge.sql (US-1732 Athleta brand KB, 2026-07-15)

Data-only seed/refine of the `brand_knowledge*` tables for Athleta: one
`brand_knowledge` row (Gap Inc brand, fabric-line auth tells, alpha+numeric size
markers — RN omitted as unsourced), 5 `brand_styles` (Salutation BRUSHED vs
Elation SMOOTH Powervita vs Ultimate firm SuperSonic; woven Brooklyn ankle pant;
Rainier low-confidence), 3 `brand_colorways`, and an UPSERT (`do update`) of the
two existing 00389 Athleta `brand_size_charts` to the sourced XXS-XL measurements

- the numeric map (XXS≈00 … XL≈16-18) in the note. Every fact `source_url` +
  `confidence`, `verified=false`. Idempotent. Apply after 00447 via
  `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`, redeploy the
  edge (boot guard now expects **00448**). Bumps `EXPECTED_SCHEMA_VERSION` → **00448**.

**Risk: LOW** — data-only into deny-all global-reference tables; the size-chart
upsert only REFINES existing rows (adds hip + numeric note). **No CLIENT read** —
read only by the edge resolver (`brand-knowledge.ts`, with the `sizing-charts.ts`
in-code fallback this commit also refines, so it works before the SQL lands).

## ⏳ PENDING: 00447_alo_yoga_brand_knowledge.sql (US-1731 Alo Yoga brand KB, 2026-07-15)

Data-only seed into the five `brand_knowledge*` reference tables (00389): one
`brand_knowledge` row for Alo Yoga (aliases, RN 87370 / Color Image Apparel,
country + auth tells), 5 `brand_styles` (Airlift / Airbrush / 7-8 High-Waist /
Accolade Hoodie / Muse Sweatpant with the Airlift-vs-Airbrush sheen/matte
disambiguation), 5 `brand_colorways` (named colors), and 3 `brand_size_charts`
(women's bottoms + tops from the published Alo guide; men's tops as a standard
activewear-alpha approximation). Every fact carries `source_url` + `confidence`
and `verified=false` (US-1715 admin queue confirms later). Idempotent
(`on conflict do nothing` / brand_knowledge `do update`). Apply after 00446 via
`scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`, redeploy the
edge (boot guard now expects **00447**). Bumps `EXPECTED_SCHEMA_VERSION` → **00447**.

**Risk: LOW** — data-only into deny-all global-reference tables (no tenant data,
no schema change, no rewrite). **No CLIENT read** — the KB is read only by the edge
resolver (`brand-knowledge.ts` DB-first, with the in-code `sizing-charts.ts`
fallback that this commit ALSO extends, so the resolver already works before the
SQL lands — the DB seed just upgrades confidence/coverage). Frontend auto-deploy
on push is unaffected.

## ⏳ PENDING: 00446_listing_gen_v2_prompt.sql (US-1900 listing-gen prompt v-next, 2026-07-14)

Registers the `listing_gen_v2` prompt version in `public.ai_prompt_versions` as a
single INACTIVE row (empty `prompt_text`; stage `listing_gen`; `is_active=false`).
v2's text lives in code (`ai-listing.ts:LISTING_GEN_SYSTEM_PROMPT_V2`) and is
resolved from the row's `version_name` by the new `resolvePromptText()` — so the
row just registers the version + drives the lifecycle flags. v2 adds the verified
eBay policy title rules (no cross-brand comparison, no duplicate title token,
prefer buyer-typed qualifiers over aspect-carried tokens) + AI-summary-era
description guidance. Apply after 00445 via `scripts/apply-prod-migrations.sh`
(idempotent `NOT EXISTS`-guarded INSERT), `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects **00446**). Bumps
`EXPECTED_SCHEMA_VERSION` → **00446**.

**Risk: LOW** — a single additive, INACTIVE config row; changes NOTHING at
runtime on its own. v1 stays the live champion. **No CLIENT read.** v2 becomes
the A/B challenger only after an operator runs the listing-eval gate
(`runListingEval` sets `eval_passed`) and flips `in_trial=true`; it goes active
only via `activatePromptVersion`. Nothing about the frontend auto-deploy depends
on this row.

**⚙️ ALSO — OPS (not a migration), to actually ship v2:** after applying, an
operator runs the listing-gen eval against the seeded `listing_eval_cases` for
`listing_gen_v2` (admin grading/eval trigger), confirms it clears the gate
(title ≤80 + ≥75% required-aspect coverage + price-band), sets `in_trial=true`
to start the US-547 acceptance A/B, then `activatePromptVersion` promotes it once
its keep-rate beats v1. Until then v1 is unchanged.

## ⏳ PENDING: 00445_autolister_job_ai_reserved.sql (US-1931 idempotent AI reservation, 2026-07-14)

Adds `ai_reserved boolean not null default false` to `public.listing_generation_jobs`
(existing tenant table — no new table, no new RLS). Makes the AutoLister per-item
AI-action reservation IDEMPOTENT per job id: a crash between reserve and refund no
longer leaks the reservation, and on reclaim the job REUSES its reservation
(`ai_reserved=true`) instead of charging the owner's monthly cap again (was up to
MAX_JOB_ATTEMPTS=5 charges for one item under a crash loop). Apply after 00444 via
`scripts/apply-prod-migrations.sh`, `NOTIFY pgrst, 'reload schema';`, redeploy the
edge (boot guard now expects **00445**). Bumps `EXPECTED_SCHEMA_VERSION` → **00445**.

**Risk: LOW** — additive column with a default (no rewrite, no lock beyond the
add-column catalog update). **No CLIENT read** — only the edge worker
(`flipdesk-autolister.ts`) reads/writes the column; the frontend never touches it,
so the Cloudflare Pages auto-deploy on push is safe even before the SQL is applied
(the edge boot guard, not the frontend, is what gates on 00445).

## ⏳ PENDING: 00444_user_badges.sql (US-1850 achievements, 2026-07-13)

New tenant table `public.user_badges` (user_id, badge_key, earned_at, context)
with `UNIQUE(user_id, badge_key)` for idempotent awards + RLS read-own. The badge
DEFINITIONS catalog is in code (lib/rewards-badges.ts) — criteria are predicates.
Apply after 00443 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst`, redeploy
the edge (boot guard now expects **00444**). Bumps `EXPECTED_SCHEMA_VERSION` → **00444**.

**Risk: LOW** — additive table, no rewrite. No CLIENT read yet (the award engine
writes it; the profile/card surfacing — US-1850 AC3 — is not built).

## ⏳ PENDING: 00443_rewards_xp_engine.sql (US-1849 rewards XP engine, 2026-07-13)

REUSES the reputation_events ledger (00417) for the XP track (no parallel
ledger, per US-1849). Two changes: (1) extends the `reputation_events` event_type
CHECK with the reward-only types (`coverage_completed`, `badge_embedded`,
`aspects_filled`, `marketplace_connected`, `verified_share`) — a DROP + re-ADD of
`reputation_events_event_type_check`, idempotent; (2) adds `public.user_reward_state`
(user_id PK, xp_total/level/current_streak/longest_streak) with RLS read-own.
Apply after 00442 via `scripts/apply-prod-migrations.sh`, `NOTIFY pgrst`, redeploy
the edge (boot guard now expects **00443**). Bumps `EXPECTED_SCHEMA_VERSION` → **00443**.

**Risk: LOW** — additive table + a CHECK widening (never rejects existing rows;
only ADDS allowed values). Reward events are ignored by the trust scorer, so the
buyer Trust Score is unaffected. **No CLIENT read** of the new table in this
branch (the edge writes it; nothing on the frontend reads it yet).

## ⏳ PENDING: 00442_inventory_equity_snapshots.sql (US-1870 equity trend, 2026-07-12)

New tenant table `public.inventory_equity_snapshots` (user_id, snapshot_date,
total/low/high cents, valued/unvalued counts) with `UNIQUE(user_id, snapshot_date)`
for daily-idempotent upserts, RLS **read-own** (`auth.uid() = user_id`; the
nightly job writes via the service-role client). Powers the equity-over-time
trend chart. Apply after 00441 via `scripts/apply-prod-migrations.sh`
(idempotent), then `NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot
guard now expects **00442**). Bumps `EXPECTED_SCHEMA_VERSION` → **00442**.

**Risk: LOW** — additive table + indexes, no rewrite of existing data. The web
reads it via the tenant-scoped `/api/flipdesk/equity/trend` edge route (not a
direct client PostgREST read), so the Cloudflare Pages auto-deploy is unaffected;
the EDGE reads/writes it, so the edge redeploy must follow the migration.

**⚙️ ALSO — OPS (not a migration):** register a **daily Coolify scheduled task**
that curls `POST /api/functions/api/jobs/equity-snapshot` with the internal job
secret header (same pattern as the other `jobs-*` crons; mind the curl-in-image
gotcha). Until it runs on ≥2 distinct days, the trend chart stays hidden (needs
≥2 snapshots) — the rest of the equity card works immediately.

## ℹ️ NO-APPLY: 00001–00007 idempotency backfill (US-1941, 2026-07-12)

Edits 00001/00002/00003/00005/00006/00007 to add replay guards (`CREATE TABLE/
INDEX IF NOT EXISTS`, `DROP POLICY/TRIGGER IF EXISTS` before create, `DO $$ …
pg_type` enum guards, `ON CONFLICT DO NOTHING` on the storage.buckets seed, a
`pg_publication_tables` guard on the notifications realtime ADD). **No prod
action required and NO `EXPECTED_SCHEMA_VERSION` change** — these migrations are
already applied on prod; the change only makes re-running the directory
(`apply-prod-migrations.sh`) a safe no-op instead of erroring on the first
duplicate `CREATE TYPE`/`POLICY`. Semantically identical to the original schema.

## ⏳ PENDING: 00436–00440 — code-review sweep DB fixes (US-1918/1926/1939/1940/1942, 2026-07-12)

Five small, low-risk migrations from the 2026-07-11 code-review sweep. Apply in
NNNNN order via `scripts/apply-prod-migrations.sh` (all idempotent), then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00440**). **None are read by NEW client code** in this branch, so the frontend
auto-deploy is unaffected. Bumps `EXPECTED_SCHEMA_VERSION` → **00440**.

- **00436_job_locks_lockdown.sql** (US-1918) — `REVOKE ALL ON public.job_locks
FROM anon, authenticated` + `ENABLE ROW LEVEL SECURITY` (deny-all, zero
  policies). Closes the only table lacking both RLS and REVOKE; blocked a
  logged-in client from clearing/wedging cron leases. **Risk: LOW** — service-role
  (edge crons) bypasses RLS, so acquire/release RPCs are unchanged.
- **00437_notifications_insert_policy.sql** (US-1926) — `DROP POLICY IF EXISTS
"Service role can insert notifications" ON public.notifications`. That policy
  was `WITH CHECK (true)` and (since service-role bypasses RLS) let any
  authenticated user inject notifications into any feed via PostgREST. **Risk:
  LOW** — service-role edge writes still succeed (bypass RLS); SELECT/UPDATE
  owner policies untouched.
- **00438_money_precision.sql** (US-1939) — alters bare `decimal` money columns
  (inventory_items.acquired_price, listings.listing_price, sales.sale_price/
  platform_fees, shipments.shipping_cost/label_cost) to `numeric(10,2)` +
  non-negative CHECKs. **Risk: LOW–MEDIUM** — brief ACCESS EXCLUSIVE + rewrite of
  these small FlipDesk tables; existing values round to 2dp (already cent-level in
  practice). Guarded: type change only fires while a column is still unbounded.
- **00439_flipdesk_fk_indexes.sql** (US-1940) — partial indexes on
  payout_imports.sale_id and flipdesk_grading_submissions.submission_id (WHERE
  NOT NULL). **Risk: LOW** — additive indexes on small tables.
- **00440_api_keys_key_hash_unique.sql** (US-1942) — de-dupes any colliding
  key_hash rows (keeps earliest), then replaces the plain index with a UNIQUE
  one. **Risk: LOW** — a genuine collision means a duplicate issuance, not two
  valid keys; the delete keeps the earliest row per hash.

## ⏳ PENDING: 00441_submission_video.sql (US-1763 walk-around video grading, 2026-07-12)

Adds three **nullable** columns to `public.submissions` —
`video_storage_path text`, `video_content_type text`,
`video_duration_seconds numeric` — so the grade `/submit` video branch can
persist the reference to an uploaded walk-around clip (stored in the private
`submission-images` bucket, same per-user folder + RLS as the photos). The
follow-on frame-extraction story (US-1764) consumes these. Apply after 00440 via
`scripts/apply-prod-migrations.sh` (idempotent `ADD COLUMN IF NOT EXISTS`), then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge (boot guard now expects
**00441**). Bumps `EXPECTED_SCHEMA_VERSION` → **00441**.

**Risk: LOW** — additive nullable columns, no rewrite, no default. **No CLIENT
read** of these columns in this branch (the edge writes them; nothing on the
frontend reads them yet), so the Cloudflare Pages auto-deploy is unaffected — but
the EDGE write path (`grade.ts`) sets them, so the edge redeploy must follow the
migration (standard boot-guard order).

## ⏳ PENDING: 00435_sync_state_flipdesk_id_text.sql (bring-your-own-sheet snapshot save, 2026-07-12)

**What:** Widens `public.google_sheet_sync_state.flipdesk_id` from **uuid → text**
(guarded; no-op if already text). The mapped "bring your own sheet" sync (00433)
keys snapshot rows by the seller's SKU (an arbitrary string like "286"), but the
column was uuid — so the snapshot save threw `22P02 invalid input syntax for type
uuid: "286"` and failed the whole run. text holds both a UUID (classic sync) and
a SKU (mapped). Bumps `EXPECTED_SCHEMA_VERSION` → **00435**. Self-records '00435'.

**Risk: LOW–MEDIUM** — a column TYPE change on a PK column briefly takes ACCESS
EXCLUSIVE + rewrites the (small) sync-state table and its PK index. Lossless
(every uuid casts to its text form); the classic sync already uses flipdesk_id as
a string key, so no code change is needed. **No CLIENT read** of this column.
**⚠️ Apply order:** after 00434; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00435).

## ⏳ PENDING: 00434_thumbnail_backfill_failed_marker.sql (thumbnail-backfill orphan retry loop, 2026-07-12)

**What:** One additive nullable column `public.item_photos.thumbnail_backfill_failed_at
timestamptz`. Gives the thumbnail-backfill cron (`routes/jobs-thumbnail-backfill.ts`)
a terminal state for a permanently-missing source object. The job selects
`thumbnail_url IS NULL` rows and downloads each object; a 404-in-both-buckets
(object deleted out-of-band or never landed) previously left the row NULL, so it
was re-selected and retried EVERY run forever (log spam + wasted batch slots).
Now the job stamps this column on a confirmed "not found" and the query skips
stamped rows. The same commit also adds `.eq("archived_to_r2", false)` to the
query so R2-archived photos (Supabase object intentionally deleted) stop 404ing
too. Bumps `EXPECTED_SCHEMA_VERSION` → **00434**. Self-records '00434'.

**Risk: LOW** — one nullable timestamp column, no backfill, no behavior change for
healthy rows; only changes how _failures_ are handled. **No CLIENT read** — the
column is edge-only (the cron writes it; nothing on the frontend reads it), so the
frontend auto-deploy on push is unaffected. Reversible: `UPDATE item_photos SET
thumbnail_backfill_failed_at = NULL WHERE ...` to retry after a storage repair.
**⚠️ Apply order:** after 00433; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00434).

**Note (not part of this migration):** 3 live _drafted_ items lost photo objects
out-of-band (Peter Millar Quarter-Zip, Acegolfs Golf Pants, Magashoni Cardigan);
the first two are below the front+back required set and need re-shooting. This
migration only stops the retry loop — it does not delete those broken rows.

## ⏳ PENDING: 00433_sheet_map.sql ("bring your own sheet" column map, 2026-07-11)

**What:** One additive nullable column `public.google_connections.sheet_map jsonb`
— a PER-USER column map so the Google Sheets sync can drive the seller's own
tab/layout (matched/created by their SKU) instead of only the generated
UUID-keyed tabs. NULL = classic mode (unchanged behavior for every existing
user). Non-NULL = mapped mode. The map shape is validated in edge code
(`lib/sheet-map.ts`), not the DB. Bumps `EXPECTED_SCHEMA_VERSION` → **00433**.
Self-records '00433'.

**Risk: LOW** — one nullable jsonb column, no backfill, no behavior change until a
user opts into a map (Phase C UI, not built yet). **The CLIENT will READ
`sheet_map`** via the owner-read RLS on google_connections once the mapping UI
ships; the edge mapped-merge (Phase B, not built yet) reads it too. Nothing reads
it yet, so this can apply ahead of the code safely, but it still boot-guards the
edge to 00433 — apply BEFORE the push. **⚠️ Apply order:** after 00432;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00433).

## ⏳ PENDING: 00432_promote_listings_default.sql (FlipDesk promoted-listings default → off/opt-in, 2026-07-11)

**What:** Flips eBay Promoted Listings from promote-everything to **off by
default, opt-in per seller**. Adds three columns on `public.users`
(`promote_listings_by_default` bool DEFAULT false, `default_promo_rate_pct`
numeric, `default_promo_mode` text) and one tri-state column on
`public.listings` (`promote_override` bool, NULL = inherit the seller default).
Publish now resolves promotion as `promote_override ?? promote_listings_by_default`
(a legacy `promo_opt_out=true` still force-disables). Bumps
`EXPECTED_SCHEMA_VERSION` → **00432**. Self-records '00432'.

**Backfill (one UPDATE):** `listings.promote_override = false WHERE
promo_opt_out = true` — preserves EXPLICIT opt-outs. Every other listing stays
NULL → inherits the (off-by-default) seller default. **Live ads already on eBay
are untouched; this only affects the NEXT publish/revise.** Consequence: a
currently-promoted listing that was never explicitly opted out will NOT
re-promote on its next publish until the seller flips their new default on in
Settings → FlipDesk → Promoted Listings. (This is the intended "off by default"
behavior, confirmed with the user 2026-07-11.)

**Risk: LOW–MEDIUM** — additive columns + one narrow backfill, no destructive
change. But it CHANGES AD-SPEND BEHAVIOR on re-publish, and **the CLIENT reads
the new columns on frontend auto-deploy**: the composer seeds the promote
toggle/rate/mode from `users.promote_*` + `listings.promote_override`
(`useSellerPromoDefaults`), and Settings reads/writes `users.promote_*`
directly via RLS self-update (the columns are NOT in the
`guard_users_protected_columns` list, so self-update is allowed). The edge
publish path + `GET/POST/DELETE /listings/:id/promotion` boot-expect 00432.
**Apply BEFORE the push.** **⚠️ Apply order:** after 00431;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00432).

## ⏳ PENDING: 00431_buyer_wants.sql (US-1830 demand-board want model + matches, 2026-07-10)

**What:** Two new owner-read / service-write tables — `public.buyer_wants` (a
buyer's active demand criteria + visibility/status/expiry) and
`public.want_matches` (want↔matched-cert with the grading seller;
UNIQUE(want_id,certificate_id)). Bumps `EXPECTED_SCHEMA_VERSION` → **00431**.
Self-records '00431'.

**Risk: LOW** — two new isolated tables, no writes to existing tables, no
backfill. **The CLIENT reads its own wants/matches via owner RLS on frontend
auto-deploy** (US-1831 UI), and the edge wants route boot-expects 00431 — apply
BEFORE the push. **⚠️ Apply order:** after 00430; `scripts/apply-prod-migrations.sh`,
then `NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00431).

## ⏳ PENDING: 00430_closet_promotion.sql (US-1828 closet→FlipDesk list-this link, 2026-07-10)

**What:** One additive column on `public.closet_items` — `promoted_item_id` (uuid
FK → inventory_items, ON DELETE SET NULL) — the idempotency link + "Listed" state
for the one-click list-this bridge. No writes to existing rows. Bumps
`EXPECTED_SCHEMA_VERSION` → **00430**. Self-records '00430'.

**Risk: LOW** — one nullable FK column, no backfill. **The CLIENT reads
`promoted_item_id`** (the portfolio "Listed" state) and the edge
(`GET /closet/export.csv`, `POST /closet/:id/list`) boot-expects 00430 — apply
BEFORE the push. **⚠️ Apply order:** after 00429; `scripts/apply-prod-migrations.sh`,
then `NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00430).

## ⏳ PENDING: 00429_portfolio_alerts.sql (US-1827 portfolio value alerts, 2026-07-10)

**What:** Additive columns on `public.closet_item_valuations` —
`peak_estimate_cents`, `last_alert_estimate_cents`, `last_alerted_at`,
`sell_guidance` (default 'unknown'). Plus a `system_settings` row
`buyer.portfolio_alerts`. Bumps `EXPECTED_SCHEMA_VERSION` → **00429**.
Self-records '00429'.

**Risk: LOW** — additive columns on a table added this same batch (00428) + one
settings row; no backfill. **No new CLIENT column read** beyond the valuation
endpoint (edge); the edge (valuation recompute + the new alerts cron) boot-expects
00429 — apply BEFORE the push. A new daily cron `/api/jobs/portfolio-alerts` must
be registered as a Coolify scheduled task (row already in the regenerated
COOLIFY.md/CRON_SETUP.md). **⚠️ Apply order:** after 00428;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, redeploy
the edge (boot guard now expects 00429).

## ⏳ PENDING: 00428_closet_item_valuations.sql (US-1826 portfolio valuation cache, 2026-07-10)

**What:** New `public.closet_item_valuations` — a per-closet-item valuation cache
(estimate/low/high cents, confidence, basis jsonb, cost_basis, trend, computed_at;
owner-read, service-write). No writes to existing tables. Bumps
`EXPECTED_SCHEMA_VERSION` → **00428**. Self-records '00428'.

**Risk: LOW** — one new isolated table, no backfill. **No CLIENT read of the new
table** (the portfolio page reads valuations through the edge
`/api/buyer/closet/valuation`, not direct RLS), but that route boot-expects 00428
— apply BEFORE the push. Recompute is cached + TTL-refreshed on read (no cron).
**⚠️ Apply order:** after 00427; `scripts/apply-prod-migrations.sh`, then `NOTIFY
pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00428).

## ⏳ PENDING: 00427_buyer_public_profile.sql (US-1818 opt-in public buyer profile, 2026-07-10)

**What:** Three additive columns on `public.users` — `buyer_profile_handle`
(text, unique `lower()` partial index), `buyer_profile_enabled` (boolean, default
false), `buyer_profile_show` (jsonb). Edge-written via the buyer profile route, so
the users self-update guard is untouched. Bumps `EXPECTED_SCHEMA_VERSION` →
**00427**. Self-records '00427'.

**Risk: LOW** — three nullable/defaulted columns on an existing table + one
partial unique index, no backfill. **The CLIENT reads the settings via the edge**
(not direct RLS), and both the authed profile route and the public read
(`/api/content/public/buyer-profile/:handle`) boot-expect 00427 — apply BEFORE
the push. The public page `/trust/:handle` is NOINDEX + absent from the sitemap.
**⚠️ Apply order:** after 00426; `scripts/apply-prod-migrations.sh`, then `NOTIFY
pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00427).

## ⏳ PENDING: 00426_guarantee_fraud.sql (US-1823 guarantee anti-fraud controls, 2026-07-10)

**What:** Additive columns — `buyer_guarantee_claims` gains `fraud_flags` (jsonb),
`fraud_score`, `resolved_by`/`resolved_at`/`resolution_note`; `users` gains
`buyer_coverage_revoked_at` (edge-written coverage revoke). Plus a
`system_settings` row `buyer.guarantee_fraud`. Bumps `EXPECTED_SCHEMA_VERSION` →
**00426**. Self-records '00426'.

**Risk: LOW** — additive nullable/defaulted columns on existing tables + one
settings row; no destructive change, no backfill. **The CLIENT reads the new
claim columns on frontend auto-deploy** (the admin pool queue shows fraud_flags),
and the edge (fraud gate in the payout path + admin resolve route) boot-expects
00426 — apply BEFORE the push. **⚠️ Apply order:** after 00425;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, redeploy
the edge (boot guard now expects 00426).

## ⏳ PENDING: 00425_guarantee_pool.sql (US-1822 guarantee claims-pool accounting, 2026-07-10)

**What:** New `public.guarantee_pool_ledger` — an append-only accrual/drawdown
ledger (admin-read only, service-write; `UNIQUE(entry_type, reference_id)`
idempotency; per-period + per-account indexes). Plus a `system_settings` row
`buyer.guarantee_pool` (period budget, per-account cap, loss-ratio throttle,
accrual-per-active-sub). Bumps `EXPECTED_SCHEMA_VERSION` → **00425**.
Self-records '00425'.

**Risk: LOW** — one new isolated table + one settings row; no writes to existing
tables, no backfill. **No CLIENT read of the new table** (the admin dashboard
reads it through the service-role edge, not direct RLS), but the edge (the
US-1821 payout gate now consults the pool + the new cron/admin routes)
boot-expects 00425 — apply BEFORE the push. A new daily cron
`/api/jobs/guarantee-pool` must be registered as a Coolify scheduled task (row
already in the regenerated COOLIFY.md/CRON_SETUP.md tables). **⚠️ Apply order:**
after 00424; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload
schema';`, redeploy the edge (boot guard now expects 00425).

## ⏳ PENDING: 00424_buyer_guarantee_claims.sql (US-1821 buyer guarantee claim intake + remedy, 2026-07-10)

**What:** New `public.buyer_guarantee_claims` (owner/admin read, service-write;
UNIQUE(purchase_id) idempotency; status enum, remedy_cents/remedy_credits, audit
snapshot). A NEW RPC `grant_buyer_reward_credit` (uncapped, reason-tagged,
idempotent) for the remedy payout, and a same-signature `CREATE OR REPLACE` of
`issue_buyer_reward_credit` (00422) that re-scopes the day-cap count to
`reason='grade_confirmation'` so remedy grants don't consume the confirmation
cap. Plus a `system_settings` row `buyer.guarantee_remedy`. Bumps
`EXPECTED_SCHEMA_VERSION` → **00424**. Self-records '00424'.

**Risk: LOW–MEDIUM** — one new table + one new RPC + one in-place RPC re-def
(same signature, body-only change) + one settings row; no destructive change, no
backfill. **The CLIENT reads `buyer_guarantee_claims` on frontend auto-deploy**
(the /buyer/rewards claim status), and the edge claim route boot-expects 00424 —
apply BEFORE the push. Order matters: 00424 re-defines the 00422 RPC, so apply
**after 00422**. **⚠️ Apply order:** after 00423; `scripts/apply-prod-migrations.sh`,
then `NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00424).

## ⏳ PENDING: 00423_buyer_rewards_leaderboard.sql (US-1814 buyer rewards leaderboard opt-in, 2026-07-10)

**What:** Two additive columns on `public.users` — `rewards_leaderboard_enabled`
(boolean, default false) and `rewards_display_name` (text) — mirroring the
referral leaderboard opt-in (00195). Both are edge-written (service role) via the
buyer rewards opt-in route, never client self-update, so the users self-update
guard is untouched. Bumps `EXPECTED_SCHEMA_VERSION` → **00423**. Self-records '00423'.

**Risk: LOW** — two nullable/defaulted columns on an existing table, no backfill,
no destructive change. **The CLIENT reads `rewards_*` on frontend auto-deploy**
(the /buyer/rewards leaderboard opt-in card), and the edge rewards route
boot-expects 00423 — apply BEFORE the push. **⚠️ Apply order:** after 00422;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, redeploy
the edge (boot guard now expects 00423).

## ⏳ PENDING: 00422_buyer_reward_ledger.sql (US-1813 buyer reward ledger + redemption, 2026-07-09)

**What:** Two service-write / owner-read tables — `public.buyer_reward_ledger`
(append-only earn/redeem/reversal history; `UNIQUE(user_id,entry_type,
reference_id)` is the idempotency ledger so a re-confirmed purchase never
double-credits) and `public.buyer_reward_credits` (the derived spendable
balance). Three SECURITY DEFINER RPCs: `issue_buyer_reward_credit` (idempotent +
per-account/day capped, row-locked), `redeem_buyer_reward_credit` (atomic −1,
fail-closed at the floor), `refund_buyer_reward_credit`. Plus a `system_settings`
row `buyer.reward_config` (admin-tunable economics; ON CONFLICT DO NOTHING). Bumps
`EXPECTED_SCHEMA_VERSION` → **00422**. Self-records '00422'.

**Risk: LOW–MEDIUM** — two new isolated tables + three new RPCs + one settings
row; no change to existing tables. **The CLIENT reads the balance on frontend
auto-deploy** (the /buyer/rewards page shows the reward-credit card), and the edge
(confirm issuance + `withBuyerMeter` redemption fallback) boot-expects 00422 —
apply BEFORE the push. The reward-credit fallback in `withBuyerMeter` is inert
until a buyer has a balance (existing metered flows unchanged). **⚠️ Apply order:**
after 00421; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload
schema';`, redeploy the edge (boot guard now expects 00422).

## ⏳ PENDING: 00421_buyer_grade_confirmations.sql (US-1812 buyer confirm/dispute engine, 2026-07-09)

**What:** (a) EXTENDS the existing `public.grade_outcomes` (00036) with buyer
confirm/dispute columns — `buyer_user_id`, `buyer_purchase_id`, `seller_user_id`
(denormalized for the seller-integrity scan), `match_status`
(confirmed|disputed), `factor_deltas` jsonb, `overall_delta`, `dispute_reason`,
`dispute_severity` (cosmetic|material), `prompt_version`, `guarantee_eligible`,
`human_review_flagged` — all additive/nullable; a UNIQUE partial index on
`buyer_purchase_id` (one verdict per purchase, upsert), a seller-scan index, and
a buyer-owner SELECT policy (the 00036 seller/admin read policies stay). Buyer
rows carry `source='buyer_arrival'` so the seller-sale readers exclude them.
(b) NEW `public.seller_grade_integrity` — a per-seller aggregate cache
(confirmed/disputed/material counts + smoothed 0–100 integrity_score);
seller/admin read, service-write (no write policy). This is the US-1912
substrate. Bumps `EXPECTED_SCHEMA_VERSION` → **00421**. Self-records '00421'.

**Risk: LOW–MEDIUM** — additive columns on an existing table + one new isolated
table; no destructive change, no backfill. **The CLIENT reads the new columns on
frontend auto-deploy** (the /buyer/rewards page reads `grade_outcomes`
match_status/dispute_severity/guarantee_eligible for the buyer's own outcomes),
and the new edge confirm route (POST /api/buyer/purchases/:id/confirm)
boot-expects 00421 — apply BEFORE the push. **⚠️ Apply order:** after 00420;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00421).

## ⏳ PENDING: 00420_closet_items.sql (US-1825 wardrobe portfolio closet model, 2026-07-09)

**What:** One OWNER-READ / SERVICE-WRITE table `public.closet_items` — an owner's
closet (source certificate/passport/manual; certificate_id / garment_id link,
brand/type/size/condition_grade/title/notes). Partial-unique dedup on
(user_id, certificate_id) and (user_id, garment_id) so a linked item is closeted
once (re-add merges); manual entries may repeat. The edge (/api/buyer/closet)
verifies ownership of a linked cert (graded it OR bought+linked via US-1811) or
passport (garment_events→owner_nodes.linked_user_id, US-1105) before insert.
Bumps `EXPECTED_SCHEMA_VERSION` → **00420**. Self-records '00420'.

**Risk: LOW** — one new isolated table, no writes to existing tables. **The CLIENT
reads it on frontend auto-deploy** (the /buyer/portfolio page lists closet_items
via direct owner-RLS), and the new edge closet route boot-expects 00420 — apply
BEFORE the push. Valuation/dashboard are US-1826/1827 (not built). **⚠️ Apply
order:** after 00419; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst,
'reload schema';`, redeploy the edge (boot guard now expects 00420).

## ⏳ PENDING: 00419_purchase_coverage.sql (US-1820 insured purchase-guarantee coverage model, 2026-07-09)

**What:** One OWNER-READ / SERVICE-WRITE table `public.purchase_coverage` — a
SNAPSHOT (one per buyer_purchase, UNIQUE(purchase_id)) of whether a linked
purchase is covered by the insured "Grade-Locked" guarantee and on what FROZEN
terms (eligible + ineligible_reason, plan_at_purchase, level_at_purchase,
window_days, payout_cap_cents, grade_delta_threshold, covered_until). Distinct
from the seller-side grade-fee `guarantee_claims` (00197). The edge snapshots it
at purchase-link time (POST /api/buyer/purchases) from the buyer's entitlement
tier (US-1800) + Trust Score level (US-1817), frozen so a later downgrade never
voids an in-force claim. Bumps `EXPECTED_SCHEMA_VERSION` → **00419**. Self-records.

**Risk: LOW** — one new isolated table, no writes to existing tables. **The CLIENT
reads it on frontend auto-deploy** (the /buyer/rewards page shows the coverage
badge), and the edge snapshot writer boot-expects 00419 — apply BEFORE the push.
Terms are config-tunable via getSetting `buyer_guarantee_coverage` (no migration).
Claim intake/payout is US-1821 (not built). **⚠️ Apply order:** after 00418;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, redeploy
the edge (boot guard now expects 00419).

## ⏳ PENDING: 00418_buyer_purchases.sql (US-1811 buyer purchase-link + arrival capture, 2026-07-09)

**What:** Two OWNER-READ / SERVICE-WRITE tables — `public.buyer_purchases` (a
buyer links a purchase to a PUBLIC grade: grade_report_id FK + certificate_id +
price/marketplace/purchased_at + brand/title snapshot, UNIQUE(user_id,
grade_report_id)) + `public.purchase_arrival_captures` (front/back/label/detail
image_type + storage_path in the existing PRIVATE `submission-images` bucket,
UNIQUE(purchase_id,image_type)). RLS owner-SELECT only; the edge (/api/buyer/\*)
does all writes after verifying the cert / hardening the upload. Bumps
`EXPECTED_SCHEMA_VERSION` → **00418**. Self-records '00418'. NO new storage
bucket (reuses submission-images + its per-user-folder RLS).

**Risk: LOW** — two new isolated tables, no writes to existing tables. **The
CLIENT reads both the moment the frontend auto-deploys** (the /buyer/rewards page
lists buyer_purchases + purchase_arrival_captures via direct owner-RLS reads), and
the new edge `/api/buyer/*` route boot-expects 00418 — so apply BEFORE the push.
**⚠️ Apply order:** after 00417; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00418).

## ⏳ PENDING: 00417_buyer_trust_score.sql (US-1816 buyer Trust Score model + engine, 2026-07-09)

**What:** Two new OWNER-READ / SERVICE-WRITE tables (RLS `FOR SELECT USING
(auth.uid() = user_id)` only — a buyer sees their reputation but can never
fabricate it; only the service-role client writes, like `buyer_notification_log` 00412) seeding the Trust Score epic (US-1815): `public.reputation_events` (the
append-only event log — event_type CHECK IN verified_purchase/grade_confirmed/
dispute_upheld/dispute_overturned/chargeback_penalty/tenure, `verified` gate,
magnitude, source, reference_id, metadata; UNIQUE(user_id,event_type,reference_id)
for idempotent emission) + `public.buyer_trust_scores` (derived cache: score,
level 0..3, level_label, event_count — recomputed from the log, never authority).
Deterministic scorer is `lib/buyer-trust-score.ts`. Bumps
`EXPECTED_SCHEMA_VERSION` → **00417**. Self-records '00417'.

**Risk: LOW** — two brand-new isolated tables, no writes to existing tables. NO
client reads/writes them yet (the buyer-facing surface is US-1818; producers are
the rewards/dispute/billing flows, US-1810+), so unlike 00416 nothing breaks on
the frontend auto-deploy — but the edge boot guard expects 00417 on next deploy.
**⚠️ Apply order:** after 00416; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00417).

## ⏳ PENDING: 00416_alerts_watchlist.sql (US-1806 alerts watchlist + saved-search model, 2026-07-09)

**What:** Two new TENANT-SCOPED, owner-managed tables (RLS `auth.uid() = user_id`,
like `buyer_preferences`) that seed the condition-alerts epic (US-1805):
`public.saved_searches` (standing buyer criteria — brands/categories/sizes/keywords/
min_grade/max_price_cents, is_active, per-search notify flags, `last_matched_at`) +
`public.watchlist_items` (a specific certificate/listing/passport a buyer watches,
UNIQUE(user_id, target_type, target_id) so a repeat "watch" is idempotent, plus a
display snapshot label/brand). Bumps `EXPECTED_SCHEMA_VERSION` → **00416**.
Self-records '00416'.

**Risk: LOW** — two brand-new isolated tables, no writes to existing tables/columns.
Managed entirely from the SPA under RLS; **the CLIENT reads/writes these the moment
the frontend auto-deploys** (new `use-watchlist` / `use-saved-searches` hooks + the
certificate-page Watch button, which is gated behind the `conditionAlerts`
entitlement so it stays hidden until a plan unlocks it). So this migration MUST be
applied before the push-triggered Cloudflare Pages deploy, or those queries 404 the
missing tables. The matching engine (US-1807) that READS these from the edge is not
built yet. **⚠️ Apply order:** after 00415; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00416).

## ⏳ PENDING: 00415_api_overage_credits.sql (US-1792 B2B API overage credits, 2026-07-09)

**What:** Two new TENANT-SCOPED tables — `public.api_credit_wallet` (user_id PK,
balance, service-role writes only, owner-read RLS) + `public.api_credit_transactions`
(append-only ledger, UNIQUE(stripe_session_id) for grant idempotency) — plus two
RPCs `grant_api_credits` (idempotent on session id) + `debit_api_credits` (atomic
FOR UPDATE, returns -1 when insufficient). The prepaid, never-expiring API overage
wallet: over-quota calls draw down 1 credit instead of 429ing. Wallet in its own
table (no users guard churn, like buyer_meter_usage). Bumps
`EXPECTED_SCHEMA_VERSION` → **00415**. Self-records '00415'.

**Risk: LOW** — two new isolated tables + two functions, no writes to existing
tables. Inert until the STRIPE*PRICE_API_OVERAGE*\* prices exist (run
setup-stripe-pricing.mjs) + a key carries a monthly_quota. **⚠️ Apply order:**
after 00414; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload
schema';`, redeploy the edge (boot guard now expects 00415).

## ⏳ PENDING: 00414_buyer_iap.sql (US-1804 buyer mobile IAP, 2026-07-09)

**What:** Five ADDITIVE nullable columns on `public.users` for the buyer
subscription IAP processor tag + store identifiers: `buyer_billing_source`
(stripe/appstore/googleplay, CHECKed), `buyer_appstore_original_transaction_id`,
`buyer_appstore_product_id`, `buyer_google_purchase_token`,
`buyer_google_product_id`, + two partial indexes to reconcile a store
renewal/expiry by its id. Mirrors the seller billing_source/appstore/google
columns for the buyer product. Bumps `EXPECTED_SCHEMA_VERSION` → **00414**.
Self-records '00414'.

**Risk: LOW** — additive nullable columns + two partial indexes, no writes to
existing columns. The Stripe buyer webhook now stamps `buyer_billing_source =
'stripe'`; the Apple IAP verify writes the appstore columns. **⚠️ Apply order:**
after 00413; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload
schema';`, redeploy the edge (boot guard now expects 00414).

## ⏳ PENDING: 00413_buyer_metering.sql (US-1800 buyer metered actions, 2026-07-09)

**What:** New TENANT-SCOPED table `public.buyer_meter_usage` (user_id PK, usage
jsonb, reset_at) + owner-SELECT RLS (writes ONLY via the SECURITY DEFINER RPCs,
so a buyer can't reset their own counter). Two RPCs `reserve_buyer_meter(user,
meter, limit)` + `refund_buyer_meter(user, meter)` — the atomic, cap-aware,
monthly-rolling reserve/refund for buyer metered actions (extension checks /
authenticity / video credits), cloned from reserve_ai_action (00087). Bumps
`EXPECTED_SCHEMA_VERSION` → **00413**. Self-records '00413'.

**Risk: LOW** — one new isolated table + two new functions, no writes to existing
tables. The `withBuyerMeter` helper (lib/buyer-metering.ts) is defined but NOT
yet called by any route (the metered buyer features are later epics), so nothing
exercises it until then. **⚠️ Apply order:** after 00412;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00413).

## ⏳ PENDING: 00412_buyer_notifications.sql (US-1803 buyer notification layer, 2026-07-09)

**What:** (1) Four values on the `notification_type` enum
(`buyer_condition_alert/reward/guarantee/portfolio`) via `ADD VALUE IF NOT
EXISTS`. (2) New TENANT-SCOPED table `public.buyer_notification_log` (idempotency
ledger: `UNIQUE (user_id, dedupe_key)`, `sent_at`, `channels[]`) + owner SELECT
RLS + two indexes. (3) Three columns on `buyer_preferences`: `digest_frequency`
('immediate'|'daily'|'weekly', default immediate), `quiet_hours_start/end`
(smallint 0-23, nullable). Bumps `EXPECTED_SCHEMA_VERSION` → **00412**.
Self-records '00412'.

**Risk: LOW** — additive enum values + one new isolated table + three nullable/
defaulted columns. The delivery layer (`lib/buyer-notify.ts`) is defined but NOT
yet wired to any caller (the buyer feature epics call it later), so nothing
executes against the new schema until then. Frontend auto-deploy is safe (the
new `buyer_preferences` columns aren't read by the shipped settings UI yet; the
notification-preferences buyer categories are code-side JSONB defaults).
**⚠️ Apply order:** after 00411; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects
00412). **⚠️ Enum caveat:** the new `notification_type` values can't be USED in
the same transaction they're added — fine here (inserts happen at runtime).

## ✅ APPLIED: 00411_buyer_preferences.sql (US-1797/1798 buyer shopping prefs, 2026-07-09)

**What:** New TENANT-SCOPED table `public.buyer_preferences` (user_id PK/FK,
followed_brands/categories/sizes, price band, condition_floor, unit + notify
prefs, onboarding_completed_at) + `set_updated_at` trigger + owner-only RLS
(`FOR ALL USING auth.uid()=user_id`). Buyers manage it directly from the SPA
(no edge write route); downstream edge features read it scoped by user_id.
Bumps `EXPECTED_SCHEMA_VERSION` → **00411**. Self-records '00411'.

**Risk: LOW** — one new isolated table, no writes to existing tables, no billing
columns. **Applied to prod by the user 2026-07-09** (confirmed). Frontend reads
the new table (`useBuyerPreferences`) so it needed the table live before the
Cloudflare Pages auto-deploy — done.

## ⏳ HELD: 00410_grading_batches.sql (US-1790 batch grading — NOW FULLY WIRED, 2026-07-09)

**What:** Two new TENANT-SCOPED tables `public.grading_batches` +
`public.grading_batch_jobs` (user_id FK, status text+CHECK, attempts, payload
jsonb, submission_id, counters) + indexes + `set_updated_at` triggers + owner
SELECT RLS policies. The durable-jobs queue for B2B batch grading. Bumps
`EXPECTED_SCHEMA_VERSION` → **00410**. Self-records '00410'.

**Now wired (US-1790 part 2, same push):** `POST /api/v1/grades/batch` +
`GET /api/v1/grades/batch/:id` (api-v1.ts), the background worker + reclaim
handler (`lib/grading-batch-worker.ts`), and the reclaim cron mount
`/api/jobs/grading-batch-reclaim` (main.ts). **⚠️ NEW OPS TASK:** add the
`grading-batch-reclaim` Coolify scheduled task (`*/5 * * * *`,
`$FLIPDESK_INTERNAL_JOB_SECRET`) — see COOLIFY.md — or stale batches never
self-heal.

**Risk: LOW — two new isolated tables, no writes to existing tables.** The
endpoints are gated behind the `grading` feature flag + AI-budget gate and
charge per garment via the existing payment precedence (no new money path).
**⚠️ verify:db NOT run (Docker down).** **⚠️ Apply order:** after 00409;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00410).

## ⏳ HELD: 00409_api_key_quotas.sql (US-1791 B2B API quotas, 2026-07-09)

**What:** Two ADDITIVE nullable columns on `public.api_keys`:
`monthly_quota integer` (NULL = unlimited; max API calls per UTC month, enforced
in api-key-auth.ts → 429 quota_exceeded) and `rate_tier text` (NULL = derive from
owner plan; e.g. 'enterprise' for the new high-throughput tier). Bumps
`EXPECTED_SCHEMA_VERSION` → **00409**. Self-records '00409'.

**Risk: LOW — additive nullable columns; existing keys behave exactly as before**
(NULL quota = unlimited, NULL rate_tier = plan-derived). **⚠️ CLIENT READ:** the
api-keys UI reads `api_keys` — additive columns are ignored by existing reads, so
no break; but apply so the columns exist before the edge reads them in auth.
**⚠️ verify:db NOT run (Docker down).** **⚠️ Apply order:** after 00408;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00409).

## ⏳ HELD: 00408_impact_factors.sql (US-1786 sustainability factors, 2026-07-09)

**What:** New DENY-ALL (RLS enabled, ZERO policies), GLOBAL/NON-TENANT config
table `public.impact_factors` (`garment_type`, `material` default 'default',
`co2e_kg`, `water_liters`, `weight_kg`, `source`, `version`) + unique
(garment_type, material) index + `set_updated_at` trigger. Seeded with 6
conservative type-level rows from published apparel LCAs (cited in `source`).
Read only by the service-role edge (`impact-estimate.ts`); the SPA never queries
it. Registered in `rls-guard_test.ts` SERVICE_ROLE_ONLY. Bumps
`EXPECTED_SCHEMA_VERSION` → **00408**. Self-records '00408'.

**Risk: LOW — one new isolated seeded config table, no writes to existing
tables, no client read** (impact-estimate.ts also has a code-side FALLBACK so it
works even before the table applies). **⚠️ verify:db NOT run (Docker down).**
**⚠️ Apply order:** after 00407; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy the edge (boot guard now expects 00408).

## ⏳ HELD: 00407_body_profiles.sql (US-1777 buyer body profiles, 2026-07-09)

**What:** New TENANT-SCOPED table `public.body_profiles` (`user_id` FK→users
ON DELETE CASCADE, `name`, `measurements` jsonb in inches, `is_default`) +
`idx_body_profiles_user` + `set_updated_at` trigger. RLS policy
`auth.uid() = user_id` FOR ALL (owner-only; body measurements are sensitive
PII). Bumps `EXPECTED_SCHEMA_VERSION` → **00407**. Self-records '00407'.

**⚠️ CLIENT-SIDE READ — apply this one promptly (ideally before the frontend
deploy).** The new page `/dashboard/measurements` (src/pages/fit/body-profiles.tsx)
reads AND writes `body_profiles` directly via the authenticated Supabase client
(RLS is the boundary; no edge path). Until the table exists in prod, that page's
queries error. Exposure is LOW — the route is NOT yet linked from any nav — but
apply 00407 with/before the push so a user who navigates there directly works.
**Risk otherwise LOW:** new isolated table, no writes to existing tables.
**⚠️ verify:db NOT run (Docker down).** **⚠️ Apply order:** after 00406;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00407).

## ⏳ HELD: 00406_durability_aggregates.sql (US-1773 durability aggregation, 2026-07-09)

**What:** One new DENY-ALL (RLS enabled, ZERO policies), GLOBAL/NON-TENANT
reference table `public.durability_aggregates` — one row per sku_class cohort
(`sku_class_key` unique, `brand`, `garment_type`, `label`, `garment_count`,
`regraded_count`, `avg_overall_decay`, `avg_retention`, `avg_span_days`,
`per_factor_decay` jsonb, `resale_sample`, `resale_median_cents`,
`resale_by_band` jsonb, `sufficient`) + unique/partial indexes +
`set_updated_at` trigger. Written by the service-role cron
`POST /api/jobs/durability-aggregate` (guarded by X-Internal-Job-Secret) and read
by the future public rankings endpoint (US-1774). Registered in
`rls-guard_test.ts` SERVICE_ROLE_ONLY. Bumps `EXPECTED_SCHEMA_VERSION` → **00406**.
Self-records '00406'. References only existing objects (set_updated_at).

**Risk: LOW — one new isolated table, no writes to existing tables.** Aggregate-
only + PII-safe (no per-listing price / buyer / node identity). Nothing reads it
until US-1774 ships; the cron is opt-in (not scheduled until you add a Coolify
task). **⚠️ verify:db NOT run (Docker down at author time)** — idempotent
CREATE-IF-NOT-EXISTS + deny-all pattern matching prior tables. **⚠️ Apply order:**
after 00405; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00406).

## ⏳ HELD: 00405_authenticity_eval.sql (US-1770 authenticity eval gate, 2026-07-09)

**What:** Two new admin-only (is_admin RLS) operator tables mirroring the
grading eval pair (00050): `public.authenticity_eval_cases` (labeled
authentic/counterfeit golden set — `brand_key`, `images` jsonb, `expected_label`
CHECK in `('authentic','counterfeit','inconclusive')`, `tags`, `is_active`,
`created_by`→users) + `public.authenticity_eval_runs` (a run's per-brand +
overall agreement, `passed`, `per_case`/`per_brand` jsonb). Indexes on
active/brand + created_at. `set_updated_at` trigger on cases. Bumps
`EXPECTED_SCHEMA_VERSION` → **00405**. Self-records '00405'. References only
existing objects (public.users, garment_type enum, set_updated_at, is_admin,
applied_migrations).

**Risk: LOW — two new isolated tables, no writes to existing tables.** Read
only from the EDGE (`authenticity-eval.ts` runAuthenticityEval + a future admin
trigger); the FRONTEND never touches them, so a Pages deploy landing first is
safe. The eval gate is INERT until an operator adds real labeled cases
(`runAuthenticityEval` throws "No active authenticity eval cases" on an empty
set — never fabricate cases). **⚠️ verify:db NOT run (Docker down at author
time)** — the SQL is an idempotent mirror of the proven 00050 pattern; run
`npm run verify:db` or apply carefully. **⚠️ Apply order:** after 00404;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge (boot guard now expects 00405).

## ⏳ HELD: 00404_badge_click_events.sql (US-1760 badge funnel, 2026-07-09)

**What:** New deny-all operator table `public.badge_click_events`
(`owner_user_id` FK→users, `target_type` CHECK in `('cert','seller')`,
`target_id`, `source`, `created_at`) + `idx_badge_click_events_owner`. RLS enabled
with ZERO policies (service-role only). Records off-platform badge clicks
(attributed to the seller server-side, no buyer PII) for the seller + admin badge
funnel. Registered in `rls-guard_test.ts` SERVICE_ROLE_ONLY. Bumps
`EXPECTED_SCHEMA_VERSION` → **00404**. Self-records '00404'.

**Risk: LOW — new isolated table, no writes to existing tables.** Nothing reads
or writes it until this migration applies. **⚠️ CLIENT/EDGE READ:** the edge
funnel endpoints (`/api/verified/badge-funnel`, `/api/admin/growth/badge-funnel`)
and the public `/api/content/public/badge-click` recorder query this table — they
500/no-op until the table exists, and the seller "Badge performance" card +
admin "Badge funnel" tile simply stay hidden (they render only with data). So a
frontend deploy landing before the migration degrades gracefully, but apply
00404 with/before the push for the endpoints to work. **⚠️ Apply order:** after
00403; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge.

## ⏳ HELD: 00403_condition_index_seed_provenance.sql (US-1746 Value Index auto-seed, 2026-07-09)

**What:** Adds two additive columns to `public.condition_index_seeds` —
`source text NOT NULL DEFAULT 'curated'` (CHECK in `('curated','generated')`) and
`generated_at timestamptz` — plus `idx_condition_index_seeds_source`. Tags seeds
proposed by the new seed-generation cron (`/api/jobs/condition-index-seedgen`,
US-1746) as `'generated'` so the admin surface can distinguish them and an audit
can target only the machine-proposed set. Bumps `EXPECTED_SCHEMA_VERSION` →
**00403**. Self-records '00403'.

**Risk: LOW — additive columns + idempotent CHECK/index.** Existing seeds default
to `'curated'`; nothing behaves differently until an operator flips the
`condition_index_seedgen` system-setting to `enabled:true` (OFF by default).
**⚠️ CLIENT READ:** `src/pages/admin/condition-index.tsx` (admin-only) now reads
`source`/`generated_at` off the seed-list API. The edge selects the new columns —
so a frontend deploy landing BEFORE this migration would make the edge
`SELECT ... source, generated_at` 400 on the admin Condition Index list until the
migration applies. Apply this migration before/with the push. **⚠️ Apply order:**
after 00402; `scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`,
redeploy the edge. No new cron scheduling is needed until you enable seedgen.

## ⏳ HELD: 00402_buyer_subscription.sql (US-1799 buyer subscription, 2026-07-08)

**What:** Adds a `buyer_plan` enum (`free`/`guard`/`connoisseur`) and the buyer
subscription column family to `public.users` — `buyer_plan` (DEFAULT 'free'),
`buyer_interval`, `buyer_subscription_status` (reuses the existing
`subscription_status` enum), `buyer_subscription_id`, `buyer_period_end`,
`buyer_cancel_at_period_end`. `CREATE OR REPLACE`s `guard_users_protected_columns()`
(over 00331) to also freeze these billing columns against browser self-update.
Bumps `EXPECTED_SCHEMA_VERSION` → **00402**. Self-records '00402'.

**Risk: LOW — additive columns + idempotent guard replace.** All default to a
free/none/no-sub state, so existing accounts are unaffected. **⚠️ CLIENT READ:**
`src/types/database.ts` gains `buyer_*` on `UserRow`; no shipped client code
SELECTs them yet (buyer billing UI US-1801), so a frontend deploy landing before
this migration is safe. **⚠️ Apply order:** after 00401;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, redeploy.

## ⏳ HELD: 00401_buyer_account_roles.sql (US-1796 buyer/seller roles, 2026-07-08)

**What:** Adds two additive boolean role flags to `public.users` — `is_seller`
(DEFAULT true, backfills every existing account) and `is_buyer` (DEFAULT false) —
plus a partial index `idx_users_is_buyer`. `CREATE OR REPLACE`s `handle_new_user()`
so a buyer-origin signup (`account_type='buyer'` in signup metadata) lands with
`is_buyer=true, is_seller=false` and NO seller/FlipDesk assumptions (free plan,
`none` status, no 14-day trial); the absent-key seller path is byte-for-byte
unchanged aside from `is_seller=true`. Bumps `EXPECTED_SCHEMA_VERSION` → **00401**.
Self-records '00401'.

**Risk: LOW — additive columns + idempotent trigger replace.** No RLS change; the
new flags are intentionally NOT in the US-347 self-update guard (in-app role
opt-in). **⚠️ CLIENT READ:** `src/types/database.ts` gains `is_seller`/`is_buyer`
on `UserRow`, but no shipped client code SELECTs them yet (added by the buyer
dashboard US-1802), so a frontend deploy landing before this migration is safe.
**⚠️ Apply order:** after 00400; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy edge.

## ⏳ HELD: 00400_gucci_brand_knowledge.sql (US-1728 Gucci, 2026-07-07)

**What:** DATA-ONLY seed of Gucci — 5 lines (GG Supreme, Guccissima, Marmont,
Ophidia, Web Stripe), a 6-digit `style_number` decoder (informational), and tells
that state the serial proves nothing and the KB must **never auto-authenticate**.
source_url + confidence + verified on every row. Bumps `EXPECTED_SCHEMA_VERSION`
→ **00400**. Self-records '00400'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00399; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00399_louis_vuitton_brand_knowledge.sql (US-1727 Louis Vuitton, 2026-07-07)

**What:** DATA-ONLY seed of Louis Vuitton (NEW brand_knowledge row) — 5 canvases/
lines (Monogram, Damier Ebene, Damier Azur, Empreinte, Epi), a date-code
FORMAT decoder (2 letters + 4 digits; informational only, discontinued March 2021
→ microchip), and tells that state a date code proves nothing and the KB must
**never auto-authenticate**. source_url + confidence + verified on every row.
Bumps `EXPECTED_SCHEMA_VERSION` → **00399**. Self-records '00399'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00398; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00398_coach_brand_knowledge.sql (US-1726 Coach, 2026-07-07)

**What:** DATA-ONLY seed of Coach (first LUXURY brand) — 5 lines/bags (Signature
canvas, Glovetanned leather, Willis, Rogue, Tabby), a boutique-vs-outlet
`style_number` decoder (`F`-prefix = factory/outlet), and `brand_knowledge` tells
that explicitly say **never auto-authenticate** (creed/serial is informational
only). source_url + confidence + verified on every row. Bumps
`EXPECTED_SCHEMA_VERSION` → **00398**. Self-records '00398'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00397; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00397_ralph_lauren_brand_knowledge.sql (US-1725 Ralph Lauren, 2026-07-07)

**What:** DATA-ONLY seed of Ralph Lauren — 6 sub-lines as styles (Purple Label /
RRL / Polo Ralph Lauren / Polo Sport / Lauren / Chaps) with value-tier
fingerprints, and enriched `brand_knowledge` (sub-brand hierarchy + pony + RN
tells). NO decoder — RL has no reliable regular code; the value tier is read from
the label wording. source_url + confidence + verified on every row. Bumps
`EXPECTED_SCHEMA_VERSION` → **00397**. Self-records '00397'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00396; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00396_the_north_face_brand_knowledge.sql (US-1724 TNF, 2026-07-07)

**What:** DATA-ONLY seed of The North Face — 7 styles (Nuptse down vs ThermoBall
synthetic vs Denali fleece; Osito, Apex, McMurdo, Summit Series), an `NF0A…`
`style_number` decoder, and enriched `brand_knowledge` (down-vs-synthetic +
Summit-Series-vs-mainline tells). source_url + confidence + verified on every
row. Bumps `EXPECTED_SCHEMA_VERSION` → **00396**. Self-records '00396'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00395; `scripts/apply-prod-migrations.sh`, redeploy
(boot guard → 00396).

## ⏳ HELD: 00395_patagonia_brand_knowledge.sql (US-1723 Patagonia, 2026-07-07)

**What:** DATA-ONLY seed of Patagonia into the 00389 KB tables — 7 styles
(Nano Puff/Down Sweater/Micro Puff puffer disambiguation by fill; Better Sweater/
R1/Retro-X fleeces; Baggies), a 5-digit `style_number` decoder, 4 persistent
colorways, and enriched `brand_knowledge` (insulation-type tell). Every fact
source_url + confidence + verified. Bumps `EXPECTED_SCHEMA_VERSION` → **00395**.
Self-records '00395'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent.

**⚠️ CLIENT READ — none.** **⚠️ Apply order:** after 00394;
`scripts/apply-prod-migrations.sh`, then redeploy (boot guard → 00395).

## ⏳ HELD: 00394_carhartt_brand_knowledge.sql (US-1722 Carhartt, 2026-07-07)

**What:** DATA-ONLY seed of Carhartt + Carhartt WIP into the 00389 KB tables — 6
styles (Detroit vs Chore vs Active Jac silhouette fingerprints, Duck Bib, K87
tee, B01 dungaree), a classic `style_number` decoder (letter+digits, `B01`/`J140`/
`K87`), and enriched `brand_knowledge` (mainline-vs-WIP tell + Carhartt WIP as a
distinct pricier line). Every fact source_url + confidence + verified. Bumps
`EXPECTED_SCHEMA_VERSION` → **00394**. Self-records '00394'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent (brand_knowledge
`ON CONFLICT DO UPDATE`, children `DO NOTHING`).

**⚠️ CLIENT READ — none** (server-side extraction/baselines only).

**⚠️ Apply order:** after 00393. Run `scripts/apply-prod-migrations.sh`, then
redeploy the edge (boot guard → 00394).

## ⏳ HELD: 00393_levis_brand_knowledge.sql (US-1721 Levi's, 2026-07-07)

**What:** DATA-ONLY seed of Levi's into the 00389 KB tables — 8 styles (fit
fingerprints: 501 button-fly vs 505 zip-fly vs 511 slim, 512/541/550/569 +
Trucker Jacket), a brand-scoped `lot_number` fit decoder (`5NN`), and enriched
`brand_knowledge` (Big-E/small-e red-tab era dating + back-patch/selvedge tells).
Every fact source_url + confidence + verified. Bumps `EXPECTED_SCHEMA_VERSION` →
**00393**. Self-records '00393'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent (brand_knowledge
`ON CONFLICT DO UPDATE`, children `DO NOTHING`).

**⚠️ CLIENT READ — none** (server-side extraction/baselines only).

**⚠️ Apply order:** after 00392 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge (boot guard → 00393).

## ⏳ HELD: 00392_adidas_yeezy_brand_knowledge.sql (US-1720 adidas & Yeezy, 2026-07-07)

**What:** DATA-ONLY seed of adidas + Yeezy into the 00389 KB tables — 6 styles
(Tiro/Tango Performance vs Firebird/Adicolor Originals-Trefoil; Yeezy Season +
Yeezy Gap Round Jacket), the adidas `article_number` decoder (2 letters + 4
digits, `GX1234`) seeded as PURE DATA, and enriched `brand_knowledge` (Trefoil
vs 3-Bar line tell; Yeezy minimalist-aesthetic tell). Yeezy is a NEW
brand_knowledge row (not in the 00389 alias seed). Every fact source_url +
confidence + verified. Bumps `EXPECTED_SCHEMA_VERSION` → **00392**. Self-records
'00392'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent (brand_knowledge
`ON CONFLICT DO UPDATE`, children `DO NOTHING`).

**⚠️ CLIENT READ — none** (server-side extraction/baselines only).

**⚠️ Apply order:** after 00391 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge (boot guard → 00392).

## ⏳ HELD: 00391_nike_jordan_brand_knowledge.sql (US-1719 Nike & Jordan, 2026-07-07)

**What:** DATA-ONLY seed of Nike + Jordan into the 00389 KB tables — 8 styles
(Tech Fleece vs Club Fleece fingerprints, Therma-FIT, Dri-FIT, Windrunner, ACG,
Jordan Jumpman), the Nike `style_number` decoder (6-char + "-" + 3-digit
colorway, `CW1234-001`) seeded as PURE DATA (regex + fieldMap, **no new
transform**) under both `nike` and `jordan`, and enriched `brand_knowledge`
(style-number tag era + line-vs-brand tells). Every fact source_url + confidence

- verified=true. Bumps `EXPECTED_SCHEMA_VERSION` → **00391**. Self-records
  '00391'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent: brand_knowledge
`ON CONFLICT (brand_key) DO UPDATE`, children `DO NOTHING`.

**⚠️ CLIENT READ — none** (same as 00390 — server-side extraction/baselines
only).

**⚠️ Apply order:** after 00390 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge so its boot guard
matches 00391. `NOTIFY pgrst` not required (rows only).

## ⏳ HELD: 00390_lululemon_brand_knowledge.sql (US-1718 Lululemon content, 2026-07-07)

**What:** DATA-ONLY seed of the 00389 KB tables with Lululemon content — 9
styles with disambiguating visual fingerprints (ABC 5-pocket+gusset vs Commission
chino, Align vs Wunder Train vs Fast & Free, etc.), 2 decoder specs
(`style_number` + `size_dot`; DB rows that override the in-code
DEFAULT_DECODER_SPECS), 5 representative colorways, and enriched
`brand_knowledge` (tag eras + authentication/size-dot tells). Every fact carries
source_url + confidence + verified=true. Bumps `EXPECTED_SCHEMA_VERSION` →
**00390**. Self-records '00390'.

**Risk: LOW — additive INSERTs only** (no DDL, no schema change). Idempotent:
brand_knowledge via `ON CONFLICT (brand_key) DO UPDATE`, children via
`ON CONFLICT … DO NOTHING` (re-running never clobbers an admin edit). Tables +
Lululemon size charts already exist from 00389.

**⚠️ CLIENT READ — none.** No SPA query reads these tables (the admin UI reads
via the service-role edge route). The KB only affects server-side extraction
(US-1713) + baseline generation (US-1717). No hard ordering hazard beyond the
edge boot guard expecting **00390**.

**⚠️ `NOTIFY pgrst, 'reload schema';`** — not strictly required (no schema-shape
change, rows only), but harmless; keep the runbook uniform.

**⚠️ Apply order:** after 00389 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge so its boot guard
matches 00390.

## ⏳ HELD: 00389_brand_knowledge_base.sql (US-1710 Brand & Style KB, 2026-07-07)

**What:** creates FIVE global-reference operator tables — `brand_knowledge`,
`brand_styles`, `brand_style_codes`, `brand_colorways`, `brand_size_charts` — the
schema foundation for the DB-backed, retrievable garment brand/style/size
knowledge base (fixes brand/style ID failures, esp. Lululemon cut-tag recovery).
Seeds `brand_knowledge` from `brand-normalize.ts` BRAND_ALIASES (53 brands) and
`brand_size_charts` from `sizing-charts.ts` SIZING_CHARTS (15 charts) so the
future DB-first resolver (US-1711) has parity with today's in-code data. Deny-all
RLS (no `user_id`, no tenant data); registered in `rls-guard_test.ts`
`SERVICE_ROLE_ONLY`. Bumps `EXPECTED_SCHEMA_VERSION` → **00389**. Self-records
'00389'.

**Risk: LOW — five NEW additive tables + indexes + updated_at triggers + an
idempotent data seed** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS`, `DROP TRIGGER IF EXISTS` before create; seed via `ON CONFLICT DO
NOTHING`). No changes to existing tables. Re-running the whole directory is a
no-op.

**⚠️ CLIENT READ — none.** Nothing reads these tables yet: this story is
schema-only. The resolver that reads them (US-1711) and the admin UI that writes
them (US-1715) are later stories. The only code shipping in this commit is the
migration, the `EXPECTED_SCHEMA_VERSION` bump, and the rls-guard registration —
so there is **no hard ordering hazard** beyond the edge boot guard expecting
**00389**. The SPA never queries them.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (five new tables — PostgREST
must reload to expose them to the service-role client).

**⚠️ Apply order:** after 00388 (top of the held stack). Run
`scripts/apply-prod-migrations.sh` (idempotent tail), then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge so its boot guard
matches 00389.

## ⏳ HELD: 00388_content_safety_flagged_status.sql (advisory content-safety, 2026-07-07)

**What:** adds the value `'flagged'` to the `public.content_safety_status` enum
(`ADD VALUE IF NOT EXISTS`). The pre-publish content-safety review (US-486) is now
ADVISORY on the auto-publish path: AI blog/social posts publish immediately even
when the reviewer returns a non-pass verdict, tagged `safety_status='flagged'`
(reasons in `safety_notes`) instead of being held as a draft. Edge writes
`'flagged'` on the blog editor `/generate` path + the scheduler tick
(`runBlogTick`/`runSocialTick`). Bumps `EXPECTED_SCHEMA_VERSION` → **00388**.
Self-records '00388'.

**Risk: LOW — additive enum value, no data change.** Idempotent
(`ADD VALUE IF NOT EXISTS`), not wrapped in a transaction (a new enum value can't
be USED in the same tx; this migration never does). `'held'` is retained.

**⚠️ CLIENT READ — none.** No frontend query filters on `safety_status`, so a
frontend auto-deploy before the SQL applies is safe. The edge only WRITES
`'flagged'` from this build, which is boot-guarded on **00388**, so it can't run
before the value exists. Behavior change is otherwise pure product logic (publish
instead of hold).

**⚠️ Apply order:** after 00387 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';` (enum
changed), then redeploy the edge so its boot guard matches 00388.

## ⏳ HELD: 00387_ads_recommendation_decisions.sql (US-1702 review workflow, 2026-07-07)

**What:** adds `snooze_until timestamptz` + `dismiss_reason text` (+ an index) to
the existing `ads_recommendations` table for the approve/dismiss/snooze review
workflow. The decision itself is recorded as an `action='decision'` row in the
existing `ads_change_audit` (no new table). Bumps `EXPECTED_SCHEMA_VERSION` →
**00387**. Self-records '00387'.

**Risk: LOW — two additive nullable columns + one index on an existing operator
table, idempotent** (`ADD COLUMN IF NOT EXISTS`). No table creation.

**⚠️ CLIENT READ — the Command Center reads `snooze_until` / `dismiss_reason`
through the super-admin `/recommendations` route** (degrades: the columns are
nullable, so pre-migration reads just return null). No hard break.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new columns).

**⚠️ Apply order:** after 00386 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00387.

## ⏳ HELD: 00386_ads_search_terms.sql (US-1706 search-terms mining, 2026-07-07)

**What:** creates the operator table `ads_search_terms` (search_term,
matched_keyword, match_type, campaign/ad_group external ids, impressions/clicks/
cost/conversions, window) — the daily sync pulls the Google Ads search-terms
report here, and the analysis mines it for negative-keyword + new-keyword
recommendations. Deny-all RLS; registered in `rls-guard_test.ts`
`SERVICE_ROLE_ONLY`. Bumps `EXPECTED_SCHEMA_VERSION` → **00386**. Self-records
'00386'.

**Risk: LOW — one NEW additive table + indexes + updated_at trigger, idempotent.**
No changes to existing tables. Only the service-role sync writes it.

**⚠️ CLIENT READ — none.** Mining runs server-side; recommendations surface via
the existing super-admin route.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00385 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00386.

## ⏳ HELD: 00385_ad_click_attributions_upload.sql (US-1704 offline import, 2026-07-07)

**What:** adds `uploaded_at`, `upload_status`, `upload_error` columns (+ a partial
index) to the existing `ad_click_attributions` table so the offline-conversion
upload job is idempotent (uploads each converted row once) and records
success/skip/failure per row. Bumps `EXPECTED_SCHEMA_VERSION` → **00385**.
Self-records '00385'.

**Risk: LOW — three additive nullable columns + one partial index on an existing
operator table, fully idempotent** (`ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`). No table creation, no data change.

**⚠️ CLIENT READ — none.** Only the service-role upload job reads/writes these
columns. No frontend reads them.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new columns on a table the
service-role client selects).

**⚠️ Apply order:** after 00384 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00385.

## ⏳ HELD: 00384_ads_change_audit.sql (US-1703 guarded apply, 2026-07-07)

**What:** creates the operator table `ads_change_audit` (recommendation_id,
change_type, target_resource, before_value, after_value, dry_run, success,
action, result, owner_user_id) — every guarded apply/rollback of an approved
recommendation writes a row with the pre-mutate value for rollback. Deny-all
RLS; registered in `rls-guard_test.ts` `SERVICE_ROLE_ONLY`. Bumps
`EXPECTED_SCHEMA_VERSION` → **00384**. Self-records '00384'.

**Risk: LOW — one NEW additive table + indexes, idempotent.** No changes to
existing tables. Only the service-role apply flow writes it.

**⚠️ CLIENT READ — none directly** (Command Center reads via the super-admin edge
route). The apply/revert routes fail CLOSED when Google Ads is unconfigured.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00383 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00384.

## ⏳ HELD: 00383_ads_recommendations.sql (US-1701 Claude analysis, 2026-07-07)

**What:** creates the operator table `ads_recommendations` (target_type,
target_resource, change_type, rationale, confidence, projected_impact, payload,
severity, status='proposed') — the report-only output of the Claude ads-analysis
pass; the guarded apply (US-1703) later acts on the payload. Deny-all RLS;
registered in `rls-guard_test.ts` `SERVICE_ROLE_ONLY`. Bumps
`EXPECTED_SCHEMA_VERSION` → **00383**. Self-records '00383'.

**Risk: LOW — one NEW additive table + index + updated_at trigger, idempotent.**
No changes to existing tables. Only the service-role edge writes (the analysis
pass); the Command Center reads via /api/admin/ads/recommendations.

**⚠️ CLIENT READ — none directly.** The SPA reads recommendations only through the
super-admin edge route, which degrades to `[]` if the table is absent. The
"Analyze" button POSTs /api/admin/ads/analyze (report-only). No hard ordering
hazard beyond the edge boot guard expecting **00383**.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00382 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00383.

## ⏳ HELD: 00382_ad_click_attributions.sql (US-1700 conversion wiring, 2026-07-07)

**What:** creates the operator table `ad_click_attributions` (click_id,
click_id_type, platform, landing_at, owner_user_id nullable, converted_at,
conversion_type, value) — links captured Google click ids (gclid/gbraid/wbraid)
to the converting user + downstream conversion value, for the ads analysis
(US-1701) + offline import (US-1704). Deny-all RLS; registered in
`rls-guard_test.ts` `SERVICE_ROLE_ONLY`. Bumps `EXPECTED_SCHEMA_VERSION` →
**00382**. Self-records '00382'.

**Risk: LOW — one NEW additive table + indexes + updated_at trigger, fully
idempotent.** No changes to existing tables. Only the service-role edge writes
(the /api/ads/attribution route + the future offline import).

**⚠️ CLIENT READ — none.** The SPA never reads this table. The client only
CAPTURES click ids into first-party storage and POSTs them to
`/api/ads/attribution` (authed); that route no-ops safely if the table is absent
(the write just errors and returns 400 — no user-facing breakage). The
Command-Center/analysis reads are operator-only.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00381 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00382.

## ⏳ HELD: 00381_ads_data_model.sql (US-1698 Ads Command Center, 2026-07-07)

**What:** creates SEVEN operator tables for the Ads Command Center —
`ads_accounts`, `ads_campaigns`, `ads_ad_groups`, `ads_ads`, `ads_keywords`,
`ads_metrics_daily`, `ads_sync_runs` — each with a `platform` column
('google_ads' | 'apple_search_ads') and deny-all RLS (service-role only). Local
snapshots of our OWN Google Ads account structure + daily metrics, synced by
`/api/jobs/ads-sync` (daily cron) and `/api/admin/ads/google/sync` (manual,
super-admin). Bumps `EXPECTED_SCHEMA_VERSION` → **00381**. Self-records '00381'.

**Risk: LOW — seven NEW additive tables + indexes + updated_at triggers, fully
idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`DROP TRIGGER IF EXISTS` before create). No changes to existing tables. Only the
service-role edge writes (bypasses RLS); registered in `rls-guard_test.ts`
`SERVICE_ROLE_ONLY`.

**⚠️ CLIENT READ — none.** No frontend reads these yet (the US-1699 dashboard is a
later story). The edge code that reads/writes them (`google-ads-sync*.ts`, the
admin route, the cron) NO-OPS entirely when the `GOOGLE_ADS_*` secrets are unset,
so there is **no hard ordering hazard** beyond the edge boot guard expecting
**00381** — the schema-version bump ships in this same commit.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (seven new tables — PostgREST
must reload to expose them to the service-role client).

**⚠️ Apply order:** after 00380 (top of the held stack). Run
`scripts/apply-prod-migrations.sh` (idempotent tail), then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge so its boot guard
matches 00381.

## ⏳ HELD: 00380_cert_assets_bucket.sql (cert-image render fix, 2026-07-06)

**What:** creates the PUBLIC `cert-assets` storage bucket (+ a public-read
policy) that the new Deno-edge renderer writes the certificate images to (the
"slab" graded photo, OG card, badge). This moves image rendering off the
Free-plan Cloudflare Worker (which 503s with "error code: 1102" — CPU limit)
onto the edge, which renders once and stores here. Self-records '00380'.

**Risk: LOW — additive storage bucket + one public-READ policy, idempotent**
(`ON CONFLICT DO NOTHING` / `DROP POLICY IF EXISTS`). Only the service-role edge
writes (bypasses RLS). `NOTIFY pgrst, 'reload schema';` NOT required (no
table/column/RPC/enum shape change — storage.buckets is a data row).

**⚠️ CLIENT READ — none.** No frontend reads a new column. **Graceful
degradation if applied late:** the edge route uploads with `.catch()` and treats
a missing bucket as a cache-miss, so it re-renders every request (works, just
uncached) until the bucket exists. So there is no hard ordering hazard beyond the
edge boot guard expecting **00380**.

**⚠️ Apply order:** after 00379 (top of the held stack). Run
`scripts/apply-prod-migrations.sh` (idempotent tail). Redeploy the edge so its
boot guard matches 00380.

## ⏳ HELD: 00379_signup_source_survey.sql (US-1670 / SEO 2.0, 2026-07-06)

**What:** the last piece of the SEO/GEO measurement layer — a self-reported
"How did you hear about us?" signup survey with an **"AI assistant"** option.
Adds nullable `users.signup_source text` and `CREATE OR REPLACE`s
`handle_new_user()` to whitelist the value from `raw_user_meta_data` (exactly
like `use_case` in 00303). Self-reported AI discovery is the only reliable
ChatGPT/Claude/Perplexity attribution (referrers are stripped), complementing the
referrer-side `ai_referrer` PostHog property already shipped. Self-records '00379'.

**Risk: LOW — additive nullable column + CREATE OR REPLACE trigger (idempotent).**
No backfill (NULL = "not reported"). The whitelist rejects anything unknown to
NULL, so a malformed client value can never abort signup (the function also keeps
its resilient EXCEPTION handler). Edge boot guard now expects **00379**.

**⚠️ CLIENT READ — SAFE (backward-compatible):** the frontend signup form
(`src/pages/signup.tsx`) now passes an extra `signup_source` key in
`options.data` (raw_user_meta_data). The OLD trigger simply IGNORES that key, so
a frontend auto-deploy that lands BEFORE this migration applies degrades to
"source not recorded" — signup never breaks. Nothing client-side READS the column
(it's write-only attribution; admin analytics reads it server-side later). So
there is no hard ordering hazard beyond the edge boot guard.

**⚠️ Apply order:** after 00378 (i.e. last, on top of the whole held stack
00332–00378). `NOTIFY pgrst, 'reload schema';` IS needed (new column). Redeploy
the edge so its boot guard matches 00379. Constants↔trigger whitelist drift is
pinned by `src/lib/__tests__/signup-source.test.ts`.

## ⏳ HELD: 00378_seed_reseller_blog_and_topics.sql (blog seed, 2026-07-06)

**What:** pure DATA seed (no schema change). Inserts 4 fully-written **draft**
`blog_posts` (status='draft', generated_by='human') plus ~40 `content_topics`
(status='queued') derived from the July 2026 Reddit-research titles, re-angled to
GradeThread/FlipDesk. Self-records '00378'.

**Apply order: AFTER 00377.** This stacks on the still-held Vinted enum migration
— run `scripts/apply-prod-migrations.sh` (idempotent, applies the tail in NNNNN
order) so 00377 then 00378 land together.

**Risk: LOW — additive INSERTs only.** Idempotent: `blog_posts` via
`ON CONFLICT (slug) DO NOTHING`, `content_topics` via `WHERE NOT EXISTS` on the
`(surface, product_focus, lower(primary_keyword))` dedup key. Re-running is a
no-op. No new table/column/enum → **no `NOTIFY pgrst, 'reload schema'` needed**
(schema shape is unchanged; only rows added).

**⚠️ CLIENT READ:** the 4 posts are `status='draft'`, so the anon SSR (published-
only RLS) will NOT surface them until an admin publishes — the frontend
auto-deploy on push is safe. The only hard requirement is the edge boot guard:
apply the SQL (so `applied_migrations` reaches **00378**) BEFORE the next Coolify
edge redeploy, since `EXPECTED_SCHEMA_VERSION` is now `00378`.

**Review the drafts:** /admin/content/blog/editor — publish when ready. The rest
sit in the topic bank for the autonomous scheduler.

## ⏳ HELD: 00377_listing_platform_vinted.sql (US-1663, 2026-07-05)

**What:** adds the value `'vinted'` to the `public.listing_platform` enum. Vinted
is an EXTENSION-mechanism channel (no public API — listed via the GradeThread
Lister extension, like Poshmark/Mercari/Grailed), so there is NO edge connector;
the enum value just lets `listings.platform` carry 'vinted' and the Listing Kit /
cross-list surfaces map a Vinted sibling. Self-records '00377'.

**Risk: LOW — additive enum value, no data change.** Idempotent
(`ADD VALUE IF NOT EXISTS`), not wrapped in a transaction (can't use a new enum
value in the same tx; this migration never does).

**⚠️ CLIENT READ — safe:** the frontend now lists `vinted` in `LISTING_PLATFORMS`
/`MARKETPLACE_*` and renders it in the extension-channels section. Pure display,
no DB query for the enum value, so the frontend auto-deploy on push is safe even
before the SQL applies. No edge code filters `.eq("platform","vinted")` on a hot
path (extension channels have no server connector). Apply the SQL first anyway so
the edge boot guard (now **00377**) doesn't crash-loop.

**⚠️ Apply order:** after 00376. `NOTIFY pgrst, 'reload schema';` recommended
(enum changed). Redeploy the edge so its boot guard matches 00377.

## ⏳ HELD: 00376_listing_platform_etsy.sql (US-1659, 2026-07-05)

**What:** adds the value `'etsy'` to the `public.listing_platform` enum
(`ALTER TYPE ... ADD VALUE IF NOT EXISTS 'etsy'`). `listings.platform` and
`marketplace_connections.marketplace` are BOTH this enum, so the value must exist
before any Etsy connection row or sibling listing can be written. Ships alongside
the Etsy connection layer (`etsy-client.ts`/`etsy-api.ts`/adapter/route), all
gated behind `ETSY_ENABLED` (off until Etsy app approval). Self-records '00376'.

**Risk: LOW — additive enum value, no data change.** Idempotent
(`ADD VALUE IF NOT EXISTS`), so re-running the whole directory is a no-op once the
value exists. NOT wrapped in a transaction (an enum value added inside a
transaction can't be used in that same transaction; this migration never uses it).

**⚠️ CLIENT READ — safe, but note the enum caveat:** the frontend
(`src/lib/constants.ts`) now lists `etsy` in `LISTING_PLATFORMS`/`MARKETPLACE_*`
and the Marketplaces UI renders it in the "pending approval" tier. That is pure
client display and does NOT query the DB for the enum value, so the frontend
auto-deploy on push is safe even before the SQL applies. HOWEVER, per the enum
rule: no edge code filters `.eq("marketplace","etsy")` on a path that could run
before this migration applies except INSIDE the `ETSY_ENABLED` gate (off in prod
until approval) — so there is no window where edge code selects a not-yet-existing
enum value. Apply the SQL first regardless so the edge boot guard (now **00376**)
doesn't crash-loop.

**⚠️ Apply order:** after 00375. `NOTIFY pgrst, 'reload schema';` recommended
(enum changed). Redeploy the edge so its boot guard matches 00376.

## ⏳ HELD: 00375_affiliate_amounts_integer_cents.sql (US-1655, 2026-07-05)

**What:** converts `affiliate_commissions.amount` and `affiliate_payouts.amount`
from `numeric(10,2)` (USD dollars) to `integer` (cents), backfilling every
existing row by `round(amount * 100)`. `CHECK (amount >= 0)` and `DEFAULT 0`
carry over unchanged. The edge engine (`lib/affiliate-payout.ts`) now carries
integer cents end-to-end and drops the `*100` at the `stripe.transfers.create`
boundary (cents are the minor unit Stripe already expects). Self-records '00375'.

**Risk: MEDIUM — money-transforming column type change on existing rows.** The
transform runs `amount * 100` on live data, so it is guarded on
`data_type='numeric'`: once the column is already `integer` the `DO` block is a
no-op, making a re-run (apply-prod-migrations.sh re-runs the whole directory)
safe — it can NEVER double-multiply. Proven locally: verify:db green (fresh
from-zero apply reaches 00375) + a direct scratch-table proof
($5.00→500, $12.34→1234, $0.10→10, $599.99→59999, $0→0; a second run leaves them
unchanged). The affiliate engine ships `mode:'off'` by default, so in practice
these tables are empty in prod today — the backfill is a safety net, not a live
data move, but it is correct either way.

**⚠️ CLIENT READ — converted at the API boundary, NOT client-side:** the web
(`src/pages/referrals.tsx`) renders `payouts.balance.*`, `payouts.tax.*`, and
`payouts.payouts[].amount` as USD currency. The route `routes/affiliate.ts` now
converts cents→dollars at the JSON boundary (via `centsToDollars`), so the client
contract is UNCHANGED and no frontend edit is required. The finance-agent feed
(`lib/agent-tools.ts fetchRecentPayouts`) likewise converts affiliate cents→dollars
so its dollar math stays consistent with `consignor_payouts` (still numeric
dollars — NOT touched by this migration). **Because the contract is preserved,
the frontend auto-deploy on push is safe even before the SQL is applied** — but
apply the SQL first anyway so the edge boot guard (now **00375**) doesn't crash-loop.

**⚠️ Apply order:** after 00310 (the affiliate tables) and 00374. `NOTIFY pgrst,
'reload schema';` IS needed (column type changed). Redeploy the edge so its boot
guard matches 00375.

## ⏳ HELD: 00374_seed_user_lifecycle_agent.sql (US-1600 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the User Lifecycle agent (module U),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY (Mon 05:00) / sonnet
model / read-only allowlist (get_user_lifecycle) / $2 cap. Cohort-level lifecycle
analyst: activation-stall diagnosis, churn narrative, winback sizing. Proposes
cohort-level moves only — enroll_cohort (wraps the existing drip enrollment for a
WHITELISTED cohort 'trial_expiring_7d' into campaign 'trial_conversion'; marketing
opt-outs excluded, already-enrolled deduped, hard-capped at 500) or a file_task
for a new drip variant. NEVER emails anyone (drip engine + frequency caps own
delivery). Prompt in the repo charter. `ON CONFLICT (key) DO NOTHING`. Self-records
'00374'.

**Risk: LOW — one paused seed row into the operator agents table (00357).** No
schema change beyond the seed. The read tool aggregates cohort COUNTS only
(funnel_metrics RPC, drip_enrollments, users trial-expiry HEAD counts) — no
per-user rows reach the model. enroll_cohort reuses the same idempotent upsert as
the trial-drip tick (UNIQUE user_id,campaign from 00274). No client read. Edge boot
guard now expects **00374**.

**⚠️ Apply order:** after 00357–00373. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00374.

## ⏳ HELD: 00373_seed_marketing_portfolio_agent.sql (US-1599 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Marketing Portfolio agent (module M),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY (Mon 06:00) / sonnet
model / read-only allowlist (get_marketing_portfolio) / $2 cap. One supervisor
over the three self-tuning marketing engines; its value is the cross-engine view
(audience fatigue, blog/newsletter cannibalization, same-day collisions). Proposes
engine-level levers only — add_marketing_topic (email_topic_bank 00290 /
content_topics 00041), adjust_frequency (marketing_frequency_cap_per_day setting),
or a file_task to pause a sequence. Prompt in the repo charter. `ON CONFLICT (key)
DO NOTHING`. Self-records '00373'.

**Risk: LOW — one paused seed row into the operator agents table (00357).** No
schema change beyond the seed; the tool reads/writes existing tables
(marketing_send_log, drip_enrollments, newsletter_issues, content_topics,
email_topic_bank) + the frequency setting. No client read. Edge boot guard now
expects **00373**.

**⚠️ Apply order:** after 00357–00372. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00373.

## ⏳ HELD: 00372_agent_handoffs.sql (US-1613 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** creates `agent_handoffs` — the queue for agent-to-agent handoffs
(target_agent, origin_agent, origin_run_id, kind, payload, evidence, hop,
provenance jsonb, status queued|consumed, consumed_run_id/at). Deny-all RLS,
service-role only (mirrors agent_memory 00357); registered in rls-guard_test.ts
SERVICE_ROLE_ONLY. Partial index on (target_agent, created_at) WHERE
status='queued'. Also merges `accepts_handoffs_from` into two existing agent
configs — sentinel accepts ['support-triage'], integrations-watchdog accepts
['sentinel'] (jsonb ||, guarded by NOT (config ? 'accepts_handoffs_from') for
idempotency; a no-op if those rows aren't seeded yet).

**Risk: LOW.** New operator table (no tenant data — agent keys + run ids + the
emitting agent's finding payload) + two idempotent config merges. No client read.
The kernel reads/writes it entirely server-side. Edge boot guard now expects
**00372**.

**⚠️ Apply order:** after 00357–00371 (FKs to agent_runs from 00357; the config
merges target sentinel/integrations-watchdog rows seeded earlier). `NOTIFY pgrst,
'reload schema';` IS needed (new table). Redeploy the edge so its boot guard
matches 00372.

## ⏳ HELD: 00370–00371 Support Triage (US-1595 / AGENTIC-OS Phase 1, 2026-07-05)

**00370_support_ticket_triage_fields.sql — What:** adds four NULLable advisory
columns to `support_tickets` — `triage_category` (CHECK billing|grading|technical|
account|shipping|other), `triage_severity` (CHECK low|normal|high|urgent),
`triage_kb_slug` (text, references support_kb_articles.slug BY VALUE — no FK), and
`triaged_at timestamptz` — plus a partial index on (triage_severity,
last_message_at) for open/pending rows. Additive + idempotent. NO RLS change:
support_tickets already restricts SELECT to owner/admin and allows no client
writes (service-role only, 00223).

**00371_seed_support_triage_agent.sql — What:** seeds ONE `agents` row — the
Support Triage agent (module S), `status='paused'`, `autonomy='{}'` (L0), config =
every-2h / sonnet model / read-only allowlist (get*support_triage) / $3 cap.
Classifies + prioritizes new tickets, drafts approval-gated replies (draft_reply →
send_support_reply), persists classifications (triage_tickets → persist_ticket*
triage, onto the 00370 columns), and files cluster escalations for Sentinel
(file_task). NEVER sends a reply or changes a ticket itself. `ON CONFLICT (key) DO
NOTHING`. Self-records '00371'.

**Risk: LOW.** 00370 is additive columns on an existing table (no backfill, no
client read of the new columns yet — the admin support UI renders them once the
frontend adds them, but nothing breaks in the meantime). 00371 is one paused seed
row. Edge boot guard now expects **00371**.

**⚠️ Apply order:** 00370 THEN 00371 (the seed's comment references the columns),
after 00357–00369. `NOTIFY pgrst, 'reload schema';` IS needed (00370 adds
columns). Redeploy the edge so its boot guard matches 00371.

## ⏳ HELD: 00369_seed_experiments_governor_agent.sql (US-1609 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** seeds ONE `agents` row — the Experiments Governor (module X),
`status='paused'`, `autonomy='{}'` (L0), config = twice-weekly (Mon/Thu 07:00) /
haiku model / read-only allowlist (get_experiments_registry) / $1 cap. Unifies
every LIVE A/B across three engines (newsletter subject tests, grading-prompt
canaries, drip variants) into one registry and flags portfolio issues:
interference (same audience + metric, overlapping windows), underpowered "wins",
and experiments past their decision date. Files an admin task (file_task) with a
concrete remedy; NEVER stops/extends/promotes an experiment itself. Prompt lives
in the repo charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records
'00369'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. The get_experiments_registry tool reads existing columns
only — `newsletter_issues` A/B fields (00282), `ai_prompt_versions` canary fields
(00221), `drip_enrollments` (00253) — no new schema beyond this seed row. Edge
boot guard now expects **00369**.

**⚠️ Apply order:** apply after 00357–00368. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00369.

## ⏳ HELD: 00368_seed_release_agent.sql (US-1610 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** seeds ONE `agents` row — the Release agent (module Q), `status='paused'`,
`autonomy='{}'` (L0), config = hourly / haiku model / read-only allowlist
(get_release_health) / $1 cap. Detects a RELEASE_SHA change, compares post-deploy
health to a pre-deploy baseline, files a regression admin task (file_task) or an
all-clear; may propose run_smoke. NEVER rolls back. Prompt lives in the repo
charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records '00368'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00368**. NOTE: the
get_release_health tool lazily upserts a `release.verify_state` system_settings
row at runtime (SHA + baseline watermark) — no migration needed.

**⚠️ Apply order:** apply after 00357–00367. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00368.

## ⏳ HELD: 00367_seed_cron_governance_agent.sql (US-1611 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** seeds ONE `agents` row — the Cron Governance agent (module J),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY schedule / sonnet model /
read-only allowlist (get_cron_fleet_health + get_cron_health) / $1 cap. It diffs
CRON_REGISTRY vs cron_runs (missed ticks, maintenance-suppressed; duration creep)
and files schedule-adjustment admin tasks (file_task) once an operator grants L1;
it NEVER changes Coolify config. The prompt lives in the repo charter. `ON CONFLICT
(key) DO NOTHING` (idempotent). Self-records '00367'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00367**.

**⚠️ Apply order:** apply after 00357–00366. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00367.

## ⏳ HELD: 00366_seed_growth_agent.sql (US-1602 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Growth agent (module R), `status='paused'`,
`autonomy='{}'` (L0), config = WEEKLY schedule / sonnet model / read-only allowlist
(get_growth_health) / $2 cap. Narrates funnel anomalies + referral health and
files experiment briefs as admin tasks (file_task) once an operator grants L1; it
generates/ranks ideas but never starts experiments. The prompt lives in the repo
charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records '00366'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00366**.

**⚠️ Apply order:** apply after 00357–00365. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00366.

## ⏳ HELD: 00365_seed_ceo_brief_agent.sql (US-1603 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the CEO Brief chief-analyst (module Y),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY schedule / sonnet model /
read-only allowlist (get_ceo_brief) / $2 cap. Scheduled after the other weekly
agents so it can cite their runs. It narrates north-star metrics + the fleet's
latest run outcomes into a decision memo (honest attribution / graceful
degradation); it proposes nothing to execute. The prompt lives in the repo
charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records '00365'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00365**.

**⚠️ Apply order:** apply after 00357–00364. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00365.

## ⏳ HELD: 00364_seed_trust_safety_agent.sql (US-1597 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Trust & Safety agent (module T),
`status='paused'`, config = daily / sonnet / read-only allowlist
(get_trust_safety_health) / $2 daily cap. UNLIKE the other seeds, its `autonomy`
map is non-empty: it explicitly sets the account-action classes (suspend_account,
require_step_up, deny_claim) at **L1** to make the hard ceiling visible. The
policy engine (AUTONOMY_HARD_CAPS in agent-policy.ts) ALSO clamps them to L1
regardless of any later promotion — a permanent design decision. Approving one
files an admin task on the fraud console; it never suspends anyone directly. The
prompt lives in the repo charter. `ON CONFLICT (key) DO NOTHING` (idempotent).
Self-records '00364'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00364**.

**⚠️ Apply order:** apply after 00357–00363. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00364.

## ⏳ HELD: 00363_seed_marketplace_ops_agent.sql (US-1598 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Marketplace Ops agent (module L),
`status='paused'`, `autonomy='{}'` (L0), config = daily schedule / sonnet model /
read-only allowlist (get_marketplace_ops_health + get_marketplace_health) / $2
daily cap. The prompt lives in the repo charter
(`agents/charters/marketplace-ops-agent.ts`). It reads OPERATOR-SCOPE AGGREGATES
only and can propose reclaim-cron retry_jobs + file admin tasks once an operator
grants L1; it NEVER mutates tenant listings/inventory. `ON CONFLICT (key) DO
NOTHING` (idempotent). Self-records '00363'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00363**. NOTE: the agent's
get_marketplace_ops_health tool also upserts a `marketplace_ops.backlog_snapshot`
system_settings row at RUNTIME (operator backlog watermark) — created lazily on
first run, no migration needed.

**⚠️ Apply order:** apply after 00357–00362. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00363.

## ⏳ HELD: 00362_seed_pricing_agent.sql (US-1601 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Pricing agent (module P), `status='paused'`,
`autonomy='{}'` (L0), config = daily schedule / sonnet model / read-only allowlist
(get_pricing_health) / $2 daily cap. The prompt lives in the repo charter
(`agents/charters/pricing-agent.ts`). It audits cross-tenant aggregates and can
propose a curve-refresh retry_job + file admin tasks once an operator grants L1;
it NEVER edits a tenant's rules or prices. `ON CONFLICT (key) DO NOTHING`
(idempotent). Self-records '00362'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00362**.

**⚠️ Apply order:** apply after 00357–00361. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00362.

## ⏳ HELD: 00361_seed_finance_agent.sql (US-1596 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Finance agent (module F), `status='paused'`,
`autonomy='{}'` (L0), config = daily schedule / sonnet model / read-only allowlist
(get_finance_health + get_revenue_window + get_ai_spend) / $2 daily cap. The prompt
lives in the repo charter (`agents/charters/finance-agent.ts`). It has NO write
tools of its own — it can only file admin tasks (file_task) once an operator grants
L1; it never moves money or credits. `ON CONFLICT (key) DO NOTHING` (idempotent).
Self-records '00361'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00361**.

**⚠️ Apply order:** apply after 00357–00360. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00361.

## ⏳ HELD: 00360_seed_integrations_watchdog_agent.sql (US-1604 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Integrations Watchdog agent (module I),
`status='paused'`, `autonomy='{}'` (L0), config = daily schedule / haiku model /
read-only allowlist (get_integrations_health + get_marketplace_health) / $1 daily
cap. The prompt lives in the repo charter
(`agents/charters/integrations-watchdog.ts`). It has NO write tools of its own —
it can only file admin tasks (file_task) once an operator grants L1. `ON CONFLICT
(key) DO NOTHING` (idempotent). Self-records '00360'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00360**.

**⚠️ Apply order:** apply after 00357/00358/00359. Data-only (no `NOTIFY pgrst`
needed). Redeploy the edge so its boot guard matches 00360.

## ⏳ HELD: 00359_seed_grading_quality_agent.sql (US-1594 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Grading Quality agent (module G),
`status='paused'`, `autonomy='{}'` (L0), config = weekly schedule / sonnet model
/ read-only allowlist (get_grading_quality + get_review_queue_stats) / $2 daily
cap. The prompt lives in the repo charter (`agents/charters/grading-quality.ts`).
It has NO grading write tools — it can never mutate grading config. `ON CONFLICT
(key) DO NOTHING` (idempotent). Self-records '00359'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00359**.

**⚠️ Apply order:** apply after 00357/00358. Data-only (no `NOTIFY pgrst`
needed). Redeploy the edge so its boot guard matches 00359.

## ⏳ HELD: 00358_seed_sentinel_agent.sql (US-1593 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Sentinel health/incident agent (module H),
`status='paused'`, `autonomy='{}'` (L0), config = schedule 30m / haiku model /
read-tool allowlist (get_incidents + ops reads) / $1 daily cap / 8 max steps.
The prompt lives in the repo charter (`agents/charters/sentinel.ts`), not the
row. `ON CONFLICT (key) DO NOTHING` (idempotent; never disturbs later operator
edits). Self-records '00358'.

**Risk: LOW — one seed row into a brand-new operator table (00357).** No client
reads. The agent is seeded PAUSED, so it does nothing until an operator enables
it in Mission Control. Edge boot guard now expects **00358**.

**⚠️ Apply order:** apply after 00357 (the agents table must exist first). No
`NOTIFY pgrst` strictly needed (no schema surface change — data only), but
harmless. Redeploy the edge so its boot guard matches 00358.

## ⏳ HELD: 00357_agentic_os_kernel_schema.sql (US-1583 / AGENTIC-OS Phase 0, 2026-07-04)

**What:** creates the five foundational Agentic OS operator tables — `agents`
(registry: key/name/module_letter/status/autonomy jsonb/config jsonb),
`agent_runs` (run ledger: status/tokens/cost/outcome), `agent_run_steps`
(transcript: seq/step_type/input/output/duration), `agent_proposals` (approval
queue: action_class/payload/evidence/status/idempotency_key unique), and
`agent_memory` (agent_id/kind/key/content/weight). All uuid PKs, created_at/
updated_at + `set_updated_at` triggers, and indexes (runs by agent+started_at
desc, proposals by status, unique run_id+seq, unique agent_memory key).
Idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE … IF NOT EXISTS`);
self-records '00357'.

**Risk: LOW — five NEW empty deny-all tables; no client reads, no data change.**
All RLS-enabled with ZERO policies (service-role only, registered in
SERVICE_ROLE_ONLY in rls-guard_test.ts); none has a `user_id` column. Fixed-set
columns use text + CHECK (not Postgres ENUM) to stay cleanly idempotent. **No
routes or kernel code ship in this story** (US-1584 builds the run loop), so
nothing reads these at runtime yet — applying it is safe at any time. Edge boot
guard now expects **00357**.

**⚠️ Apply order:** apply after 00353→00356 (all held above). `NOTIFY pgrst,
'reload schema';` after applying (new tables PostgREST would otherwise not know
of — harmless here since the SPA never reads them, but keeps the runbook
uniform). Redeploy the edge so its boot guard matches 00357.

## ⏳ HELD: 00356_public_cert_moderation_withhold.sql (US-1654 / DB-P2, 2026-07-04)

**What:** `CREATE OR REPLACE VIEW public_grade_reports` reproducing every 00318
column verbatim, plus a LEFT JOIN to `submissions` and a WHERE predicate that
mirrors `isCertificateWithheld` (excludes `status='pending_review'`, and flagged
submissions unless `moderation_status='approved'`). Closes the bypass where a
finalized-then-flagged certificate stayed readable via PostgREST / the SPA
`/cert/:id` even though the edge endpoints 404 it. Self-records '00356'.

**Risk: LOW — output columns UNCHANGED (only the row set narrows); no client
projection change; no data change.** The view runs as its owner (bypasses the
underlying RLS exactly as the existing view already does for grade_reports), so
the submissions join needs no new grant. Edge boot guard now expects **00356**.

**⚠️ Apply order:** apply after 00353/00354/00355. `NOTIFY pgrst, 'reload
schema';` after applying (the view definition changed). Redeploy the edge so its
boot guard matches 00356. No client code depends on the change (it only stops
withheld rows appearing) — so applying it is safe at any time; do it before
merging so the SPA `/cert/:id` stops rendering withheld grades.

## ⏳ HELD: 00355_dispute_admin_alerted_at.sql (US-1652, 2026-07-04)

**What:** `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS admin_alerted_at
timestamptz`. The dedup gate for the dispute-filed admin alert — the handler
claims it with a race-safe conditional UPDATE (`WHERE admin_alerted_at IS NULL`)
so the alert fires at most once per dispute. Self-records '00355'.

**Risk: LOW — additive nullable column; no client reads.** No backfill (NULL =
"never alerted", correct for existing open disputes). Edge boot guard now expects
**00355**.

**⚠️ Apply order:** apply after 00353/00354. The edge code reads/writes
`admin_alerted_at` at RUNTIME only when `/dispute-filed` is called — an update
targeting a missing column would 42703-fail that request, so apply 00355 before
this edge build deploys. `NOTIFY pgrst, 'reload schema';` after applying (a new
column PostgREST must expose). Redeploy the edge so its boot guard matches 00355.

## ⏳ HELD: 00354_dead_letter_googleplay_provider.sql (US-1650 / C6, 2026-07-04)

**What:** extends the `webhook_dead_letters.provider` CHECK allow-list to include
`'googleplay'` (was `stripe`/`ebay`/`appstore`/`content`), so the new Google Play
RTDN webhook (`routes/google-play-rtdn.ts`) can durably dead-letter a
non-transient failure like every other provider. `DROP CONSTRAINT IF EXISTS` +
re-`ADD` (mirrors 00206); self-records '00354'.

**Risk: LOW — no client-side reads; constraint-only.** No column/view/data
change. The edge boot guard now expects **00354**.

**⚠️ Apply order:** apply 00353 first (already held below), then 00354. After
applying, redeploy the edge so its boot guard matches 00354. No `NOTIFY pgrst`
needed. The RTDN webhook only reconciles at RUNTIME when Google delivers a
notification, so nothing breaks pre-apply — but its dead-letter path would fail
the CHECK until 00354 is applied, so apply it before enabling the Pub/Sub push.

Also set `GOOGLE_RTDN_WEBHOOK_SECRET` on the edge and configure the Pub/Sub push
endpoint as `…/api/webhooks/google-play?token=<that secret>`.

## ⏳ HELD: 00353_google_purchase_token_unique.sql (US-1614 / C1, 2026-07-04)

**What:** a partial unique index
`idx_users_google_purchase_token ON users(google_purchase_token) WHERE google_purchase_token IS NOT NULL`.
The DB backstop for binding a Google Play subscription purchaseToken to exactly
one account (the edge verify path now also requires a matching
`obfuscatedExternalAccountId` and refuses a token already claimed on another
user's row).

Idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`); self-records '00353'.

**Risk: LOW — no client-side reads of new schema.** Purely an index; no column
or view change. Edge boot guard expects 00353.

**⚠️ Apply caveat:** if prod already has duplicate `google_purchase_token`
values (the C1 exploit was used before this shipped), the index creation will
FAIL — that's the correct signal to investigate/de-dupe first. Google Play
billing is pre-launch, so no legitimate duplicates are expected. No
`NOTIFY pgrst` needed (no schema surface change), but redeploy the edge so its
boot guard matches 00353.

## ⏳ HELD: 00349_draft_review_lifecycle.sql (US-1568/US-1569, 2026-07-03)

**What:** two changes in one transaction:

1. `listings.reviewed_at timestamptz` — the "a human reviewed this draft"
   marker (composer Save + bulk-edit save set it; regeneration clears it; the
   AutoLister drafts cockpit filters `reviewed_at IS NULL`).
2. `items_full` view recreated with three appended columns:
   `listing_needs_review`, `listing_reviewed_at`, `listing_title`
   (every pre-existing column reproduced in its exact 00306 position).

Idempotent (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW); self-records
'00349'.

**Risk: MEDIUM — ⚠️ CLIENT-SIDE READS.** This commit's frontend:

- selects the three NEW view columns in the inventory table projection
  (`LISTINGS_COLUMNS` in listings.tsx) → the whole Inventory table (all tabs)
  **400s** the moment Cloudflare Pages auto-deploys, until 00349 is applied;
- filters the AutoLister drafts cockpit on `reviewed_at` → that page **400s**
  too;
- the composer/bulk-edit save writes `reviewed_at` → **saves fail**.

**Apply 00349 (after 00346–00348) BEFORE OKing the push.** Then
`NOTIFY pgrst, 'reload schema';` (REQUIRED here — new column + view) and
redeploy the edge (boot guard expects 00349).

## ⏳ HELD: 00348_autolister_carryover_backfill.sql (US-1567, 2026-07-03)

**What:** DML-only backfill (no schema change) repairing EXISTING AI-generated
AutoLister items whose Brand/Size/Color/Material/Style, attributes, title, and
description never carried from the aspect stores onto the item's own columns:

1. Fills blank `inventory_items.size/color/material/style` from
   `ebay_aspects` (Size / US Shoe Size / Color / Colour / Material / Type…).
2. Fill-only merge of attributes jsonb keys (department, size_type, pattern,
   fit, sleeve_length, features…) from the matching aspects.
3. Adopts the newest AutoLister draft's `listing_title` when the item still
   holds the "Item N"/"Untitled"/blank placeholder (mirrors
   shouldAdoptGeneratedTitle), and the draft description when the item has none.

STRICTLY FILL-ONLY: seller-typed values are never overwritten. Idempotent —
re-running changes nothing. Self-records '00348'.

**Risk: LOW.** Pure data fill on existing columns; no DDL, no enum, no RLS.
The paired edge change (`aspectCarryOver` in ai-listing.ts, EXPECTED_SCHEMA_VERSION
→ 00348) handles all FUTURE generations and only writes columns that already
exist — nothing client-side reads a new column, so the frontend auto-deploy is
safe even before this is applied; the backfill just makes OLD drafts whole.

**Apply order:** after 00346–00347. Then `NOTIFY pgrst, 'reload schema';`
(harmless for DML-only, keeps the runbook uniform) and redeploy the edge
(boot guard expects 00348).

## ⏳ HELD: 00352_measure_corrections.sql (US-1580, 2026-07-03)

**What:** `measure_corrections` operator table (correction-delta telemetry:
class/key/proposed/final/delta/confidence — no photo content; deny-all RLS,
service-role only). Idempotent; self-records '00352'.

**Risk: LOW** (new deny-all table). Client reads nothing; the editor posts to
the edge (boot-guarded on 00352). Apply after 00351, then
`NOTIFY pgrst, 'reload schema';`.

---

## ⏳ HELD: 00351_measure_card_requests.sql (US-1579, 2026-07-03)

**What:** `measure_card_requests` operator table (mailed-card fulfillment
queue; deny-all RLS, service-role only, owner_user_id convention; partial
unique index = one active request/seller) + `users.measure_card_version` /
`users.measure_card_source` profile columns. Idempotent; self-records '00351'.

**Risk: LOW** (new table + nullable user columns). Client reads NOTHING new
directly — the tools page talks to the edge (card-request routes boot-guarded
on 00351). Apply after 00350, then `NOTIFY pgrst, 'reload schema';`.

---

## ⏳ HELD: 00350_measurement_overlay_photo_type.sql (US-1577, 2026-07-03)

**What:** `ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_overlay';`
— the GENERATED card-free annotated measurements photo (listing-eligible,
never primary). Idempotent; self-records '00350'.

**Risk: LOW.** Client-side reads: the web photo pickers list the new type the
moment the frontend deploys — retagging a photo TO it 400s until applied
(same class as 00346). Edge writes it only post-boot-guard (version 00350).
NOTE: Ralph's 00348 (carry-over backfill) + 00349 (draft review lifecycle)
sit between — apply 00346 → 00350 IN ORDER, then NOTIFY pgrst.

---

## ⏳ HELD: 00347_measure_calibration.sql (US-1572, 2026-07-03)

**What:** `ALTER TABLE public.item_photos ADD COLUMN IF NOT EXISTS measure_calibration jsonb;`
— persisted MeasureCard calibration (homography/ppi/quality) so the editor
never re-runs detection. Idempotent; self-records '00347'.

**Risk: LOW** (nullable column add). Client-side reads: none yet — only the
edge writes/reads it (POST /api/flipdesk/measure/calibrate), and the edge
boot-guards on 00347 via EXPECTED_SCHEMA_VERSION in the same commit. Apply
together with 00346, then `NOTIFY pgrst, 'reload schema';`.

---

## ⏳ HELD: 00346_measurement_photo_type.sql (US-1571, 2026-07-03)

**What:** `ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement';`
— the MeasureCard calibration-frame photo tag for the photo-measurement
pipeline (US-1570..1580). Idempotent; self-records '00346'.

**Risk: LOW** (single enum value add). But note the CLIENT-SIDE read:

- ⚠️ The same commit ships web UI that lets a seller TAG a photo
  `measurement` (photo-manager retag picker, AutoLister role picker). The
  moment this commit reaches origin, Cloudflare Pages auto-deploys — and
  picking "Measurement card (not listed)" 400s ("invalid input value for
  enum") until 00346 is applied to prod. **Apply 00346 BEFORE OKing the push.**
- The edge in this commit bumps `EXPECTED_SCHEMA_VERSION` to 00346 and adds
  two SQL-side `.neq("photo_type","measurement")` filters — safe because the
  boot guard holds the edge redeploy behind the applied migration.

**Apply order:** ensure 00343→00345 are applied first (see below / prior
sessions), then 00346, then `NOTIFY pgrst, 'reload schema';`. All idempotent —
re-running the tail is safe. Edge redeploy afterward at your convenience.

---

> ## 🚨 STATUS CHANGE 2026-07-02 22:19 CT — THE HELD COMMITS WERE PUSHED
>
> A `git pull` + push from this machine (user or the concurrent agent — reflog
> shows the pull at 22:19:14; I did not push) landed EVERYTHING on origin/main,
> including migrations **00339–00342**. Consequences RIGHT NOW:
>
> 1. **Cloudflare Pages auto-deployed the new frontend.** The web AutoLister
>    generate() inserts `item_photos.original_filename` (00339) — that column
>    does not exist on prod yet, so **AutoLister generation 400s in prod until
>    00339 is applied**. The "Internal (not listed)" photo type (00340) also
>    400s if a seller picks it.
> 2. **The edge is NOT redeployed** (manual Coolify), so 00341/00342 aren't
>    load-bearing yet — but the NEXT edge redeploy boot-guards on **00342**.
>
> **Fix (5 minutes, all idempotent):** apply 00339 → 00342 to prod
> (`scripts/apply-prod-migrations.sh` or run the four files in order), then
> `NOTIFY pgrst, 'reload schema';`. Then the edge can be redeployed whenever.

## 📌 CURRENT STATE — 2026-07-02 (bulk-intake epic session)

### 🔸 NEW + HELD LOCALLY (not pushed): `00339` (US-1539)

**`supabase/migrations/00339_item_photos_provenance.sql`** — adds nullable
`item_photos.original_filename text` (+ a belt-and-suspenders
`captured_at timestamptz`, which most DBs already have from 00066). Idempotent
(`ADD COLUMN IF NOT EXISTS`), self-record footer, `EXPECTED_SCHEMA_VERSION`
bumped **00338 → 00339** in the same commit. Apply to prod +
`NOTIFY pgrst, 'reload schema';` BEFORE the edge redeploy that follows the next
push (its boot guard will expect 00339). Low-risk: nullable columns, no code
reads them server-side yet — the web AutoLister writes them at generate().
**Per the standing rule, the commit carrying 00339 stays local until you apply
it and say "OK to push".**

### 🔸 ALSO NEW + HELD LOCALLY: `00340` (US-1549, user-requested)

**`supabase/migrations/00340_internal_photo_type.sql`** — `ALTER TYPE
flipdesk_photo_type ADD VALUE IF NOT EXISTS 'internal'` (seller-reference
photos: kept with the item, never sent to eBay/AI/public — enforcement is
edge-side code). `EXPECTED_SCHEMA_VERSION` bumped **00339 → 00340**. Apply with
00339 (both idempotent, any order), `NOTIFY pgrst, 'reload schema';`, then the
edge redeploy (boot guard expects 00340). Zero-risk: pure enum addition —
nothing reads the value until clients send it.

### 🔸 ALSO NEW + HELD LOCALLY: 00341 (US-1533)

**supabase/migrations/00341_garment_baselines.sql** - new garment_baselines table
(operator knowledge cache for grading expectation briefs; deny-all RLS, service-role
only). EXPECTED_SCHEMA_VERSION bumped **00340 -> 00341**. Apply with 00339+00340
(all idempotent), NOTIFY pgrst, then the edge redeploy. Zero-risk: new empty table;
the pipeline feature is OFF until you set GRADING_BASELINES=1 on the edge.

### 🔸 ALSO NEW + HELD LOCALLY: 00342 (US-1536)

**supabase/migrations/00342_peer_norm_indexes.sql** - two plain btree indexes
(submissions.garment_category + human_reviews.grade_report_id) supporting the
peer-norm sanity-check scan. EXPECTED_SCHEMA_VERSION bumped **00341 -> 00342**.
Apply with 00339-00341 (all idempotent), NOTIFY pgrst, then the edge redeploy.
Zero-risk: pure index additions.

### 🔸 ALSO NEW + HELD LOCALLY: `00343` (US-1560)

**`supabase/migrations/00343_rbac_router_scopes.sql`** — seeds the four new
RBAC scope families (ops/marketplace/support/growth:write) into
permission_scopes + grants all four to the `admin` role, so the new
requireScope() enforcement across all 48 admin routers lands with ZERO
behavior change. `EXPECTED_SCHEMA_VERSION` bumped **00342 → 00343**.
⚠️ MUST apply before the edge redeploy that carries this commit — an edge
build enforcing the new scopes against an unseeded DB would 403 admins on the
newly-guarded surfaces (the boot guard enforces this ordering mechanically).

### 🔸 ALSO NEW + HELD LOCALLY: `00344` (US-1565)

**`supabase/migrations/00344_admin_tasks_service_role_only.sql`** — drops the
12 admin client RLS policies on `admin_task_projects` / `admin_tasks` /
`admin_task_comments` (task-board CRUD now flows through the new
`/api/admin/tasks` edge router; deny-all + service-role only, registered in
rls-guard). `EXPECTED_SCHEMA_VERSION` bumped **00343 → 00344**.
⚠️ Ordering: apply WITH/AFTER 00343 and before the edge redeploy carrying this
commit. Note the frontend on Pages auto-deploys on push — after this push the
tasks/dashboard/system pages REQUIRE the new edge routes, so redeploy the edge
promptly after pushing.

### 🔸 ALSO NEW + HELD LOCALLY: `00345` (US-1421 code slice)

**`supabase/migrations/00345_negotiation_access_denied.sql`** — adds
`marketplace_connections.negotiation_access_denied` (mirrors
analytics_access_denied): set when a /sell/negotiation call 403s although the
deployment requests the scope (token predates the grant → reconnect required),
cleared on any successful negotiation call. `EXPECTED_SCHEMA_VERSION`
**00344 → 00345**. Additive column; no ordering hazard beyond apply-before-
edge-redeploy.

### Previously outstanding — apply to prod (already on origin)

Everything through migration **00338** is already ON `origin/main` (0230db73 was
pushed). What's outstanding is **applying to prod**, not pushing:

- **`00338_listings_marketplace_connection_id.sql`** (US-1507) — nullable
  `listings.marketplace_connection_id` FK + partial index; idempotent + self-record
  footer; `EXPECTED_SCHEMA_VERSION` is at **00338**. Legacy rows stay null (edge
  falls back to the primary connection). Safe to apply any time; MUST be applied
  before the next edge redeploy (boot guard expects 00338).
- If `00332`–`00337` haven't been applied yet either, apply them first — every
  migration is idempotent, so the simplest path is `scripts/apply-prod-migrations.sh`
  (or run 00332→00338 in order), then `NOTIFY pgrst, 'reload schema';`, then
  redeploy the edge.

**Held locally (NOT pushed):** 17e8b614 (autolister watchdogs) + this session's
US-1507/1509 completion commit — both code-only, no new migration. They stay local
until you apply 00338 (+ any earlier stragglers) and say "OK to push".

---

> Running package for the pre-launch loop. As of the latest push (af1b3d74), local main == origin/main and ALL committed stories are code-only (no migrations). Future migrations will be listed here for you to apply before the next push. At
> check-in, apply any migrations below to prod (DB → edge → frontend order per
> DEPLOY.md), redeploy the edge (Coolify), then give the OK to `git push`.

## 🔸 HELD (commit-only loop — NOT pushed): `00334` (US-1531)

**`supabase/migrations/00334_ai_enrichment_corrected_fields.sql`** — adds
`ai_enrichment_log.corrected_fields jsonb NOT NULL DEFAULT '{}'` (idempotent,
`ADD COLUMN IF NOT EXISTS`). `EXPECTED_SCHEMA_VERSION` bumped **00333 → 00334**.
Apply to prod (idempotent) + `NOTIFY pgrst, 'reload schema';` BEFORE pushing the
held US-1531 commit. No code reads the column yet (foundation chunk), so applying
it early is harmless.

---

## How to apply

1. Apply each migration SQL below to prod in listed order (they're idempotent).
   Or run `scripts/apply-prod-migrations.sh` if you prefer the scripted path.
2. Redeploy the edge service on Coolify so `EXPECTED_SCHEMA_VERSION` matches.
3. `NOTIFY pgrst, 'reload schema';` if any table/column/RPC changed.
4. Tell me "OK to push" — I'll `git push origin main`.

---

## ⚠️ STATUS UPDATE — commits PUSHED; migrations still must be APPLIED to prod

`origin/main` now includes US-1515 (`00332`) + US-1524 (`00333`). **Pushing to git
is NOT the same as applying the SQL to prod.** No immediate breakage from the push
alone (the edge only re-reads the schema version on a Coolify redeploy, and the new
iOS build isn't released yet) — BUT you must apply `00332` + `00333` to prod BEFORE:
• redeploying the edge (its boot guard now expects `00333`; DB at `00331` →
schema-guard failure after the ~40s grace window), and
• releasing the new iOS build (US-1515 queries `updated_at` on sales/item_photos;
missing column → PostgREST 400 on those syncs).
• To fix the **Tag-rotation 400 now**, apply `00333` (independent of `00332`).

Apply order + steps below. Once applied, tell me and I'll push the remaining
code-only commit (US-1494).

---

## Original packaging note (apply `00332` then `00333`)

Apply IN ORDER (both idempotent, both end with the `applied_migrations` footer).
`EXPECTED_SCHEMA_VERSION` is bumped **00331 → 00333** (edge `schema-version.ts`).

**1. `supabase/migrations/00332_sales_item_photos_updated_at.sql`** (US-1515) —
adds `updated_at` (+ `set_updated_at` trigger + backfill + delta index) to
`public.sales` and `public.item_photos` so the iOS sync can delta them on EDITS.

**2. `supabase/migrations/00333_submission_images_owner_update.sql`** (US-1524) —
adds the missing per-user-folder UPDATE RLS policies (owner + workspace member) on
`storage.objects` for the private `submission-images` bucket. FIXES the reported
bug: rotating a **Tag / Certificate** photo returned HTTP 400 because the rotate
re-upload (`x-upsert`) is an UPDATE and that bucket had no UPDATE policy (only
INSERT/SELECT/DELETE). Public `item-photos` rotates fine (it has UPDATE).

**To apply (before I push the held commits):**

1. Apply `00332` then `00333` to prod — `scripts/apply-prod-migrations.sh` or run
   the SQL directly, in order.
2. `NOTIFY pgrst, 'reload schema';` (00332 adds columns).
3. Redeploy the edge (Coolify) so its boot guard sees `00333`.
4. Tell me "OK to push" — I'll push the held commits.

The US-1515 + US-1524 commits are **held locally, NOT pushed** until you apply
these — US-1515's iOS code queries `updated_at` (must exist first), and 00333 is a
pure prod-RLS fix (no code depends on it, but keep the schema-version in lockstep).

---

| US-1494 (iOS expense date integrity) | none | none | (held behind 00332/00333)

### Earlier stories this loop — code-only (already pushed, no schema changes)

| Story                                       | Migration? | Schema bump? |
| ------------------------------------------- | ---------- | ------------ |
| US-1505 (eBay specifics string[] normalize) | none       | none         |
| US-1506 (End-listing truthfulness)          | none       | none         |
| US-1502 (grade → live eBay listing)         | none       | none         |
| US-1503 (measurements → live listing)       | none       | none         |
| US-1504 (price coherence)                   | none       | none         |
| US-1518 (photo thumbnail tier — edge job)   | none       | none         |
| US-1522 (iOS UX dead-end sweep, 8 fixes)    | none       | none         |
| US-1521 (iOS auth/signup polish)            | none       | none         |
| US-1516 (iOS member-tenant item write)      | none       | none         |
| US-1514 (iOS stale-read gating)             | none       | none         |

`EXPECTED_SCHEMA_VERSION` unchanged at **00331**; latest migration file is
`00331_fix_users_guard_bogus_moderation_cols.sql`. Next migration, when one is
needed, is `00332`.

_This file is updated as the loop progresses — check it at every check-in._
