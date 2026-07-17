-- US-1992: Outdoor & technical (tier 2) brand knowledge (8 brands).
--
-- Fjällräven, Salomon, Cotopaxi, Kühl, Helly Hansen, Mammut, Rab, Outdoor
-- Research. This is the tier-2 outdoor/technical pack; it sits beside 00453
-- (Arc'teryx, Patagonia, The North Face, Columbia, Marmot, ...) and 00460's
-- luxury outerwear (Canada Goose, Moncler, ...), NEITHER re-touched. These eight
-- were passthrough-only, so a "salomon" or "helly hansen" tag rendered the
-- seller's own casing into the prompt block and the eBay Brand aspect.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT BINDS THIS GROUP: THE VALUE IS THE MODEL NAME + THE FABRIC TECHNOLOGY —
-- NEVER A TAG-PRINTED BRAND-UNIQUE CODE.
--
--   A technical jacket, fleece or pack lists precisely when it is grounded by two
--   things the photo can actually show: the MODEL NAME (Kånken, XT-6, Allpa,
--   Renegade, Alpha, Eiger Extreme, Microlight, Foray) and the FABRIC TECHNOLOGY
--   printed on the hangtag/membrane (GORE-TEX, G-1000, LIFA, Pertex, Primaloft,
--   Contagrip, down FILL-POWER). That pairing is the read — a Microlight is a
--   Pertex + hydrophobic-down jacket, an XT-6 is a Sensifit/Quicklace trail
--   runner — and both halves are NAMES, not codes. The fabric tech leads every
--   style fingerprint below for exactly that reason (the 00453 outdoor lesson:
--   the membrane is the grade, and the model is a name).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ZERO DECODERS, DELIBERATELY — and every candidate is fixtured as a REFUSAL
-- negative in brand-knowledge-golden_test.ts (a refusal that is not tested is a
-- comment). This is the 00470 call (footwear tier 2): NO decoder clears the bar
-- for this group — not one of the eight prints a code that is tag-printed AND
-- regular AND brand-unique in FORMAT (the 00460 test). The models are NAMES.
--
--   * SALOMON `L41252600` (and the `47000`-style article runs) — a genuine
--     Salomon catalogue/web article number, but it is a BARE ALPHANUMERIC RUN
--     with no closed brand-unique prefix (the Chanel rule, US-1736; a pattern
--     over it mints the KB's costliest false positive from any number on any
--     tag), and it is not established as a regular SEWN-tag code rather than a
--     web/box SKU. Refused; the model NAME (XT-6, Speedcross) is the identifier.
--   * FJÄLLRÄVEN / HELLY HANSEN product numbers (e.g. Fjällräven `F23511`, HH
--     `53040`) — these are web/catalogue SKUs printed on the hangtag/packaging,
--     not a regular brand-unique tag code. Refused; the model is a NAME.
--   * COTOPAXI / KÜHL / MAMMUT / RAB / OUTDOOR RESEARCH — the model is a NAME and
--     the article numbers are plain web/catalogue SKUs with no regular
--     tag-printed brand-unique format.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PACK'S TWO NAME / WORD COLLISIONS (both carried in brand-normalize.ts, not
-- here):
--
--   1. RAB is an ordinary short token AND a given name (Rab). "Rab" is added to
--      DETECT_EXCLUDED_FROM_TEXT — it is reachable BY TAG (a brand field of
--      literally "Rab" resolves) but must NEVER be minted from prose, exactly the
--      KEEN / Brooks call (00470). Verified by mutation in the content test.
--   2. KÜHL is the German word for "cool"; a bare "kühl" in prose is the adjective,
--      not the brand. "Kühl" is added to DETECT_EXCLUDED_FROM_TEXT for the same
--      reason (reachable by tag, never guessed from prose), and both the accented
--      `khl` and unaccented `kuhl` alias keys resolve a tag. Verified by mutation.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REGISTERED NUMBERS: NONE ARE SEEDED. These are largely imported technical
-- outerwear; no registrant could be sourced to a PRIMARY FTC record, and
-- fabricating one is the KB's costliest error (the RN 17257 lesson, 00468) — so
-- RN is left empty, owed to the US-1715 queue.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TAG ERAS: DOCUMENTED for the two HERITAGE makers with a genuine chronology —
-- HELLY HANSEN (founded 1877; older HH labels / vintage rain gear) and FJÄLLRÄVEN
-- (founded 1960; older Greenland/Kånken labels, Arctic-fox logo, Made in various)
-- — and EMPTY for the six modern-corpus brands (Salomon, Cotopaxi, Kühl, Mammut,
-- Rab, Outdoor Research). TAG ERAS EMPTY ON PURPOSE for those six (the athleisure
-- precedent, 00452): Cotopaxi is a 2014 brand and Kühl a 1993 brand with no
-- value-driving dated label chronology, so empty is CORRECT, not a gap.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- COLORWAYS: ONE BRAND QUALIFIES — FJÄLLRÄVEN. The KÅNKEN backpack ships in a
-- small set of PROPRIETARY NAMED colours (UN Blue, Ox Red, Frost Green, Graphite,
-- Royal Blue, Ochre) that recur for years and are searched BY NAME — a true
-- internal palette (the UGG Chestnut / Dr. Martens Cherry Red precedent, 00459).
-- The other seven ship ordinary descriptive SEASON colours that form no stable
-- dictionary, so none are seeded (the 00456/00462 rule).
--   ⚠ COTOPAXI IS THE INVERSION, and worth stating: its DEL DÍA line is
--   INTENTIONALLY one-of-a-kind — the sewer chooses the remnant-fabric colour
--   blocking, so NO two are alike and there is NO stable palette to seed.
--   ZERO Cotopaxi colorways, by design — the opposite of a named palette.
--
-- Data-only + idempotent. Every fact carries source_url + confidence and lands
-- verified=false for the US-1715 admin verify queue (the 00443..00471
-- convention). Confidence is DELIBERATELY UNEVEN: a brand-published spec is ~0.8;
-- a collector-corroborated tell is ~0.6 and says so.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers,
   tag_eras, country_patterns, authentication_tells, notes, source_url,
   confidence, verified, updated_by)
values
  ('fjallraven', 'Fjällräven',
   ARRAY['fjallraven','fjällräven','fjall raven','kanken','kånken','fjallravenkanken']::text[],
   ARRAY['backpacks','trekking trousers','waxed jackets','outdoor apparel','daypacks']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Older Kånken / Greenland labels + Arctic-fox logo","years":"1960-present (approximate)","description":"COLLECTOR-CORROBORATED, NOT A DATED CHART. Fjällräven (founded 1960, Örnsköldsvik, Sweden by Åke Nordin) built the Greenland Jacket (1968) and the KÅNKEN backpack (1978). The Arctic-fox logo and the woven Kånken label have evolved; older Made-in-various examples and earlier logo weaves skew vintage but no precise dated chronology is sourced — treat as a coarse prior only. The G-1000 fabric (65/35 poly-cotton, waxable with Greenland Wax) is the durable identity across eras."}]$j$::jsonb,
   $j$[{"pattern":"Sweden (heritage), broadly Asia/Europe (modern)","note":"COARSE PRIOR ONLY: Fjällräven is a Swedish brand and older stock may carry European construction, but the vast majority of modern product is made in Asia and country does not authenticate or precisely date a piece."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; identify by the MODEL + the G-1000 fabric","detail":"Fjällräven has no per-unit serial and no consumer authentication portal. Grade condition. The value read is the MODEL (Kånken / Greenland Jacket / Keb or Vidda Pro trousers) plus the FABRIC (G-1000 waxable poly-cotton vs the lighter Abisko). The Arctic-fox logo and Kånken''s snap-strap + boxy silhouette are the recognizable cues — flag anything inconsistent in condition_notes, never assert authenticity."},{"tell":"On G-1000 the WAX and the FABRIC are the grade","detail":"G-1000 is a WAXABLE fabric (Greenland Wax) — a re-waxed or patchy-wax finish is normal maintenance, not damage, but abrasion holes, a broken zip and a cracked/peeling coating ARE defects. On a Kånken the value is in the fabric body, the snap straps and the base; check the seams and the zip pulls."}]$j$::jsonb,
   'Founded 1960 in Örnsköldsvik, Sweden by Åke Nordin. The resale core: the KÅNKEN backpack (1978 — a boxy Vinylon-F daypack with snap straps and the Arctic-fox logo), the GREENLAND JACKET (a G-1000 waxable field jacket) and the KEB / VIDDA PRO trekking trousers (G-1000 with reinforcement panels). G-1000 (a 65/35 poly-cotton waxable with Greenland Wax) is the signature fabric technology. EUROPEAN SIZING — see the size chart (a EU 50 ≈ US M). NO RN IS SEEDED (imported technical outerwear; none sourced). NO DECODER: the model is a NAME, and Fjällräven product numbers (e.g. F23511) are web/catalogue SKUs, not a regular tag-printed brand-unique code.',
   'https://www.fjallraven.com/', 0.80, false, 'migration:00472'),

  ('salomon', 'Salomon',
   ARRAY['salomon','salomonsports','salomonrunning']::text[],
   ARRAY['trail running shoes','hiking boots','hiking shoes','technical apparel','ski']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Salomon (a French brand, now Amer Sports) produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; a trail shoe is graded on its MILEAGE","detail":"Salomon has no consumer authentication and no per-unit serial. Grade condition — on the trail-running line the decisive read is WEAR: Contagrip outsole lug loss, a compressed EVA midsole and a frayed Quicklace/Sensifit cage. A shoe that looks clean on top can be dead underfoot; require a SOLE photo and say the outsole is UNSEEN rather than grading the mesh upper. Identify by the MODEL name (XT-6, Speedcross, X Ultra, Quest)."},{"tell":"The QUICKLACE + Sensifit cage is the product identity","detail":"The Salomon signature is the QUICKLACE toggle lace and the Sensifit welded cage — a broken toggle, a missing lace garage or a delaminated cage are real defects and part of the grade. The XT-6 (S/Lab-derived, now a fashion piece) comps very differently from the technical Speedcross; read the model."}]$j$::jsonb,
   'Founded 1947 in Annecy, France; now part of Amer Sports. The resale driver is FOOTWEAR: the XT-6 (an S/Lab-derived trail runner turned fashion staple, Sensifit + Quicklace + a mudguard), the SPEEDCROSS (an aggressive-lug trail runner on Contagrip), the X ULTRA (hiking shoe/boot) and the QUEST (a GORE-TEX backpacking boot). Contagrip (the outsole rubber) and Quicklace/Sensifit are the signature technologies. Salomon also makes technical apparel, but footwear is the resale core. THE SIZE IS STAMPED (US/UK/EU), NOT MEASURED — see the footwear chart. NO RN IS SEEDED. NO DECODER: the model is a NAME; the article number (e.g. L41252600) is a bare alphanumeric web/catalogue SKU, refused (the Chanel rule). TAG ERAS EMPTY ON PURPOSE — a modern performance brand with no value-driving vintage tag corpus (the athleisure precedent, 00452).',
   'https://www.salomon.com/', 0.80, false, 'migration:00472'),

  ('cotopaxi', 'Cotopaxi',
   ARRAY['cotopaxi','cotopaxigear']::text[],
   ARRAY['travel packs','down jackets','fleece','windbreakers','daypacks']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Cotopaxi produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the DEL DÍA colour blocking is one-of-a-kind","detail":"Cotopaxi has no per-unit serial and no consumer authentication portal. Grade condition. ⚠ The DEL DÍA line (Fuego down / Teca fleece + windbreaker) is made from REMNANT fabric and the sewer picks the colours — so NO two are alike and a wild colour block is the PRODUCT, not a flaw. The llama logo and the model (Allpa / Fuego / Teca) are the identifiers; grade the zips, the fabric and (on down) the loft."},{"tell":"The ALLPA suspension + TPU coating is the grade on a pack","detail":"On the Allpa travel pack the value is in the TPU-coated fabric, the laptop suspension and the zips — check for coating peel, zip failure and strap wear. On the Fuego down jacket the FILL LOFT (800-fill) is the grade: a flat, non-lofting or leaking baffle is a defect."}]$j$::jsonb,
   'Founded 2014 in Salt Lake City, Utah; a B-Corp known for colourful travel and outdoor gear. Core models: the ALLPA travel pack (TPU-coated, laptop suspension), the FUEGO down jacket (800-fill), the TECA fleece/windbreaker (repurposed polyester) and the DEL DÍA line (one-of-a-kind remnant-fabric colour blocking on the Fuego/Teca). The llama logo is the mark. NO RN IS SEEDED. NO DECODER: the model is a NAME; article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — a 2014 brand with no vintage tag corpus (the athleisure precedent, 00452). ⚠ ZERO COLORWAYS ARE SEEDED, DELIBERATELY: Del Día is intentionally one-of-a-kind (no stable palette) — the exact inversion of Fjällräven''s named Kånken palette.',
   'https://www.cotopaxi.com/', 0.80, false, 'migration:00472'),

  ('kuhl', 'Kühl',
   ARRAY['kuhl','kühl','kuhlclothing','kuhlpants']::text[],
   ARRAY['hiking pants','softshell pants','fleece','outdoor apparel','work-outdoor']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Kühl produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; identify by the PANT model + fabric","detail":"Kühl has no per-unit serial and no consumer authentication portal. Grade condition. The value read is the MODEL and its FABRIC: the RENEGADE (an articulated softshell hiking pant), the LAW / RYDR (a rugged cotton-nylon work-outdoor pant) and the Born-in-the-Mountains fleece (Alfpaca / Interceptor). Read the model off the interior/waistband label."},{"tell":"The FIT and the FABRIC are the grade on a pant","detail":"Kühl pants run articulated and are graded on the fabric (abrasion, knee wear, a broken gusset) and the hardware (the metal rivets/buttons). ⚠ KÜHL is the German word for cool — a bare ''kühl'' in prose is the adjective, not the brand (it is added to DETECT_EXCLUDED_FROM_TEXT; reachable by tag, never guessed from text)."}]$j$::jsonb,
   'Founded 1993 (Alfwear, Salt Lake City, Utah); known for rugged, articulated outdoor pants and fleece. Core models: the RENEGADE (softshell articulated hiking pant), the LAW / RYDR (cotton-nylon work-outdoor pants) and the ''Born in the Mountains'' fleece (Alfpaca / Interceptor). ⚠ "Kühl" IS THE GERMAN WORD FOR "COOL" — it is added to DETECT_EXCLUDED_FROM_TEXT (brand-normalize.ts) so it is reachable BY TAG but never GUESSED from prose, and both `khl` (accented) and `kuhl` (unaccented) alias keys resolve a tag. NO RN IS SEEDED. NO DECODER: the model is a NAME; article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — a 1993 brand with no value-driving vintage tag corpus (the athleisure precedent, 00452).',
   'https://www.kuhl.com/', 0.80, false, 'migration:00472'),

  ('hellyhansen', 'Helly Hansen',
   ARRAY['helly hansen','hellyhansen','helly','hh','hellyhansenworkwear']::text[],
   ARRAY['ski jackets','sailing rain jackets','shell jackets','base layers','technical outerwear']::text[],
   ARRAY[]::text[],
   $j$[{"era":"Older HH-logo labels / vintage rain gear","years":"1877-present (approximate)","description":"COLLECTOR-CORROBORATED, NOT A DATED CHART. Helly Hansen (founded 1877, Moss, Norway by Helly Juell Hansen) is one of the oldest technical-apparel makers. Vintage oilskin/rubberized rain gear and older ''HH'' logo labels (and the 1980s-90s sailing pieces that resurged as streetwear) skew vintage, but no precise dated chronology is sourced — treat as a coarse prior. The LIFA fibre (1970) and Helly Tech membrane are the durable technology identity."}]$j$::jsonb,
   $j$[{"pattern":"Norway (heritage), broadly offshore (modern)","note":"COARSE PRIOR ONLY: HH is a Norwegian brand and older stock may carry European construction, but modern product is broadly offshore and country does not authenticate or precisely date a piece."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the MEMBRANE / insulation is the grade","detail":"Helly Hansen has no per-unit serial and no consumer authentication portal. Grade condition. Identify by the MODEL + technology: the ALPHA (insulated ski jacket, H2Flow + Life Pockets), the ODIN / VERGLAS (GORE-TEX / shell mountaineering), LIFA base layers (LIFA hydrophobic fibre) and the CREW jacket (Helly Tech sailing rain jacket). On a shell the membrane (delamination, wetting-out) and the seam tape are the grade — require a lining photo."},{"tell":"The vintage HH sailing pieces comp as streetwear","detail":"1980s-90s HH sailing/logo pieces resurged as streetwear and comp on the vintage market, separately from current technical stock. Read the label era and the model — do not price a vintage logo jacket off the current Alpha ski ladder or vice versa."}]$j$::jsonb,
   'Founded 1877 in Moss, Norway by Helly Juell Hansen; one of the oldest technical-apparel houses. Core models: the ALPHA (insulated ski jacket, H2Flow venting + Life Pockets), the ODIN / VERGLAS (GORE-TEX shell mountaineering), the LIFA base layers (the LIFA hydrophobic fibre, 1970) and the iconic CREW jacket (a Helly Tech sailing rain jacket). EUROPEAN SIZING — see the size chart (a EU 50 ≈ US M). NO RN IS SEEDED. NO DECODER: the model is a NAME; HH product numbers (e.g. 53040) are web/catalogue SKUs, not a regular tag-printed brand-unique code.',
   'https://www.hellyhansen.com/', 0.80, false, 'migration:00472'),

  ('mammut', 'Mammut',
   ARRAY['mammut','mammutsports']::text[],
   ARRAY['mountaineering boots','packs','shell jackets','softshell','alpine apparel']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia)","note":"Mammut (a Swiss brand) produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the MEMBRANE / boot construction is the grade","detail":"Mammut has no per-unit serial and no consumer authentication portal. Grade condition. Identify by the MODEL + technology: the TRION / DUCAN packs, the KENTO / NORDWAND mountaineering boots (GORE-TEX), the EIGER EXTREME premium alpine line and the classic softshell / Ultimate hoody. The mammoth logo is the mark. On a GORE-TEX boot the membrane, the rand and the sole bond are the grade — require a sole photo."},{"tell":"The EIGER EXTREME line is the premium tier","detail":"Eiger Extreme is Mammut''s top alpine collection and comps well above the general line — read the exact model/collection off the label, do not fold it onto the mainline ladder."}]$j$::jsonb,
   'Founded 1862 in Switzerland (originally a rope maker); a Swiss alpine brand. Core products: the TRION / DUCAN packs, the KENTO / NORDWAND mountaineering boots (GORE-TEX), the EIGER EXTREME premium alpine line and the classic softshell / Ultimate hoody. The mammoth logo is the mark; GORE-TEX and Mammut''s softshell fabrics are the signature technologies. EUROPEAN SIZING — see the size chart (a EU 50 ≈ US M). NO RN IS SEEDED. NO DECODER: the model is a NAME; article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — no documented, value-driving dated label chronology is sourced (the athleisure precedent, 00452).',
   'https://www.mammut.com/', 0.80, false, 'migration:00472'),

  ('rab', 'Rab',
   ARRAY['rab','rabequipment','rabdownjacket']::text[],
   ARRAY['down jackets','synthetic insulation','softshell','shell jackets','mountaineering']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"broadly offshore (Asia); UK design","note":"Rab (a British brand) designs in the UK and produces broadly offshore; country is not a date or authenticity tell."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; on a down jacket the LOFT + fill-power is the grade","detail":"Rab has no per-unit serial and no consumer authentication portal. Grade condition. The value read is the MODEL + insulation: the MICROLIGHT (the flagship down jacket, Pertex shell + hydrophobic down, stitch-through baffles), the NEUTRINO (higher fill-power box-wall down), the KINETIC (waterproof softshell) and the XENON (synthetic Primaloft). On a down jacket the FILL LOFT and any leaking baffle are the grade — require a photo of the baffles and the Pertex face."},{"tell":"Read STITCH-THROUGH vs BOX-WALL construction","detail":"The Microlight is stitch-through (lighter, everyday) and the Neutrino is box-wall (warmer, higher fill-power) — they look similar but comp differently. Read the model and the baffle construction. ⚠ ''Rab'' is an ordinary short token / a given name (added to DETECT_EXCLUDED_FROM_TEXT; reachable by tag, never guessed from prose)."}]$j$::jsonb,
   'Founded 1981 in Sheffield, England by Rab Carrington; a British down/insulation specialist. Core models: the MICROLIGHT (THE flagship down jacket — Pertex shell, hydrophobic down, stitch-through baffles), the NEUTRINO (box-wall higher-fill-power down), the KINETIC (waterproof softshell) and the XENON (synthetic Primaloft). Pertex (shell), hydrophobic down and down FILL-POWER are the signature technologies. ⚠ "Rab" IS AN ORDINARY SHORT TOKEN / A GIVEN NAME — added to DETECT_EXCLUDED_FROM_TEXT (brand-normalize.ts) so it is reachable BY TAG but never GUESSED from prose (the KEEN / Brooks precedent, 00470). EUROPEAN/UK SIZING — see the size chart. NO RN IS SEEDED. NO DECODER: the model is a NAME; article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — no value-driving vintage tag corpus (the athleisure precedent, 00452).',
   'https://www.rab.equipment/', 0.80, false, 'migration:00472'),

  ('outdoorresearch', 'Outdoor Research',
   ARRAY['outdoor research','outdoorresearch','orgear']::text[],
   ARRAY['shell jackets','softshell','wind shells','gloves','gaiters','accessories']::text[],
   ARRAY[]::text[],
   $j$[]$j$::jsonb,
   $j$[{"pattern":"USA (some Seattle-made accessories) + broadly offshore","note":"Outdoor Research (Seattle) makes some accessories in the USA and produces apparel broadly offshore; country is not a reliable date or authenticity tell on its own."}]$j$::jsonb,
   $j$[{"tell":"Grade condition; the MEMBRANE / shell fabric is the grade","detail":"Outdoor Research has no per-unit serial and no consumer authentication portal. Grade condition. Identify by the MODEL + technology: the FORAY / ASPIRE (GORE-TEX jacket with the signature side TorsoFlo zips), the FERROSI (stretch-woven softshell pant/jacket), the HELIUM (ultralight Pertex wind shell) and the accessories (Crocodile gaiters, Sun Runner) — OR is unusually strong in accessories (gloves, gaiters, hats). On a shell the membrane and seam tape are the grade."},{"tell":"The TorsoFlo side zips are the Foray/Aspire identity","detail":"The Foray (men) / Aspire (women) run full-length side ''TorsoFlo'' zips from hem to bicep — the unmistakable cue that separates them from an ordinary GORE-TEX shell. Check the zips and the seam tape; a failed zip or peeling tape is a defect."}]$j$::jsonb,
   'Founded 1981 in Seattle, Washington; a technical apparel + accessories brand. Core products: the FORAY / ASPIRE (GORE-TEX jacket with the signature full-length side TorsoFlo zips), the FERROSI (stretch-woven softshell pant/jacket), the HELIUM (ultralight Pertex wind shell) and the accessories heritage (Crocodile gaiters, Sun Runner sun hat, gloves) — OR is unusually strong in accessories. GORE-TEX, Pertex and the stretch-woven softshell are the signature technologies. US SIZING — see the size chart. NO RN IS SEEDED. NO DECODER: the model is a NAME; article numbers are web SKUs. TAG ERAS EMPTY ON PURPOSE — a modern performance brand with no value-driving vintage tag corpus (the athleisure precedent, 00452). ⚠ do NOT alias a bare "OR" — it is the English word / the state Oregon; only "outdoor research" / "outdoorresearch" resolve.',
   'https://www.outdoorresearch.com/', 0.80, false, 'migration:00472')
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
-- prompt (US-1740). For this group the highest-value fingerprint is the MODEL
-- silhouette + the FABRIC TECHNOLOGY (GORE-TEX, G-1000, LIFA, Pertex, down
-- fill-power, Contagrip) that separates lookalike shells/fleece/packs, so the
-- style rows lead with those.
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint,
   fabric_tech, era, msrp_band, keywords, source_url, confidence, verified, updated_by)
values
  -- Fjällräven
  ('fjallraven', 'Kånken', 'Unisex', 'backpack', 'Backpacks',
   'THE ICON: a boxy, structured daypack in Vinylon-F / G-1000 with SNAP-BUTTON shoulder straps, twin side pockets, a flat zip-around top and the ARCTIC-FOX logo patch. ⚠ Comes in Classic, Mini, Big, Laptop and Re-Kånken — read the size. Searched by its NAMED colourway (UN Blue, Ox Red, Frost Green...). The fabric body + snap straps are the grade.',
   ARRAY['Vinylon-F','G-1000']::text[], '1978-present', '$$',
   ARRAY['kanken','kånken','daypack','arctic fox','snap strap','fjallraven']::text[],
   'https://www.fjallraven.com/', 0.80, false, 'migration:00472'),
  ('fjallraven', 'Greenland Jacket', 'Unisex', 'jacket', 'Waxed outerwear',
   'A boxy field jacket in G-1000 (a 65/35 poly-cotton WAXABLE fabric, treated with Greenland Wax), with big front bellows pockets and a fold-down collar. ⚠ The wax finish is maintenance, not damage — a re-waxed or patchy face is normal; abrasion holes and a broken zip are defects. Made-for-wax is the identity.',
   ARRAY['G-1000','Greenland Wax']::text[], '1968-present', '$$$',
   ARRAY['greenland jacket','g-1000','waxable','field jacket','fjallraven']::text[],
   'https://www.fjallraven.com/', 0.75, false, 'migration:00472'),
  ('fjallraven', 'Keb / Vidda Pro Trousers', 'Unisex', 'pants', 'Trekking trousers',
   'G-1000 trekking TROUSERS with REINFORCEMENT PANELS at the knee/seat, ventilation zips and articulated knees. Keb (a hybrid stretch + G-1000) and Vidda Pro (full G-1000) are the two core trousers. Grade the fabric, the knees and the zips; read the model off the waistband label.',
   ARRAY['G-1000','stretch panels']::text[], 'current', '$$$',
   ARRAY['keb','vidda pro','trekking trousers','g-1000','fjallraven']::text[],
   'https://www.fjallraven.com/', 0.65, false, 'migration:00472'),

  -- Salomon
  ('salomon', 'XT-6', 'Unisex', 'shoe', 'Trail / sportstyle',
   'THE S/Lab-DERIVED trail runner turned fashion staple: a low, aggressive mesh + welded-cage silhouette with the SENSIFIT cage, QUICKLACE toggle and a chunky mudguard. ⚠ Separable from the Speedcross by the sleeker, lower-lug fashion sole. Grade the Contagrip outsole + the Quicklace toggle; the model is on the tongue/heel.',
   ARRAY['mesh','Sensifit cage','Contagrip outsole','Quicklace']::text[], 'current', '$$$',
   ARRAY['xt-6','xt6','s/lab','quicklace','sensifit','salomon']::text[],
   'https://www.salomon.com/', 0.80, false, 'migration:00472'),
  ('salomon', 'Speedcross', 'Unisex', 'shoe', 'Trail running',
   'THE aggressive-LUG trail runner: deep, widely-spaced Contagrip lugs for soft/muddy ground, a Quicklace toggle and a Sensifit cage. ⚠ Separable from the XT-6 by the DEEP MUD LUGS. Numbered by generation. Grade on mileage (outsole lug loss, packed-out midsole) — require a sole photo.',
   ARRAY['mesh','Contagrip outsole','Quicklace','Sensifit']::text[], 'current', '$$',
   ARRAY['speedcross','trail running','mud lugs','contagrip','salomon']::text[],
   'https://www.salomon.com/', 0.75, false, 'migration:00472'),
  ('salomon', 'X Ultra', 'Unisex', 'shoe', 'Hiking',
   'A hiking shoe/mid boot (X Ultra) with a Contagrip outsole, Advanced Chassis and GORE-TEX (GTX) options. Separable from the trail runners by the more supportive hiking build. Grade the outsole + the membrane; read the model off the tongue.',
   ARRAY['synthetic','Contagrip outsole','GORE-TEX']::text[], 'current', '$$',
   ARRAY['x ultra','hiking shoe','gore-tex','contagrip','salomon']::text[],
   'https://www.salomon.com/', 0.65, false, 'migration:00472'),
  ('salomon', 'Quest', 'Unisex', 'boot', 'Backpacking',
   'A tall GORE-TEX BACKPACKING BOOT with a supportive chassis, a protective toe cap and a lugged Contagrip outsole. The stiffest of the seeded Salomon footwear. Grade the membrane, the sole bond and the outsole lugs — require a sole photo.',
   ARRAY['nubuck','GORE-TEX','Contagrip outsole']::text[], 'current', '$$$',
   ARRAY['quest','backpacking boot','gore-tex','contagrip','salomon']::text[],
   'https://www.salomon.com/', 0.60, false, 'migration:00472'),

  -- Cotopaxi
  ('cotopaxi', 'Del Día', 'Unisex', 'jacket', 'Repurposed / one-of-a-kind',
   '⚠ THE ONE-OF-A-KIND line: the Fuego (down) and Teca (fleece/windbreaker) made from REMNANT fabric where the SEWER CHOOSES THE COLOURS — so no two are alike and a wild colour block is the PRODUCT, not a flaw. The llama logo is the mark. Grade the zips + fabric; on the Fuego, the down LOFT.',
   ARRAY['repurposed nylon','down','repurposed polyester']::text[], 'current', '$$$',
   ARRAY['del dia','del día','one-of-a-kind','llama','repurposed','cotopaxi']::text[],
   'https://www.cotopaxi.com/', 0.75, false, 'migration:00472'),
  ('cotopaxi', 'Allpa', 'Unisex', 'backpack', 'Travel packs',
   'THE travel pack: a boxy, clamshell-opening TPU-COATED pack with a laptop suspension, mesh internal organisation and a rain cover. Sold in 28L/35L/42L. Grade the TPU coating (peel), the zips and the straps; the model is on the pack.',
   ARRAY['TPU-coated nylon','ripstop']::text[], 'current', '$$',
   ARRAY['allpa','travel pack','tpu','laptop','cotopaxi']::text[],
   'https://www.cotopaxi.com/', 0.70, false, 'migration:00472'),
  ('cotopaxi', 'Fuego', 'Unisex', 'jacket', 'Down insulation',
   'The 800-FILL down jacket (hooded and non-hooded), often in bright/blocked colours. ⚠ The Del Día Fuego is one-of-a-kind (remnant colours); the standard Fuego ships season colours. Grade the FILL LOFT and any leaking baffle — require a photo of the baffles.',
   ARRAY['down 800-fill','ripstop nylon']::text[], 'current', '$$$',
   ARRAY['fuego','down jacket','800-fill','cotopaxi']::text[],
   'https://www.cotopaxi.com/', 0.65, false, 'migration:00472'),
  ('cotopaxi', 'Teca', 'Unisex', 'jacket', 'Fleece / windbreaker',
   'The TECA line: a repurposed-polyester fleece (Teca Fleece) and a packable windbreaker (Teca Half-Zip / Cálido), typically colour-blocked. Grade the fabric, the zips and the pill; on Del Día Teca the colour block is one-of-a-kind.',
   ARRAY['repurposed polyester fleece','ripstop']::text[], 'current', '$$',
   ARRAY['teca','fleece','windbreaker','repurposed','cotopaxi']::text[],
   'https://www.cotopaxi.com/', 0.60, false, 'migration:00472'),

  -- Kühl
  ('kuhl', 'Renegade Pant', 'Men', 'pants', 'Softshell hiking',
   'THE core hiking pant: an ARTICULATED softshell pant with a stretch nylon fabric, gusseted crotch, zip thigh pocket and a signature waistband. Grade the fabric (abrasion, knee wear), the gusset and the hardware. Read the model off the interior/waistband label; sold by WAIST x inseam.',
   ARRAY['stretch nylon softshell']::text[], 'current', '$$',
   ARRAY['renegade','softshell','hiking pant','articulated','kuhl']::text[],
   'https://www.kuhl.com/', 0.75, false, 'migration:00472'),
  ('kuhl', 'Law / Rydr Pant', 'Men', 'pants', 'Work-outdoor',
   'A rugged COTTON-NYLON work-outdoor pant (Law = the flagship, Rydr = a relaxed 5-pocket), heavier and more casual than the Renegade softshell, with metal rivets/hardware. Grade the fabric, the knees and the rivets. Sold by WAIST x inseam.',
   ARRAY['cotton-nylon canvas']::text[], 'current', '$$',
   ARRAY['law','rydr','work pant','cotton nylon','kuhl']::text[],
   'https://www.kuhl.com/', 0.65, false, 'migration:00472'),
  ('kuhl', 'Born in the Mountains Fleece', 'Unisex', 'fleece', 'Fleece',
   'The Kühl fleece line (Alfpaca / Interceptor / Spyfire): a high-loft bonded or Alfpaca fleece with the ''Born in the Mountains'' branding. Grade the loft, the pill and the zips. Read the exact model off the label; comp against the specific fleece.',
   ARRAY['Alfpaca fleece','bonded fleece']::text[], 'current', '$$$',
   ARRAY['alfpaca','interceptor','fleece','born in the mountains','kuhl']::text[],
   'https://www.kuhl.com/', 0.60, false, 'migration:00472'),

  -- Helly Hansen
  ('hellyhansen', 'Alpha', 'Unisex', 'jacket', 'Ski insulation',
   'THE insulated SKI jacket: PrimaLoft insulation with H2Flow venting (mechanical torso vents) and Life Pockets, a helmet-compatible hood and a powder skirt. Grade the insulation loft, the zips and the membrane. Read the model off the interior label; comp on the ski ladder.',
   ARRAY['PrimaLoft','H2Flow','Helly Tech']::text[], 'current', '$$$$',
   ARRAY['alpha','ski jacket','h2flow','life pockets','helly hansen']::text[],
   'https://www.hellyhansen.com/', 0.75, false, 'migration:00472'),
  ('hellyhansen', 'Odin / Verglas', 'Unisex', 'jacket', 'Shell mountaineering',
   'The technical SHELL line: GORE-TEX (or Helly Tech Professional) hardshell mountaineering jackets (Odin, Verglas) with taped seams and a helmet hood. Grade the membrane (delamination, wetting-out) and the seam tape — require a lining photo. Comp on the technical-shell ladder.',
   ARRAY['GORE-TEX','Helly Tech Professional']::text[], 'current', '$$$$',
   ARRAY['odin','verglas','gore-tex','hardshell','helly hansen']::text[],
   'https://www.hellyhansen.com/', 0.70, false, 'migration:00472'),
  ('hellyhansen', 'LIFA Base Layer', 'Unisex', 'base layer', 'Base layers',
   'The LIFA base layers: a hydrophobic LIFA fibre (often a LIFA + merino blend, ''LIFA Merino'') next-to-skin layer. Grade the fabric (pilling, thinning, odour) and the seams. Read ''LIFA'' off the neck label; comp as a technical base layer.',
   ARRAY['LIFA fibre','merino blend']::text[], '1970-present', '$',
   ARRAY['lifa','base layer','hydrophobic','merino','helly hansen']::text[],
   'https://www.hellyhansen.com/', 0.65, false, 'migration:00472'),
  ('hellyhansen', 'Crew Jacket', 'Unisex', 'jacket', 'Sailing rain',
   'THE iconic SAILING rain jacket: a Helly Tech waterproof-breathable jacket with a fleece-lined collar, often in bright colour blocks with the HH logo — a piece that resurged as streetwear. Grade the membrane, the zips and the lining. Vintage examples comp as streetwear.',
   ARRAY['Helly Tech']::text[], 'current', '$$',
   ARRAY['crew jacket','sailing','helly tech','rain jacket','helly hansen']::text[],
   'https://www.hellyhansen.com/', 0.65, false, 'migration:00472'),

  -- Mammut
  ('mammut', 'Trion / Ducan Pack', 'Unisex', 'backpack', 'Packs',
   'The alpine PACKS: the Trion (technical climbing/alpine pack) and the Ducan (trekking pack), with the mammoth logo. Grade the fabric (abrasion, coating), the zips, the buckles and the frame/suspension. Read the model + litre volume off the pack.',
   ARRAY['ripstop nylon','coated fabric']::text[], 'current', '$$',
   ARRAY['trion','ducan','pack','mammoth','mammut']::text[],
   'https://www.mammut.com/', 0.65, false, 'migration:00472'),
  ('mammut', 'Kento / Nordwand Boot', 'Unisex', 'boot', 'Mountaineering',
   'GORE-TEX mountaineering BOOTS: the Kento (lighter hiking/mountaineering) and the Nordwand (technical alpine, often crampon-compatible). Grade the GORE-TEX membrane, the rand, the sole bond and the lugs — require a sole photo. Read the model off the tongue/heel.',
   ARRAY['GORE-TEX','Vibram outsole']::text[], 'current', '$$$',
   ARRAY['kento','nordwand','mountaineering boot','gore-tex','mammut']::text[],
   'https://www.mammut.com/', 0.60, false, 'migration:00472'),
  ('mammut', 'Eiger Extreme', 'Unisex', 'jacket', 'Premium alpine',
   '⚠ THE PREMIUM alpine collection: top-tier shells, down and softshell built for high-altitude use — comps ABOVE the mainline. Read ''Eiger Extreme'' off the label; grade the membrane/insulation and hardware. Do not fold it onto the general Mammut ladder.',
   ARRAY['GORE-TEX Pro','down','softshell']::text[], 'current', '$$$$',
   ARRAY['eiger extreme','premium','alpine','gore-tex pro','mammut']::text[],
   'https://www.mammut.com/', 0.60, false, 'migration:00472'),
  ('mammut', 'Ultimate Hoody', 'Unisex', 'jacket', 'Softshell',
   'The classic SOFTSHELL: the Ultimate hooded softshell (WINDSTOPPER / GORE-TEX Infinium), a stretchy wind-resistant midlayer/outer. Grade the fabric (abrasion, pill), the zips and the cuffs. Read the model off the label.',
   ARRAY['WINDSTOPPER','GORE-TEX Infinium','softshell']::text[], 'current', '$$$',
   ARRAY['ultimate hoody','softshell','windstopper','mammut']::text[],
   'https://www.mammut.com/', 0.55, false, 'migration:00472'),

  -- Rab
  ('rab', 'Microlight', 'Unisex', 'jacket', 'Down insulation',
   'THE FLAGSHIP down jacket: a lightweight PERTEX shell over HYDROPHOBIC down with STITCH-THROUGH baffles (visible horizontal seam lines through the down). ⚠ Separable from the Neutrino by the stitch-through (not box-wall) baffles. Grade the FILL LOFT, any leaking baffle and the Pertex face — require a baffle photo.',
   ARRAY['Pertex shell','hydrophobic down','stitch-through baffles']::text[], 'current', '$$$',
   ARRAY['microlight','down jacket','pertex','stitch-through','rab']::text[],
   'https://www.rab.equipment/', 0.80, false, 'migration:00472'),
  ('rab', 'Neutrino', 'Unisex', 'jacket', 'Down insulation',
   'The higher-fill-power BOX-WALL down jacket (warmer than the Microlight): internal box baffles that hold more loft, a Pertex shell. ⚠ Separable from the Microlight by the BOX-WALL construction (no stitch-through seams). Grade the loft + baffles; comp above the Microlight.',
   ARRAY['Pertex shell','box-wall down','high fill-power']::text[], 'current', '$$$$',
   ARRAY['neutrino','box-wall','down jacket','high fill power','rab']::text[],
   'https://www.rab.equipment/', 0.70, false, 'migration:00472'),
  ('rab', 'Kinetic', 'Unisex', 'jacket', 'Waterproof softshell',
   'The WATERPROOF SOFTSHELL line (Kinetic): a stretchy Proflex waterproof-breathable jacket that bridges hardshell and softshell. Grade the membrane, the DWR face and the seams. Read the model off the label; comp on the softshell/shell ladder.',
   ARRAY['Proflex membrane','stretch waterproof']::text[], 'current', '$$$',
   ARRAY['kinetic','waterproof softshell','proflex','rab']::text[],
   'https://www.rab.equipment/', 0.60, false, 'migration:00472'),
  ('rab', 'Xenon', 'Unisex', 'jacket', 'Synthetic insulation',
   'The SYNTHETIC-insulation jacket (Xenon): PrimaLoft synthetic fill (warm when damp) under a Pertex shell — the synthetic counterpart to the down Microlight. Grade the fabric, the loft and the zips. Read the model off the label.',
   ARRAY['Pertex shell','PrimaLoft synthetic']::text[], 'current', '$$',
   ARRAY['xenon','synthetic','primaloft','pertex','rab']::text[],
   'https://www.rab.equipment/', 0.55, false, 'migration:00472'),

  -- Outdoor Research
  ('outdoorresearch', 'Foray / Aspire', 'Unisex', 'jacket', 'GORE-TEX shell',
   'THE signature GORE-TEX shell: the Foray (men) / Aspire (women) with full-length side ''TorsoFlo'' zips running hem-to-bicep (the unmistakable cue) for ventilation. Grade the membrane, the zips and the seam tape — require a lining photo. Read the model off the interior label.',
   ARRAY['GORE-TEX','TorsoFlo side zips']::text[], 'current', '$$$',
   ARRAY['foray','aspire','gore-tex','torsoflo','outdoor research']::text[],
   'https://www.outdoorresearch.com/', 0.75, false, 'migration:00472'),
  ('outdoorresearch', 'Ferrosi', 'Unisex', 'jacket', 'Stretch softshell',
   'The STRETCH-WOVEN softshell line (Ferrosi): a light, breathable, wind-resistant nylon-spandex softshell jacket AND pant — the everyday do-everything OR piece. Grade the fabric (abrasion, pill), the zips and the cuffs. Sold as jacket, hoody and pant.',
   ARRAY['stretch-woven nylon-spandex softshell']::text[], 'current', '$$',
   ARRAY['ferrosi','softshell','stretch-woven','outdoor research']::text[],
   'https://www.outdoorresearch.com/', 0.70, false, 'migration:00472'),
  ('outdoorresearch', 'Helium', 'Unisex', 'jacket', 'Ultralight wind shell',
   'The ULTRALIGHT Pertex wind/rain shell (Helium): a packable, minimal Pertex Shield jacket that stuffs into its own pocket. Grade the Pertex face, the coating (peel) and the zip. Read the model off the label; comp as an ultralight shell.',
   ARRAY['Pertex Shield','ripstop nylon']::text[], 'current', '$$',
   ARRAY['helium','ultralight','pertex','wind shell','outdoor research']::text[],
   'https://www.outdoorresearch.com/', 0.60, false, 'migration:00472'),
  ('outdoorresearch', 'Gaiters / Accessories', 'Unisex', 'accessory', 'Accessories',
   'THE ACCESSORIES heritage: the CROCODILE gaiters (the iconic burly GORE-TEX gaiter), the Sun Runner sun hat, and OR gloves — Outdoor Research is unusually strong in accessories. Grade the fabric, the closures and the elastic. Read the model off the tag; comp on the accessory market.',
   ARRAY['GORE-TEX','nylon','Cordura']::text[], 'current', '$',
   ARRAY['crocodile','gaiters','sun runner','gloves','accessories','outdoor research']::text[],
   'https://www.outdoorresearch.com/', 0.55, false, 'migration:00472')
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
-- ONE BRAND QUALIFIES. The Fjällräven KÅNKEN ships in a small set of DURABLE,
-- proprietary NAMED colours that recur across the daypack for years and are
-- searched BY NAME — a true internal palette (the UGG Chestnut / Dr. Martens
-- Cherry Red precedent, 00459). The other seven brands ship ordinary descriptive
-- season colours that form no stable dictionary, so none are seeded (00456/00462).
-- ⚠ COTOPAXI IS THE INVERSION: Del Día is INTENTIONALLY one-of-a-kind (the sewer
-- picks the remnant-fabric colours), so there is NO stable palette to seed —
-- ZERO Cotopaxi colorways, by design.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by)
values
  ('fjallraven', 'UN Blue', ARRAY['un blue','unblue']::text[], null,
   'The classic KÅNKEN blue — a mid royal/cornflower blue, one of the original and most-searched Kånken colourways. A proprietary NAMED colour, checkable by eye against the photo.',
   'https://www.fjallraven.com/', 0.75, false, 'migration:00472'),
  ('fjallraven', 'Ox Red', ARRAY['ox red','oxred']::text[], null,
   'A deep brick/oxblood red Kånken colourway — a durable named colour that recurs across seasons.',
   'https://www.fjallraven.com/', 0.70, false, 'migration:00472'),
  ('fjallraven', 'Frost Green', ARRAY['frost green','frostgreen']::text[], null,
   'A soft sage/frost green Kånken colourway — a durable named colour searched by name.',
   'https://www.fjallraven.com/', 0.70, false, 'migration:00472'),
  ('fjallraven', 'Graphite', ARRAY['graphite grey','graphite gray']::text[], null,
   'A dark charcoal/graphite grey Kånken colourway — a staple named colour.',
   'https://www.fjallraven.com/', 0.70, false, 'migration:00472'),
  ('fjallraven', 'Royal Blue', ARRAY['royal blue','royalblue']::text[], null,
   'A bright royal blue Kånken colourway — a recurring named colour.',
   'https://www.fjallraven.com/', 0.65, false, 'migration:00472'),
  ('fjallraven', 'Ochre', ARRAY['ochre','ocre']::text[], null,
   'A warm mustard/ochre yellow Kånken colourway — a durable named colour searched by name.',
   'https://www.fjallraven.com/', 0.65, false, 'migration:00472')
on conflict (brand_key, color_name) do update set
  aliases    = excluded.aliases,
  hex        = excluded.hex,
  years      = excluded.years,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  updated_by = excluded.updated_by;

-- ── brand_size_charts ──────────────────────────────────────────────────────
-- Mirrored 1:1 into services/edge-functions/src/lib/sizing-charts.ts (the
-- in-code fallback). formatSizingChartsForPrompt renders labels + note IN FULL
-- (US-1740), so the fit/system caveats live in the note. THE SYSTEM (EU numeric
-- vs US alpha vs a stamped US/UK/EU footwear number) is the signal, written into
-- the note. Body-equivalent approximations, not brand-published specs — hence the
-- modest confidence.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows,
   note, source_url, confidence, verified, updated_by)
values
  -- Fjällräven — EUROPEAN numeric apparel. Men + Women.
  ('fjallraven', 'Fjällräven', ARRAY['fjällräven','fjallraven']::text[], 'Men',
   'Apparel (EU numeric ↔ US alpha, body inches)',
   ARRAY['jacket','pants','trouser','shirt','fleece','top','vest','shell','greenland','keb','vidda']::text[],
   $j$[{"size":"S = EU 46-48","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M = EU 50","measurements":{"chest":"38-40","waist":"32-34"}},{"size":"L = EU 52","measurements":{"chest":"41-43","waist":"35-37"}},{"size":"XL = EU 54","measurements":{"chest":"44-46","waist":"38-40"}},{"size":"XXL = EU 56","measurements":{"chest":"47-49","waist":"41-43"}}]$j$::jsonb,
   'FJÄLLRÄVEN IS A EUROPEAN BRAND — much stock is EU-numbered (a EU 50 ≈ US M), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label and state the EU number for the buyer to check. Trousers are often sold by WAIST inch (and a numeric leg length). G-1000 is a WAXABLE fabric — a re-waxed face is maintenance, not damage; abrasion holes and a broken zip are the defects. Body-equivalent approximations, not brand-published specs.',
   'https://www.fjallraven.com/', 0.55, false, 'migration:00472'),
  ('fjallraven', 'Fjällräven', ARRAY['fjällräven','fjallraven']::text[], 'Women',
   'Apparel (EU numeric ↔ US alpha, body inches)',
   ARRAY['jacket','pants','trouser','shirt','fleece','top','vest','shell','greenland','keb','vidda']::text[],
   $j$[{"size":"XS = EU 34","measurements":{"bust":"32-33","waist":"24-25","hip":"34-35"}},{"size":"S = EU 36","measurements":{"bust":"34-35","waist":"26-27","hip":"36-37"}},{"size":"M = EU 38","measurements":{"bust":"36-37.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L = EU 40","measurements":{"bust":"38.5-40","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL = EU 42","measurements":{"bust":"41-43","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'FJÄLLRÄVEN IS A EUROPEAN BRAND — women''s stock is often EU-numbered (a EU 38 ≈ US M/S), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label and state the EU number. Trousers are often sold by WAIST inch. Body-equivalent approximations, not brand-published specs.',
   'https://www.fjallraven.com/', 0.55, false, 'migration:00472'),

  -- Salomon — FOOTWEAR (the resale driver). US/UK/EU translator; the size is STAMPED.
  ('salomon', 'Salomon', ARRAY['salomon']::text[], 'Men',
   'Footwear (US/UK/EU — trail/hiking, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','boot','trail','hiking','running','xt-6','speedcross','x ultra','quest','sneaker']::text[],
   $j$[{"size":"US M8 = UK 7.5 = EU 41.5","measurements":{"footLength":"9.95"}},{"size":"US M9 = UK 8.5 = EU 43","measurements":{"footLength":"10.3"}},{"size":"US M10 = UK 9.5 = EU 44.5","measurements":{"footLength":"10.6"}},{"size":"US M11 = UK 10.5 = EU 45.5","measurements":{"footLength":"10.95"}},{"size":"US M12 = UK 11.5 = EU 46.5","measurements":{"footLength":"11.25"}},{"size":"US M13 = UK 12.5 = EU 48","measurements":{"footLength":"11.6"}}]$j$::jsonb,
   'SALOMON IS A FRENCH/EU BRAND and its shoes are primarily EU-stamped; the US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED — read it off the tongue/insole. A trail runner is graded on MILEAGE: Contagrip OUTSOLE lug loss, a packed-out midsole and a frayed Quicklace/Sensifit cage are the real defects and need a SOLE photo. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.salomon.com/', 0.55, false, 'migration:00472'),
  ('salomon', 'Salomon', ARRAY['salomon']::text[], 'Women',
   'Footwear (US/UK/EU — trail/hiking, the size is STAMPED)',
   ARRAY['shoe','shoes','footwear','boot','trail','hiking','running','xt-6','speedcross','x ultra','sneaker']::text[],
   $j$[{"size":"US W6 = UK 4 = EU 37","measurements":{"footLength":"8.9"}},{"size":"US W7 = UK 5 = EU 38","measurements":{"footLength":"9.25"}},{"size":"US W8 = UK 6 = EU 39","measurements":{"footLength":"9.5"}},{"size":"US W9 = UK 7 = EU 40.5","measurements":{"footLength":"9.9"}},{"size":"US W10 = UK 8 = EU 41.5","measurements":{"footLength":"10.2"}},{"size":"US W11 = UK 9 = EU 43","measurements":{"footLength":"10.5"}}]$j$::jsonb,
   'SALOMON IS A FRENCH/EU BRAND and its shoes are primarily EU-stamped; the US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED. A trail runner is graded on MILEAGE — Contagrip OUTSOLE lug loss + a packed-out midsole need a SOLE photo. Foot-length inches are a sanity check for a shoe in hand. Body-equivalent approximations, not brand-published specs.',
   'https://www.salomon.com/', 0.55, false, 'migration:00472'),

  -- Cotopaxi — US alpha apparel. Men + Women.
  ('cotopaxi', 'Cotopaxi', ARRAY['cotopaxi']::text[], 'Men',
   'Apparel (US alpha, body inches)',
   ARRAY['jacket','fleece','vest','top','shirt','windbreaker','fuego','teca','down','shell']::text[],
   $j$[{"size":"S","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M","measurements":{"chest":"38-40","waist":"32-34"}},{"size":"L","measurements":{"chest":"41-43","waist":"35-37"}},{"size":"XL","measurements":{"chest":"44-46","waist":"38-40"}},{"size":"XXL","measurements":{"chest":"47-49","waist":"41-43"}}]$j$::jsonb,
   'Cotopaxi men''s apparel sizes US alpha (S-XXL); the SYSTEM is US alpha. ⚠ THE DEL DÍA colour blocking is ONE-OF-A-KIND (remnant fabric, the sewer picks the colours) — a wild colour block is the PRODUCT, not a flaw. On the Fuego down jacket the FILL LOFT is the grade (a flat/leaking baffle is a defect). Body-equivalent approximations, not brand-published specs.',
   'https://www.cotopaxi.com/', 0.55, false, 'migration:00472'),
  ('cotopaxi', 'Cotopaxi', ARRAY['cotopaxi']::text[], 'Women',
   'Apparel (US alpha, body inches)',
   ARRAY['jacket','fleece','vest','top','shirt','windbreaker','fuego','teca','down','shell']::text[],
   $j$[{"size":"XS","measurements":{"bust":"32-33","waist":"24-25","hip":"34-35"}},{"size":"S","measurements":{"bust":"34-35","waist":"26-27","hip":"36-37"}},{"size":"M","measurements":{"bust":"36-37.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L","measurements":{"bust":"38.5-40","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL","measurements":{"bust":"41-43","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'Cotopaxi women''s apparel sizes US alpha (XS-XL); the SYSTEM is US alpha. ⚠ THE DEL DÍA colour blocking is ONE-OF-A-KIND (remnant fabric) — a wild colour block is the PRODUCT. On the Fuego the FILL LOFT is the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.cotopaxi.com/', 0.55, false, 'migration:00472'),

  -- Kühl — US alpha tops + WAIST-inch pants. Men + Women.
  ('kuhl', 'Kühl', ARRAY['kühl','kuhl']::text[], 'Men',
   'Apparel (US alpha tops; pants by WAIST inch)',
   ARRAY['jacket','fleece','pant','pants','softshell','trouser','top','shirt','hoodie','renegade','law','rydr']::text[],
   $j$[{"size":"S (pant waist ~30-31)","measurements":{"chest":"35-37","waist":"30-31"}},{"size":"M (pant waist ~32-33)","measurements":{"chest":"38-40","waist":"32-33"}},{"size":"L (pant waist ~34-36)","measurements":{"chest":"41-43","waist":"34-36"}},{"size":"XL (pant waist ~38-40)","measurements":{"chest":"44-46","waist":"38-40"}},{"size":"XXL (pant waist ~42-44)","measurements":{"chest":"47-49","waist":"42-44"}}]$j$::jsonb,
   'Kühl men''s tops size US alpha; ⚠ PANTS (Renegade / Law / Rydr) ARE SOLD BY WAIST x INSEAM INCH — read the waist number off the tag, the alpha here is an approximate cross-map. The FIT is articulated and the FABRIC (abrasion, knee wear, a broken gusset) is the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.kuhl.com/', 0.55, false, 'migration:00472'),
  ('kuhl', 'Kühl', ARRAY['kühl','kuhl']::text[], 'Women',
   'Apparel (US alpha, body inches)',
   ARRAY['jacket','fleece','pant','pants','softshell','top','shirt','hoodie','legging']::text[],
   $j$[{"size":"XS","measurements":{"bust":"32-33","waist":"24-25","hip":"34-35"}},{"size":"S","measurements":{"bust":"34-35","waist":"26-27","hip":"36-37"}},{"size":"M","measurements":{"bust":"36-37.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L","measurements":{"bust":"38.5-40","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL","measurements":{"bust":"41-43","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'Kühl women''s apparel sizes US alpha (XS-XL); pants may also carry a numeric waist. The articulated FIT + the FABRIC are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.kuhl.com/', 0.55, false, 'migration:00472'),

  -- Helly Hansen — EUROPEAN numeric apparel. Men + Women.
  ('hellyhansen', 'Helly Hansen', ARRAY['helly hansen','hellyhansen']::text[], 'Men',
   'Apparel (EU numeric ↔ US alpha, body inches)',
   ARRAY['jacket','shell','ski','base layer','fleece','top','shirt','pant','alpha','odin','verglas','crew','lifa']::text[],
   $j$[{"size":"S = EU 46-48","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M = EU 50","measurements":{"chest":"38-40","waist":"32-34"}},{"size":"L = EU 52","measurements":{"chest":"41-43","waist":"35-37"}},{"size":"XL = EU 54","measurements":{"chest":"44-46","waist":"38-40"}},{"size":"XXL = EU 56","measurements":{"chest":"47-49","waist":"41-43"}}]$j$::jsonb,
   'HELLY HANSEN IS A EUROPEAN (Norwegian) BRAND — stock is often EU-numbered (a EU 50 ≈ US M), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label and state the EU number. On a shell the MEMBRANE (delamination, wetting-out) and the seam tape are the grade — require a lining photo. Body-equivalent approximations, not brand-published specs.',
   'https://www.hellyhansen.com/', 0.55, false, 'migration:00472'),
  ('hellyhansen', 'Helly Hansen', ARRAY['helly hansen','hellyhansen']::text[], 'Women',
   'Apparel (EU numeric ↔ US alpha, body inches)',
   ARRAY['jacket','shell','ski','base layer','fleece','top','shirt','pant','alpha','crew','lifa']::text[],
   $j$[{"size":"XS = EU 34","measurements":{"bust":"32-33","waist":"24-25","hip":"34-35"}},{"size":"S = EU 36","measurements":{"bust":"34-35","waist":"26-27","hip":"36-37"}},{"size":"M = EU 38","measurements":{"bust":"36-37.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L = EU 40","measurements":{"bust":"38.5-40","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL = EU 42","measurements":{"bust":"41-43","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'HELLY HANSEN IS A EUROPEAN (Norwegian) BRAND — women''s stock is often EU-numbered (a EU 38 ≈ US M/S), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label. On a shell the membrane + seam tape are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.hellyhansen.com/', 0.55, false, 'migration:00472'),

  -- Mammut — EUROPEAN numeric apparel. Men + Women.
  ('mammut', 'Mammut', ARRAY['mammut']::text[], 'Men',
   'Apparel (EU numeric ↔ US alpha, body inches)',
   ARRAY['jacket','shell','softshell','fleece','top','shirt','pant','eiger extreme','ultimate']::text[],
   $j$[{"size":"S = EU 46-48","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M = EU 50","measurements":{"chest":"38-40","waist":"32-34"}},{"size":"L = EU 52","measurements":{"chest":"41-43","waist":"35-37"}},{"size":"XL = EU 54","measurements":{"chest":"44-46","waist":"38-40"}},{"size":"XXL = EU 56","measurements":{"chest":"47-49","waist":"41-43"}}]$j$::jsonb,
   'MAMMUT IS A EUROPEAN (Swiss) BRAND — stock is often EU-numbered (a EU 50 ≈ US M), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label and state the EU number. The EIGER EXTREME line comps ABOVE the mainline — read the exact collection. On a shell the membrane + seam tape are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.mammut.com/', 0.55, false, 'migration:00472'),
  ('mammut', 'Mammut', ARRAY['mammut']::text[], 'Women',
   'Apparel (EU numeric ↔ US alpha, body inches)',
   ARRAY['jacket','shell','softshell','fleece','top','shirt','pant','eiger extreme','ultimate']::text[],
   $j$[{"size":"XS = EU 34","measurements":{"bust":"32-33","waist":"24-25","hip":"34-35"}},{"size":"S = EU 36","measurements":{"bust":"34-35","waist":"26-27","hip":"36-37"}},{"size":"M = EU 38","measurements":{"bust":"36-37.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L = EU 40","measurements":{"bust":"38.5-40","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL = EU 42","measurements":{"bust":"41-43","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'MAMMUT IS A EUROPEAN (Swiss) BRAND — women''s stock is often EU-numbered (a EU 38 ≈ US M/S), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label. On a shell the membrane + seam tape are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.mammut.com/', 0.55, false, 'migration:00472'),

  -- Rab — EUROPEAN/UK apparel. Men + Women.
  ('rab', 'Rab', ARRAY['rab']::text[], 'Men',
   'Apparel (UK/EU ↔ US alpha, body inches)',
   ARRAY['jacket','down','softshell','shell','fleece','top','pant','microlight','neutrino','kinetic','xenon']::text[],
   $j$[{"size":"S = EU 46-48","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M = EU 50","measurements":{"chest":"38-40","waist":"32-34"}},{"size":"L = EU 52","measurements":{"chest":"41-43","waist":"35-37"}},{"size":"XL = EU 54","measurements":{"chest":"44-46","waist":"38-40"}},{"size":"XXL = EU 56","measurements":{"chest":"47-49","waist":"41-43"}}]$j$::jsonb,
   'RAB IS A BRITISH BRAND — sizing is UK/EU referenced (a EU 50 ≈ US M), so the SYSTEM (UK/EU vs US alpha) is the signal; read the label. On a DOWN jacket (Microlight / Neutrino) the FILL LOFT and any leaking baffle are the grade — stitch-through (Microlight) vs box-wall (Neutrino) comp differently. Body-equivalent approximations, not brand-published specs.',
   'https://www.rab.equipment/', 0.55, false, 'migration:00472'),
  ('rab', 'Rab', ARRAY['rab']::text[], 'Women',
   'Apparel (UK/EU ↔ US alpha, body inches)',
   ARRAY['jacket','down','softshell','shell','fleece','top','pant','microlight','neutrino','kinetic','xenon']::text[],
   $j$[{"size":"XS = EU 34 (UK 8)","measurements":{"bust":"32-33","waist":"24-25","hip":"34-35"}},{"size":"S = EU 36 (UK 10)","measurements":{"bust":"34-35","waist":"26-27","hip":"36-37"}},{"size":"M = EU 38 (UK 12)","measurements":{"bust":"36-37.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L = EU 40 (UK 14)","measurements":{"bust":"38.5-40","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL = EU 42 (UK 16)","measurements":{"bust":"41-43","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'RAB IS A BRITISH BRAND — women''s sizing is UK/EU referenced (a UK 12 ≈ US M), so the SYSTEM (UK/EU vs US alpha) is the signal; read the label. On a down jacket the FILL LOFT + baffles are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.rab.equipment/', 0.55, false, 'migration:00472'),

  -- Outdoor Research — US alpha apparel. Men + Women.
  ('outdoorresearch', 'Outdoor Research', ARRAY['outdoor research','outdoorresearch']::text[], 'Men',
   'Apparel (US alpha, body inches)',
   ARRAY['jacket','shell','softshell','fleece','top','shirt','pant','foray','ferrosi','helium','gaiter','glove']::text[],
   $j$[{"size":"S","measurements":{"chest":"35-37","waist":"29-31"}},{"size":"M","measurements":{"chest":"38-40","waist":"32-34"}},{"size":"L","measurements":{"chest":"41-43","waist":"35-37"}},{"size":"XL","measurements":{"chest":"44-46","waist":"38-40"}},{"size":"XXL","measurements":{"chest":"47-49","waist":"41-43"}}]$j$::jsonb,
   'Outdoor Research men''s apparel sizes US alpha (S-XXL); the SYSTEM is US alpha. On a GORE-TEX shell (Foray) the membrane, the TorsoFlo zips and the seam tape are the grade — require a lining photo. OR is unusually strong in accessories (gaiters, gloves) — grade those on the accessory market. Body-equivalent approximations, not brand-published specs.',
   'https://www.outdoorresearch.com/', 0.55, false, 'migration:00472'),
  ('outdoorresearch', 'Outdoor Research', ARRAY['outdoor research','outdoorresearch']::text[], 'Women',
   'Apparel (US alpha, body inches)',
   ARRAY['jacket','shell','softshell','fleece','top','shirt','pant','aspire','ferrosi','helium','gaiter','glove']::text[],
   $j$[{"size":"XS","measurements":{"bust":"32-33","waist":"24-25","hip":"34-35"}},{"size":"S","measurements":{"bust":"34-35","waist":"26-27","hip":"36-37"}},{"size":"M","measurements":{"bust":"36-37.5","waist":"28-29.5","hip":"38-39.5"}},{"size":"L","measurements":{"bust":"38.5-40","waist":"30.5-32","hip":"40.5-42"}},{"size":"XL","measurements":{"bust":"41-43","waist":"33-35","hip":"43-45"}}]$j$::jsonb,
   'Outdoor Research women''s apparel sizes US alpha (XS-XL); the SYSTEM is US alpha. On a GORE-TEX shell (Aspire) the membrane + TorsoFlo zips + seam tape are the grade. Body-equivalent approximations, not brand-published specs.',
   'https://www.outdoorresearch.com/', 0.55, false, 'migration:00472')
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
insert into public.applied_migrations (version) values ('00472') on conflict do nothing;
