-- US-1734: Outdoor & technical brand knowledge group (6 brands).
--
-- Columbia, Arc'teryx, Marmot, REI Co-op, L.L.Bean, Mountain Hardwear — the
-- outdoor tier beside the two flagships already seeded (Patagonia 00395 /
-- The North Face 00396).
--
-- The through-line for this group: identity is the FABRIC TECHNOLOGY, and it is
-- printed on the garment. Columbia's Omni- family (Omni-Tech / Omni-Heat /
-- Omni-Shade) and Arc'teryx's Gore-Tex tiers are wordmarks on the tag or hangtag,
-- so the model reads the LINE off the garment rather than inferring it from a
-- silhouette. Two of those tech tells double as DATING evidence and are seeded as
-- first-class facts because they are the highest-leverage facts in the group:
--   * Columbia Omni-Heat Reflective = SILVER dots; Omni-Heat Infinity = GOLD dots
--     and is 2021+. The dot COLOR dates the garment on sight.
--   * REI's house label was rebranded "REI Co-op" ~2015 — a plain "REI" label is
--     pre-rebrand.
--
-- Arc'teryx is the ONLY brand in this group with a regular, garment-printed code,
-- and it is a NAME system rather than a number: MODEL + weight-class SUFFIX
-- (SL/LT/AR/SV/MX/FL). "Atom LT" / "Beta AR" are Arc'teryx-unique compounds, so a
-- pattern anchored on model+suffix TOGETHER recovers the brand off a cut tag
-- without false-positive risk. It gets the group's only brand_style_codes row.
-- The others get NO decoder: Columbia/Marmot/L.L.Bean/REI item numbers are
-- retailer/catalog SKUs whose format is not brand-unique, so decoding one would
-- invent a recovery the format cannot support.
--
-- Data-only, idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
-- Columbia + Arc'teryx + Marmot + L.L.Bean enrich their bare 00389 alias-only
-- rows; REI Co-op + Mountain Hardwear are new.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  ('columbia', 'Columbia', ARRAY['columbia','columbia sportswear','columbiasportswear','columbia sportswear company']::text[],
   ARRAY['outdoor','technical','insulation','fleece','rainwear','mens','womens']::text[],
   $j$[{"era":"Omni-Heat Reflective","years":"2010-present","description":"SILVER reflective dots printed on the lining. The dot pattern is the single most recognizable Columbia interior."},{"era":"Omni-Heat Infinity","years":"2021-present","description":"GOLD reflective dots (launched with the NASA collaboration). Gold dots DATE the garment to 2021 or later — the dot COLOR is a reliable on-sight era tell vs the silver Reflective generation."}]$j$::jsonb,
   $j$[{"pattern":"Imported","note":"Columbia manufactures offshore; country of origin varies by garment and is NOT an authentication signal on its own."}]$j$::jsonb,
   $j$[{"tell":"The Omni- wordmark IS the line","detail":"Omni-Tech (waterproof + breathable seam-sealed shell), Omni-Heat (reflective lining), Omni-Shade (UPF sun), Omni-Wick (moisture transport), Omni-Shield (stain/water repellent), Omni-Freeze ZERO (sweat-activated cooling rings). The mark is printed on the tag/hangtag — read it rather than inferring the tech from the silhouette. This is the primary Columbia disambiguation and needs no code."},{"tell":"Omni-Heat dot COLOR dates the garment","detail":"Silver dots = Omni-Heat Reflective (2010+). Gold dots = Omni-Heat Infinity (2021+). A gold-dot lining cannot be a pre-2021 garment."},{"tell":"Interchange = a 3-in-1 system, not a model","detail":"Bugaboo and Whirlibird are INTERCHANGE jackets: a shell plus a zip-out liner that each wear alone. A listing selling only one half is incomplete — check for both pieces and say which are present."},{"tell":"PFG is a sub-brand","detail":"Performance Fishing Gear (PFG) is Columbia's fishing line (Bahama II, Tamiami II) with its own logo and following. Title it as PFG — it comps separately from mainline Columbia."},{"tell":"Never auto-authenticate","detail":"No published Columbia authentication standard, tag serial or date code exists that could prove authenticity programmatically. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Columbia identity = the Omni- technology wordmark printed on the garment (Omni-Tech shell / Omni-Heat lining / Omni-Shade sun). Founded 1938 in Portland OR as the Columbia Hat Company (Paul and Marie Lamfrom); Gert Boyle ("One Tough Mother") ran it from 1970, Tim Boyle is CEO. Columbia Sportswear Company also OWNS Mountain Hardwear (acquired 2003 — the sibling in this same pack), Sorel and prAna, so a corporate-family question is not a counterfeit question. No tag decoder — the item number is a retailer SKU, not a brand-unique format. RN omitted — not sourceable.',
   'https://www.columbia.com/omni-technologies.html', 0.85, false, 'migration:00453'),

  ('arcteryx', 'Arc''teryx', ARRAY['arcteryx','arc teryx','arc''teryx','arcterix']::text[],
   ARRAY['outdoor','technical','alpine','gore-tex','insulation','mens','womens']::text[],
   $j$[{"era":"Rock Solid","years":"1989-1991","description":"Founded as Rock Solid in Vancouver BC; renamed Arc'teryx in 1991. A Rock Solid label is a pre-1991 piece."},{"era":"Made in Canada","years":"1991-2010s","description":"Older pieces were sewn at the North Vancouver factory and read Made in Canada. Most current production is offshore — 'Made in Canada' skews EARLY/collectible, while an imported tag on a modern piece is entirely normal."}]$j$::jsonb,
   $j$[{"pattern":"Made in Canada (early) / Imported (current)","note":"Arc'teryx ran its own North Vancouver factory and still makes a limited range there; the bulk is now offshore. Country of origin is an ERA hint, NOT an authenticity verdict — an imported modern Arc'teryx is normal."}]$j$::jsonb,
   $j$[{"tell":"MODEL + SUFFIX is the naming system — the single best Arc'teryx fact","detail":"Every technical piece is [MODEL] + [weight-class SUFFIX]: SL = Superlight, LT = Lightweight, AR = All-Round, SV = Severe Weather, MX = Mixed conditions, FL = Fast and Light. So 'Beta AR' and 'Atom LT' name a model AND its intended conditions. The suffix is REGULAR and printed on the garment, which is why it is the only decodable code in this pack — and why the suffix must be carried into the title (an Atom LT and an Atom AR are different jackets at different prices)."},{"tell":"The logo is a fossil skeleton","detail":"The mark is the Berlin specimen of Archaeopteryx lithographica — the brand is named for it. It is a detailed SKELETON; fakes routinely render it as a flat or simplified bird."},{"tell":"Heavily counterfeited — one of the most faked outdoor brands","detail":"Arc'teryx has a large counterfeit market, so tag/logo heuristics circulating online come from low-authority sources and NO single tell is dispositive. Route to human review; never emit an authentic/fake verdict. Flag inconsistencies in condition_notes only."},{"tell":"Laminated construction","detail":"Shells use taped/laminated seams and minimal face stitching; hardware is co-branded (GORE-TEX, WaterTight zippers). Consistent with genuine; absence is a SOFT flag only, never proof."}]$j$::jsonb,
   'Arc''teryx identity = MODEL + weight-class SUFFIX (Beta AR, Atom LT, Cerium SL). Founded 1989 in Vancouver BC as Rock Solid, renamed 1991 after Archaeopteryx; HQ North Vancouver. Owned by Amer Sports (an Anta-led consortium acquired Amer in 2019). Gore-Tex tiers map to models: Alpha/Beta = Gore-Tex hardshells, Gamma = softshell, Atom = synthetic insulation, Cerium = down, Proton = air-permeable insulation, Delta = fleece. RN omitted — not sourceable.',
   'https://arcteryx.com/us/en/explore/product-naming', 0.80, false, 'migration:00453'),

  ('marmot', 'Marmot', ARRAY['marmot','marmot mountain','marmot mountain works']::text[],
   ARRAY['outdoor','technical','rainwear','down','insulation','mens','womens']::text[],
   $j$[{"era":"Marmot Mountain Works","years":"1974-1980s","description":"The original name/label. A Marmot Mountain Works tag is an early piece."}]$j$::jsonb,
   $j$[{"pattern":"Imported","note":"Offshore manufacture is normal for current Marmot; country of origin is not an authentication signal."}]$j$::jsonb,
   $j$[{"tell":"MemBrain vs Gore-Tex separates the rain shells","detail":"MemBrain is Marmot's OWN waterproof/breathable membrane (NanoPro is its higher-breathability version) and it is what the budget PreCip uses. The Minimalist uses licensed GORE-TEX. Reading the membrane wordmark off the tag separates two visually similar rain jackets that comp very differently — this is the highest-value Marmot call."},{"tell":"The logo is the marmot","detail":"The groundhog/marmot mark. Consistent with genuine; not an authentication proof."},{"tell":"Never auto-authenticate","detail":"No published Marmot authentication standard, serial or date code exists. Counterfeiting is not the main risk on this brand — MISATTRIBUTION between the MemBrain and Gore-Tex shells is. Route authenticity to human review."}]$j$::jsonb,
   'Marmot identity = the MEMBRANE (MemBrain/NanoPro in-house vs licensed Gore-Tex) + the model. Founded 1974 as Marmot Mountain Works (Eric Reynolds and Dave Huntley); later Santa Rosa CA, now a Newell Brands label. No tag decoder — the item number is a retailer SKU, not a brand-unique format. RN omitted — not sourceable.',
   'https://www.marmot.com/technology.html', 0.75, false, 'migration:00453'),

  ('reicoop', 'REI Co-op', ARRAY['rei','rei co-op','reicoop','rei coop','recreational equipment inc','recreational equipment']::text[],
   ARRAY['outdoor','technical','rainwear','hiking','mens','womens']::text[],
   $j$[{"era":"REI (plain)","years":"pre-2015","description":"The house label read simply REI. A plain-REI garment tag is PRE-rebrand — this is the cleanest date boundary on the brand."},{"era":"REI Co-op","years":"2015-present","description":"The house brand was rebranded REI Co-op around 2015. A Co-op label cannot be an older piece."}]$j$::jsonb,
   $j$[{"pattern":"Imported","note":"REI Co-op branded apparel is manufactured offshore; country of origin is not an authentication signal."}]$j$::jsonb,
   $j$[{"tell":"REI Co-op is a HOUSE brand — sold nowhere else","detail":"REI Co-op label goods are sold only through REI (no wholesale). That makes counterfeiting economically pointless and it is why authenticity is a non-issue on this brand; the real resale risk is confusing the HOUSE label with the national brands REI also retails. An 'REI' listing is only an REI Co-op garment if the LABEL says so."},{"tell":"The label dates the garment","detail":"Plain 'REI' = pre-2015; 'REI Co-op' = 2015 or later. Cheap, reliable dating from the tag alone."},{"tell":"REI is a consumer co-operative","detail":"Founded 1938 in Seattle by Lloyd and Mary Anderson and 21 friends; buyers hold a lifetime membership. This is brand context, not a garment tell — do not put membership language in a listing title."},{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard. Grade condition only."}]$j$::jsonb,
   'REI Co-op identity = the HOUSE label itself (plain "REI" pre-2015 vs "REI Co-op" 2015+ — the tag dates the piece). Recreational Equipment, Inc., founded 1938 in Seattle as a consumer co-operative; HQ Sumner WA. Sold only through REI, so a Co-op garment never appears at another retailer new. No tag decoder — the item number is a retailer SKU. RN omitted — not sourceable.',
   'https://www.rei.com/about-rei', 0.75, false, 'migration:00453'),

  -- NOTE: a bare "bean" is deliberately NOT an alias — it is an ordinary English
  -- word and would resolve any garment tagged "bean" to this brand.
  ('llbean', 'L.L.Bean', ARRAY['llbean','l l bean','l.l. bean','ll bean','l.l.bean']::text[],
   ARRAY['outdoor','heritage','americana','flannel','footwear','mens','womens']::text[],
   $j$[{"era":"Freeport Maine / Made in USA script","years":"vintage","description":"Older labels read L.L.Bean, Freeport, Maine and Made in USA on apparel. Modern APPAREL is imported, so a Made-in-USA flannel or field coat skews vintage/collectible."},{"era":"Guarantee change","years":"2018-02-09","description":"The unlimited satisfaction guarantee was cut to ONE YEAR with proof of purchase on 2026-02-09-era terms (announced 9 Feb 2018) after return abuse. Resale-relevant: a listing still advertising a lifetime guarantee is repeating a policy that no longer applies to a resale buyer."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA (Bean Boots + Boat and Tote) / Imported (apparel)","note":"Bean Boots and the Boat and Tote are still made in Maine (Brunswick/Lewiston). Apparel is imported. So Made-in-USA is EXPECTED on a Bean Boot and notable on a shirt — the origin tag means opposite things by product, which is why it is recorded per-product rather than brand-wide."}]$j$::jsonb,
   $j$[{"tell":"Do not repeat the lifetime guarantee","detail":"HIGHEST-VALUE L.L.BEAN LISTING FACT. The famous unlimited return guarantee ENDED 9 Feb 2018 — it is now one year with proof of purchase. A resale buyer has no proof of purchase, so the guarantee does not transfer. Never carry lifetime-guarantee language into a title or description; it is a live misrepresentation, not a selling point."},{"tell":"Bean sizing runs GENEROUS","detail":"L.L.Bean's classic cut is roomy/relaxed — a Bean Medium wears larger than a Medium from a technical brand. Do not trust the tag alone; measure the garment and state the flat measurements."},{"tell":"The Bean Boot is the icon","detail":"The Maine Hunting Shoe (1912) — a rubber bottom stitched to a leather upper — is the brand's origin and its highest-value resale item. It is still made in Maine, so a Made-in-USA sole is normal, and the rubber bottoms are RESOLEABLE, which supports value on a worn pair."},{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard. Counterfeiting is not the risk on this brand — over-claiming the guarantee and over-stating size are. Route authenticity to human review."}]$j$::jsonb,
   'L.L.Bean identity = the heritage model (Bean Boot / Scotch Plaid flannel / Boat and Tote) + a GENEROUS classic cut. Founded 1912 in Freeport Maine by Leon Leonwood Bean with the Maine Hunting Shoe. CRITICAL for listings: the unlimited "lifetime" guarantee ended 9 Feb 2018 (now 1 year with proof of purchase) and does NOT transfer to a resale buyer — never repeat it. No tag decoder — the item number is a retailer SKU. RN omitted — not sourceable.',
   'https://www.llbean.com/llb/shop/516886', 0.75, false, 'migration:00453'),

  ('mountainhardwear', 'Mountain Hardwear', ARRAY['mountain hardwear','mountainhardwear','mhw','mountain hard wear']::text[],
   ARRAY['outdoor','technical','alpine','down','fleece','mens','womens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Imported","note":"Offshore manufacture is normal; country of origin is not an authentication signal."}]$j$::jsonb,
   $j$[{"tell":"The logo is a climbing nut","detail":"The mark is a stylized nut/chock (climbing protection), not a mountain outline. It is the fastest brand read on an unlabelled photo."},{"tell":"Ghost Whisperer is the value item — and it is identifiable by HAND","detail":"The ultralight down jacket is the brand's highest-value resale piece. Its 7D/10D nylon shell is extraordinarily thin and audibly crinkly — the fabric hand alone separates it from an ordinary puffer. Weight and packed size are the corroborating checks."},{"tell":"Stretchdown baffles are WELDED, not sewn","detail":"The Stretchdown line bonds its baffles instead of stitching through them, giving continuous channels with no needle holes. This is a construction FACT visible in a photo, so it is a far more objective line call than a hand-feel judgment."},{"tell":"Never auto-authenticate","detail":"No published authentication standard, serial or date code. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Mountain Hardwear identity = the model line (Ghost Whisperer ultralight down / Stretchdown welded baffles / Kor shells / Monkey Fleece high-loft). Founded 1993 in Richmond CA by former Sierra Designs staff; ACQUIRED BY COLUMBIA SPORTSWEAR in 2003 — Columbia is the sibling in this same pack, so a shared corporate parent is expected and is not a counterfeit signal. No tag decoder. RN omitted — not sourceable.',
   'https://www.mountainhardwear.com/about-us.html', 0.75, false, 'migration:00453')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- Columbia: the Omni- technologies ARE the identity, and the confusable pairs are
-- the two Interchange parkas + the two classic fleeces (men's/women's siblings).
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('columbia', 'Bugaboo', ARRAY['bugaboo','bugaboo ii','bugaboo interchange']::text[], 'Unisex', 'jacket', 'Interchange',
   'The long-running INTERCHANGE 3-in-1: an Omni-Tech shell with a zip-out liner, each wearable alone. vs Whirlibird: both are Interchange parkas, so the system does NOT separate them — the LINER does (Bugaboo''s liner is classically a fleece; Whirlibird''s is an Omni-Heat insulated liner). Confirm BOTH pieces are present before listing it as 3-in-1.',
   ARRAY['Omni-Tech','Omni-Shield']::text[], 'long-running core', '$160-$230', ARRAY['bugaboo','interchange','3-in-1','omni-tech','parka']::text[],
   'https://www.columbia.com/omni-technologies.html', 0.75, false, 'migration:00453'),
  ('columbia', 'Whirlibird', ARRAY['whirlibird','whirlibird iv','whirlibird interchange']::text[], 'Unisex', 'jacket', 'Interchange',
   'The Omni-Heat INTERCHANGE parka — a waterproof Omni-Tech shell over a zip-out insulated liner with the silver reflective dot lining. The dotted liner is what separates it on sight from the Bugaboo. Same 3-in-1 caveat: a listing missing the liner is one piece of a two-piece system.',
   ARRAY['Omni-Tech','Omni-Heat']::text[], 'long-running core', '$200-$260', ARRAY['whirlibird','interchange','3-in-1','omni-heat','parka']::text[],
   'https://www.columbia.com/omni-technologies.html', 0.75, false, 'migration:00453'),
  ('columbia', 'Steens Mountain', ARRAY['steens mountain','steens','steens mountain full zip']::text[], 'Men', 'top', 'Steens Mountain',
   'The classic men''s full-zip fleece and one of the highest-VOLUME Columbia items in resale (low ASP — comp it as a basic fleece, not as technical outerwear). Plain sherpa-ish MTR filament fleece, zip hand pockets, no membrane and no reflective lining. Its women''s counterpart is Benton Springs — same fleece, different department, so read the CUT/department rather than the fabric to tell them apart.',
   ARRAY['MTR filament fleece']::text[], 'long-running core', '$40-$60', ARRAY['steens mountain','fleece','full zip']::text[],
   'https://www.columbia.com/omni-technologies.html', 0.72, false, 'migration:00453'),
  ('columbia', 'Benton Springs', ARRAY['benton springs','benton springs full zip']::text[], 'Women', 'top', 'Benton Springs',
   'The women''s classic full-zip fleece — the direct counterpart to the men''s Steens Mountain, in the same plain filament fleece with zip hand pockets. Because the FABRIC is identical, the department/cut is the only separator; do not call a Benton Springs a Steens Mountain.',
   ARRAY['MTR filament fleece']::text[], 'long-running core', '$40-$60', ARRAY['benton springs','fleece','full zip']::text[],
   'https://www.columbia.com/omni-technologies.html', 0.72, false, 'migration:00453'),
  ('columbia', 'Silver Ridge', ARRAY['silver ridge','silver ridge convertible']::text[], 'Unisex', 'pant', 'Silver Ridge',
   'The Omni-Shade sun/hiking pant, most often the CONVERTIBLE (zip-off leg) version — the zip ring at the knee is the tell. Lightweight ripstop nylon, not a fleece or a shell. UPF is the point of the garment, so name Omni-Shade in the listing.',
   ARRAY['Omni-Shade','Omni-Wick']::text[], 'long-running core', '$50-$70', ARRAY['silver ridge','convertible','omni-shade','hiking pant','upf']::text[],
   'https://www.columbia.com/omni-technologies.html', 0.70, false, 'migration:00453'),
  ('columbia', 'PFG Bahama II', ARRAY['bahama ii','pfg bahama','bahama']::text[], 'Men', 'shirt', 'PFG',
   'Performance Fishing Gear short-sleeve vented shirt: a mesh-lined back cape vent, roll-up sleeve tabs and rod holders. PFG carries its own logo and its own audience — title it PFG, because it comps separately from mainline Columbia. vs Tamiami II: Bahama is the SHORT-sleeve nylon one; Tamiami is the long-sleeve Omni-Wick one.',
   ARRAY['Omni-Shade','Omni-Wick']::text[], 'long-running core', '$45-$60', ARRAY['pfg','bahama','fishing shirt','vented']::text[],
   'https://www.columbia.com/omni-technologies.html', 0.70, false, 'migration:00453'),

  -- Arc'teryx: the suffix carries the price. Atom LT vs AR is the classic pair.
  ('arcteryx', 'Beta', ARRAY['beta','beta ar','beta lt','beta sl','beta jacket']::text[], 'Unisex', 'jacket', 'Beta',
   'The all-round GORE-TEX hardshell family — a waterproof shell with taped seams, a helmet-compatible StormHood and pit zips on the heavier tiers. The SUFFIX is the product: Beta SL (superlight emergency shell) < Beta LT < Beta AR (all-round, the volume seller) < Beta SV (severe weather, Gore-Tex Pro). Carry the suffix into the title — the tiers are different jackets at different prices.',
   ARRAY['GORE-TEX','GORE-TEX Pro']::text[], 'long-running core', '$400-$750', ARRAY['beta','beta ar','gore-tex','hardshell','stormhood']::text[],
   'https://arcteryx.com/us/en/explore/product-naming', 0.80, false, 'migration:00453'),
  ('arcteryx', 'Atom', ARRAY['atom','atom lt','atom ar','atom sl','atom hoody']::text[], 'Unisex', 'jacket', 'Atom',
   'THE most confusable Arc''teryx pair and the most common mis-listing. Coreloft SYNTHETIC insulation (not down) under a Tyono face. Atom LT has stretch FLEECE SIDE PANELS for breathability — look at the side body, that is the tell — while Atom AR is the warmer, fully-insulated winter version. Both are called "Atom Hoody" in casual listings; the suffix is what a buyer is actually shopping for.',
   ARRAY['Coreloft','Tyono']::text[], 'long-running core', '$260-$400', ARRAY['atom','atom lt','coreloft','synthetic insulation','hoody']::text[],
   'https://arcteryx.com/us/en/explore/product-naming', 0.80, false, 'migration:00453'),
  ('arcteryx', 'Cerium', ARRAY['cerium','cerium lt','cerium sl','cerium hoody']::text[], 'Unisex', 'jacket', 'Cerium',
   'The DOWN sibling of the Atom — 850-fill down with synthetic Coreloft placed in the moisture-prone zones (shoulders/cuffs). Down vs synthetic is the Cerium-vs-Atom call: Cerium is loftier and compresses far smaller. Reading the fill off the care tag settles it.',
   ARRAY['850 fill down','Coreloft']::text[], 'long-running core', '$400-$500', ARRAY['cerium','cerium lt','down','850 fill','hoody']::text[],
   'https://arcteryx.com/us/en/explore/product-naming', 0.75, false, 'migration:00453'),
  ('arcteryx', 'Gamma', ARRAY['gamma','gamma lt','gamma mx','gamma sl']::text[], 'Unisex', 'jacket', 'Gamma',
   'The SOFTSHELL family — stretch woven, air-permeable and water-RESISTANT, never waterproof. That is the separator from Beta: a Gamma has no membrane and no taped seams, so it must not be listed as a rain/Gore-Tex shell.',
   ARRAY['Fortius','softshell']::text[], 'long-running core', '$200-$350', ARRAY['gamma','gamma mx','softshell','stretch woven']::text[],
   'https://arcteryx.com/us/en/explore/product-naming', 0.72, false, 'migration:00453'),
  ('arcteryx', 'Alpha', ARRAY['alpha','alpha sv','alpha ar','alpha fl']::text[], 'Unisex', 'jacket', 'Alpha',
   'The ALPINE/climbing hardshell family — the most technical Gore-Tex tier, cut for a harness and a helmet with high hand pockets that clear a hipbelt. Alpha SV (severe weather, Gore-Tex Pro) is the flagship. vs Beta: Beta is the all-round hiking line, Alpha is climbing-specific.',
   ARRAY['GORE-TEX Pro']::text[], 'long-running core', '$600-$900', ARRAY['alpha','alpha sv','gore-tex pro','alpine','hardshell']::text[],
   'https://arcteryx.com/us/en/explore/product-naming', 0.72, false, 'migration:00453'),

  -- Marmot: the MEMBRANE separates two lookalike rain shells.
  ('marmot', 'PreCip', ARRAY['precip','precip eco','pre-cip']::text[], 'Unisex', 'jacket', 'PreCip',
   'The flagship budget rain jacket and Marmot''s highest-VOLUME resale item. Uses Marmot''s OWN NanoPro/MemBrain membrane — NOT Gore-Tex — with taped seams and PitZips. The tag wordmark is the call: MemBrain/NanoPro here vs GORE-TEX on the Minimalist, two shells that look nearly identical but comp very differently. PreCip Eco is the recycled-fabric version of the same jacket.',
   ARRAY['NanoPro','MemBrain']::text[], 'long-running core', '$100-$130', ARRAY['precip','precip eco','nanopro','membrain','rain jacket','pitzips']::text[],
   'https://www.marmot.com/technology.html', 0.75, false, 'migration:00453'),
  ('marmot', 'Minimalist', ARRAY['minimalist','minimalist jacket','minimalist gore-tex']::text[], 'Unisex', 'jacket', 'Minimalist',
   'The GORE-TEX (Paclite) rain shell — the licensed-membrane sibling of the PreCip and a materially more valuable jacket. If the tag says GORE-TEX it is not a PreCip; if it says MemBrain/NanoPro it is not a Minimalist. Name the membrane in the title.',
   ARRAY['GORE-TEX','GORE-TEX Paclite']::text[], 'long-running core', '$200-$275', ARRAY['minimalist','gore-tex','paclite','rain jacket']::text[],
   'https://www.marmot.com/technology.html', 0.72, false, 'migration:00453'),
  ('marmot', 'Guides Down Hoody', ARRAY['guides down','guides down hoody','guide down']::text[], 'Unisex', 'jacket', 'Guides Down',
   'The long-running down hoody — 700-fill down in sewn-through baffles with an insulated hood. Down, not synthetic: read the fill off the care tag rather than judging the loft.',
   ARRAY['700 fill down']::text[], 'long-running core', '$200-$260', ARRAY['guides down','down hoody','700 fill']::text[],
   'https://www.marmot.com/technology.html', 0.65, false, 'migration:00453'),

  -- REI Co-op: house-label models; the label itself is the dating evidence.
  ('reicoop', 'Rainier Rain Jacket', ARRAY['rainier','rainier rain jacket']::text[], 'Unisex', 'jacket', 'Rainier',
   'The classic entry-level REI Co-op waterproof shell and the brand''s highest-VOLUME resale piece — a 2.5-layer coated shell with taped seams and pit zips. It is a house-label budget jacket: comp it against other entry shells, never against a Gore-Tex hardshell.',
   ARRAY['waterproof breathable laminate']::text[], 'long-running core', '$100-$130', ARRAY['rainier','rain jacket','rei co-op','pit zips']::text[],
   'https://www.rei.com/about-rei', 0.65, false, 'migration:00453'),
  ('reicoop', 'XeroDry GTX', ARRAY['xerodry','xerodry gtx','xero dry']::text[], 'Unisex', 'jacket', 'XeroDry',
   'The GORE-TEX house shell — the licensed-membrane step above the Rainier. GTX in the name is the whole point of the garment; carry it into the title, because it is what separates this from the coated Rainier at nearly double the value.',
   ARRAY['GORE-TEX']::text[], 'current', '$180-$230', ARRAY['xerodry','gtx','gore-tex','rain jacket']::text[],
   'https://www.rei.com/about-rei', 0.60, false, 'migration:00453'),
  ('reicoop', 'Flash', ARRAY['flash','flash 55','flash insulated','flash air']::text[], 'Unisex', 'jacket', 'Flash',
   'The ULTRALIGHT sub-line — the name marks a weight class, not one garment (it spans packs, insulated jackets and shells). So "Flash" alone does not identify a product: pair it with the garment type and, where present, the number.',
   ARRAY[]::text[], 'current', null, ARRAY['flash','ultralight','rei co-op']::text[],
   'https://www.rei.com/about-rei', 0.55, false, 'migration:00453'),
  ('reicoop', 'Co-op Cycles', ARRAY['co-op cycles','coop cycles','drt','adv']::text[], 'Unisex', 'other', 'Co-op Cycles',
   'The house BICYCLE line (DRT mountain / ADV adventure / CTY city). Recorded so a Co-op Cycles listing is not mistaken for apparel — it is a different category entirely.',
   ARRAY[]::text[], '2017-present', null, ARRAY['co-op cycles','bike','drt','adv']::text[],
   'https://www.rei.com/about-rei', 0.55, false, 'migration:00453'),

  -- L.L.Bean: heritage models. The Bean Boot is the whole resale story.
  ('llbean', 'Bean Boot', ARRAY['bean boot','bean boots','maine hunting shoe','duck boot']::text[], 'Unisex', 'other', 'Bean Boot',
   'THE icon and the brand''s highest-value resale item: the Maine Hunting Shoe (1912) — a rubber bottom stitched to a leather upper, sized by height (6"/8"/10"/16") and by shaft, often lined (Thinsulate/shearling). STILL MADE IN MAINE, so a Made-in-USA stamp is expected here rather than notable. The rubber bottoms are RESOLEABLE, which holds value on a visibly worn pair — say so instead of discounting it as worn out.',
   ARRAY['rubber','leather']::text[], '1912-present', '$130-$200', ARRAY['bean boot','duck boot','maine hunting shoe','made in usa']::text[],
   'https://www.llbean.com/llb/shop/516886', 0.80, false, 'migration:00453'),
  ('llbean', 'Scotch Plaid Flannel Shirt', ARRAY['scotch plaid','scotch plaid flannel','bean flannel']::text[], 'Unisex', 'shirt', 'Scotch Plaid',
   'The long-running heavyweight brushed-cotton flannel in named tartan plaids — a high-volume Bean resale item with a real vintage market. A Made-in-USA tag on this (unlike on a Bean Boot) skews VINTAGE, since modern Bean apparel is imported. Runs generous like the rest of the line: measure it.',
   ARRAY['brushed cotton flannel']::text[], 'long-running core', '$60-$80', ARRAY['scotch plaid','flannel','tartan','llbean']::text[],
   'https://www.llbean.com/llb/shop/516886', 0.70, false, 'migration:00453'),
  ('llbean', 'Boat and Tote', ARRAY['boat and tote','boat & tote','bean tote']::text[], 'Unisex', 'other', 'Boat and Tote',
   'The canvas tote (1944) with contrast handles and optional monogram — still made in Maine. NOTE: a MONOGRAM is personalization, not a defect, but it materially narrows the buyer pool; always disclose the initials and photograph them.',
   ARRAY['canvas']::text[], '1944-present', '$35-$60', ARRAY['boat and tote','tote','canvas','monogram','made in usa']::text[],
   'https://www.llbean.com/llb/shop/516886', 0.70, false, 'migration:00453'),
  ('llbean', 'Wicked Good Slippers', ARRAY['wicked good','wicked good slippers']::text[], 'Unisex', 'other', 'Wicked Good',
   'Shearling-lined suede slippers — a perennial Bean seller. "Wicked Good" is the brand''s shearling sub-line name (Maine idiom), not a condition claim; do not read it as a grade.',
   ARRAY['shearling','suede']::text[], 'long-running core', '$80-$100', ARRAY['wicked good','slippers','shearling']::text[],
   'https://www.llbean.com/llb/shop/516886', 0.65, false, 'migration:00453'),

  -- Mountain Hardwear: Ghost Whisperer carries the group's ultralight value.
  ('mountainhardwear', 'Ghost Whisperer', ARRAY['ghost whisperer','ghost whisperer 2','ghost whisperer ul','ghostwhisperer']::text[], 'Unisex', 'jacket', 'Ghost Whisperer',
   'The brand''s highest-VALUE resale piece: an ultralight 800/1000-fill down hoody in a 7D/10D nylon shell. The fabric is the tell — extraordinarily thin, semi-translucent and audibly crinkly, packing to roughly a fist. An ordinary-feeling puffer claiming to be a Ghost Whisperer is a real inconsistency; weigh it and check the packed size rather than eyeballing the loft.',
   ARRAY['800 fill down','1000 fill down','7D nylon','10D nylon']::text[], '2013-present', '$325-$400', ARRAY['ghost whisperer','ultralight','down','800 fill','packable']::text[],
   'https://www.mountainhardwear.com/about-us.html', 0.75, false, 'migration:00453'),
  ('mountainhardwear', 'Stretchdown', ARRAY['stretchdown','stretch down','stretchdown hoody']::text[], 'Unisex', 'jacket', 'Stretchdown',
   'Down jacket whose baffles are WELDED/bonded rather than sewn through — continuous stretch channels with no needle holes along the quilt lines. That is a construction fact readable straight off a photo, making it the most objective line call in the brand.',
   ARRAY['700 fill down','welded baffles']::text[], 'current', '$250-$320', ARRAY['stretchdown','welded baffle','down','bonded']::text[],
   'https://www.mountainhardwear.com/about-us.html', 0.70, false, 'migration:00453'),
  ('mountainhardwear', 'Monkey Fleece', ARRAY['monkey fleece','monkey man','monkey woman','polartec high loft']::text[], 'Unisex', 'top', 'Monkey Fleece',
   'The cult high-loft Polartec Thermal Pro fleece — a deep, shaggy, almost furry pile that looks nothing like a flat microfleece. The pile depth is unmistakable in a photo and there is a real collector market, so name it Monkey Fleece/Monkey Man rather than listing it as a generic fleece.',
   ARRAY['Polartec Thermal Pro','high-loft fleece']::text[], 'long-running cult', '$150-$200', ARRAY['monkey fleece','monkey man','polartec','high loft','shaggy']::text[],
   'https://www.mountainhardwear.com/about-us.html', 0.65, false, 'migration:00453'),
  ('mountainhardwear', 'Kor', ARRAY['kor','kor airshell','kor preshell','kor strata']::text[], 'Unisex', 'jacket', 'Kor',
   'The lightweight wind/air-permeable family: Kor AirShell (windshell), Kor Preshell (breathable weather resistance), Kor Strata (active synthetic insulation). Kor is a LINE, not one garment — pair the name with its sub-variant.',
   ARRAY['Pertex','synthetic insulation']::text[], 'current', '$130-$250', ARRAY['kor','airshell','preshell','strata','windshell']::text[],
   'https://www.mountainhardwear.com/about-us.html', 0.60, false, 'migration:00453')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Arc'teryx ONLY ───────────────────────────────────────
-- Arc'teryx is the only brand in this group whose garment-printed identifier is
-- REGULAR: the [MODEL] + [weight-class SUFFIX] naming system. "Atom LT" / "Beta
-- AR" are Arc'teryx-unique compounds — no other apparel brand names products this
-- way — so an anchored pattern requiring BOTH parts recovers the brand off a cut
-- tag with no realistic false-positive risk. A bare model word ("Alpha") or a bare
-- suffix ("AR") deliberately does NOT match: on their own they are ordinary
-- English and would false-recover a brand from any tag that happened to say them.
--
-- Deliberately NOT decoded for the other five: Columbia/Marmot/REI/L.L.Bean item
-- numbers are retailer/catalog SKUs. They are not brand-unique in format, so a
-- pattern over them would claim a recovery the format cannot support.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('arcteryx', 'style_name',
   'Arc''teryx MODEL + weight-class SUFFIX printed on the garment/tag (SL=Superlight, LT=Lightweight, AR=All-Round, SV=Severe Weather, MX=Mixed conditions, FL=Fast and Light) — e.g. "Atom LT", "Beta AR".',
   '^(?<style>(?:Alpha|Beta|Gamma|Zeta|Atom|Cerium|Proton|Delta|Nuclei|Sabre|Sentinel|Rush|Kyanite|Incendo|Squamish)\s+(?:SL|LT|AR|SV|MX|FL))$',
   $j${"fieldMap":{"style":"styleCode"},"transforms":{"style":"upper"},"confidence":0.7}$j$::jsonb,
   $j$[{"code":"Atom LT","expected":{"styleCode":"ATOM LT"}},{"code":"Beta AR","expected":{"styleCode":"BETA AR"}},{"code":"Alpha SV","expected":{"styleCode":"ALPHA SV"}},{"code":"Alpha","expected":null,"note":"A bare model word is ordinary English — it must NOT recover a brand."},{"code":"AR","expected":null,"note":"A bare suffix must NOT recover a brand."}]$j$::jsonb,
   'https://arcteryx.com/us/en/explore/product-naming', 0.70, false, 'migration:00453')
on conflict (brand_key, decoder_kind) do nothing;

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Only where the brand genuinely uses proprietary NAMED colors that persist
-- across seasons. Arc'teryx is the strongest case in the group (its colorway
-- names carry real resale signal — Kingfisher is a recognized collector color).
-- Deliberately NOT seeded: Marmot / REI Co-op / L.L.Bean / Mountain Hardwear —
-- their color names are largely descriptive and rotate per season rather than
-- forming a stable dictionary.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('arcteryx', 'Kingfisher', ARRAY['kingfisher']::text[], null, null, 'https://arcteryx.com/us/en/explore/product-naming', 0.70, false, 'migration:00453'),
  ('arcteryx', 'Black Sapphire', ARRAY['black sapphire']::text[], null, null, 'https://arcteryx.com/us/en/explore/product-naming', 0.65, false, 'migration:00453'),
  ('arcteryx', 'Black', ARRAY['black']::text[], '#000000', null, 'https://arcteryx.com/us/en/explore/product-naming', 0.80, false, 'migration:00453'),
  ('columbia', 'Collegiate Navy', ARRAY['collegiate navy']::text[], null, null, 'https://www.columbia.com/omni-technologies.html', 0.65, false, 'migration:00453'),
  ('columbia', 'Black', ARRAY['black']::text[], '#000000', null, 'https://www.columbia.com/omni-technologies.html', 0.80, false, 'migration:00453')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts (INCHES, BODY measurements) ───────────────────────────
-- Every chart below is BODY measurement (the wearer), NOT flat-garment. That
-- matters even more in this category than in activewear: an outdoor SHELL is cut
-- with deliberate layering room, so its flat chest measures well ABOVE the body
-- chest it is sized to — the opposite direction of the compression-legging error,
-- and just as wrong. Each note states the basis.
--
-- HONESTY NOTE ON CONFIDENCE: outdoor brands cluster tightly on the standard US
-- alpha chest grade, and these charts are that shared grade rather than values
-- fetched from each brand's own published guide. They are seeded at LOW/CAPPED
-- confidence with the approximation stated in the note, so the US-1715 verifier
-- knows to replace them with brand-fetched figures rather than rubber-stamp them.
-- The Columbia rows reuse the outerwear grade already shipped in 00389.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('columbia', 'Columbia', ARRAY['columbia','columbia sportswear']::text[], 'Men', 'Tops', ARRAY['top','tee','shirt','polo','hoodie','fleece','jacket','coat','shell','parka','vest','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"33-35"}},{"size":"S","measurements":{"chest":"35-38"}},{"size":"M","measurements":{"chest":"38-41"}},{"size":"L","measurements":{"chest":"42-45"}},{"size":"XL","measurements":{"chest":"46-49"}},{"size":"XXL","measurements":{"chest":"50-53"}}]$json$::jsonb,
   'BODY measurement (tape under the arms at the fullest part of the chest) — NOT flat-garment. An outdoor shell is cut with layering room, so its FLAT chest measures well above the body chest listed here; never compare this chart to a flat-lay tape. Same alpha grade as the shared outdoor-outerwear chart in 00389. Standard outdoor-alpha approximation rather than Columbia-fetched figures — capped confidence, verify against Columbia''s own guide.',
   'https://www.columbia.com/omni-technologies.html', 0.60, false, 'migration:00453'),
  ('columbia', 'Columbia', ARRAY['columbia','columbia sportswear']::text[], 'Women', 'Tops', ARRAY['top','tee','shirt','tank','fleece','hoodie','jacket','coat','shell','parka','vest','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}},{"size":"XXL","measurements":{"bust":"44-46"}}]$json$::jsonb,
   'BODY measurement (fullest part of the bust) — NOT flat-garment; outdoor cuts carry layering room. Standard outdoor-alpha approximation rather than Columbia-fetched figures — capped confidence, verify against Columbia''s own guide.',
   'https://www.columbia.com/omni-technologies.html', 0.55, false, 'migration:00453'),
  ('columbia', 'Columbia', ARRAY['columbia','columbia sportswear']::text[], 'Men', 'Bottoms', ARRAY['bottom','pant','short','trouser','hiking pant','convertible']::text[],
   $json$[{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}},{"size":"W40","measurements":{"waist":"40"}}]$json$::jsonb,
   'BODY measurement (natural waistline) — NOT flat-garment. Columbia men''s hiking pants are labeled W (waist) x L (inseam) in inches, so the label IS the measurement. INSEAM is a separate axis (commonly 30/32/34) and the Silver Ridge convertible zips off to a short — capture the zip-off as an attribute, not as a size.',
   'https://www.columbia.com/omni-technologies.html', 0.60, false, 'migration:00453'),

  ('arcteryx', 'Arc''teryx', ARRAY['arc''teryx','arcteryx','arc teryx']::text[], 'Men', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','hardshell','softshell','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"chest":"33-35"}},{"size":"S","measurements":{"chest":"35-38"}},{"size":"M","measurements":{"chest":"38-41"}},{"size":"L","measurements":{"chest":"42-45"}},{"size":"XL","measurements":{"chest":"46-49"}},{"size":"XXL","measurements":{"chest":"50-53"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. IMPORTANT: the FIT varies by suffix, not by size — an Alpha/Beta hardshell is cut for layering while an Atom LT is trim, so the same body chest can wear a different letter across the lines. State the flat measurements and the suffix. Standard outdoor-alpha approximation rather than Arc''teryx-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://arcteryx.com/us/en/explore/product-naming', 0.55, false, 'migration:00453'),
  ('arcteryx', 'Arc''teryx', ARRAY['arc''teryx','arcteryx','arc teryx']::text[], 'Women', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','hardshell','softshell','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Same suffix-drives-fit caveat as the men''s chart. Standard outdoor-alpha approximation rather than Arc''teryx-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://arcteryx.com/us/en/explore/product-naming', 0.55, false, 'migration:00453'),

  ('marmot', 'Marmot', ARRAY['marmot']::text[], 'Men', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','rain jacket','long sleeve']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-38"}},{"size":"M","measurements":{"chest":"38-41"}},{"size":"L","measurements":{"chest":"42-45"}},{"size":"XL","measurements":{"chest":"46-49"}},{"size":"XXL","measurements":{"chest":"50-53"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment; a rain shell is cut with layering room over this. Standard outdoor-alpha approximation rather than Marmot-fetched figures — capped confidence, verify against Marmot''s own guide.',
   'https://www.marmot.com/technology.html', 0.55, false, 'migration:00453'),
  ('marmot', 'Marmot', ARRAY['marmot']::text[], 'Women', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','rain jacket','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Standard outdoor-alpha approximation rather than Marmot-fetched figures — capped confidence, verify against Marmot''s own guide.',
   'https://www.marmot.com/technology.html', 0.55, false, 'migration:00453'),

  ('reicoop', 'REI Co-op', ARRAY['rei co-op','rei coop','reicoop','rei']::text[], 'Men', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','rain jacket','shirt','long sleeve']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-38"}},{"size":"M","measurements":{"chest":"38-41"}},{"size":"L","measurements":{"chest":"42-45"}},{"size":"XL","measurements":{"chest":"46-49"}},{"size":"XXL","measurements":{"chest":"50-53"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment; house-label shells carry layering room. Standard outdoor-alpha approximation rather than REI-fetched figures — capped confidence, verify against REI''s own guide.',
   'https://www.rei.com/about-rei', 0.55, false, 'migration:00453'),
  ('reicoop', 'REI Co-op', ARRAY['rei co-op','rei coop','reicoop','rei']::text[], 'Women', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','rain jacket','shirt','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Standard outdoor-alpha approximation rather than REI-fetched figures — capped confidence, verify against REI''s own guide.',
   'https://www.rei.com/about-rei', 0.55, false, 'migration:00453'),

  ('llbean', 'L.L.Bean', ARRAY['l.l.bean','llbean','l.l. bean','ll bean']::text[], 'Men', 'Tops', ARRAY['top','shirt','flannel','tee','polo','sweater','hoodie','fleece','jacket','coat','vest','long sleeve']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"42-44"}},{"size":"XL","measurements":{"chest":"46-48"}},{"size":"XXL","measurements":{"chest":"50-52"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. CRITICAL L.L.BEAN CAVEAT: the classic Bean cut runs GENEROUS/relaxed, so the FINISHED garment is roomier than this body chart implies and a Bean Medium wears larger than a Medium from a technical brand. This chart maps body-to-label; it does NOT predict the flat measurement. Always measure the garment and publish the flat figures. Standard US men''s alpha approximation rather than Bean-fetched figures — capped confidence.',
   'https://www.llbean.com/llb/shop/516886', 0.55, false, 'migration:00453'),
  ('llbean', 'L.L.Bean', ARRAY['l.l.bean','llbean','l.l. bean','ll bean']::text[], 'Men', 'Bottoms', ARRAY['bottom','pant','short','trouser','chino','jean']::text[],
   $json$[{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}},{"size":"W40","measurements":{"waist":"40"}}]$json$::jsonb,
   'BODY measurement (natural waistline) — NOT flat-garment. L.L.Bean men''s pants are labeled W (waist) x L (inseam) in inches, so the label IS the measurement. Bean also grades LENGTH as a named axis (Regular/Tall) alongside the numeric inseam — capture it separately, not as part of the size.',
   'https://www.llbean.com/llb/shop/516886', 0.60, false, 'migration:00453'),
  ('llbean', 'L.L.Bean', ARRAY['l.l.bean','llbean','l.l. bean','ll bean']::text[], 'Women', 'Tops', ARRAY['top','shirt','flannel','tee','sweater','hoodie','fleece','jacket','coat','vest','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Same generous-cut caveat as the men''s chart: the finished garment runs roomier than this body chart implies, so measure and publish the flat figures. Standard US women''s alpha approximation rather than Bean-fetched figures — capped confidence.',
   'https://www.llbean.com/llb/shop/516886', 0.55, false, 'migration:00453'),

  ('mountainhardwear', 'Mountain Hardwear', ARRAY['mountain hardwear','mountainhardwear','mhw']::text[], 'Men', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','down','long sleeve']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-38"}},{"size":"M","measurements":{"chest":"38-41"}},{"size":"L","measurements":{"chest":"42-45"}},{"size":"XL","measurements":{"chest":"46-49"}},{"size":"XXL","measurements":{"chest":"50-53"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. NOTE the intra-brand fit spread: the Ghost Whisperer is cut trim/athletic as an ultralight layer while the Kor shells allow layering room, so the same body chest can wear a different letter across the lines. Standard outdoor-alpha approximation rather than MHW-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.mountainhardwear.com/about-us.html', 0.55, false, 'migration:00453'),
  ('mountainhardwear', 'Mountain Hardwear', ARRAY['mountain hardwear','mountainhardwear','mhw']::text[], 'Women', 'Tops', ARRAY['top','jacket','coat','shell','hoodie','fleece','vest','down','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb,
   'BODY measurement — NOT flat-garment. Same intra-brand fit spread as the men''s chart (trim Ghost Whisperer vs layering-cut Kor). Standard outdoor-alpha approximation rather than MHW-fetched figures — capped confidence, verify against the brand''s own guide.',
   'https://www.mountainhardwear.com/about-us.html', 0.55, false, 'migration:00453')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- Columbia and Arc'teryx now have their OWN brand_size_charts above, so drop them
-- from the shared 00389 outdoor-outerwear chart's brand_match. Without this the
-- resolver returns BOTH the shared row and the brand row for one brand — two
-- charts with the same numbers, competing for the 3-chart prompt budget. The
-- shared row stays for The North Face + Patagonia, which have no own-brand chart.
-- Mirrors the same narrowing in the in-code sizing-charts.ts fallback.
update public.brand_size_charts
   set brand_match = ARRAY['north face','patagonia']::text[],
       updated_by = 'migration:00453'
 where brand_key = 'thenorthfacepatagoniaouterwear';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00453') on conflict do nothing;
