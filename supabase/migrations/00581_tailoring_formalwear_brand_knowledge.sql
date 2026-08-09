-- US-2220 AC3: tailoring and formalwear — Suitsupply, Hugo Boss, Canali,
-- Jos. A. Bank. The story records that the KB had "nothing beyond Brooks
-- Brothers/Peter Millar as general labels" for suits, sport coats, tuxedos and
-- neckwear.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AC3 IS THE POINT OF THIS PACK: "tailoring's sizing is modelled honestly —
-- chest+length letter suffixes (40R/40L/40S) and DROP are the sizing system, not
-- an alpha size; this cannot reuse the tops chart shape unchanged."
--
-- It cannot, and here is why in one line:
--
--   **A SUIT SIZE IS TWO GARMENTS AND A SUBTRACTION.**
--
-- `40R` is a 40-inch jacket chest in Regular length. It does NOT tell you the
-- trouser waist. That comes from the DROP — jacket chest minus trouser waist —
-- and the drop is a property of the MAKER'S CUT, not of the label:
--
--     6-drop (the US off-the-rack default)   40 chest -> 34 waist
--     4-drop (fuller build)                  40 chest -> 36 waist
--     8-drop (athletic build)                40 chest -> 32 waist
--
-- So the same printed "40R" is a 32, a 34 or a 36 waist depending on who made
-- it. A listing that gives the label and not the drop has not given the trouser
-- size at all. THREE charts are seeded because there are three real systems
-- here — the chest run, the length letters, and dress-shirt neck×sleeve — and
-- collapsing any of them into an alpha size destroys the information.
--
-- The LENGTH LETTER is a third axis and it moves length and sleeve, never chest:
-- S is short, R regular, L long, mapped by makers to height bands (roughly under
-- 5'8", 5'8"-6'1", 6'1"-6'4"), with L adding about 1.5 inches of jacket length
-- and sleeve over R.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ THE FACT THAT MATTERS MOST IN RESALE, AND IT IS NOT A SIZE:
--
--   **A JACKET WITHOUT ITS TROUSERS IS A SPORT COAT, AND IT IS WORTH A
--     FRACTION.**
--
-- A suit is two garments sold as one. Split them and the jacket loses most of
-- its value, because the buyer for a lone suit jacket is not the buyer for a
-- suit. "Is it complete" is therefore a PRICING question, not a completeness
-- footnote — the same shape as a matched scrub set (00580), with far more money
-- on it.
--
-- ⚠ AND THE LABEL IS OFTEN A LIE, PERMANENTLY AND INVISIBLY. Tailored clothing
-- is altered: waist suppressed, sleeves shortened, trousers hemmed and taken in.
-- The tag still says 40R. So in this category, MORE THAN ANY OTHER THIS KB
-- COVERS, the garment must be measured rather than read — and the inverse fact is
-- worth money too: unused INLAY (let-out room in the seams and the trouser
-- waistband) is what lets the next owner have it fitted, so a suit that has
-- never been altered is worth more than one that has.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AC2 — BRAND SELECTION JUSTIFIED BY RESALE VOLUME, in the header as required:
--
--   * SUITSUPPLY — the highest-volume modern brand in the accessible-quality
--     tier, and the one buyers search BY FIT NAME (Milano, Havana, Roma), which
--     makes its model names genuinely worth seeding.
--   * HUGO BOSS — the highest unit volume in suit resale, from decades of
--     department-store distribution.
--   * CANALI — the Italian tier that holds real resale value and is the one most
--     often UNDER-listed by sellers who do not recognise it.
--   * JOS. A. BANK — enormous US unit volume from years of buy-one-get-three
--     promotions, and seeded WITH the honest consequence: that same promotional
--     history is why supply overwhelms demand and the resale value is low.
--     Volume and value are different axes, and a KB that implies otherwise
--     misprices half this category.
--
-- NO DECODERS. None of these puts a regular, brand-unique style code on the
-- garment; what the label carries is the SIZE, which is the one string in this
-- category that is guaranteed not to identify a maker.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'suitsupply', 'Suitsupply',
    ARRAY['suitsupply']::text[],
    ARRAY['tailoring','suits','formalwear','menswear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"The FIT NAME is the model, and it is on the label","detail":"Milano and Havana are the slim cuts — Milano with a structured shoulder, Havana with a natural one — and Roma is roomier through chest and waist with a natural shoulder. Buyers search these names, so the fit belongs in the title. The shoulder construction is also visible in a photo, which makes it checkable rather than merely claimed."},
      {"tell":"Separates are the exception, not the rule","detail":"Suitsupply states that only certain suits can be bought with the jacket and trousers in different sizes. So for most of the range the trouser waist is DETERMINED by the jacket size and the house drop — which is exactly why a listing must give the measured waist, not just the label."},
      {"tell":"⚠ Measure it; the tag may predate the alterations","detail":"Tailored clothing is altered and the label never changes. Give the measured chest, waist, sleeve and inseam. Unused inlay is worth stating too: a suit with let-out room can be fitted by the next owner."}
    ]$json$::jsonb,
    'Dutch tailoring house, accessible-quality tier, the highest-volume modern brand in menswear resale and the one buyers search BY FIT NAME. NO DECODER — the label carries the SIZE, which identifies no maker. ⚠ Read the sizing charts here as a system: chest label, length letter and drop are three axes, not one alpha size.',
    'https://suitsupply.com/en-us/journal/jacket-fit-guide.html', 0.65, true, 'migration:00581'
  ),
  (
    'hugoboss', 'Hugo Boss',
    ARRAY['hugoboss','boss','bosshugoboss']::text[],
    ARRAY['tailoring','suits','formalwear','menswear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"The highest unit volume in the category","detail":"Decades of department-store distribution mean supply is deep, so condition and completeness do more work on price here than the name does."},
      {"tell":"⚠ 'BOSS' alone is ambiguous and is not folded","detail":"The house has run several diffusion labels over the years, and a bare BOSS on a label does not by itself place a garment in a tier. Read the full label text rather than the four letters."},
      {"tell":"Measure rather than read the tag","detail":"Same as the rest of the category: alterations do not change the label."}
    ]$json$::jsonb,
    'German house, the highest unit volume in suit resale. NO DECODER. ⚠ A bare "boss" resolves here as an exact whole-field key only — see brand-normalize for why it is kept out of free-text detection.',
    'https://www.hugoboss.com/', 0.55, false, 'migration:00581'
  ),
  (
    'canali', 'Canali',
    ARRAY['canali']::text[],
    ARRAY['tailoring','suits','italian','luxury menswear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ THE MOST UNDER-LISTED NAME IN THE CATEGORY","detail":"Canali sits in the Italian tier that holds real resale value, and sellers who do not recognise it list it as a generic suit. If the label reads Canali, the item is not a mall suit and should not be priced as one."},
      {"tell":"Italian sizing is on the label as a number in the 40s and 50s","detail":"A European 50 is roughly a US 40 chest. A two-digit number well above the US run is a sizing SYSTEM difference, not a huge jacket — the same trap size-system conversion exists to prevent."},
      {"tell":"Measure rather than read the tag","detail":"Alterations do not change the label, and a garment at this tier has usually been altered."}
    ]$json$::jsonb,
    'Italian tailoring house. Seeded because it is the name most often UNDER-listed by sellers who do not recognise the tier. NO DECODER. ⚠ Its labels carry EU sizing — see size-system-conversions for why that is converted only where the corpus has paired data.',
    'https://www.canali.com/', 0.55, false, 'migration:00581'
  ),
  (
    'josabank', 'Jos. A. Bank',
    ARRAY['josabank','josephabank','josabanks']::text[],
    ARRAY['tailoring','suits','formalwear','menswear']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"⚠ HIGH VOLUME IS NOT HIGH VALUE, AND HERE THEY ARE INVERSELY RELATED","detail":"Years of buy-one-get-three promotions put an enormous number of these suits into circulation, and that same history is why supply overwhelms resale demand. Seeded so the KB does not let unit volume read as desirability — the two are different axes."},
      {"tell":"Completeness carries the price here","detail":"With the name doing little work, whether the suit is complete, unaltered and clean is most of what a buyer is paying for."}
    ]$json$::jsonb,
    'US menswear retailer with very high unit volume in resale and correspondingly low value — a promotional history put far more of these suits into circulation than the market absorbs. Seeded WITH that consequence, because volume and value are different axes.',
    'https://www.josbank.com/', 0.5, false, 'migration:00581'
  )
on conflict (brand_key) do nothing;

-- ── brand_size_charts — THREE SYSTEMS, seeded as three charts (AC3) ─────────
-- ⚠ These are seeded under the GENERIC key `tailoringmenswear` rather than under
-- a brand, deliberately and against the usual rule in brand-kb-sizing-units.md.
-- The reason is that the chest run and the drop arithmetic are an INDUSTRY
-- convention rather than any house's label — unlike hat sizes, where two makers
-- print different inches for the same printed size. Where a house departs from
-- the convention, that belongs in a brand-specific chart that overrides this one.
-- The precedent is 00389's own `genericwomensalpha` / `genericmensalpha` /
-- `genericmenspants` keys: a chart-only key with no brand_knowledge row is an
-- established shape here, used exactly when the chart describes a CONVENTION
-- rather than a house.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match,
   rows, note, source_url, confidence, verified, updated_by)
values
  (
    'tailoringmenswear', 'Menswear tailoring (US convention)', ARRAY[]::text[], 'Men',
    'Suits & sport coats (jacket chest, with 6-drop trouser waist)',
    ARRAY['suit','sport coat','blazer','jacket','tuxedo','tailoring']::text[],
    $json$[
      {"size":"36R","measurements":{"chest":"36","trouser_waist_at_6_drop":"30"}},
      {"size":"38R","measurements":{"chest":"38","trouser_waist_at_6_drop":"32"}},
      {"size":"40R","measurements":{"chest":"40","trouser_waist_at_6_drop":"34"}},
      {"size":"42R","measurements":{"chest":"42","trouser_waist_at_6_drop":"36"}},
      {"size":"44R","measurements":{"chest":"44","trouser_waist_at_6_drop":"38"}},
      {"size":"46R","measurements":{"chest":"46","trouser_waist_at_6_drop":"40"}},
      {"size":"48R","measurements":{"chest":"48","trouser_waist_at_6_drop":"42"}}
    ]$json$::jsonb,
    'The number is the jacket CHEST in inches. ⚠ THE TROUSER WAIST SHOWN IS THE 6-DROP DEFAULT AND IS NOT PART OF THE LABEL: drop is jacket chest minus trouser waist and is a property of the maker''s cut. 6-drop is the US off-the-rack default; 4-drop suits a fuller build and 8-drop an athletic one, so the same printed 40R is a 36, 34 or 32 waist depending on who made it. A listing that gives the label without the measured waist has not given the trouser size. The waists here are the arithmetic (chest minus 6), not a claim about any house.',
    'https://www.tailorsizeguide.com/blog/mens-suit-size-chart', 0.6, false, 'migration:00581'
  ),
  (
    'tailoringmenswear', 'Menswear tailoring (US convention)', ARRAY[]::text[], 'Men',
    'Jacket length letters (S / R / L)',
    ARRAY['suit','sport coat','blazer','jacket','tuxedo']::text[],
    $json$[
      {"size":"S (short)","measurements":{"jacket_length_vs_regular":"-1.5"}},
      {"size":"R (regular)","measurements":{"jacket_length_vs_regular":"0"}},
      {"size":"L (long)","measurements":{"jacket_length_vs_regular":"1.5"}}
    ]$json$::jsonb,
    'The letter is the THIRD axis and it moves jacket length and sleeve, never chest — a 40S, 40R and 40L all fit a 40-inch chest. Makers map the letters to height bands, roughly: S under 5''8", R 5''8"-6''1", L 6''1"-6''4". L adds about 1.5 inches of length and sleeve over R. The deltas here are approximate and vary by house; measure the garment rather than converting.',
    'https://www.tailorsizeguide.com/blog/mens-suit-size-chart', 0.55, false, 'migration:00581'
  ),
  (
    'tailoringmenswear', 'Menswear tailoring (US convention)', ARRAY[]::text[], 'Men',
    'Dress shirts (neck x sleeve)',
    ARRAY['dress shirt','shirt','formal shirt','tuxedo shirt']::text[],
    $json$[
      {"size":"15 / 32-33","measurements":{"neck":"15","sleeve":"32-33"}},
      {"size":"15.5 / 32-33","measurements":{"neck":"15.5","sleeve":"32-33"}},
      {"size":"16 / 34-35","measurements":{"neck":"16","sleeve":"34-35"}},
      {"size":"16.5 / 34-35","measurements":{"neck":"16.5","sleeve":"34-35"}},
      {"size":"17 / 36-37","measurements":{"neck":"17","sleeve":"36-37"}}
    ]$json$::jsonb,
    'A dress shirt is sized NECK x SLEEVE, in inches, and both numbers are on the label. This is a THIRD system again — not the alpha S/M/L a casual shirt uses, and not the chest run a jacket uses. Sleeve is commonly printed as a two-inch range because the same body is cut for two lengths. Converting either number into an alpha size loses the half-inch neck increments that are the whole point.',
    'https://www.tailorsizeguide.com/blog/mens-suit-size-chart', 0.55, false, 'migration:00581'
  )
on conflict (brand_key, department, garment) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('suitsupply', 'Milano', ARRAY['milano']::text[], 'Suits', 'Men', 'suit',
   'Slim through chest and waist with a STRUCTURED shoulder. The shoulder is the tell that separates it from Havana in a photograph.',
   null, ARRAY['milano','slim','structured shoulder']::text[],
   'https://suitsupply.com/en-us/journal/jacket-fit-guide.html', 0.65, true, 'migration:00581'),
  ('suitsupply', 'Havana', ARRAY['havana']::text[], 'Suits', 'Men', 'suit',
   'Slim through chest and waist with a NATURAL shoulder — the same silhouette as Milano with a softer shoulder line.',
   null, ARRAY['havana','slim','natural shoulder']::text[],
   'https://suitsupply.com/en-us/journal/jacket-fit-guide.html', 0.65, true, 'migration:00581'),
  ('suitsupply', 'Roma', ARRAY['roma']::text[], 'Suits', 'Men', 'suit',
   'Roomier through chest and waist with a natural shoulder, for a more relaxed silhouette.',
   null, ARRAY['roma','relaxed','natural shoulder']::text[],
   'https://suitsupply.com/en-us/journal/jacket-fit-guide.html', 0.65, true, 'migration:00581'),
  ('hugoboss', 'Suit', ARRAY['boss suit']::text[], 'Suits', 'Men', 'suit',
   'The house''s core tailored offering. Seeded as a single line because the fit names have changed repeatedly and none could be sourced to a first-party page.',
   null, ARRAY['suit','tailoring']::text[],
   'https://www.hugoboss.com/', 0.4, false, 'migration:00581'),
  ('canali', 'Suit', ARRAY['canali suit']::text[], 'Suits', 'Men', 'suit',
   'Italian-tier tailoring, typically labelled in EU sizing. Seeded as a single line for the same reason as Hugo Boss.',
   null, ARRAY['suit','italian','eu sizing']::text[],
   'https://www.canali.com/', 0.4, false, 'migration:00581'),
  ('josabank', 'Suit', ARRAY['jos a bank suit']::text[], 'Suits', 'Men', 'suit',
   'Core tailored offering. The fit names have changed across the promotional era and none could be sourced first-party.',
   null, ARRAY['suit','tailoring']::text[],
   'https://www.josbank.com/', 0.4, false, 'migration:00581')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes. None of these puts a regular, brand-unique style code on
-- the garment; the label carries the SIZE, which is the one string in this
-- category guaranteed not to identify a maker. Asserted in
-- services/edge-functions/src/tests/tailoring-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00581') on conflict do nothing;
