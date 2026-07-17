-- US-1981: Luxury outerwear & down brand knowledge group (6 brands).
--
-- Moncler, Canada Goose, Mackage, Herno, Woolrich, Bogner — the high-value
-- down/outerwear tier. All six were PASSTHROUGH-ONLY before this (none had a
-- brand_knowledge row, an alias, or a chart), so a "moncler" tag rendered the
-- seller's own casing into the prompt block and the eBay Brand aspect.
--
-- ── THE SIZE IS A NUMBER IN A SYSTEM THE TAG DOES NOT NAME ──────────────────
-- The through-line, and the reason this group is worth more than its style
-- fingerprints. FOUR of the six size in a system the garment never identifies:
--   * MONCLER sizes 0-5 — its OWN proprietary scale, not US, not EU, not alpha.
--     A women's Moncler tagged "2" is a US 6-8 / M. A seller who reads "2" and
--     lists a US 2 has listed an XS-labelled M — off by THREE US sizes.
--   * HERNO is ITALIAN-sized: a men's "50" is IT 50 = US 40 / L, not a US 50.
--   * BOGNER is GERMAN-sized: a women's "38" is DE 38 = US 8, not a US 38.
--   * WOOLRICH's Italian-era pieces carry EU sizing while its US-mill heritage
--     wool carries US alpha — the SAME brand, two systems, decided by era.
-- This is the footwear (00459) trap on a garment: the number is real, the photo
-- does not contradict it, and the mistake is a WRONG LISTING rather than a
-- pricing refinement. So the cross-map is written INTO the size LABEL of every
-- chart, which is the only uncapped channel that reaches the model.
--
-- ── AUTHENTICATION TELLS ARE INFORMATIONAL — NEVER AUTO-AUTHENTICATE ────────
-- This is the most counterfeited tier the KB has seeded, and it is the tier where
-- a confident wrong answer costs the most. Moncler ships a QR ("Moncler Code")
-- and Canada Goose a holographic disc — both are MANUFACTURER-side verification
-- services, and neither is evidence WE can act on: a scannable QR or a rainbow
-- hologram is exactly what a competent counterfeit reproduces. Every tell here is
-- seeded as a description/consistency aid that routes to human review. The pack
-- must never emit an authentic/fake verdict.
--
-- ── ONE DECODER — CANADA GOOSE, AND ONLY IT QUALIFIES ───────────────────────
-- The bar (US-1736/US-1740) is tag-printed AND regular AND brand-unique in FORMAT.
-- Canada Goose prints a style number on the interior care label as 4 digits + a
-- department letter (4660MA Expedition, 7950M Chilliwack, 2506L Kensington) — a
-- compound distinctive enough to anchor on, like the LV SD1160 precedent.
-- Everything else in the group FAILS the format leg and is deliberately
-- decoder-less: Moncler's serial and Canada Goose's hologram number are BARE
-- DIGIT RUNS (the Chanel rule — a pattern over one mints the KB's costliest false
-- positive from any tag with 8 digits), and the Herno/Mackage/Woolrich/Bogner
-- article numbers are catalog SKUs whose format is not brand-unique. Those facts
-- live in tag_eras/authentication_tells, which is where they belong anyway.
--
-- Data-only, idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
-- All six are NEW rows — none had even a bare alias-only row from 00389.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  ('moncler', 'Moncler', ARRAY['moncler','moncler grenoble','monclergrenoble','moncler genius','moncler enfant','moncler maya']::text[],
   ARRAY['luxury','outerwear','down','puffer','ski','mens','womens']::text[],
   $j$[{"era":"Woven tricolour tag + hologram label","years":"c.2000s-2015","description":"Interior woven tricolour (blue-white-red) branding plus a holographic label carrying a serial. An older Moncler shows this generation rather than a QR."},{"era":"Moncler Code (QR label)","years":"c.2016-present","description":"A sewn-in QR label (the 'Moncler Code') the OWNER can scan on Moncler's site to run the brand's own verification. Its PRESENCE dates a piece to roughly 2016+; its scanning is NOT proof of authenticity to us — the label is reproducible and the check is Moncler's service, not ours."}]$j$::jsonb,
   $j$[{"pattern":"Made in Moldova / Romania / Hungary / Bulgaria / Italy","note":"Moncler is an ITALIAN company (Milan) whose down outerwear is largely sewn in Eastern Europe — Made in Moldova or Made in Romania is COMPLETELY NORMAL on a genuine Moncler and is one of the most common false 'fake' calls made by sellers. Country of origin is NOT an authenticity signal here."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate — a QR that scans is not proof","detail":"Moncler is among the most counterfeited outerwear brands on earth. The Moncler Code QR and the older hologram are MANUFACTURER-side services; a competent fake reproduces both, and we cannot verify a scan result. Describe what is present, flag inconsistencies in condition_notes, and route authenticity to human review. Never emit an authentic/fake verdict."},{"tell":"THE SIZE IS 0-5 AND IT IS MONCLER'S OWN SCALE","detail":"Moncler sizes its outerwear 0,1,2,3,4,5 — not US, not EU, not alpha. 0=XS, 1=S, 2=M, 3=L, 4=XL, 5=XXL. A women's piece tagged 2 is a US 6-8, NOT a US 2. This is the single most valuable Moncler listing fact and the most common mis-listing on the brand."},{"tell":"The tricolour flag patch on the LEFT SLEEVE","detail":"The blue-white-red rooster/flag patch sits on the upper left sleeve on most outerwear. It is the fastest Moncler read on an unlabelled photo — a description aid, not an authentication proof."},{"tell":"Made in Moldova is NORMAL","detail":"The most common false counterfeit call on this brand. Moncler is Italian-owned but sews in Eastern Europe; an origin tag reading Moldova/Romania/Hungary does not impugn a garment."}]$j$::jsonb,
   'Moncler identity = the glossy nylon laqué down jacket + the tricolour sleeve patch, sized on Moncler''s OWN 0-5 scale (the group''s headline trap). Founded 1952 at Monestier-de-Clermont, France (MONCLER = MONestier-de-CLERmont) by René Ramillon; now an ITALIAN company headquartered in Milan after Remo Ruffini acquired it in 2003. Moncler S.p.A. also owns Stone Island (acquired 2020), so a shared corporate parent is not a counterfeit signal. Lines: Grenoble (technical ski), Genius (numbered designer collaborations, 2018+), Enfant (kids). NO DECODER — the serial is a bare digit run and a pattern over it would mint a false positive from any tag with a long number. RN omitted — not sourceable.',
   'https://www.moncler.com/en-us/moncler-code.html', 0.75, false, 'migration:00460'),

  -- NOTE: a bare "goose" is deliberately NOT an alias — it is an ordinary word
  -- (and a different brand's name), and mapping it would rebrand anything tagged
  -- "goose down". Same rule as L.L.Bean's "bean" in 00453.
  ('canadagoose', 'Canada Goose', ARRAY['canada goose','canadagoose','canada goose inc','snow goose','metro sportswear']::text[],
   ARRAY['luxury','outerwear','down','parka','arctic','mens','womens']::text[],
   $j$[{"era":"Metro Sportswear / Snow Goose","years":"1957-1990s","description":"Founded as Metro Sportswear; the consumer label was SNOW GOOSE before the brand became Canada Goose for export (the Snow Goose name was already taken in Europe). A Snow Goose label is a genuinely early piece."},{"era":"Pre-hologram","years":"pre-2011","description":"No holographic disc. Its ABSENCE on an older parka is expected and is not a fake tell — this is a common false counterfeit call."},{"era":"Holographic disc label","years":"c.2011-present","description":"A holographic disc bearing the maple-leaf mark was added to fight counterfeits. Its presence dates a piece to roughly 2011+; it is NOT proof of authenticity to us."},{"era":"Fur-free","years":"2022-present","description":"Canada Goose stopped buying fur in 2021 and went fur-free by end of 2022. A REAL COYOTE RUFF therefore dates a parka to the earlier era — and is resale-relevant beyond dating: real fur is restricted or banned in some jurisdictions and on some marketplaces, so the ruff material must be stated, not assumed."}]$j$::jsonb,
   $j$[{"pattern":"Made in Canada (most parkas) / imported (some lighter styles)","note":"Canadian manufacture is a CORE brand claim and most heavyweight parkas are genuinely made in Canada — unusually for this KB, origin carries real signal here. But it is not absolute: lighter/knit styles are made offshore, so an imported tag is not automatically a fake. Treat a Made in Canada tag as consistent-with-genuine, never as proof."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate — the hologram is not proof","detail":"Canada Goose is heavily counterfeited and the holographic disc is reproduced by fakes. It is a manufacturer-side device we cannot verify. Route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE STYLE NUMBER IS ON THE CARE LABEL AND IT NAMES THE MODEL","detail":"4 digits + a department letter: M = men's, L = ladies' (4660MA = Expedition, 7950M = Chilliwack Bomber, 2506L = Kensington). It is the only regular, brand-unique, tag-printed code in this group and the only one that gets a decoder — a cut-off brand tag can still be recovered from it."},{"tell":"REAL COYOTE FUR vs fur-free — state which","detail":"Fur-free since end of 2022; earlier parkas have a real coyote ruff. Real fur is restricted on some marketplaces and in some jurisdictions, so the ruff material is a LISTING COMPLIANCE fact, not just a dating one. Never assume — say which is present, and note if the ruff is detachable or missing (it materially affects value)."},{"tell":"TEI rates the warmth 1-5","detail":"The Thermal Experience Index is Canada Goose's own 1-5 warmth scale (5 = Extreme Weather, e.g. the Expedition). It is brand-unique vocabulary worth carrying into a listing, and it separates models a photo makes look alike."}]$j$::jsonb,
   'Canada Goose identity = the model (Expedition / Chilliwack / Kensington) + the arm-patch disc, with the STYLE NUMBER on the care label naming the model outright. Founded 1957 in Toronto as Metro Sportswear by Sam Tick; the Snow Goose label became Canada Goose for export; Dani Reiss (Tick''s grandson) led its luxury turn. Warmth is rated on the brand''s own TEI 1-5 scale. Fur-free since end-2022 — an earlier parka has a real coyote ruff, which is a marketplace-compliance fact. The ONLY brand in this group with a decoder (the 4-digit + M/L style number); the hologram number is a bare digit run and is deliberately NOT decoded. RN omitted — not sourceable.',
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.75, false, 'migration:00460'),

  ('mackage', 'Mackage', ARRAY['mackage','mackage inc']::text[],
   ARRAY['luxury','outerwear','down','leather','parka','mens','womens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Imported","note":"Mackage manufactures offshore; country of origin is not an authentication signal on this brand."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"No published Mackage authentication standard, serial or date code exists that could prove authenticity programmatically. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"HARDWARE IS THE MACKAGE SIGNATURE — and it is what breaks","detail":"Oversized branded zip pulls, leather-trimmed plackets and a belted waist define the look. It is also the highest-value CONDITION call on the brand: a missing belt, a stripped branded pull or a detached fur hood trim are the failures that actually move the price, and each is visible in a photo. Check for the belt before listing — it is a separate piece and it goes missing."},{"tell":"DOWN vs LEATHER are two different price ladders","detail":"Mackage runs a down-outerwear line and a leather line under one label. They comp differently and are not interchangeable — say which the garment is; a photo of a black belted coat does not settle it."},{"tell":"Montreal brand, not a fur house","detail":"Founded 1999 in Montreal. Hood trims may be real fur, faux fur or removable — state which, since real fur is restricted on some marketplaces. Do not assume from the silhouette."}]$j$::jsonb,
   'Mackage identity = luxury Canadian outerwear defined by HARDWARE (oversized branded pulls, leather trim, a belted waist) across two ladders: down and leather. Founded 1999 in Montreal by Eran Elfassy and Elisa Dahan. Sizes ALPHA (XS-XXL) — the one brand in this group that does NOT hide its size system, which is why its chart is the plain-reading control case for the pack. NO DECODER — the article number is a catalog SKU, not a brand-unique format. RN omitted — not sourceable.',
   'https://www.mackage.com/pages/about-us', 0.65, false, 'migration:00460'),

  ('herno', 'Herno', ARRAY['herno','herno laminar','hernolaminar','herno spa']::text[],
   ARRAY['luxury','outerwear','down','rainwear','technical','italian','mens','womens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in Italy","note":"Herno manufactures in Italy (Lesa, on Lake Maggiore) and Made in Italy is EXPECTED on the label — unusually for this KB, its absence is worth a second look rather than its presence. Still not an authentication verdict on its own."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"No published Herno authentication standard, serial or date code exists. Counterfeiting is not the main risk on this brand — the ITALIAN SIZE misread is. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE SIZE IS ITALIAN AND THE TAG DOES NOT SAY SO","detail":"A men's Herno tagged 50 is an IT 50 = US 40 / L. A women's tagged 42 is an IT 42 = US 6 / M. The garment does not print 'IT' anywhere. A seller who reads the number as a US size lists a garment that is nowhere near what arrives — the highest-value Herno fact by a wide margin."},{"tell":"LAMINAR is the technical line and it is a wordmark","detail":"Herno Laminar is the GORE-TEX/laminated technical line and it is printed on the tag — read the LINE off the garment rather than inferring it. Laminar pieces have bonded/taped seams and no visible face stitching, and they comp above the classic line."},{"tell":"The ultralight down is the volume item","detail":"Herno's reputation is the ultralight, packable down/rain-resistant jacket — a very thin nylon shell with fine horizontal baffles. Its weight and packability are the corroborating checks."}]$j$::jsonb,
   'Herno identity = Italian technical outerwear — the ultralight down jacket and the laminated LAMINAR (Gore-Tex) line — sized in ITALIAN numbers the tag never labels as such. Founded 1948 in Lesa, Italy by Giuseppe Marenzi, named for the local Erno river; still family-run (Claudio Marenzi) and still made in Italy. Read the LINE (Laminar vs classic) off the tag wordmark. NO DECODER — the article number is a catalog SKU, not a brand-unique format. RN omitted — not sourceable.',
   'https://www.herno.com/us/experience/about-us', 0.65, false, 'migration:00460'),

  ('woolrich', 'Woolrich', ARRAY['woolrich','woolrich john rich & bros','woolrich john rich and bros','john rich & bros','woolrich woolen mills','woolrich international']::text[],
   ARRAY['heritage','outerwear','down','parka','wool','americana','mens','womens']::text[],
   $j$[{"era":"US mill / Made in USA wool","years":"1830-2018","description":"Woolrich, Pennsylvania — the original mill and the LAST woolen mill in the United States. It CLOSED IN 2018. A Made-in-USA Woolrich wool shirt or blanket therefore cannot be newer than 2018 and skews heritage/collectible. This is the cleanest date boundary on the brand."},{"era":"Italian-era outerwear","years":"c.2010s-present","description":"The brand is now run out of Italy (Woolrich International / WP Lavori in Corso, Bologna), where the Arctic Parka became a European status coat. Italian-era pieces are imported and may carry EU sizing — the SAME brand in a different size system from the US heritage wool."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA (pre-2018 wool) / imported (modern outerwear)","note":"The origin tag means OPPOSITE things by product and era. Made in USA is expected on the heritage wool (and impossible after the 2018 mill closure); the modern Italian-era outerwear is imported and that is normal. This is why origin is recorded per-era rather than brand-wide."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"No published Woolrich authentication standard, serial or date code. The real risk on this brand is ERA MISATTRIBUTION, not counterfeiting. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"TWO WOOLRICHES UNDER ONE NAME — this is the whole brand call","detail":"The American heritage mill (Buffalo Check wool, Pennsylvania, Made in USA, closed 2018) and the Italian-era outerwear house (the fur-trimmed Arctic Parka, a European status coat) are the same label and comp on completely different ladders. Read the ERA off the origin tag and the product: a Made-in-USA wool shirt is the heritage brand; an Arctic Parka is the Italian one. Calling one the other is the costliest Woolrich mistake."},{"tell":"MIND THE SIZE SYSTEM — it follows the era","detail":"US heritage wool carries US alpha sizing; Italian-era outerwear may carry EU sizing on the same label. One brand, two systems, decided by era — so confirm which before trusting the tag."},{"tell":"The Buffalo Check is the icon and it is claimed constantly","detail":"The red/black Buffalo Check dates to 1850 and is the brand's signature — it is also the most imitated plaid in America. A red-and-black plaid is NOT automatically a Woolrich; the label decides, never the pattern."}]$j$::jsonb,
   'Woolrich identity = which WOOLRICH it is — the American heritage mill (Buffalo Check wool, Made in USA, mill closed 2018) or the Italian-era outerwear house (the Arctic Parka). Founded 1830 in Woolrich, Pennsylvania by John Rich; the oldest outdoor clothing company in America and the last US woolen mill until its 2018 closure. Now run from Italy (Woolrich International / WP Lavori in Corso, Bologna). Sub-labels John Rich & Bros and Woolrich Woolen Mills print their own name and are folded onto this canonical — they share the brand''s price band. NO DECODER — the article number is a catalog SKU. RN omitted — not sourceable.',
   'https://www.woolrich.com/us/about-us', 0.65, false, 'migration:00460'),

  ('bogner', 'Bogner', ARRAY['bogner','willy bogner','fire + ice','fire and ice','fireice','bogner fire + ice','bogner fire and ice']::text[],
   ARRAY['luxury','ski','outerwear','down','sportswear','german','mens','womens']::text[],
   $j$[{"era":"Fire + Ice launch","years":"1985-present","description":"The Fire + Ice sub-label (named for Willy Bogner Jr.'s 1986 ski film) launched as the younger, sportier diffusion line. It prints its OWN name — a Fire + Ice tag is Bogner, but it is the diffusion ladder, not mainline."}]$j$::jsonb,
   $j$[{"pattern":"Imported / Made in Europe","note":"Bogner is a German company; production varies by line and era. Country of origin is not an authentication signal on this brand."}]$j$::jsonb,
   $j$[{"tell":"NEVER auto-authenticate","detail":"No published Bogner authentication standard, serial or date code. The risks here are the GERMAN SIZE misread and the mainline/Fire+Ice ladder confusion, not counterfeiting. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict."},{"tell":"THE SIZE IS GERMAN AND THE TAG DOES NOT SAY SO","detail":"A women's Bogner tagged 38 is a DE 38 = US 8. A men's tagged 50 is a DE 50 = US 40 / L. The garment does not print 'DE' or 'EU'. Reading the number as a US size is the most common and most expensive Bogner mis-listing — the highest-value fact on the brand."},{"tell":"FIRE + ICE IS THE DIFFUSION LINE — and it prints its own name","detail":"Fire + Ice (1985, named for the Willy Bogner Jr. film) is the sportier, lower-priced sub-label. A Fire + Ice tag IS Bogner, but titling one as mainline Bogner over-claims the ladder. Read the label, not the silhouette."},{"tell":"Bogner is a SKI house first","detail":"Maria Bogner's 1950s stretch ski pant is the brand's origin — it was so dominant that 'bogners' became an American word for ski pants. Ski technical wear (pants, jackets, suits) is the core and the highest-value resale, not the sportswear."}]$j$::jsonb,
   'Bogner identity = German luxury SKI wear — the stretch ski pant lineage and the "B" mark — sized in GERMAN numbers the tag never labels as such, across two ladders (mainline Bogner and the Fire + Ice diffusion line). Founded 1932 in Munich by Willy Bogner Sr., a ski racer; Maria Bogner''s 1950s stretch ski pant was so dominant that "bogners" became the American word for ski pants. Willy Bogner Jr. — ski racer and filmmaker — later ran the house; Fire + Ice (1985) is named for his film. NO DECODER — the article number is a catalog SKU. RN omitted — not sourceable.',
   'https://www.bogner.com/en-us/about-bogner/', 0.65, false, 'migration:00460')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- The confusable pairs in this group are LINE-vs-LINE (Moncler main vs Grenoble,
-- Bogner vs Fire + Ice, Woolrich US-heritage vs Italian-era) far more than
-- silhouette-vs-silhouette: these are all dark belted/baffled coats and the photo
-- rarely separates them. So each fingerprint leads with what the TAG says.
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('moncler', 'Maya', ARRAY['maya','maya jacket']::text[], 'Men', 'jacket', 'Moncler',
   'THE icon: a SHORT down jacket in glossy nylon laqué with wide horizontal baffles, a zip front under a snap placket and the tricolour patch on the left sleeve. The GLOSS is the tell — nylon laqué is lacquered and reads wet/shiny in a photo, which separates it from Moncler''s matte styles. vs Bady: same lacquered shell and same baffles, so the FABRIC does not separate them — the DEPARTMENT and cut do (Maya is the men''s; Bady is the women''s fitted counterpart). Sized 0-5 like all Moncler outerwear.',
   ARRAY['nylon laqué','goose down']::text[], 'long-running icon', '$1,300-$1,800', ARRAY['maya','down jacket','nylon laque','puffer','tricolour']::text[],
   'https://www.moncler.com/en-us/moncler-code.html', 0.70, false, 'migration:00460'),
  ('moncler', 'Bady', ARRAY['bady','bady jacket']::text[], 'Women', 'jacket', 'Moncler',
   'The women''s fitted short down jacket in the same glossy nylon laqué as the men''s Maya, cut with a nipped waist. Because the SHELL FABRIC is identical to the Maya, the cut/department is the only separator — do not call a Bady a Maya. Sized 0-5 on Moncler''s own scale, so a Bady tagged 2 is a US 6-8.',
   ARRAY['nylon laqué','goose down']::text[], 'long-running icon', '$1,200-$1,700', ARRAY['bady','down jacket','nylon laque','puffer','fitted']::text[],
   'https://www.moncler.com/en-us/moncler-code.html', 0.68, false, 'migration:00460'),
  ('moncler', 'Long Bear', ARRAY['long bear','longbear']::text[], 'Women', 'coat', 'Moncler',
   'The women''s LONG down parka — thigh/knee length with a fur-trimmed hood, in matte rather than lacquered nylon. Length is the separator from the short Maya/Bady family, and it is worth real money: the long coats sit above the short jackets. Confirm whether the hood fur is present and detachable — it is a removable piece and it goes missing.',
   ARRAY['goose down']::text[], 'long-running core', '$1,800-$2,500', ARRAY['long bear','parka','down coat','fur hood']::text[],
   'https://www.moncler.com/en-us/moncler-code.html', 0.62, false, 'migration:00460'),
  ('moncler', 'Grenoble', ARRAY['grenoble','moncler grenoble']::text[], 'Unisex', 'jacket', 'Grenoble',
   'A LINE, not a single garment — Moncler''s technical SKI collection, tagged GRENOBLE in its own right. The tag wordmark is the whole call: Grenoble carries ski features (powder skirt, taped seams, lift-pass pocket, articulated hood) and comps ABOVE mainline Moncler outerwear. Read the line off the label; a dark baffled Moncler coat in a photo does not tell you whether it is Grenoble.',
   ARRAY['goose down','taped seams']::text[], '2010s-present', '$1,500-$3,000', ARRAY['grenoble','ski','technical','powder skirt']::text[],
   'https://www.moncler.com/en-us/moncler-code.html', 0.65, false, 'migration:00460'),
  ('moncler', 'Moncler Genius', ARRAY['genius','moncler genius','1 moncler','2 moncler','moncler x']::text[], 'Unisex', 'jacket', 'Genius',
   'The NUMBERED designer-collaboration line (2018+): each collaborator gets a number ("1 Moncler JW Anderson", "6 Moncler 1017 ALYX 9SM"), and the NUMBER + designer name is printed on the label. A Genius piece is a limited collaboration and comps well above the equivalent mainline garment — so the numbered label is a high-value read that no photo of the silhouette can replace. The number here is a COLLECTION index, NOT a size; do not confuse it with Moncler''s 0-5 size scale.',
   ARRAY['goose down']::text[], '2018-present', '$1,500-$4,000+', ARRAY['genius','collaboration','limited','numbered']::text[],
   'https://www.moncler.com/en-us/moncler-code.html', 0.62, false, 'migration:00460'),

  ('canadagoose', 'Expedition Parka', ARRAY['expedition','expedition parka','4660']::text[], 'Unisex', 'coat', 'Canada Goose',
   'The flagship heavyweight arctic parka — thigh-length, a huge coyote-ruffed hood, oversized cargo pockets and the arm-patch disc. TEI 5 (Extreme Weather), the brand''s warmest rating, and the highest-value model in resale. Style number 4660MA (men''s) / 4660LA (ladies''), printed on the care label. Check the ruff: fur-free production began end-2022, so an older Expedition has a REAL coyote ruff — state which, and whether it is present and detachable.',
   ARRAY['625 fill power down','Arctic Tech']::text[], 'long-running flagship', '$1,300-$1,700', ARRAY['expedition','parka','tei 5','coyote','4660']::text[],
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.72, false, 'migration:00460'),
  ('canadagoose', 'Chilliwack Bomber', ARRAY['chilliwack','chilliwack bomber','7950']::text[], 'Unisex', 'jacket', 'Canada Goose',
   'The SHORT bomber-length down jacket with a fur-ruffed hood, a ribbed hem/cuff and a distinctive two-way front zip under a storm flap. LENGTH is the separator: Chilliwack is hip-length where the Expedition is thigh-length, and they are otherwise easy to confuse in a photo. Style number 7950M / 7999L on the care label.',
   ARRAY['625 fill power down','Arctic Tech']::text[], 'long-running core', '$950-$1,200', ARRAY['chilliwack','bomber','7950','fur hood']::text[],
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.70, false, 'migration:00460'),
  ('canadagoose', 'Kensington Parka', ARRAY['kensington','kensington parka','2506']::text[], 'Women', 'coat', 'Canada Goose',
   'The women''s slim thigh-length parka — a fitted silhouette with a centre-front two-way zip, a fur-ruffed hood and back-thigh vents. It is the women''s volume model. Style number 2506L on the care label. vs Trillium: both are women''s hip/thigh parkas — the Kensington is the slimmer, longer, dressier cut.',
   ARRAY['625 fill power down','Arctic Tech']::text[], 'long-running core', '$1,000-$1,300', ARRAY['kensington','parka','2506','fur hood','womens']::text[],
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.68, false, 'migration:00460'),
  ('canadagoose', 'Langford Parka', ARRAY['langford','langford parka','2062']::text[], 'Men', 'coat', 'Canada Goose',
   'The men''s slim thigh-length parka cut for city wear rather than expedition use — trimmer through the body than the Expedition, with a fur-ruffed hood. Style number 2062M on the care label; the number is what settles a Langford-vs-Expedition call that a photo of a dark hooded parka will not.',
   ARRAY['625 fill power down','Arctic Tech']::text[], 'long-running core', '$1,000-$1,300', ARRAY['langford','parka','2062','fur hood','slim']::text[],
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.66, false, 'migration:00460'),
  ('canadagoose', 'Trillium Parka', ARRAY['trillium','trillium parka','6550']::text[], 'Women', 'coat', 'Canada Goose',
   'The women''s relaxed hip-length parka with an adjustable waist cinch and a fur-ruffed hood — the roomier, shorter counterpart to the slim Kensington. Style number 6550L. Because both are women''s fur-hooded parkas, the LENGTH and the waist cinch are the visual separators and the style number is the confirmation.',
   ARRAY['625 fill power down','Arctic Tech']::text[], 'long-running core', '$975-$1,200', ARRAY['trillium','parka','6550','womens']::text[],
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.64, false, 'migration:00460'),

  ('mackage', 'Adali', ARRAY['adali']::text[], 'Women', 'coat', 'Mackage',
   'The women''s belted down coat with a fur-trimmed hood — the brand''s signature silhouette. The BELT is the tell and the risk: it is a separate piece, it defines the look, and it goes missing. Check it is present before listing; a beltless Adali is an incomplete garment, not a minor flaw.',
   ARRAY['down']::text[], 'long-running core', '$700-$1,100', ARRAY['adali','down coat','belted','fur hood']::text[],
   'https://www.mackage.com/pages/about-us', 0.60, false, 'migration:00460'),
  ('mackage', 'Kay', ARRAY['kay','kay coat']::text[], 'Women', 'coat', 'Mackage',
   'The women''s LONG down coat — knee-length with a fur-trimmed hood and a belted waist. Length is the separator from the shorter Adali; both are belted fur-hooded down coats and a photo of a black coat will not settle which. Same belt caveat: confirm it is present.',
   ARRAY['down']::text[], 'long-running core', '$800-$1,200', ARRAY['kay','long down coat','belted','fur hood']::text[],
   'https://www.mackage.com/pages/about-us', 0.58, false, 'migration:00460'),
  ('mackage', 'Trish', ARRAY['trish']::text[], 'Women', 'jacket', 'Mackage',
   'The women''s LEATHER biker jacket — an asymmetric zip, quilted panels and oversized branded hardware. This is the LEATHER ladder, not the down one: it is a different garment class at a different price from the Adali/Kay coats, so never let a black-Mackage-jacket photo collapse the two. Hardware condition (branded pulls, zip function) is the value call.',
   ARRAY['leather']::text[], 'long-running core', '$800-$1,200', ARRAY['trish','leather jacket','biker','asymmetric zip']::text[],
   'https://www.mackage.com/pages/about-us', 0.58, false, 'migration:00460'),
  ('mackage', 'Dixon', ARRAY['dixon']::text[], 'Men', 'jacket', 'Mackage',
   'The men''s down jacket — hip-length, matte shell, oversized branded zip pulls and a leather-trimmed placket. The leather trim on an otherwise plain down jacket is the fastest Mackage read on a men''s piece.',
   ARRAY['down','leather trim']::text[], 'long-running core', '$600-$900', ARRAY['dixon','down jacket','mens','leather trim']::text[],
   'https://www.mackage.com/pages/about-us', 0.55, false, 'migration:00460'),
  ('mackage', 'Edward', ARRAY['edward','edward coat']::text[], 'Men', 'coat', 'Mackage',
   'The men''s long WOOL topcoat — a tailored knee-length overcoat, not a down piece and not leather. It is the third ladder on the label and the one most likely to be mistyped as an ordinary wool coat: the branded hardware and the interior label are what identify it.',
   ARRAY['wool']::text[], 'long-running core', '$600-$900', ARRAY['edward','wool coat','topcoat','mens']::text[],
   'https://www.mackage.com/pages/about-us', 0.55, false, 'migration:00460'),

  ('herno', 'Laminar', ARRAY['laminar','herno laminar']::text[], 'Unisex', 'jacket', 'Laminar',
   'A LINE, not a single garment — Herno''s laminated GORE-TEX technical collection, tagged LAMINAR in its own right. Bonded/taped seams and a clean face with no visible stitching are the construction tells, and they are photographable. The tag wordmark is the call: Laminar comps ABOVE the classic line, and reading the LINE off the label is more reliable than judging the shell by eye. Sized in ITALIAN numbers.',
   ARRAY['GORE-TEX','laminated','bonded seams']::text[], '2010s-present', '$700-$1,200', ARRAY['laminar','gore-tex','technical','bonded']::text[],
   'https://www.herno.com/us/experience/about-us', 0.62, false, 'migration:00460'),
  ('herno', 'Ultralight Down Jacket', ARRAY['ultralight','ultralight down','il mio piumino','piumino']::text[], 'Unisex', 'jacket', 'Herno',
   'The brand''s reputation piece: an extremely light, packable down jacket in a very thin nylon shell with fine horizontal baffles. The FABRIC HAND and the pack size are the corroborating checks — it compresses far smaller than an ordinary puffer. vs Laminar: this is the classic down line, NOT the Gore-Tex one; the tag decides, since both are slim dark nylon jackets in a photo.',
   ARRAY['ultralight nylon','goose down']::text[], 'long-running core', '$600-$1,000', ARRAY['ultralight','packable','down jacket','piumino']::text[],
   'https://www.herno.com/us/experience/about-us', 0.60, false, 'migration:00460'),
  ('herno', 'Rain Coat', ARRAY['rain coat','raincoat','trench']::text[], 'Unisex', 'coat', 'Herno',
   'The rain-resistant technical coat the house was founded on — a clean, tailored, water-repellent overcoat rather than a sporty shell. Herno began in 1948 making rain-resistant coats, so this is the heritage silhouette. Sized in ITALIAN numbers like the rest of the brand.',
   ARRAY['water-repellent']::text[], 'long-running core', '$600-$1,100', ARRAY['rain coat','trench','water repellent']::text[],
   'https://www.herno.com/us/experience/about-us', 0.55, false, 'migration:00460'),

  ('woolrich', 'Arctic Parka', ARRAY['arctic parka','arctic','arctic parka n.3']::text[], 'Unisex', 'coat', 'Woolrich',
   'THE Italian-era icon: a thigh-length down parka with a coyote-fur-trimmed hood, a two-way front zip and large flap pockets — the coat that made Woolrich a European status brand. This is the ITALIAN Woolrich, not the Pennsylvania wool mill, and it comps on a completely different ladder from the heritage Buffalo Check. It may carry EU sizing. Confirm the hood fur is present and state whether it is real.',
   ARRAY['down','fur trim']::text[], '1972-present', '$700-$1,300', ARRAY['arctic parka','down parka','fur hood','italian']::text[],
   'https://www.woolrich.com/us/about-us', 0.65, false, 'migration:00460'),
  ('woolrich', 'Buffalo Check Wool Shirt', ARRAY['buffalo check','buffalo plaid','wool shirt','red buffalo']::text[], 'Unisex', 'shirt', 'John Rich & Bros',
   'The AMERICAN heritage piece: a heavy red/black Buffalo Check wool overshirt, the pattern Woolrich has run since 1850. Read the ORIGIN TAG — a Made in USA Buffalo Check came from the Pennsylvania mill and CANNOT be newer than its 2018 closure, which makes it the collectible half of the brand. CRITICAL: a red-and-black plaid is not automatically Woolrich; the most imitated plaid in America is settled by the LABEL, never by the pattern.',
   ARRAY['wool']::text[], 'heritage (US mill, pre-2018)', '$100-$200', ARRAY['buffalo check','wool shirt','plaid','made in usa']::text[],
   'https://www.woolrich.com/us/about-us', 0.62, false, 'migration:00460'),
  ('woolrich', 'Woolrich Woolen Mills', ARRAY['woolen mills','wwm','woolrich woolen mills']::text[], 'Unisex', 'jacket', 'Woolrich Woolen Mills',
   'The designer-led heritage sub-label, printed as WOOLRICH WOOLEN MILLS on its own tag — Americana workwear reinterpreted, and collectible in its own right. It prints its OWN name and never simply "Woolrich", which is exactly why it must be read off the label. Folded onto the Woolrich canonical: it shares the brand''s price band rather than sitting an order of magnitude away.',
   ARRAY['wool']::text[], 'c.2006-present (intermittent)', '$200-$500', ARRAY['woolen mills','wwm','americana','workwear']::text[],
   'https://www.woolrich.com/us/about-us', 0.55, false, 'migration:00460'),

  ('bogner', 'Ski Pant', ARRAY['ski pant','ski pants','stretch pant','bogners']::text[], 'Unisex', 'pant', 'Bogner',
   'The brand''s founding garment and its highest-value resale category: the technical stretch SKI PANT. Maria Bogner''s 1950s stretch pant was so dominant that "bogners" became the American word for ski pants. Look for a stirrup or an integrated boot gaiter, a high/bibbed waist and sealed seams. Sized in GERMAN numbers — a men''s 50 is a DE 50 = US 40, NOT a US 50.',
   ARRAY['stretch technical fabric','sealed seams']::text[], 'long-running heritage', '$400-$900', ARRAY['ski pant','stretch','gaiter','bogners']::text[],
   'https://www.bogner.com/en-us/about-bogner/', 0.62, false, 'migration:00460'),
  ('bogner', 'Ski Jacket', ARRAY['ski jacket','down ski jacket']::text[], 'Unisex', 'jacket', 'Bogner',
   'The technical ski jacket — an insulated/down shell with a powder skirt, a lift-pass pocket and a helmet-compatible hood, carrying the "B" mark. The ski FEATURES are the separator from Bogner''s ordinary sportswear outerwear, and they are photographable: the powder skirt and pass pocket are inside the hem. Sized in GERMAN numbers.',
   ARRAY['down','sealed seams','powder skirt']::text[], 'long-running core', '$700-$1,500', ARRAY['ski jacket','powder skirt','down','lift pass']::text[],
   'https://www.bogner.com/en-us/about-bogner/', 0.60, false, 'migration:00460'),
  ('bogner', 'Fire + Ice', ARRAY['fire + ice','fire and ice','fireice','bogner fire + ice']::text[], 'Unisex', 'jacket', 'Fire + Ice',
   'A LINE, not a single garment — the sportier DIFFUSION label (1985, named for Willy Bogner Jr.''s ski film), which prints FIRE + ICE on its own tag. The tag wordmark is the entire call: a Fire + Ice piece IS Bogner but sits BELOW mainline on the ladder, so titling one as plain Bogner over-claims it. No photo separates the lines — read the label.',
   ARRAY['stretch technical fabric']::text[], '1985-present', '$300-$700', ARRAY['fire + ice','fire and ice','diffusion','ski']::text[],
   'https://www.bogner.com/en-us/about-bogner/', 0.60, false, 'migration:00460')
on conflict (brand_key, style_name, department) do update set
  aliases = excluded.aliases, product_line = excluded.product_line,
  category = excluded.category, visual_fingerprint = excluded.visual_fingerprint,
  fabric_tech = excluded.fabric_tech, era = excluded.era, msrp_band = excluded.msrp_band,
  keywords = excluded.keywords, source_url = excluded.source_url,
  confidence = excluded.confidence, verified = excluded.verified,
  updated_by = excluded.updated_by;

-- ── brand_style_codes: CANADA GOOSE ONLY ────────────────────────────────────
-- The only code in this group that clears all three bars (tag-printed, regular,
-- brand-unique FORMAT). 4 digits + a department letter is a compound distinctive
-- enough to anchor on — the LV SD1160 precedent — where the bare digit runs in
-- this group (Moncler's serial, the hologram number) are NOT and are deliberately
-- left as informational tells (the Chanel rule, US-1736).
--
-- THE M/L GROUP IS NON-CAPTURING ON PURPOSE. It genuinely encodes the department
-- (M = men's, L = ladies'), but the genderCode transform maps only M/W — a
-- captured "L" would pass through RAW as "L", writing garbage into a field the
-- listing surfaces. Same call as US-1740's New Balance "U": match on it, don't
-- capture it. Only `style` is captured, into styleCode, which is what
-- enrichExtractionWithBrandKnowledge keys brand recovery off.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by)
values
  ('canadagoose', 'style_number',
   'Canada Goose style number printed on the interior care label: 4 digits + a department letter (M = men''s, L = ladies'') + an optional 1-2 letter model suffix. 4660MA = Expedition Parka (men''s), 7950M = Chilliwack Bomber, 2506L = Kensington Parka. Recovers the BRAND off a cut brand tag — the group''s cut-tag case.',
   '^(?<style>\d{4}[ML][A-Z]{0,2})$',
   $j${"fieldMap": {"style": "styleCode"}, "confidence": 0.75}$j$::jsonb,
   $j$[{"code":"4660MA","expected":{"styleCode":"4660MA"}},{"code":"7950M","expected":{"styleCode":"7950M"}},{"code":"2506L","expected":{"styleCode":"2506L"}}]$j$::jsonb,
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.65, false, 'migration:00460')
on conflict (brand_key, decoder_kind) do update set
  description = excluded.description, pattern = excluded.pattern,
  extraction_rules = excluded.extraction_rules, examples = excluded.examples,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Only where the brand genuinely uses PROPRIETARY named colors (AC3) — the same
-- bar 00453 applied. Canada Goose is the one clear case in this group: it ships
-- house color names a seller cannot derive from the photo, and they persist across
-- seasons rather than rotating.
--
-- Deliberately NOT seeded for the other five. Moncler is the instructive refusal:
-- its signature "nylon laqué" is a FABRIC, not a color (it is already carried in
-- fabric_tech, which is where the resolver reads it), and seeding a fabric as a
-- colorway would put the fact in a renderer that colors — not materials — feed.
-- Mackage/Herno/Woolrich/Bogner use ordinary color words that rotate per season
-- and form no stable dictionary; inventing one would be worse than the gap.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('canadagoose', 'Northern Night', ARRAY['northern night']::text[], '#1B1F2E', 'current',
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.55, false, 'migration:00460'),
  ('canadagoose', 'Atlantic Navy', ARRAY['atlantic navy']::text[], '#1F2A44', 'current',
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.55, false, 'migration:00460'),
  ('canadagoose', 'Spirit', ARRAY['spirit']::text[], NULL, 'current',
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.50, false, 'migration:00460'),
  ('canadagoose', 'Black', ARRAY['black']::text[], '#000000', NULL,
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.80, false, 'migration:00460')
on conflict (brand_key, color_name) do update set
  aliases = excluded.aliases, hex = excluded.hex, years = excluded.years,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_size_charts (INCHES, BODY measurements) ───────────────────────────
-- THE CROSS-MAP IS WRITTEN INTO THE SIZE LABEL, not just the note. Four of these
-- six brands size in a system their own tag never names, so the label is where the
-- translation has to live — it is what the model actually reads (the US-1731
-- lesson, and the whole product of US-1740's footwear charts).
--
-- Mirrored 1:1 into the sizing-charts.ts in-code fallback.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by)
values
  ('moncler', 'Moncler', ARRAY['moncler']::text[], 'Men', 'Outerwear (MONCLER 0-5 SCALE)',
   ARRAY['jacket','coat','outerwear','down','puffer','parka','vest','top']::text[],
   $json$[{"size":"0 (= XS / US 34-36)","measurements":{"chest":"34-36"}},{"size":"1 (= S / US 36-38)","measurements":{"chest":"36-38"}},{"size":"2 (= M / US 38-40)","measurements":{"chest":"38-40"}},{"size":"3 (= L / US 40-42)","measurements":{"chest":"40-42"}},{"size":"4 (= XL / US 42-44)","measurements":{"chest":"42-44"}},{"size":"5 (= XXL / US 44-46)","measurements":{"chest":"44-46"}}]$json$::jsonb,
   'THE NUMBER ON A MONCLER IS MONCLER''S OWN 0-5 SIZE AND THE GARMENT DOES NOT SAY SO — the highest-value fact in this brand group. It is not US, not EU, not alpha. A jacket tagged "2" is a MEDIUM (US 38-40 chest), and a seller who reads "2" and lists a US 2 has listed a medium as an extra-small. ALWAYS state the Moncler number AND its alpha equivalent in the listing. BODY measurement — NOT flat-garment; a down jacket is cut with loft and layering room, so its FLAT chest measures above the body chest it is sized to. Approximation from the published 0-5 mapping — capped confidence, verify against the brand''s own guide.',
   'https://www.moncler.com/en-us/moncler-code.html', 0.60, false, 'migration:00460'),
  ('moncler', 'Moncler', ARRAY['moncler']::text[], 'Women', 'Outerwear (MONCLER 0-5 SCALE)',
   ARRAY['jacket','coat','outerwear','down','puffer','parka','vest','top']::text[],
   $json$[{"size":"0 (= XS / US 0-2)","measurements":{"bust":"32-33"}},{"size":"1 (= S / US 4)","measurements":{"bust":"33-34.5"}},{"size":"2 (= M / US 6-8)","measurements":{"bust":"34.5-36"}},{"size":"3 (= L / US 10)","measurements":{"bust":"36-38"}},{"size":"4 (= XL / US 12)","measurements":{"bust":"38-40"}},{"size":"5 (= XXL / US 14)","measurements":{"bust":"40-42"}}]$json$::jsonb,
   'THE NUMBER ON A MONCLER IS MONCLER''S OWN 0-5 SIZE AND THE GARMENT DOES NOT SAY SO — and on WOMEN''S it is at its most dangerous, because the numbers COLLIDE with US women''s numeric sizing. A women''s Moncler tagged "2" is a US 6-8 / MEDIUM, not a US 2 — the same digit is a real size in both systems, so nothing looks wrong. That is a THREE-SIZE error the photo cannot contradict. ALWAYS state the Moncler number AND its US/alpha equivalent. BODY measurement — NOT flat-garment. Approximation from the published 0-5 mapping — capped confidence, verify against the brand''s own guide.',
   'https://www.moncler.com/en-us/moncler-code.html', 0.60, false, 'migration:00460'),

  ('canadagoose', 'Canada Goose', ARRAY['canada goose','canadagoose']::text[], 'Men', 'Outerwear',
   ARRAY['jacket','coat','outerwear','down','parka','bomber','vest','top']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment, and on this brand the gap is EXTREME: an arctic parka is built around heavy down loft, so its flat chest measures far above the body chest it is sized to. CANADA GOOSE RUNS LARGE and the brand''s own guidance is to size DOWN — a buyer who takes their usual size in an Expedition typically gets a coat that swims. Say the flat measurements; do not let the tag letter stand alone. NOTE the intra-brand spread: the slim Kensington/Langford city cuts and the roomy Expedition do NOT wear the same at one letter. Standard outerwear-alpha approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.55, false, 'migration:00460'),
  ('canadagoose', 'Canada Goose', ARRAY['canada goose','canadagoose']::text[], 'Women', 'Outerwear',
   ARRAY['jacket','coat','outerwear','down','parka','bomber','vest','top']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment; down loft puts the flat chest well above the body bust the coat is sized to. CANADA GOOSE RUNS LARGE — size DOWN is the brand''s own guidance. The women''s line spans a slim cut (Kensington) and a relaxed one (Trillium), so one letter does not wear the same across the range; state the flat measurements. Standard outerwear-alpha approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.canadagoose.com/us/en/help/product-care.html', 0.55, false, 'migration:00460'),

  ('mackage', 'Mackage', ARRAY['mackage']::text[], 'Men', 'Outerwear',
   ARRAY['jacket','coat','outerwear','down','parka','leather','top']::text[],
   $json$[{"size":"XS","measurements":{"chest":"34-36"}},{"size":"S","measurements":{"chest":"36-38"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. MACKAGE IS THE PLAIN-READING CONTROL IN THIS GROUP: it sizes in ordinary US alpha (XS-XXL), so unlike Moncler/Herno/Bogner the tag means what it appears to mean and needs no translation. The cut is TRIM/tailored rather than roomy, so it does not wear like the deliberately oversized parkas beside it in this pack. Standard outerwear-alpha approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.mackage.com/pages/about-us', 0.55, false, 'migration:00460'),
  ('mackage', 'Mackage', ARRAY['mackage']::text[], 'Women', 'Outerwear',
   ARRAY['jacket','coat','outerwear','down','parka','leather','top']::text[],
   $json$[{"size":"XXS","measurements":{"bust":"31-32"}},{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Ordinary US alpha sizing (the plain-reading control in this group — no translation needed, unlike Moncler/Herno/Bogner). The women''s range extends to XXS. Cut TRIM/tailored, and the belted coats (Adali/Kay) are meant to cinch — a belt-less listing misrepresents the fit as well as the completeness. Standard outerwear-alpha approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.mackage.com/pages/about-us', 0.55, false, 'migration:00460'),

  ('herno', 'Herno', ARRAY['herno']::text[], 'Men', 'Outerwear (ITALIAN-SIZED)',
   ARRAY['jacket','coat','outerwear','down','rain','top','blazer']::text[],
   $json$[{"size":"46 (= IT 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= IT 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= IT 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= IT 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= IT 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= IT 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'THE NUMBER ON A HERNO IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO — the highest-value Herno fact. A jacket tagged "50" is an IT 50 = US 40 = L. It is not a US 50 (a size that does not exist in this range), so the error usually surfaces as a nonsense listing rather than a plausible one — but it still costs the sale. SUBTRACT 10 to reach the US number. ALWAYS state both. BODY measurement — NOT flat-garment; Italian outerwear is cut TRIM, so a Herno IT 50 wears smaller than a US L from an American outdoor brand. Standard IT-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.herno.com/us/experience/about-us', 0.55, false, 'migration:00460'),
  ('herno', 'Herno', ARRAY['herno']::text[], 'Women', 'Outerwear (ITALIAN-SIZED)',
   ARRAY['jacket','coat','outerwear','down','rain','top']::text[],
   $json$[{"size":"38 (= IT 38 / US 2 / XS)","measurements":{"bust":"32-33"}},{"size":"40 (= IT 40 / US 4 / S)","measurements":{"bust":"33-34.5"}},{"size":"42 (= IT 42 / US 6 / M)","measurements":{"bust":"34.5-36"}},{"size":"44 (= IT 44 / US 8 / M-L)","measurements":{"bust":"36-37.5"}},{"size":"46 (= IT 46 / US 10 / L)","measurements":{"bust":"38-39.5"}},{"size":"48 (= IT 48 / US 12 / XL)","measurements":{"bust":"40-41.5"}}]$json$::jsonb,
   'THE NUMBER ON A HERNO IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO — and the WOMEN''S chart is the dangerous one, because an IT 42 reads as a plausible US 42 while actually being a US 6. SUBTRACT 36 to reach the US number (IT 42 - 36 = US 6). ALWAYS state both. BODY measurement — NOT flat-garment; Italian outerwear is cut TRIM. Standard IT-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.herno.com/us/experience/about-us', 0.55, false, 'migration:00460'),

  ('woolrich', 'Woolrich', ARRAY['woolrich','john rich']::text[], 'Men', 'Outerwear & wool',
   ARRAY['jacket','coat','outerwear','down','parka','shirt','wool','flannel','top']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. WATCH THE SIZE SYSTEM, IT FOLLOWS THE ERA: this US alpha chart covers the American heritage wool (the Made-in-USA Buffalo Check era, mill closed 2018), but the ITALIAN-era outerwear sold under the same label may carry EU sizing instead — one brand, two systems, decided by which Woolrich the garment is. Confirm from the origin tag before trusting the label. The heritage wool is also cut GENEROUS/boxy as an overshirt layer, so the body chart does not predict its flat measurement. Standard US-alpha approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.woolrich.com/us/about-us', 0.55, false, 'migration:00460'),
  ('woolrich', 'Woolrich', ARRAY['woolrich','john rich']::text[], 'Women', 'Outerwear & wool',
   ARRAY['jacket','coat','outerwear','down','parka','shirt','wool','flannel','top']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. WATCH THE SIZE SYSTEM, IT FOLLOWS THE ERA: US alpha on the American heritage wool, possibly EU numbers on the Italian-era outerwear (the Arctic Parka) under the SAME label. Confirm which Woolrich the garment is from the origin tag before trusting the size. Standard US-alpha approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.woolrich.com/us/about-us', 0.55, false, 'migration:00460'),

  ('bogner', 'Bogner', ARRAY['bogner','fire + ice','fire and ice']::text[], 'Men', 'Ski & outerwear (GERMAN-SIZED)',
   ARRAY['jacket','coat','outerwear','down','ski','pant','top']::text[],
   $json$[{"size":"46 (= DE 46 / US 36 / S)","measurements":{"chest":"36-37"}},{"size":"48 (= DE 48 / US 38 / M)","measurements":{"chest":"38-39"}},{"size":"50 (= DE 50 / US 40 / L)","measurements":{"chest":"40-41"}},{"size":"52 (= DE 52 / US 42 / XL)","measurements":{"chest":"42-43"}},{"size":"54 (= DE 54 / US 44 / XXL)","measurements":{"chest":"44-45"}},{"size":"56 (= DE 56 / US 46 / XXXL)","measurements":{"chest":"46-47"}}]$json$::jsonb,
   'THE NUMBER ON A BOGNER IS A GERMAN SIZE AND THE GARMENT DOES NOT SAY SO — the highest-value Bogner fact. A men''s piece tagged "50" is a DE 50 = US 40 = L. SUBTRACT 10 to reach the US number. ALWAYS state both. BODY measurement — NOT flat-garment; ski wear is cut with layering room over a base layer, so its flat chest measures above the body chest it is sized to. This chart serves BOTH ladders (mainline Bogner and the Fire + Ice diffusion line) — they share the size system, but not the price, so read the LINE off the tag separately. Standard DE-to-US menswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.bogner.com/en-us/about-bogner/', 0.55, false, 'migration:00460'),
  ('bogner', 'Bogner', ARRAY['bogner','fire + ice','fire and ice']::text[], 'Women', 'Ski & outerwear (GERMAN-SIZED)',
   ARRAY['jacket','coat','outerwear','down','ski','pant','top']::text[],
   $json$[{"size":"34 (= DE 34 / US 4 / XS)","measurements":{"bust":"32-33"}},{"size":"36 (= DE 36 / US 6 / S)","measurements":{"bust":"33.5-34.5"}},{"size":"38 (= DE 38 / US 8 / M)","measurements":{"bust":"35-36"}},{"size":"40 (= DE 40 / US 10 / L)","measurements":{"bust":"36.5-38"}},{"size":"42 (= DE 42 / US 12 / XL)","measurements":{"bust":"38.5-40"}},{"size":"44 (= DE 44 / US 14 / XXL)","measurements":{"bust":"41-42.5"}}]$json$::jsonb,
   'THE NUMBER ON A BOGNER IS A GERMAN SIZE AND THE GARMENT DOES NOT SAY SO — and the WOMEN''S chart is the dangerous one, because a DE 38 reads as a plausible-looking number while actually being a US 8, and a DE 34 is a US 4. SUBTRACT 30 to reach the US number (DE 38 - 30 = US 8). ALWAYS state both. BODY measurement — NOT flat-garment; ski wear is cut with layering room. Serves BOTH ladders (mainline and Fire + Ice) — same size system, different price, so read the LINE off the tag. Standard DE-to-US womenswear approximation rather than brand-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.bogner.com/en-us/about-bogner/', 0.55, false, 'migration:00460')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00460') on conflict do nothing;
