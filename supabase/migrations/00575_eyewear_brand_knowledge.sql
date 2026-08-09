-- US-2221 AC3: Eyewear brand knowledge (4 brands) — Ray-Ban, Oakley, Persol,
-- Warby Parker. All four were absent from the KB entirely, like the headwear
-- group in 00574.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THIS IS THE AC THE STORY WAS REALLY ABOUT. AC3 asks for eyewear temple codes
-- to be "evaluated against the decoder bar on their merits and seeded as
-- decoders only where all three tests pass — with the outcome, either way,
-- recorded in the vault". THREE PASS AND SEVERAL FAIL, and the failures are the
-- more useful half.
--
-- The bar (00460): tag-printed AND regular AND brand-unique IN FORMAT.
-- Plus the fourth question (00457/US-1986): WHICH ENTITY does it name?
--
-- ── WHAT PASSES ─────────────────────────────────────────────────────────────
--
--   RAY-BAN `RB3025` · OAKLEY `OO9102` · PERSOL `PO0714S`
--
--   TAG-PRINTED, and BETTER THAN TAG-PRINTED. There is no tag: the code is
--   printed on the INSIDE OF THE TEMPLE ARM, on the frame itself. Ray-Ban's own
--   site states the model code "is composed by the first 2 letters + 4 digits and
--   is imprinted inside the left temple". A sewn tag can be cut and a hangtag
--   comes off; a temple imprint leaves when the arm does. This is the strongest
--   physical persistence of any code in the KB — stronger than 00468's Fossil
--   case-back, because a watch can be re-cased and a temple cannot be re-armed
--   without the mark going with it.
--
--   REGULAR. Two letters and four digits, every time, across the whole catalogue.
--
--   BRAND-UNIQUE IN FORMAT — and this is the test that needed real work, because
--   ALL THREE HOUSES SHARE ONE PARENT. Ray-Ban, Oakley and Persol are Luxottica
--   brands, which is the URBN `OB######` shape (US-1986) that produced a refusal.
--   IT COMES OUT THE OTHER WAY HERE, and the difference is exactly the fourth
--   question: URBN's code is PARENT-WIDE, so a hit could not attribute a sibling.
--   `RB` / `OO` / `PO` are PER-BRAND prefixes. RB names Ray-Ban, not Luxottica,
--   and no Luxottica sibling emits an RB code. The parent is shared; the
--   identifier is not.
--
-- ── WHY EVERY PATTERN IS PREFIX-ANCHORED, AND IT IS A SAFETY MECHANISM ───────
-- This is the Fossil rule from 00468 in a bigger blast radius. decodeTagCode runs
-- specs INSIDE AN ALREADY-RESOLVED PACK, so a permissive `[A-Z]{2}\d{4}` under
-- the Ray-Ban pack would decode a licensed Luxottica frame — Prada `PR`, Versace
-- `VE`, Burberry `BE`, Michael Kors `MK` — and then spell the brand "Ray-Ban"
-- from pack.brand. Luxottica's licensed portfolio is enormous and several of
-- those houses are ALREADY canonical brands in this KB, so it would not merely
-- guess wrong, it would overwrite a correct answer with DECODER AUTHORITY.
-- `^RB\d{4}$` / `^OO\d{4}$` / `^PO\d{4}[A-Z]{0,2}$` make that impossible by
-- construction.
--
-- ── WHAT IS REFUSED, AND WHY EACH ONE IS INTERESTING ────────────────────────
--
--   * THE `RX` / `OX` OPTICAL PREFIXES — REFUSED, and this is the sharpest call
--     in the pack. Ray-Ban's optical line is `RX5154` and Oakley's is `OX####`,
--     the same shape as the sunglass codes and just as tag-printed. They are
--     refused because **`RX` IS THE UNIVERSAL ABBREVIATION FOR A PRESCRIPTION.**
--     It is not a Ray-Ban mark, it is the whole optical industry's word, so a
--     pattern over it fails brand-unique-in-format on its face and would mint
--     Ray-Ban off any prescription frame's catalogue string. The sunglass
--     prefixes carry the brand; the optical prefixes carry the CATEGORY. Losing
--     the optical line is a real cost and it is the correct one — declining beats
--     false-firing (the never-guess rule).
--   * THE SIZE TRIPLET `58□14 135` — REFUSED AS A BRAND SIGNAL, and it is the
--     pack's cleanest example of a code that is perfectly regular and identifies
--     NOBODY. Lens width, bridge width, temple length in millimetres is an
--     INDUSTRY STANDARD printed by every eyewear maker on earth. It is genuinely
--     useful — it is the frame's size, and it belongs in a listing — but it is
--     evidence about the FRAME, never about the BRAND. Compare 00574: a hat size
--     is brand-specific and cannot be converted; an eyewear size is universal and
--     needs no conversion. Same category, opposite property.
--   * WARBY PARKER FRAME NAMES — REFUSED. The temple carries a NAME (Percey,
--     Durand, Haskell) plus the size triplet and a colour code, not a numeric
--     model code. A name is the Rag & Bone `Fit 2` refusal: "Durand" is a
--     surname, "Percey" is a near-homograph of a first name, and a pattern over
--     bare capitalised words would recover the brand from any tag carrying one.
--     The names are seeded as brand_styles instead, which is where a name belongs
--     — recoverable once the brand is known, never the thing that establishes it.
--   * THE LENS CODES `2N` / `3N` / `P` — REFUSED as a decoder and kept as a tell.
--     Two characters is far below anything that can be brand-unique.
--
-- ── NO SIZE CHARTS IN THIS PACK, DELIBERATELY ───────────────────────────────
-- 00574 seeded five charts because a hat's size is a BRAND'S label that has to be
-- looked up. A frame's size is PRINTED ON THE FRAME in millimetres, so there is
-- nothing to look up and a seeded chart would be an invention. The absence is the
-- correct answer, and it is asserted by a test so it does not read as an omission.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'rayban', 'Ray-Ban',
    ARRAY['rayban','raybans','raybansunglasses']::text[],
    ARRAY['eyewear','sunglasses','optical frames']::text[],
    $json$[
      {"era":"Luxottica ownership","years":"1999","description":"Ray-Ban was acquired by Luxottica from Bausch & Lomb in 1999. A B&L-marked frame predates that; a Luxottica-marked one does not, and neither marking is an authenticity verdict on its own.","source_url":"https://en.wikipedia.org/wiki/Ray-Ban","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"The model code is on the INSIDE LEFT TEMPLE","detail":"Two letters plus four digits, imprinted on the inner face of the left arm, alongside the colour code, the size triplet and a lens code. Ray-Ban states the format itself. Read it there — a listing photo of the front of the frame carries none of it."},
      {"tell":"The right temple carries the origin and certification marks","detail":"Ray-Ban logo, country of manufacture, a frame-type letter, CE, and 'Polarized' where it applies. A frame with a model code on one arm and nothing on the other is worth a closer look."},
      {"tell":"2N / 3N / P are LENS codes, not model codes","detail":"They describe the lens (P indicates polarized). Two characters cannot identify a brand and must never be captured as a style code."},
      {"tell":"RX is a category, not a brand","detail":"Ray-Ban's optical line is RX-prefixed, but RX is the universal abbreviation for a prescription. An RX number on a frame is not by itself evidence of Ray-Ban."}
    ]$json$::jsonb,
    'Eyewear. DECODER SEEDED: RB + 4 digits, imprinted inside the left temple — the strongest physically-persistent code in this KB, since it leaves only when the arm does. ⚠ The pattern is PREFIX-ANCHORED on purpose: Luxottica makes licensed frames for houses that are already canonical brands here, and a permissive two-letter pattern would spell "Ray-Ban" onto a Prada or a Versace with decoder authority.',
    'https://www.ray-ban.com/usa', 0.75, true, 'migration:00575'
  ),
  (
    'oakley', 'Oakley',
    ARRAY['oakley','oakleysunglasses']::text[],
    ARRAY['eyewear','sunglasses','sport','goggles']::text[],
    $json$[
      {"era":"Luxottica ownership","years":"2007","description":"Oakley was acquired by Luxottica in 2007. Pre-2007 frames predate that ownership; it is a provenance fact, not a quality or authenticity one.","source_url":"https://en.wikipedia.org/wiki/Oakley,_Inc.","confidence":0.7}
    ]$json$::jsonb,
    $json$[
      {"tell":"The model code is on the LEFT EARSTEM","detail":"OO plus four digits for sunglasses, often set further down the arm than people expect, with the size triplet beside it. OO9102 is the Holbrook."},
      {"tell":"A worn-off imprint is common and is not a fake signal","detail":"Temple printing abrades with wear, especially on sport frames. An unreadable code on an otherwise consistent frame is a condition fact — say the code is illegible rather than treating it as missing."},
      {"tell":"OX is the optical prefix and is not brand evidence","detail":"Oakley's prescription line is OX-prefixed. Like Ray-Ban's RX, that names the category, not the maker."}
    ]$json$::jsonb,
    'Sport and lifestyle eyewear. DECODER SEEDED: OO + 4 digits on the left earstem, prefix-anchored for the same Luxottica-licensing reason as Ray-Ban.',
    'https://www.oakley.com/', 0.70, true, 'migration:00575'
  ),
  (
    'persol', 'Persol',
    ARRAY['persol']::text[],
    ARRAY['eyewear','sunglasses','italian','luxury']::text[],
    $json$[
      {"era":"Luxottica ownership","years":"1995","description":"Persol has been part of Luxottica since 1995. Earlier frames carry different maker marks; that is provenance, not authenticity.","source_url":"https://en.wikipedia.org/wiki/Persol","confidence":0.65}
    ]$json$::jsonb,
    $json$[
      {"tell":"The arrow and the Meflecto system are the house marks","detail":"The silver arrow on the temple and the flexing Meflecto stem are Persol's signature construction. They are design, not damage — a Meflecto stem is SUPPOSED to flex, and describing that give as a loose arm is a grading error."},
      {"tell":"The code is PO + 4 digits, with letters for the line","detail":"Persol's own catalogue emits 0PO0714SM and 0PO3092SM; the leading zero is catalogue padding, and the trailing letters mark the line (S for sun, V for optical). The temple mark is the PO form."},
      {"tell":"The keyhole bridge dates and identifies a line","detail":"The 649 and the folding 714 share the wide-lens shape and the keyhole bridge. The 714 is the folding one — if the arms do not fold, it is not a 714."}
    ]$json$::jsonb,
    'Italian eyewear house. DECODER SEEDED: PO + 4 digits plus optional line letters. ⚠ The Meflecto stem flexes BY DESIGN — do not grade that as a loose or sprung temple.',
    'https://www.persol.com/en-us', 0.70, true, 'migration:00575'
  ),
  (
    'warbyparker', 'Warby Parker',
    ARRAY['warbyparker']::text[],
    ARRAY['eyewear','optical frames','direct to consumer']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"The temple carries a NAME, not a model number","detail":"Percey, Durand, Haskell — a frame name, the size triplet and a colour code. There is no numeric model code to decode, which is why this brand gets no decoder while the other three do."},
      {"tell":"Low Bridge Fit is a SEPARATE fit, not a size","detail":"Warby Parker publishes a Low Bridge Fit variant of many frames, with adjusted nose pads and frame angle. It is a different product from the standard fit of the same name and must not be described as the same frame in a smaller size."}
    ]$json$::jsonb,
    'Direct-to-consumer eyewear. NO DECODER — the temple carries a frame NAME, and a bare capitalised word is the Rag & Bone "Fit 2" refusal: it would recover the brand from any tag carrying a surname. The names are seeded as styles instead, where a name belongs.',
    'https://www.warbyparker.com/', 0.65, true, 'migration:00575'
  )
on conflict (brand_key) do nothing;

-- ── brand_style_codes — THREE DECODERS, EVERY PATTERN PREFIX-ANCHORED ───────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples,
   source_url, confidence, verified, updated_by)
values
  ('rayban', 'style_number',
   'Ray-Ban model code, imprinted on the INSIDE OF THE LEFT TEMPLE — Ray-Ban''s own site states it "is composed by the first 2 letters + 4 digits and is imprinted inside the left temple of a standard frame". RB3025 = Aviator Classic, RB2140 = Original Wayfarer Classic, RB3016 = Clubmaster Classic, all confirmed on ray-ban.com product pages. THE PHYSICAL PERSISTENCE IS THE POINT: there is no tag to cut and no hangtag to lose, so the mark survives everything short of losing the arm — stronger than 00468''s Fossil case-back. ⚠ ANCHORED TO RB ON PURPOSE, AND IT IS A SAFETY MECHANISM: Ray-Ban, Oakley and Persol share ONE PARENT (Luxottica), which also makes licensed frames for houses ALREADY CANONICAL IN THIS KB. decodeTagCode runs specs inside an already-resolved pack, so a permissive [A-Z]{2}\d{4} here would decode a Prada PR or a Versace VE and then spell the brand "Ray-Ban" from pack.brand — overwriting a correct answer with DECODER AUTHORITY. The shared parent is exactly the URBN OB###### shape from US-1986; it comes out the other way only because RB names RAY-BAN and not Luxottica. ⚠ THE RX OPTICAL PREFIX IS DELIBERATELY EXCLUDED: Ray-Ban''s prescription line is RX-prefixed and just as tag-printed, but RX is the UNIVERSAL abbreviation for a prescription, so a pattern over it fails brand-unique-in-format outright and would mint Ray-Ban off any optical frame. Losing the optical line is the correct cost. ⚠ NOT DECODED: the colour code (001/58 and friends) and the lens codes 2N/3N/P. Two characters cannot be brand-unique, and the colour code is only meaningful against a catalogue we do not hold.',
   '^(?<style>RB\d{4})$',
   $j${"fieldMap": {"style": "styleCode"}, "transforms": {"style": "upper"}, "confidence": 0.7}$j$::jsonb,
   $j$[{"code":"RB3025","expected":{"styleCode":"RB3025"}},{"code":"RB2140","expected":{"styleCode":"RB2140"}},{"code":"RB3016","expected":{"styleCode":"RB3016"}},{"code":"rb3025","expected":{"styleCode":"RB3025"}}]$j$::jsonb,
   'https://www.ray-ban.com/usa', 0.70, false, 'migration:00575'),
  ('oakley', 'style_number',
   'Oakley model code, printed on the LEFT EARSTEM: OO plus four digits for sunglasses, with the size triplet beside it. OO9102 is the Holbrook. ⚠ ANCHORED TO OO for the same Luxottica-licensing reason as Ray-Ban — see that row. ⚠ THE OX OPTICAL PREFIX IS EXCLUDED on the same ground as Ray-Ban''s RX: it names the prescription category, not the maker. ⚠ EXPECT ILLEGIBLE CODES: temple printing abrades on sport frames, so absence here is ordinary wear and must not be read as a counterfeit signal.',
   '^(?<style>OO\d{4})$',
   $j${"fieldMap": {"style": "styleCode"}, "transforms": {"style": "upper"}, "confidence": 0.7}$j$::jsonb,
   $j$[{"code":"OO9102","expected":{"styleCode":"OO9102"}},{"code":"oo9102","expected":{"styleCode":"OO9102"}}]$j$::jsonb,
   'https://www.oakley.com/', 0.65, false, 'migration:00575'),
  ('persol', 'style_number',
   'Persol model code: PO plus four digits, with optional trailing letters marking the line (S for sun, V for optical, M for the metal/Steve McQueen variants). Persol''s own catalogue emits 0PO0714SM and 0PO3092SM — the LEADING ZERO IS CATALOGUE PADDING and is not on the temple, which is why the pattern does not accept it. PO0714S is the folding Steve McQueen, PO3092S a modern sun line. ⚠ ANCHORED TO PO for the same Luxottica-licensing reason as Ray-Ban.',
   '^(?<style>PO\d{4}[A-Z]{0,2})$',
   $j${"fieldMap": {"style": "styleCode"}, "transforms": {"style": "upper"}, "confidence": 0.7}$j$::jsonb,
   $j$[{"code":"PO0714S","expected":{"styleCode":"PO0714S"}},{"code":"PO3092SM","expected":{"styleCode":"PO3092SM"}},{"code":"po0714s","expected":{"styleCode":"PO0714S"}}]$j$::jsonb,
   'https://www.persol.com/en-us', 0.65, false, 'migration:00575')
on conflict (brand_key, decoder_kind) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('rayban', 'Aviator Classic', ARRAY['rb3025','aviator','aviator large']::text[], 'Sunglasses', 'Unisex', 'sunglasses',
   'Teardrop lenses, double bridge, thin metal frame. Model code RB3025; the classic runs 58-14 and a 55-14 small exists.',
   null, ARRAY['aviator','rb3025','teardrop']::text[],
   'https://www.ray-ban.com/usa', 0.75, true, 'migration:00575'),
  ('rayban', 'Original Wayfarer Classic', ARRAY['rb2140','wayfarer']::text[], 'Sunglasses', 'Unisex', 'sunglasses',
   'Trapezoidal acetate frame with a pronounced brow and canted arms. Model code RB2140; the classic runs 50-22.',
   null, ARRAY['wayfarer','rb2140','acetate']::text[],
   'https://www.ray-ban.com/usa', 0.75, true, 'migration:00575'),
  ('rayban', 'Clubmaster Classic', ARRAY['rb3016','clubmaster']::text[], 'Sunglasses', 'Unisex', 'sunglasses',
   'Browline: acetate top rim and arms over a metal lower rim. Model code RB3016; the classic runs 51-21.',
   null, ARRAY['clubmaster','browline','rb3016']::text[],
   'https://www.ray-ban.com/usa', 0.75, true, 'migration:00575'),
  ('oakley', 'Holbrook', ARRAY['oo9102','holbrook']::text[], 'Sunglasses', 'Unisex', 'sunglasses',
   'Square lifestyle frame with a keyhole-ish bridge and metal rivet accents. Model code OO9102.',
   null, ARRAY['holbrook','oo9102']::text[],
   'https://www.oakley.com/', 0.70, true, 'migration:00575'),
  ('persol', '714', ARRAY['po0714s','714sm','steve mcqueen']::text[], 'Sunglasses', 'Unisex', 'sunglasses',
   'THE FOLDING ONE. Introduced in the 1960s as a folding version of the 649, and the first folding sunglass model; wide pilot shape, keyhole bridge, arrow, Meflecto stems. If the arms do not fold it is not a 714. Persol says it takes ten extra manufacturing steps over a standard model.',
   '1960s-present', ARRAY['714','folding','steve mcqueen','meflecto']::text[],
   'https://www.persol.com/en-us/blogs/editorials/steve-mcqueen', 0.70, true, 'migration:00575'),
  ('persol', '649', ARRAY['po0649','649']::text[], 'Sunglasses', 'Unisex', 'sunglasses',
   'The wide-lens pilot shape the folding 714 was derived from. Keyhole bridge, arrow, Meflecto stems, non-folding.',
   null, ARRAY['649','keyhole bridge']::text[],
   'https://www.persol.com/en-us/blogs/editorials/steve-mcqueen', 0.60, true, 'migration:00575'),
  ('warbyparker', 'Percey', ARRAY['percey']::text[], 'Eyeglasses', 'Unisex', 'eyeglasses',
   'Round lenses with a keyhole bridge — Warby Parker describes it as a bookish modern classic. Sold in a standard and a Low Bridge Fit version, which are DIFFERENT products, not two sizes.',
   null, ARRAY['percey','round','keyhole bridge']::text[],
   'https://www.warbyparker.com/eyeglasses/percey/crystal', 0.70, true, 'migration:00575'),
  ('warbyparker', 'Durand', ARRAY['durand']::text[], 'Eyeglasses', 'Unisex', 'eyeglasses',
   'Between square and round — Warby Parker''s own description. Also sold in a Low Bridge Fit version.',
   null, ARRAY['durand','square','round']::text[],
   'https://www.warbyparker.com/eyeglasses/durand/crystal', 0.70, true, 'migration:00575'),
  ('warbyparker', 'Haskell', ARRAY['haskell']::text[], 'Eyeglasses', 'Unisex', 'eyeglasses',
   'A named acetate frame in the core eyeglasses line.',
   null, ARRAY['haskell']::text[],
   'https://www.warbyparker.com/eyeglasses/haskell/whiskey-tortoise', 0.60, true, 'migration:00575')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_size_charts ROWS, DELIBERATELY. 00574 seeded five because a hat's
-- size is a BRAND'S label that must be looked up. A frame's size is printed on
-- the frame itself in millimetres (lens-bridge-temple), an industry standard, so
-- there is nothing to look up and a chart would be invented. Asserted by a test
-- so the absence does not read as an omission.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00575') on conflict do nothing;
