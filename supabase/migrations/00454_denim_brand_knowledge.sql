-- US-1735: Premium & vintage denim brand knowledge group (6 brands).
--
-- Wrangler, Lee, 7 For All Mankind, True Religion, AG Jeans, Citizens of
-- Humanity — the denim tier beside Levi's (00393), which is already seeded and
-- is deliberately NOT re-touched here.
--
-- The through-line for this group is that denim VALUE TIER is decided by two
-- things the garment itself carries: the FIT (which is a named model, printed on
-- the tag) and the TAG ERA (which dates the piece). That splits the pack cleanly
-- in half and is why the group is worth one migration:
--
--   * VINTAGE tier (Wrangler / Lee) — value comes from the ERA, not the model.
--     Both are heritage workwear names whose current production is ordinary
--     mass-market denim worth very little, while a pre-1980s example of the SAME
--     model number is worth many multiples. So the dating tells are the highest-
--     leverage facts on these two brands and are seeded as first-class tag_eras:
--       - Wrangler: a "Blue Bell" tag is pre-VF (VF bought Blue Bell in 1986).
--       - Lee: a "UNION MADE" tag is pre-~1970s domestic-union production.
--     Both also stitch their identity on the back pocket (Wrangler's broken-W,
--     Lee's Lazy-S), which survives when the tag is gone.
--
--   * PREMIUM tier (7FAM / True Religion / AG / Citizens) — value comes from the
--     FIT NAME, and the fit name is a proper noun on the tag (Slimmy, Ricky,
--     Graduate, Rocket). Era is nearly worthless here: 2000s premium denim is not
--     collectible the way 1970s Wrangler is; a 2005 pair of Sevens is just an old
--     pair of Sevens. So NO tag_eras are seeded for 7FAM/AG/Citizens — there is no
--     authoritative era documentation and no resale reason to date them. True
--     Religion is the ONE exception, because its early Made-in-USA production is a
--     documented, resale-relevant boundary.
--
-- CORPORATE MAP (recorded in the notes because a shared parent looks like a
-- counterfeit signal to a naive model, and it is not): Wrangler and Lee are BOTH
-- Kontoor Brands (2019 spin-off from VF). VF also owned 7 For All Mankind from
-- 2007 until selling it to Delta Galil in 2016. And Jerome Dahan co-founded 7 For
-- All Mankind, then left to found Citizens of Humanity — which is why the two
-- brands' back-pocket arcs and fit blocks resemble each other. Citizens in turn
-- owns AGOLDE, whose name reads like AG Jeans but is a DIFFERENT company.
--
-- DECODERS — seeded for exactly TWO of the six, on the same rule the rest of the
-- epic uses (tag-printed AND regular AND brand-unique):
--   * Wrangler style_number — the MW family (13MWZ = 13oz Men's With Zipper,
--     47MWZ, 936DEN). The suffix is a Wrangler-only convention.
--   * True Religion style_name — MODEL + stitch-weight SUFFIX ("Ricky Super T").
--     A bare "Ricky" is an ordinary first name and must never mint a brand; the
--     compound with Super T / Big T is True-Religion-unique. This mirrors the
--     Arc'teryx model+suffix precedent in 00453 and is this group's CUT-TAG case.
-- Deliberately NOT decoded: Lee's 101 family is a MODEL, not a code — "101" is an
-- ordinary number with no brand-unique format, and modern Lee item numbers are
-- retailer SKUs. 7FAM / AG / Citizens print a fit NAME, not a regular code.
--
-- Data-only, idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
-- Wrangler + Lee enrich their bare 00389 alias-only rows; the four premium
-- brands are new.
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  ('wrangler', 'Wrangler', ARRAY['wrangler','wrangler jeans','blue bell wrangler','bluebell']::text[],
   ARRAY['denim','workwear','western','americana','vintage','mens','womens']::text[],
   $j$[{"era":"Blue Bell Wrangler","years":"1947-1986","description":"The tag reads BLUE BELL alongside Wrangler. Blue Bell was the parent that launched the Wrangler denim name in 1947; VF Corporation ACQUIRED Blue Bell in 1986 and the Blue Bell mark left the tag. A Blue Bell tag therefore puts the garment before the mid-1980s and is the single most valuable Wrangler dating tell — it is what separates a collectible pair from an ordinary modern one carrying the SAME model number."},{"era":"Made in USA","years":"pre-2000s","description":"Wrangler denim was domestically sewn for decades before production moved offshore. On this brand a Made-in-USA tag skews VINTAGE and is a value signal — the opposite of a modern imported pair, which is unremarkable."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA (vintage) / Imported (current)","note":"Origin is an ERA hint on this brand rather than an authenticity verdict: domestic production skews vintage/collectible, and an imported modern pair is entirely normal."}]$j$::jsonb,
   $j$[{"tell":"The broken-W back pocket stitch","detail":"Wrangler's signature is the WESTERN 'broken W' stitched on both back pockets — two mirrored Ws meeting in the middle. It is sewn into the garment, so it identifies the brand even when the tag and patch are gone. This is the primary Wrangler read on an unlabelled photo."},{"tell":"A BLUE BELL tag dates the garment pre-1986","detail":"HIGHEST-VALUE WRANGLER FACT. Blue Bell launched Wrangler in 1947 and VF acquired Blue Bell in 1986, retiring the mark from the tag. Blue Bell present = pre-mid-1980s. Since a modern 13MWZ and a 1970s 13MWZ carry the same model number, the tag era — not the model — is what sets the price."},{"tell":"The model number IS on the tag and it is decodable","detail":"Wrangler prints its model on the tag (13MWZ, 47MWZ, 936DEN). 13MWZ = 13-ounce Men's With Zipper — the digits are the denim WEIGHT and MW = Men's Western. This is a real brand-unique convention, which is why Wrangler is one of only two brands in this pack with a seeded decoder. Transcribe it verbatim."},{"tell":"Cowboy Cut is a fit family, not one jean","detail":"The Cowboy Cut line spans 13MWZ (original), 936DEN (slim), 47MWZ (slim-fit) and others. Carry the model number into the title — the fits comp differently and a buyer shops the number."},{"tell":"Never auto-authenticate","detail":"No Wrangler serial, date code or published authentication standard exists. Counterfeiting is not the risk on this brand — MISDATING is (calling a modern pair vintage is the costly error). Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Wrangler identity = the broken-W pocket stitch + the tag-printed model number (13MWZ), with the TAG ERA setting the value. Founded as a denim name in 1947 by Blue Bell (the 13MWZ was designed with rodeo tailor Rodeo Ben); VF Corporation acquired Blue Bell in 1986; since 2019 Wrangler has been part of KONTOOR BRANDS, the VF spin-off it shares with Lee — the sibling in this same pack, so a shared parent is expected and is NOT a counterfeit signal. RN omitted — not sourceable.',
   'https://www.wrangler.com/', 0.75, false, 'migration:00454'),

  ('lee', 'Lee', ARRAY['lee','lee jeans','h.d. lee','hd lee','lee riders']::text[],
   ARRAY['denim','workwear','americana','vintage','mens','womens']::text[],
   $j$[{"era":"UNION MADE","years":"pre-1970s","description":"A UNION MADE label (often with a garment-workers' union stamp) marks domestic unionized production and is the classic Lee vintage boundary — it is the first thing a vintage Lee buyer looks for. Union labels largely left the tags as production moved, so UNION MADE present = an early piece."},{"era":"Sanforized","years":"mid-century","description":"A SANFORIZED stamp on the tag marks the pre-shrunk treatment and reads as a mid-century-era tell rather than a modern one. Corroborating evidence, not proof on its own."},{"era":"Hair-on-hide leather patch","years":"vintage","description":"Older Lee jeans carry a leather patch with the hair still on the hide, rather than the smooth modern patch or a printed label. A hair-on patch skews vintage."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA (vintage) / Imported (current)","note":"Like Wrangler, origin is an ERA hint on this brand: domestic production skews vintage, imported modern production is normal and unremarkable."}]$j$::jsonb,
   $j$[{"tell":"The Lazy-S back pocket stitch","detail":"Lee's signature is the LAZY S — a long, shallow S curve stitched across both back pockets. It is the direct counterpart to Wrangler's broken-W and to Levi's arcuate, and it is the fastest way to separate the three heritage denim brands on an unlabelled photo. Sewn into the garment, so it survives a missing tag."},{"tell":"A UNION MADE tag dates the garment early","detail":"HIGHEST-VALUE LEE FACT. UNION MADE marks domestic unionized production and is the vintage boundary buyers search on. As with Wrangler, the ERA rather than the model sets the price — a modern 101 is ordinary denim and a union-made 101 is not."},{"tell":"The 101 is a MODEL family, not a decodable code","detail":"101B (button fly), 101Z (zip fly) and 101J (the jacket) are Lee's classic numbers. Deliberately NOT seeded as a decoder: '101' is an ordinary number with no brand-unique format, so a pattern over it would false-recover Lee from any tag that happened to say 101. Treat the number as a model name that must be CORROBORATED by a Lee tag or the Lazy-S, never as brand evidence on its own."},{"tell":"Storm Rider is the collectible","detail":"The Storm Rider is the blanket-lined denim jacket (a 101J with a plaid blanket lining and corduroy collar) and it is the brand''s highest-value vintage piece. The lining and the cord collar are visible in a photo — name it Storm Rider rather than listing it as a generic denim jacket."},{"tell":"Never auto-authenticate","detail":"No Lee serial, date code or published authentication standard exists. The risk on this brand is MISDATING, not counterfeiting. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Lee identity = the Lazy-S pocket stitch + the 101 model family, with the TAG ERA (UNION MADE) setting the value. Founded 1889 in Salina, Kansas by Henry David Lee as the H.D. Lee Mercantile Company; the Union-All coverall (1913) and the 101 jeans are its heritage. Since 2019 Lee has been part of KONTOOR BRANDS, the VF spin-off it shares with Wrangler — the sibling in this same pack, so a shared parent is expected and is NOT a counterfeit signal. No decoder — see the 101 tell. RN omitted — not sourceable.',
   'https://www.lee.com/', 0.75, false, 'migration:00454'),

  -- The four premium brands. Era is NOT seeded for three of them (see the header):
  -- 2000s premium denim is not collectible by age, so a fabricated era would be
  -- worse than none. True Religion is the exception and gets a documented one.
  ('7forallmankind', '7 For All Mankind', ARRAY['7 for all mankind','7forallmankind','seven for all mankind','sevenforallmankind','7fam','seven jeans']::text[],
   ARRAY['denim','premium','contemporary','womens','mens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA (early) / Imported (current)","note":"Early Sevens were cut and sewn in Los Angeles; current production is largely offshore. This is a weak era hint ONLY — unlike Wrangler/Lee it carries little value signal, because 2000s premium denim is not collectible by age."}]$j$::jsonb,
   $j$[{"tell":"The squiggle back pocket stitch","detail":"7 For All Mankind's signature is the SQUIGGLE — a loose, freehand-looking wavy line stitched across both back pockets. It is the brand read on an unlabelled photo and it is what separates a Seven from the other premium-denim arcs. Sewn in, so it survives a missing tag."},{"tell":"The FIT NAME is the product and it is on the tag","detail":"HIGHEST-VALUE 7FAM FACT. Value here tracks the FIT, not the era: Slimmy, Dojo, Roxanne, Standard, Josefina. The name is printed on the tag beside the size — read it and carry it into the title, because a buyer shops the fit name."},{"tell":"The 'A' pocket is a Dojo tell","detail":"The Dojo's back pockets carry a large squiggle whose form reads as an A — the wide-leg Dojo and the trouser fits are distinguished by the pocket, not by the tag alone."},{"tell":"Counterfeited — never auto-authenticate","detail":"7FAM was heavily counterfeited during the 2000s premium-denim boom, and the tells circulating online come from low-authority sources. No published authentication standard, serial or date code exists. Route authenticity to human review; never emit an authentic/fake verdict."}]$j$::jsonb,
   '7 For All Mankind identity = the SQUIGGLE pocket stitch + the tag-printed FIT NAME (Slimmy / Dojo / Roxanne). Founded 2000 in Los Angeles by Michael Glasser, Peter Koral and Jerome Dahan — one of the brands that created the 2000s premium-denim category. Acquired by VF Corporation in 2007 and SOLD TO DELTA GALIL in 2016. Cross-brand note: co-founder Jerome Dahan left and founded CITIZENS OF HUMANITY (also in this pack), which is why the two brands'' pocket arcs and fit blocks resemble each other — a resemblance that is shared lineage, not a copy. No decoder: the tag carries a fit NAME, not a regular code. RN omitted — not sourceable.',
   'https://www.7forallmankind.com/', 0.70, false, 'migration:00454'),

  ('truereligion', 'True Religion', ARRAY['true religion','truereligion','true religion brand jeans','true religion apparel']::text[],
   ARRAY['denim','premium','streetwear','womens','mens']::text[],
   $j$[{"era":"Made in USA","years":"2002-late 2000s","description":"Early True Religion was cut and sewn in the USA and the tag says so. This is the ONE era boundary in the premium half of this pack that carries real resale signal — the Made-in-USA thick-stitch era is what the vintage-TR market actually shops for. Later production moved offshore, so an imported pair is ordinary rather than suspect."}]$j$::jsonb,
   $j$[{"pattern":"Made in USA (early) / Imported (current)","note":"Domestic production marks the early era and is a genuine value signal on this brand. It is NOT an authenticity test — counterfeits print Made in USA too, so never read origin as proof."}]$j$::jsonb,
   $j$[{"tell":"The HORSESHOE back pocket stitch","detail":"True Religion's signature is the HORSESHOE — a bold inverted-U arc stitched across both back pockets. Together with the Buddha logo it is the brand read on an unlabelled photo, and it is sewn in, so it survives a missing tag."},{"tell":"Super T vs Big T is the STITCH WEIGHT and it sets the price","detail":"HIGHEST-VALUE TRUE RELIGION FACT. The line is defined by visibly thick contrast topstitching, and the grade is named: Big T is thick, SUPER T is the thickest (the heavy #55-gauge look). The stitch is the product — it is measurable in a photo, and a Super T comps well above a standard-stitch pair of the same fit. This is why the compound MODEL + Super T/Big T is the one True Religion string worth decoding."},{"tell":"The fit name is an ordinary first name — corroborate it","detail":"The fits are people: Ricky (men''s relaxed straight, the volume seller), Joey (flare), Billy (bootcut), Geno, Bobby, Becky. Because these are ordinary first names they are NOT brand evidence on their own — a bare 'Ricky' must never recover the brand. Only the compound with Super T / Big T is True-Religion-unique."},{"tell":"The Buddha logo","detail":"The seated Buddha with a guitar is the house mark, appearing on the patch and the flasher tag. Consistent with genuine; never proof."},{"tell":"One of the most counterfeited denim brands — never auto-authenticate","detail":"True Religion is among the most faked denim labels in resale. No published authentication standard, serial or date code exists, and the tells circulating online are low-authority. Flag inconsistencies in condition_notes and route to human review; never emit an authentic/fake verdict."}]$j$::jsonb,
   'True Religion identity = the HORSESHOE pocket stitch + the Buddha logo + the STITCH WEIGHT grade (Big T / Super T), with the fit name (Ricky / Joey / Billy) naming the block. Founded 2002 in Los Angeles by Jeffrey Lubell; the thick contrast topstitch is the brand''s whole design premise. The MODEL + Super T/Big T compound is the group''s decodable cut-tag string. RN omitted — not sourceable.',
   'https://www.truereligion.com/', 0.75, false, 'migration:00454'),

  -- NOTE: canonical is "AG Jeans", NOT "AG". A bare "AG" is two letters that occur
  -- inside other brand names (notably "patAGonia"), so the short form is kept as an
  -- exact-match ALIAS only and never as the canonical string or a chart substring.
  ('agjeans', 'AG Jeans', ARRAY['ag','ag jeans','agjeans','adriano goldschmied','ag adriano goldschmied']::text[],
   ARRAY['denim','premium','contemporary','mens','womens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA","note":"AG still cuts and sews a large share of its denim in California, so Made in USA is EXPECTED here rather than notable — the opposite of what it means on Wrangler/Lee, where it marks vintage. Treat a domestic tag on AG as normal, not as an era or value signal."}]$j$::jsonb,
   $j$[{"tell":"The WASH is the product — that is what AG-ed means","detail":"HIGHEST-VALUE AG FACT. AG is a wash house first: the brand''s name for its finishing is 'AG-ed', and the value is in the fabric treatment rather than a logo or a pocket stitch. Practical consequence for grading: heavy whiskering, fading, and even distressing on an AG pair are usually the DESIGNED FINISH, not wear. Do not grade an intentional wash as damage — read it against the rest of the garment (an evenly faded panel with intact fibres is a wash; a thin, broken, fraying one is wear)."},{"tell":"The fit name is on the tag and it is the product","detail":"Graduate (men''s tailored straight, the volume seller), Everett, Tellis, Dylan; Farrah (high-rise skinny), Prima, Mari. The name sits beside the size on the tag — read it and title it."},{"tell":"No signature pocket stitch — use the tag","detail":"Unlike its peers in this pack, AG has no bold identifying arc: its back pockets are plain or subtly stitched. So the tag and the wash are the identification, and an unlabelled AG is genuinely hard to place — say so rather than guessing from the silhouette."},{"tell":"AGOLDE is a DIFFERENT brand","detail":"AGOLDE reads like AG but is owned by CITIZENS OF HUMANITY (the sibling in this same pack), not by AG Jeans. Never merge the two or comp one against the other."},{"tell":"Never auto-authenticate","detail":"No AG serial, date code or published authentication standard. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'AG Jeans identity = the WASH ("AG-ed") + the tag-printed fit name (Graduate / Farrah), with no signature pocket stitch to fall back on. Founded 2000 in South Gate, California by Yul Ku with Adriano Goldschmied; Goldschmied himself later departed and the brand trades as AG Jeans. Much of the line is still made in California, so a domestic tag is normal here. CAUTION: AGOLDE is a Citizens of Humanity label, not an AG one. No decoder: the tag carries a fit NAME, not a regular code. RN omitted — not sourceable.',
   'https://www.agjeans.com/', 0.70, false, 'migration:00454'),

  -- NOTE: a bare "citizens" is deliberately NOT an alias — it is an ordinary
  -- English word (same rule that keeps "bean" off L.L.Bean in 00453).
  ('citizensofhumanity', 'Citizens of Humanity', ARRAY['citizens of humanity','citizensofhumanity','coh']::text[],
   ARRAY['denim','premium','contemporary','womens','mens']::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"Made in USA","note":"Citizens is a Los Angeles manufacturer and the bulk of its denim is domestically sewn, so Made in USA is EXPECTED rather than notable — as with AG, and unlike Wrangler/Lee, a domestic tag here is not an era or value signal."}]$j$::jsonb,
   $j$[{"tell":"The FIT NAME is the product and it is on the tag","detail":"HIGHEST-VALUE CITIZENS FACT. Rocket (high-rise skinny — the volume seller), Emannuelle (bootcut), Charlotte, Olivia, Daphne, Ava. The name is printed beside the size; it is what a buyer searches and it is what sets the comp."},{"tell":"Shared lineage with 7 For All Mankind — expected, not copied","detail":"Founder Jerome Dahan CO-FOUNDED 7 For All Mankind (also in this pack) before starting Citizens in 2003. The two brands'' fit blocks and pocket arcs genuinely resemble each other because of that lineage. Do not read the resemblance as a counterfeit signal, and do not comp one brand against the other."},{"tell":"Citizens OWNS AGOLDE and Goldsign","detail":"AGOLDE is a Citizens of Humanity label. Its name resembles AG Jeans (the sibling in this same pack) but they are unrelated companies — keep the three separate and never comp across them."},{"tell":"Subtle pocket stitch — use the tag","detail":"Citizens'' back-pocket stitching is understated compared with the True Religion horseshoe or the 7FAM squiggle, so an unlabelled pair is hard to place from the pocket alone. Identify from the tag; say so rather than guessing."},{"tell":"Never auto-authenticate","detail":"No serial, date code or published authentication standard. Grade condition only; route authenticity to human review."}]$j$::jsonb,
   'Citizens of Humanity identity = the tag-printed fit name (Rocket / Emannuelle), backed by Los Angeles manufacture. Founded 2003 in Huntington Park, California by Jerome Dahan — who co-founded 7 FOR ALL MANKIND (the sibling in this pack) before leaving to start it, which explains the family resemblance between the two. The company OWNS AGOLDE and Goldsign; AGOLDE is easily confused with AG Jeans (also in this pack) and must be kept distinct. No decoder: the tag carries a fit NAME, not a regular code. RN omitted — not sourceable.',
   'https://www.citizensofhumanity.com/', 0.70, false, 'migration:00454')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles ────────────────────────────────────────────────────────────
-- Every fingerprint below has to do ONE job: separate the style from the sibling
-- it is actually confused with. For the vintage half that sibling is usually the
-- SAME model from a different era; for the premium half it is the neighbouring fit.
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  -- Wrangler: the model number is on the tag, so the fingerprints lean on the era.
  ('wrangler', '13MWZ Cowboy Cut', ARRAY['13mwz','cowboy cut','13 mwz','original cowboy cut']::text[], 'Men', 'jean', 'Cowboy Cut',
   'THE Wrangler jean and the brand''s highest-volume resale item: the original Cowboy Cut, a rigid 13oz straight leg with the broken-W pockets, a high back rise and a boot-friendly leg. The model number decodes literally — 13 = the 13-ounce denim, MWZ = Men''s With Zipper. CRITICAL: the model number does NOT date the jean, because a modern 13MWZ carries the same number as a 1970s one. The TAG decides the tier — a Blue Bell tag is pre-1986 and worth multiples of a current pair that looks nearly identical.',
   ARRAY['13oz rigid denim']::text[], '1947-present', '$30-$45', ARRAY['13mwz','cowboy cut','wrangler','broken w','rigid denim']::text[],
   'https://www.wrangler.com/', 0.75, false, 'migration:00454'),
  ('wrangler', '936DEN Slim Fit', ARRAY['936den','936','slim fit cowboy cut']::text[], 'Men', 'jean', 'Cowboy Cut',
   'The SLIM-fit Cowboy Cut — same broken-W pockets and same family as the 13MWZ, cut narrower through the seat and thigh. vs 13MWZ: the silhouette is the only difference and it is easy to misread on a flat-lay, so read the MODEL NUMBER off the tag rather than judging the leg by eye. The number is the whole disambiguation.',
   ARRAY['rigid denim']::text[], 'long-running core', '$30-$45', ARRAY['936den','slim fit','cowboy cut','wrangler']::text[],
   'https://www.wrangler.com/', 0.65, false, 'migration:00454'),
  ('wrangler', '11MJ Denim Jacket', ARRAY['11mj','11mjz','wrangler denim jacket','western jacket']::text[], 'Unisex', 'jacket', 'Western',
   'The western denim jacket — pointed yokes, snap front, and the broken-W on the chest pockets. Same rule as the jeans and it matters more here, because the vintage jacket market is strong: the model number is constant across the decades, so the TAG (Blue Bell = pre-1986) is what separates a collectible from a modern one.',
   ARRAY['rigid denim']::text[], 'long-running core', '$50-$80', ARRAY['11mj','denim jacket','western','wrangler','broken w']::text[],
   'https://www.wrangler.com/', 0.60, false, 'migration:00454'),
  ('wrangler', 'Wrancher Dress Jean', ARRAY['wrancher','wrancher dress jean','western dress jean']::text[], 'Men', 'pant', 'Wrancher',
   'The western DRESS pant/jean — polyester or a poly blend rather than denim, cut with a flat front and no broken-W stitch. Recorded because it is routinely mis-listed as a Wrangler jean: it is not denim, and reading the fabric off the care tag settles it.',
   ARRAY['polyester blend']::text[], 'long-running core', '$35-$50', ARRAY['wrancher','dress jean','western','wrangler']::text[],
   'https://www.wrangler.com/', 0.55, false, 'migration:00454'),

  -- Lee: the 101 family + the Storm Rider, which carries the brand's vintage value.
  ('lee', '101 Riders', ARRAY['101','101b','101z','lee riders','101 riders']::text[], 'Men', 'jean', '101',
   'Lee''s classic jean and the heritage of the brand — the Lazy-S back pockets over a straight leg, in 101B (button fly) or 101Z (zip fly). The letter is the fly and it is the only thing separating the two, so read it off the tag rather than the photo where the fly is often not visible. As with Wrangler, the number is era-blind: UNION MADE on the tag is what marks the collectible tier.',
   ARRAY['rigid denim']::text[], '1920s-present', '$30-$50', ARRAY['101','101b','101z','lee riders','lazy s']::text[],
   'https://www.lee.com/', 0.65, false, 'migration:00454'),
  ('lee', 'Storm Rider', ARRAY['storm rider','stormrider','101j storm rider','blanket lined jacket']::text[], 'Unisex', 'jacket', 'Storm Rider',
   'THE Lee collectible: the blanket-lined denim jacket — a 101J shell with a plaid wool-look BLANKET LINING and a corduroy collar. Both tells are visible in a photo, which makes this the most objective call on the brand. vs a plain 101J: the 101J is unlined with a plain denim collar, and it is worth materially less — so open the jacket and check the lining before titling it a Storm Rider.',
   ARRAY['rigid denim','blanket lining','corduroy']::text[], 'long-running core', '$80-$150', ARRAY['storm rider','101j','blanket lined','corduroy collar','lee']::text[],
   'https://www.lee.com/', 0.70, false, 'migration:00454'),
  ('lee', '101J Denim Jacket', ARRAY['101j','lee denim jacket','lee rider jacket']::text[], 'Unisex', 'jacket', '101',
   'The unlined western denim jacket — the Storm Rider''s plain sibling, with a denim collar and no blanket lining. Recorded specifically as the Storm Rider''s counterpart: the lining is the separator and it is the difference between two very different prices.',
   ARRAY['rigid denim']::text[], 'long-running core', '$50-$90', ARRAY['101j','denim jacket','lee','rider jacket']::text[],
   'https://www.lee.com/', 0.60, false, 'migration:00454'),
  ('lee', 'Union-All', ARRAY['union all','union-all','lee coverall','unionall']::text[], 'Unisex', 'other', 'Union-All',
   'The one-piece coverall (1913) that founded the brand''s workwear reputation — a full-body garment, not a jean. Recorded so a Union-All is not catalogued as pants, and because it is exactly the kind of piece that carries an early UNION MADE tag.',
   ARRAY['denim','drill']::text[], 'vintage', null, ARRAY['union all','coverall','lee','workwear']::text[],
   'https://www.lee.com/', 0.55, false, 'migration:00454'),

  -- 7 For All Mankind: the fit name is the product.
  ('7forallmankind', 'Slimmy', ARRAY['slimmy','slimmy jean']::text[], 'Men', 'jean', 'Slimmy',
   'The men''s slim straight and 7FAM''s highest-VOLUME men''s resale item. The squiggle back pockets identify the brand; the FIT NAME on the tag identifies the product. vs Standard: Standard is the straight/relaxed block and Slimmy is the narrow one — a distinction that is unreliable on a flat-lay, so read the tag rather than the leg.',
   ARRAY['stretch denim']::text[], 'long-running core', '$150-$200', ARRAY['slimmy','7fam','squiggle','slim straight']::text[],
   'https://www.7forallmankind.com/', 0.70, false, 'migration:00454'),
  ('7forallmankind', 'Standard', ARRAY['standard','standard jean']::text[], 'Men', 'jean', 'Standard',
   'The men''s original straight-leg block — the Slimmy''s roomier sibling and the fit it is most often confused with. Same squiggle pockets, so the pocket does NOT separate them: the tag does.',
   ARRAY['denim']::text[], 'long-running core', '$150-$200', ARRAY['standard','7fam','straight leg','squiggle']::text[],
   'https://www.7forallmankind.com/', 0.65, false, 'migration:00454'),
  ('7forallmankind', 'Dojo', ARRAY['dojo','dojo jean','a pocket']::text[], 'Women', 'jean', 'Dojo',
   'The wide-leg/trouser fit and the brand''s signature women''s silhouette. Its back pockets carry the large squiggle whose form reads as an "A" — the A-pocket is the Dojo tell and it is visible in a photo, making this the one 7FAM fit identifiable WITHOUT the tag.',
   ARRAY['denim']::text[], 'long-running core', '$180-$230', ARRAY['dojo','a pocket','wide leg','trouser','7fam']::text[],
   'https://www.7forallmankind.com/', 0.70, false, 'migration:00454'),
  ('7forallmankind', 'Roxanne', ARRAY['roxanne','roxanne jean']::text[], 'Women', 'jean', 'Roxanne',
   'The women''s skinny — the fit most often confused with the bootcut Josefina and the wide Dojo. The pocket squiggle is identical across all three, so the fit name on the tag is the only reliable separator.',
   ARRAY['stretch denim']::text[], 'long-running core', '$160-$200', ARRAY['roxanne','skinny','7fam','squiggle']::text[],
   'https://www.7forallmankind.com/', 0.65, false, 'migration:00454'),
  ('7forallmankind', 'Josefina', ARRAY['josefina','josefina jean','boyfriend']::text[], 'Women', 'jean', 'Josefina',
   'The women''s relaxed boyfriend fit, typically in a lighter distressed wash. Recorded as the Roxanne''s opposite block — same brand marks, very different silhouette and comp.',
   ARRAY['denim']::text[], 'long-running core', '$180-$220', ARRAY['josefina','boyfriend','relaxed','7fam']::text[],
   'https://www.7forallmankind.com/', 0.60, false, 'migration:00454'),

  -- True Religion: the fit name + the stitch weight. The stitch is the money.
  ('truereligion', 'Ricky', ARRAY['ricky','ricky super t','ricky big t','ricky straight']::text[], 'Men', 'jean', 'Ricky',
   'The men''s relaxed straight and True Religion''s highest-VOLUME resale item. Horseshoe back pockets with the flap option. THE CALL ON THIS JEAN IS THE STITCH WEIGHT, not the fit: a Ricky Super T (thickest contrast topstitching) comps well above a standard-stitch Ricky of the same size and wash. Measure the thread visually and carry Super T / Big T into the title — omitting it undersells the jean.',
   ARRAY['heavy contrast topstitch']::text[], 'long-running core', '$180-$300', ARRAY['ricky','super t','big t','horseshoe','relaxed straight']::text[],
   'https://www.truereligion.com/', 0.75, false, 'migration:00454'),
  ('truereligion', 'Billy', ARRAY['billy','billy super t','billy bootcut']::text[], 'Men', 'jean', 'Billy',
   'The men''s bootcut — the Ricky''s sibling block, distinguished by the leg opening rather than by any brand mark (both wear the horseshoe). Same stitch-weight rule: Big T / Super T sets the tier.',
   ARRAY['heavy contrast topstitch']::text[], 'long-running core', '$170-$280', ARRAY['billy','bootcut','super t','horseshoe']::text[],
   'https://www.truereligion.com/', 0.65, false, 'migration:00454'),
  ('truereligion', 'Joey', ARRAY['joey','joey super t','joey flare']::text[], 'Unisex', 'jean', 'Joey',
   'The FLARE fit — the widest leg opening in the line and the most recognizable early-2000s True Religion silhouette, frequently with the flap back pockets. vs Billy: both flare from the knee, but the Joey opens materially wider; where the photo is ambiguous the tag name settles it.',
   ARRAY['heavy contrast topstitch']::text[], 'long-running core', '$180-$300', ARRAY['joey','flare','super t','horseshoe','flap pocket']::text[],
   'https://www.truereligion.com/', 0.65, false, 'migration:00454'),
  ('truereligion', 'Becky', ARRAY['becky','becky bootcut','becky super t']::text[], 'Women', 'jean', 'Becky',
   'The women''s bootcut and the brand''s core women''s block. Horseshoe pockets; the same stitch-weight tiering applies — a Becky Super T is a different price from a standard Becky.',
   ARRAY['heavy contrast topstitch']::text[], 'long-running core', '$160-$260', ARRAY['becky','bootcut','super t','horseshoe','womens']::text[],
   'https://www.truereligion.com/', 0.60, false, 'migration:00454'),
  ('truereligion', 'Super T', ARRAY['super t','supert','big t','thick stitch']::text[], 'Unisex', 'other', 'Stitch grade',
   'NOT a fit — a STITCH GRADE that any fit can carry, which is exactly why it is recorded as its own entry. Super T is the thickest contrast topstitching in the line (the heavy gauge look); Big T is the thick-but-lesser grade; a standard pair has ordinary thread. The grade is visible in a close photo and it is the single biggest price lever on the brand, so it must be read INDEPENDENTLY of the fit name and both must appear in the title ("Ricky Super T").',
   ARRAY['heavy contrast topstitch']::text[], 'long-running core', null, ARRAY['super t','big t','stitch','thick thread','true religion']::text[],
   'https://www.truereligion.com/', 0.70, false, 'migration:00454'),

  -- AG: the wash is the product, so the fingerprints warn against grading it as wear.
  ('agjeans', 'Graduate', ARRAY['graduate','the graduate','graduate tailored leg']::text[], 'Men', 'jean', 'Graduate',
   'The men''s tailored straight and AG''s highest-VOLUME men''s resale item — a modern straight leg, neither slim nor relaxed. vs Tellis (slim) and Everett (slim straight): the three men''s blocks sit close together and AG has NO signature pocket stitch to fall back on, so the tag name is the identification. Whatever whiskering and fading it carries is almost certainly the AG-ed finish, not wear.',
   ARRAY['stretch denim','AG-ed wash']::text[], 'long-running core', '$180-$225', ARRAY['graduate','tailored leg','ag jeans','straight']::text[],
   'https://www.agjeans.com/', 0.70, false, 'migration:00454'),
  ('agjeans', 'Tellis', ARRAY['tellis','the tellis','tellis modern slim']::text[], 'Men', 'jean', 'Tellis',
   'The men''s modern slim — the Graduate''s narrower sibling and the fit it is most often confused with. No pocket tell separates them; read the tag.',
   ARRAY['stretch denim','AG-ed wash']::text[], 'long-running core', '$180-$225', ARRAY['tellis','modern slim','ag jeans']::text[],
   'https://www.agjeans.com/', 0.65, false, 'migration:00454'),
  ('agjeans', 'Everett', ARRAY['everett','the everett','everett slim straight']::text[], 'Men', 'jean', 'Everett',
   'The men''s slim straight, sitting between the Graduate and the Tellis. Recorded because three adjacent men''s blocks with no distinguishing pocket stitch is precisely the situation where a model must NOT guess — name the fit only when the tag says it.',
   ARRAY['stretch denim','AG-ed wash']::text[], 'long-running core', '$180-$225', ARRAY['everett','slim straight','ag jeans']::text[],
   'https://www.agjeans.com/', 0.60, false, 'migration:00454'),
  ('agjeans', 'Farrah', ARRAY['farrah','the farrah','farrah skinny']::text[], 'Women', 'jean', 'Farrah',
   'The women''s HIGH-RISE skinny and AG''s signature women''s fit. The high rise is the one AG block with a silhouette cue readable in a photo — vs Prima, which is a MID-rise cigarette with a straighter, cropped leg. Confirm with the tag; the rise alone is not conclusive on a flat-lay.',
   ARRAY['stretch denim','AG-ed wash']::text[], 'long-running core', '$190-$240', ARRAY['farrah','high rise','skinny','ag jeans']::text[],
   'https://www.agjeans.com/', 0.70, false, 'migration:00454'),
  ('agjeans', 'Prima', ARRAY['prima','the prima','prima cigarette']::text[], 'Women', 'jean', 'Prima',
   'The women''s mid-rise cigarette — a slim, straighter, often cropped leg. The Farrah''s counterpart: rise and leg shape separate them, and the tag confirms.',
   ARRAY['stretch denim','AG-ed wash']::text[], 'long-running core', '$180-$220', ARRAY['prima','cigarette','mid rise','ag jeans']::text[],
   'https://www.agjeans.com/', 0.65, false, 'migration:00454'),

  -- Citizens of Humanity: the fit name is the product; AGOLDE is kept distinct.
  ('citizensofhumanity', 'Rocket', ARRAY['rocket','rocket skinny','rocket crop','the rocket']::text[], 'Women', 'jean', 'Rocket',
   'The high-rise skinny and Citizens'' highest-VOLUME resale item — the fit the brand is known for, in a sculpting stretch denim. vs Emannuelle (bootcut) and the straighter blocks: Citizens'' pocket stitching is understated, so unlike a True Religion or a Seven this is NOT identifiable from the pocket. The tag name is the identification.',
   ARRAY['stretch denim','sculpt']::text[], 'long-running core', '$200-$250', ARRAY['rocket','high rise','skinny','citizens of humanity']::text[],
   'https://www.citizensofhumanity.com/', 0.70, false, 'migration:00454'),
  ('citizensofhumanity', 'Emannuelle', ARRAY['emannuelle','emanuelle','emannuelle bootcut']::text[], 'Women', 'jean', 'Emannuelle',
   'The women''s bootcut — the Rocket''s opposite block. NOTE the spelling: Emannuelle carries a double-N and a double-L, and it is routinely mis-typed in listings, which breaks the comp search. Copy it from the tag exactly.',
   ARRAY['stretch denim']::text[], 'long-running core', '$200-$240', ARRAY['emannuelle','bootcut','citizens of humanity']::text[],
   'https://www.citizensofhumanity.com/', 0.60, false, 'migration:00454'),
  ('citizensofhumanity', 'Charlotte', ARRAY['charlotte','charlotte high rise','charlotte straight']::text[], 'Women', 'jean', 'Charlotte',
   'The high-rise straight leg. Recorded as one of the several adjacent Citizens women''s blocks that share a rise and differ only in leg shape — the case for reading the tag rather than judging the silhouette.',
   ARRAY['denim']::text[], 'long-running core', '$200-$240', ARRAY['charlotte','high rise','straight','citizens of humanity']::text[],
   'https://www.citizensofhumanity.com/', 0.60, false, 'migration:00454'),
  ('citizensofhumanity', 'Daphne', ARRAY['daphne','daphne stovepipe','daphne high rise']::text[], 'Women', 'jean', 'Daphne',
   'The high-rise stovepipe — a straight, rigid-denim block distinct from the stretch Rocket. Rigid vs stretch is readable off the care tag and is the practical separator from the sculpting fits.',
   ARRAY['rigid denim']::text[], 'current', '$220-$260', ARRAY['daphne','stovepipe','high rise','citizens of humanity']::text[],
   'https://www.citizensofhumanity.com/', 0.55, false, 'migration:00454'),
  ('citizensofhumanity', 'AGOLDE', ARRAY['agolde','a golde']::text[], 'Unisex', 'other', 'AGOLDE',
   'A SIBLING LABEL, not a Citizens fit — AGOLDE is owned by Citizens of Humanity and has its own fits (Riley, Parker, 90s). Recorded here for one reason: AGOLDE reads like AG JEANS (a different company, also in this pack) and the two are routinely conflated. An AGOLDE tag is not an AG Jeans tag; never comp them against each other.',
   ARRAY['denim']::text[], 'current', null, ARRAY['agolde','citizens of humanity','riley','parker','90s']::text[],
   'https://www.citizensofhumanity.com/', 0.60, false, 'migration:00454')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Wrangler + True Religion ONLY ────────────────────────
-- The two brands in this pack whose garment-printed identifier is REGULAR and
-- brand-unique. Everything else prints a fit NAME or a retailer SKU.
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  -- Wrangler's MW family. "13MWZ" = 13-ounce Men's With Zipper: the digits are the
  -- denim weight, MW = Men's Western, Z = zip fly. The MW/MWZ/MJ suffix is a
  -- Wrangler-only convention, so an anchored digits+suffix pattern recovers the
  -- brand off a cut tag. A bare weight ("13") must not match — it is an ordinary
  -- number. 936DEN is carried as its own alternative (the DEN suffix is likewise
  -- Wrangler-specific), and it is why the pattern is a two-branch alternation
  -- rather than one loose rule.
  ('wrangler', 'style_number',
   'Wrangler tag-printed model number: the MW family (digits = denim weight, MW = Men''s Western, Z = zip fly, J = jacket) — e.g. "13MWZ", "47MWZ", "11MJ" — or the DEN slim-fit form, e.g. "936DEN".',
   '^(?:(?<style>\d{2,3}(?:MWZPW|MWZ|MWJ|MJZ|MJ|MW))|(?<slim>\d{3}DEN))$',
   $j${"fieldMap":{"style":"styleCode","slim":"styleCode"},"transforms":{"style":"upper","slim":"upper"},"confidence":0.7}$j$::jsonb,
   $j$[{"code":"13MWZ","expected":{"styleCode":"13MWZ"}},{"code":"47MWZ","expected":{"styleCode":"47MWZ"}},{"code":"11MJ","expected":{"styleCode":"11MJ"}},{"code":"936DEN","expected":{"styleCode":"936DEN"}},{"code":"13","expected":null,"note":"A bare denim weight is an ordinary number — it must NOT recover a brand."},{"code":"MWZ","expected":null,"note":"A bare suffix must NOT recover a brand."}]$j$::jsonb,
   'https://www.wrangler.com/', 0.70, false, 'migration:00454'),

  -- True Religion's MODEL + stitch-weight SUFFIX. This is the group's CUT-TAG
  -- case and it mirrors the Arc'teryx model+suffix decoder in 00453: the parts are
  -- ordinary alone (Ricky is a first name; "Super T" could be a size) but the
  -- COMPOUND is True-Religion-unique, so requiring both is what makes recovery
  -- safe. A bare fit name deliberately does NOT match.
  ('truereligion', 'style_name',
   'True Religion MODEL + stitch-weight SUFFIX printed on the tag (Super T = the thickest contrast topstitch, Big T = the thick grade) — e.g. "Ricky Super T", "Joey Big T".',
   '^(?<style>(?:Ricky|Billy|Joey|Bobby|Becky|Geno|Johnny|Casey|Carrie|Disco|Jack|Cameron)\s+(?:Super\s*T|Big\s*T))$',
   $j${"fieldMap":{"style":"styleCode"},"transforms":{"style":"upper"},"confidence":0.7}$j$::jsonb,
   $j$[{"code":"Ricky Super T","expected":{"styleCode":"RICKY SUPER T"}},{"code":"Joey Big T","expected":{"styleCode":"JOEY BIG T"}},{"code":"Becky Super T","expected":{"styleCode":"BECKY SUPER T"}},{"code":"Ricky","expected":null,"note":"A bare fit name is an ordinary first name — it must NOT recover a brand."},{"code":"Super T","expected":null,"note":"A bare stitch grade must NOT recover a brand."}]$j$::jsonb,
   'https://www.truereligion.com/', 0.70, false, 'migration:00454')
on conflict (brand_key, decoder_kind) do nothing;

-- ── brand_colorways ─────────────────────────────────────────────────────────
-- Denim "color" is a WASH NAME, and washes are seasonal and near-infinite, so a
-- colorway dictionary is mostly the wrong shape for this category. Seeded only
-- where the name is a stable, brand-defining term rather than a season's fancy:
-- the rigid/raw and classic-indigo terms every denim brand reuses. Deliberately
-- NOT seeded: the premium brands' per-season wash names (AG alone has hundreds),
-- which would be stale within a season.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('wrangler', 'Rigid Indigo', ARRAY['rigid','rigid indigo','raw denim','unwashed']::text[], null, null, 'https://www.wrangler.com/', 0.65, false, 'migration:00454'),
  ('wrangler', 'Stonewashed', ARRAY['stonewashed','stone wash','light wash']::text[], null, null, 'https://www.wrangler.com/', 0.60, false, 'migration:00454'),
  ('lee', 'Rigid Indigo', ARRAY['rigid','rigid indigo','raw denim','unwashed']::text[], null, null, 'https://www.lee.com/', 0.60, false, 'migration:00454'),
  ('truereligion', 'Body Rinse', ARRAY['body rinse','dark rinse','rinse']::text[], null, null, 'https://www.truereligion.com/', 0.55, false, 'migration:00454')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts (INCHES) ──────────────────────────────────────────────
-- DENIM IS THE EXCEPTION IN THIS EPIC, and every note below says so. The outdoor
-- and athleisure packs seed BODY charts, because their garments are alpha-sized
-- and the label is a letter that has to be mapped onto a body. Denim is different:
-- the label IS A MEASUREMENT. A W32 claims a 32-inch waist and a numeric 27 claims
-- a 27-inch waist, so these charts are NOMINAL WAIST charts — they map the label
-- to the waist it CLAIMS.
--
-- Which sets up this group's signature trap, and it is the reason the "measure it"
-- instruction is repeated on every row: the claim is frequently FALSE, in both
-- directions and for reasons that are specific to denim —
--   * VINTAGE (Wrangler/Lee) runs SMALL against the tag: pre-shrunk sizing
--     conventions plus decades of laundering mean a vintage W32 commonly measures
--     30-31. This is the single most expensive error in the group.
--   * PREMIUM (7FAM/TR/AG/Citizens) runs LARGE against the tag: vanity sizing plus
--     stretch denim that relaxes with wear means a premium 27 commonly measures 28+.
--   * A USED pair of stretch denim has permanently given at the waistband.
-- The only defensible number is the flat waistband doubled, published as such.
--
-- HONESTY NOTE ON CONFIDENCE: these are the standard denim nominal grades, not
-- figures fetched from each brand's own published guide, and they are seeded at
-- LOW/CAPPED confidence with the approximation stated so the US-1715 verifier
-- replaces them rather than rubber-stamping them.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('wrangler', 'Wrangler', ARRAY['wrangler']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}},{"size":"W40","measurements":{"waist":"40"}},{"size":"W42","measurements":{"waist":"42"}}]$json$::jsonb,
   'NOMINAL WAIST — the label is a claimed measurement, not a body chart. Wrangler men''s jeans are labeled W (waist) x L (inseam) in inches. VINTAGE CAVEAT (the costly one on this brand): a vintage Wrangler runs SMALL against its tag — pre-shrunk sizing plus decades of laundering mean a vintage W32 commonly measures 30-31, so a Blue Bell-era pair must NEVER be listed on its tag alone. Measure the flat waistband, double it, and publish that figure. INSEAM is a separate axis (commonly 30/32/34) and vintage inseams are often shortened by hemming — measure it too.',
   'https://www.wrangler.com/', 0.60, false, 'migration:00454'),
  ('wrangler', 'Wrangler', ARRAY['wrangler']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom']::text[],
   $json$[{"size":"24","measurements":{"waist":"24-24.5","hip":"33-34"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35-36"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37-38"}},{"size":"30","measurements":{"waist":"30-31","hip":"39-40.5"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42-43"}},{"size":"34","measurements":{"waist":"34.5-35.5","hip":"44-45"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches; hip rises ~9-10in over the waist. Wrangler also sells women''s western jeans on a SIZE x INSEAM label (e.g. 5/6 x 34) in the misses/juniors block, which is a different scale entirely — do not map a juniors number onto this chart. Measure the flat waistband and double it.',
   'https://www.wrangler.com/', 0.55, false, 'migration:00454'),
  ('wrangler', 'Wrangler', ARRAY['wrangler']::text[], 'Unisex', 'Denim jackets (alpha)', ARRAY['jacket','coat','denim jacket','western jacket','outerwear','vest']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"42-44"}},{"size":"XL","measurements":{"chest":"46-48"}},{"size":"XXL","measurements":{"chest":"50-52"}}]$json$::jsonb,
   'BODY measurement (chest) — the jackets are the one part of the line that is alpha-sized rather than labeled with a waist number, so unlike the jeans charts above this one IS a body chart. A western denim jacket is cut close, so its flat chest sits near the body chest rather than well above it. Vintage jackets run SMALL against the tag for the same shrinkage reasons as the jeans — measure the flat chest (armpit to armpit, doubled) and publish it. Standard US alpha approximation rather than Wrangler-fetched figures — capped confidence.',
   'https://www.wrangler.com/', 0.55, false, 'migration:00454'),

  ('lee', 'Lee', ARRAY['lee']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}},{"size":"W40","measurements":{"waist":"40"}}]$json$::jsonb,
   'NOMINAL WAIST — the label is a claimed measurement, not a body chart. Lee men''s jeans are labeled W (waist) x L (inseam) in inches. Same VINTAGE CAVEAT as Wrangler and it applies hardest to the union-made era: an early Lee runs SMALL against its tag (a vintage W32 commonly measures 30-31), so never list a UNION MADE pair on its tag alone. Measure the flat waistband, double it, publish it. Vintage inseams are frequently hemmed shorter than the tag — measure the inside leg too.',
   'https://www.lee.com/', 0.60, false, 'migration:00454'),
  ('lee', 'Lee', ARRAY['lee']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom']::text[],
   $json$[{"size":"24","measurements":{"waist":"24-24.5","hip":"33-34"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35-36"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37-38"}},{"size":"30","measurements":{"waist":"30-31","hip":"39-40.5"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42-43"}},{"size":"34","measurements":{"waist":"34.5-35.5","hip":"44-45"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches; hip rises ~9-10in over the waist. Lee also sells women''s jeans on a misses SIZE label (e.g. 8, 10, 12), which is a DIFFERENT scale from this waist-inch one — read which scale the tag uses before mapping. Measure the flat waistband and double it.',
   'https://www.lee.com/', 0.55, false, 'migration:00454'),
  ('lee', 'Lee', ARRAY['lee']::text[], 'Unisex', 'Denim jackets (alpha)', ARRAY['jacket','coat','denim jacket','storm rider','outerwear','vest']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"42-44"}},{"size":"XL","measurements":{"chest":"46-48"}},{"size":"XXL","measurements":{"chest":"50-52"}}]$json$::jsonb,
   'BODY measurement (chest) — the jackets are alpha-sized rather than waist-labeled, so unlike the jeans charts this one IS a body chart. NOTE the Storm Rider specifically: it is BLANKET-LINED, so it is cut with room for the lining and wears smaller inside than its flat chest suggests — a lined jacket''s flat measurement overstates the room it actually gives. Measure the flat chest and say the jacket is lined. Standard US alpha approximation rather than Lee-fetched figures — capped confidence.',
   'https://www.lee.com/', 0.55, false, 'migration:00454'),

  ('7forallmankind', '7 For All Mankind', ARRAY['7 for all mankind','7forallmankind','seven for all mankind','7fam']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches. PREMIUM-DENIM CAVEAT, which runs OPPOSITE to the vintage brands in this same pack: premium denim runs LARGE against its tag. Vanity sizing plus stretch fabric that relaxes with wear means a 7FAM 27 commonly measures 28 or more, and a USED pair has permanently given at the waistband. Measure the flat waistband, double it, and publish that number rather than the tag. Standard premium-denim numeric grade rather than 7FAM-fetched figures — capped confidence.',
   'https://www.7forallmankind.com/', 0.55, false, 'migration:00454'),
  ('7forallmankind', '7 For All Mankind', ARRAY['7 for all mankind','7forallmankind','seven for all mankind','7fam']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — men''s premium denim is labeled W (waist) x L (inseam) in inches. Same PREMIUM caveat as the women''s chart: stretch denim relaxes, so a worn Slimmy measures above its tag. Measure the flat waistband and double it. Standard premium-denim grade rather than 7FAM-fetched figures — capped confidence.',
   'https://www.7forallmankind.com/', 0.55, false, 'migration:00454'),

  ('truereligion', 'True Religion', ARRAY['true religion','truereligion']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}},{"size":"W40","measurements":{"waist":"40"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat applies (runs large against the tag; a used pair has given at the waistband). TRUE-RELIGION-SPECIFIC: the INSEAM is the number to watch on this brand — the flare and bootcut fits were sold long by design and are very frequently HEMMED by the owner, so the tag inseam is often wrong on a used pair. Measure and double the flat waistband, and measure the inside leg too; publish both real figures rather than the tag. Standard premium-denim grade rather than TR-fetched figures — capped confidence.',
   'https://www.truereligion.com/', 0.55, false, 'migration:00454'),
  ('truereligion', 'True Religion', ARRAY['true religion','truereligion']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches. PREMIUM caveat applies (runs large against the tag). Same hemming warning as the men''s chart: the women''s flares were sold long and are commonly shortened, so measure the inside leg rather than trusting the tag inseam. Measure and double the flat waistband too. Standard premium-denim numeric grade rather than TR-fetched figures — capped confidence.',
   'https://www.truereligion.com/', 0.55, false, 'migration:00454'),

  -- brand_match deliberately EXCLUDES a bare "ag": findSizingCharts matches by
  -- SUBSTRING, and "patagonia" contains "ag" — a bare entry would hand every
  -- Patagonia garment an AG denim chart. The canonical brand string is "AG Jeans"
  -- (canonicalizeBrand maps the bare "AG" onto it by EXACT key), so the chart is
  -- reached via the canonical form, which is safe. Never add "ag" here.
  ('agjeans', 'AG Jeans', ARRAY['ag jeans','agjeans','adriano goldschmied']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat applies: AG''s men''s fits are stretch denim and relax with wear, so a worn Graduate measures above its tag. Measure the flat waistband and double it. Standard premium-denim grade rather than AG-fetched figures — capped confidence.',
   'https://www.agjeans.com/', 0.55, false, 'migration:00454'),
  ('agjeans', 'AG Jeans', ARRAY['ag jeans','agjeans','adriano goldschmied']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches. PREMIUM caveat applies (runs large against the tag; stretch gives with wear). AG-SPECIFIC: heavy whiskering/fading on the garment is the AG-ed WASH, not wear — do not let a distressed finish drive a size or condition judgment. Measure the flat waistband and double it. Standard premium-denim numeric grade rather than AG-fetched figures — capped confidence.',
   'https://www.agjeans.com/', 0.55, false, 'migration:00454'),

  ('citizensofhumanity', 'Citizens of Humanity', ARRAY['citizens of humanity','citizensofhumanity']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom','short']::text[],
   $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb,
   'NOMINAL WAIST — the numeric label claims the natural waist in inches. PREMIUM caveat applies (runs large against the tag). CITIZENS-SPECIFIC: the Rocket is a sculpting STRETCH fit while the Daphne is RIGID denim, and the two behave oppositely on a used pair — stretch gives permanently at the waistband, rigid does not. Read the fabric off the care tag before trusting any size claim, then measure the flat waistband and double it. Standard premium-denim numeric grade rather than Citizens-fetched figures — capped confidence.',
   'https://www.citizensofhumanity.com/', 0.55, false, 'migration:00454'),
  ('citizensofhumanity', 'Citizens of Humanity', ARRAY['citizens of humanity','citizensofhumanity']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser','short']::text[],
   $json$[{"size":"W28","measurements":{"waist":"28"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb,
   'NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat applies. Measure the flat waistband and double it. Standard premium-denim grade rather than Citizens-fetched figures — capped confidence.',
   'https://www.citizensofhumanity.com/', 0.55, false, 'migration:00454')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- NOTE — no shared-chart narrowing is needed here (contrast 00453, which had to
-- narrow the shared outdoor row). Levi's and Madewell already carry their OWN
-- denim charts from 00389 and neither claims these six brands, and the generic
-- men's-pants fallback has an EMPTY brand_match so it is only ever selected when
-- no brand chart matched. Verified in denim-content_test.ts.

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00454') on conflict do nothing;
