-- US-2220 AC4: vintage and band-tee coverage — Screen Stars, Brockum, Giant,
-- Winterland. The story calls this "the single most price-sensitive tag-era
-- category in resale, with no coverage at all", and it is the first pack in the
-- corpus built around tag_eras rather than around styles.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FOUR "BRANDS" HERE ARE NOT THE BRAND ON THE SHIRT.
--
-- A band tee's seller-facing brand is the BAND. These four are the BLANK
-- MAKERS — the tag sewn into the collar by the company that printed the tour
-- merch. That inversion is the whole pack:
--
--   THE BLANK DATES THE SHIRT. THE BAND AND THE PRINT PRICE IT.
--
-- So these rows exist to answer "when was this made", never "what is it worth".
-- A Giant tag does not make a shirt valuable; it makes a 1993 claim credible.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ THE GRADING INVERSION, AND IT IS THE MOST CONSEQUENTIAL FACT IN THIS PACK:
--
--   IN VINTAGE TEES THE WEAR IS THE PRODUCT.
--
-- Screen Stars blanks are mostly 50/50 cotton-poly. As they are worn and washed
-- the cotton fades while the polyester survives, leaving the paper-thin,
-- translucent, feather-soft shirt the category is bought FOR. Collectors pay a
-- premium for exactly the state a condition rubric is built to mark down:
-- thinness, fade, a softened hand, cracked screen print.
--
-- This is the Bosca patina call (00577) with far higher stakes, because here it
-- is not one line — it is most of the grade. A vintage tee graded on crispness
-- reads a 9 as a 4. The tells below say so explicitly, and they also name the
-- defects that ARE real in the category: holes, stains, a print that has flaked
-- away to illegibility, and a collar that has lost its recovery.
--
-- ⚠ AND THE CATEGORY IS NOT INFERRED FROM THE TAG. Nothing here should flip a
-- shirt into "vintage grading" automatically — a modern Giant-tagged blank
-- exists, and reprints are common. These are inputs to a human or a prompt, not
-- a switch.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO DECODER, AND THE REFUSAL IS SHARP:
--   **RN 13765 CANNOT ATTRIBUTE SCREEN STARS.**
-- It is a real federal Registered Identification Number and it is
-- genuinely printed on Screen Stars tags — but it belongs to the PARENT (Union
-- Underwear / Fruit of the Loom), and the same RN appears on FOTL's GENERIC
-- 1970s blanks, which defunkd documents as a separate tag entirely. So a pattern
-- over it would spell "Screen Stars" onto an unbranded Fruit of the Loom tee.
--
-- That is the URBN `OB######` refusal (US-1986) with a corroborating page: a
-- parent-wide identifier can never attribute a sibling. It is seeded as an
-- informational tell, never as a decoder — the 00460 bar, and the fourth
-- question about which entity an identifier names.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO SIZE CHARTS. A 1980s blank's "L" is not a modern L and the blanks differ
-- from each other; none of these makers publishes a chart, and the shirts have
-- shrunk unpredictably across forty years of washing. The honest answer in this
-- category is MEASURE THE GARMENT — pit-to-pit and length — which is what the
-- listing needs anyway. Seeding a chart would invent precision that the physical
-- object destroyed decades ago.
--
-- ⚠ CONFIDENCE IS DELIBERATELY MODERATE THROUGHOUT. The sourcing is specialist
-- collector reference (defunkd's dated tag timelines and similar), not the
-- makers' own statements — most of these companies no longer exist to publish
-- anything. Under US-2212 that is CITED but not authoritative, so the eras are
-- seeded at 0.5-0.6 and are prompt reference rather than publishable dating
-- claims. An era we cannot cite is invention; an era we cite weakly is a lead.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'screenstars', 'Screen Stars',
    ARRAY['screenstars','screenstarsbest']::text[],
    ARRAY['vintage tees','blanks','band tees','80s']::text[],
    $json$[
      {"era":"Generic RN 13765 tag (the precursor)","years":"1970s","description":"Fruit of the Loom / Union Underwear generic blanks carrying RN 13765, documented as the precursor to Screen Stars and fading out in the early 1980s. ⚠ The SAME RN appears on Screen Stars tags, which is exactly why the RN cannot attribute the sub-brand.","source_url":"https://www.defunkd.com/blog/2014/05/16/generic-rn-13765/","confidence":0.5},
      {"era":"Screen Stars introduced","years":"1980","description":"Fruit of the Loom introduced Screen Stars in 1980 for the screen-print imprint market; it became the decade's most circulated blank. A Screen Stars tag on a shirt dated earlier than 1980 is a contradiction.","source_url":"https://www.defunkd.com/blog/2016/12/06/the-screen-stars-timeline/","confidence":0.6},
      {"era":"Screen Stars Best","years":"1987","description":"The Screen Stars Best line appears around 1987 and was produced in the greatest quantities through the late 1980s and 1990s. 'Best' narrows the window; it does not by itself prove the decade.","source_url":"https://thriftcon.co/blogs/education/screen-stars-the-best-blanks-of-the-80s-and-90s","confidence":0.55}
    ]$json$::jsonb,
    $json$[
      {"tell":"⚠ THE THINNESS IS THE PRODUCT, NOT THE DAMAGE","detail":"Screen Stars blanks are mostly 50/50 cotton-poly. Washing fades the cotton and spares the polyester, leaving the paper-thin, translucent, feather-soft shirt collectors pay a premium FOR. Do not grade thinness, fade or a softened hand as wear in this category. DO grade holes, stains, a print flaked to illegibility, and a collar with no recovery left."},
      {"tell":"RN 13765 is the PARENT's number and attributes nothing","detail":"It is a real Registered Identification Number and it is genuinely on the tag — but it belongs to Union Underwear / Fruit of the Loom, and FOTL's generic 1970s blanks carry it too. It can corroborate a maker; it can never name Screen Stars."},
      {"tell":"A blank tag dates a shirt, it does not value one","detail":"The band, the tour, the print and the licensing house set the price. The collar tag only says when the shirt could have been made."}
    ]$json$::jsonb,
    'The 1980s imprint blank, made by Fruit of the Loom from 1980. NO DECODER — see the RN refusal. NO SIZE CHART — a forty-year-old blank''s alpha size is not a modern one and none of these makers publishes a chart; measure the garment. ⚠ Grading inversion: fade and thinness are the product.',
    'https://www.defunkd.com/blog/2016/12/06/the-screen-stars-timeline/', 0.55, false, 'migration:00579'
  ),
  (
    'brockum', 'Brockum',
    ARRAY['brockum','brockumgroup']::text[],
    ARRAY['vintage tees','band tees','concert merch','licensed']::text[],
    $json$[
      {"era":"Brockum tag in use","years":"1974-1997","description":"Defunkd dates the Brockum tag from 1974 to 1997. Brockum held licensing for stadium tours through the 1980s and into the mid-1990s — AC/DC, Metallica, the Rolling Stones, U2 among them — so a Brockum collar is a strong signal of OFFICIAL tour merchandise rather than a later reprint.","source_url":"https://www.defunkd.com/brockum/","confidence":0.6}
    ]$json$::jsonb,
    $json$[
      {"tell":"Brockum means officially licensed, not automatically valuable","detail":"It is the most sought-after tag in concert-merch collecting because it indicates official tour merchandise. It still says nothing about which tour, which band, or what the print is worth — and those are the price."},
      {"tell":"Same grading inversion as the rest of the category","detail":"Fade, thinness and a softened hand are the product. Holes, stains, an illegible print and a dead collar are the defects."}
    ]$json$::jsonb,
    'Concert-merchandise licensor and blank tag, roughly 1974-1997. NO DECODER, NO SIZE CHART. ⚠ NO brand_styles row is seeded and that is deliberate — a licensing house has no model identity; the BAND and the PRINT are the model. Same call the KB already makes for Gildan and Hanes.',
    'https://www.defunkd.com/brockum/', 0.55, false, 'migration:00579'
  ),
  (
    'giant', 'Giant',
    ARRAY['giant','giantbytultex','tultexgiant']::text[],
    ARRAY['vintage tees','band tees','90s','blanks']::text[],
    $json$[
      {"era":"Giant by Tultex, the 90s merch blank","years":"1990s","description":"Giant (initially branded Giant by Tultex) became the dominant 1990s merchandise blank for alternative rock, grunge and hip-hop tours. A Giant collar on a shirt claiming to be 1980s is a contradiction worth resolving before listing.","source_url":"https://propervintagecanada.com/blogs/the-vintage-clothing-guide/decoding-vintage-tags-screen-stars-giant-brockum","confidence":0.5}
    ]$json$::jsonb,
    $json$[
      {"tell":"⚠ A GIANT TAG DOES NOT MAKE A SHIRT VINTAGE","detail":"The tag is a dating INPUT, not a switch. Modern and reissued blanks exist and reprints of 90s graphics are common, so a Giant collar must be corroborated by construction (single stitch, made-in origin) and by the print itself before a vintage claim is made."},
      {"tell":"Same grading inversion as the rest of the category","detail":"Fade and thinness are the product; holes, stains, an illegible print and a dead collar are the defects."}
    ]$json$::jsonb,
    'The 1990s merchandise blank, originally Giant by Tultex. NO DECODER, NO SIZE CHART, and NO brand_styles row — a blank maker has no model identity (the Gildan/Hanes precedent).',
    'https://propervintagecanada.com/blogs/the-vintage-clothing-guide/decoding-vintage-tags-screen-stars-giant-brockum', 0.5, false, 'migration:00579'
  ),
  (
    'winterland', 'Winterland',
    ARRAY['winterland','winterlandproductions']::text[],
    ARRAY['vintage tees','band tees','concert merch','licensed']::text[],
    $json$[
      {"era":"Winterland concert-merch tag","years":"1980s","description":"Winterland is one of the era's primary concert-merchandise licensors alongside Brockum, and its tag is read the same way — a signal of official tour merchandise. Dated only to the decade here because the sourcing supports no tighter window.","source_url":"https://www.defunkd.com/vintage-t-shirts-103-the-brand-gallery/","confidence":0.45}
    ]$json$::jsonb,
    $json$[
      {"tell":"An official-merch tag is a provenance signal, not a grade","detail":"Like Brockum, it indicates licensed tour merchandise. What the shirt is worth is the band, the tour and the print."}
    ]$json$::jsonb,
    'Concert-merchandise licensor of the 1980s. Seeded at LOW confidence — the sourcing is a brand gallery rather than a dated timeline, so the era is a decade and nothing finer. NO DECODER, NO SIZE CHART, NO brand_styles row.',
    'https://www.defunkd.com/vintage-t-shirts-103-the-brand-gallery/', 0.45, false, 'migration:00579'
  )
on conflict (brand_key) do nothing;

-- ── brand_styles — ONLY where a real sub-line exists ────────────────────────
-- Screen Stars has documented sub-lines. Brockum, Giant and Winterland do not,
-- and inventing one would be worse than the gap: for a blank maker the MODEL is
-- the band and the print, which live on the item and not in this table. They are
-- registered in KNOWN_UNCOVERED in brand-style-coverage_test.ts with that
-- reason, the same call the KB already makes for Gildan and Hanes.
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('screenstars', 'Screen Stars Best', ARRAY['screen stars best','best']::text[], 'Blanks', 'Unisex', 't-shirt',
   'The upper Screen Stars line, appearing around 1987 and produced in the greatest quantities into the 1990s. Read the collar tag — "Best" is printed on it.',
   '1987-1990s', ARRAY['screen stars best','blank','50/50']::text[],
   'https://thriftcon.co/blogs/education/screen-stars-the-best-blanks-of-the-80s-and-90s', 0.55, false, 'migration:00579'),
  ('screenstars', 'Screen Stars 50/50', ARRAY['50/50','fifty fifty']::text[], 'Blanks', 'Unisex', 't-shirt',
   'The 50/50 cotton-poly blank. ⚠ THE BLEND IS WHY THE CATEGORY GRADES BACKWARDS: the cotton fades away with washing and the polyester stays, producing the thin, soft, translucent shirt that carries the premium.',
   null, ARRAY['50/50','cotton poly','thin']::text[],
   'https://www.defunkd.com/blog/2016/12/06/the-screen-stars-timeline/', 0.5, false, 'migration:00579')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes and NO brand_size_charts, both deliberate. See the header:
-- RN 13765 is the parent's number and attributes nothing, and a forty-year-old
-- blank's alpha size has been destroyed by four decades of washing — measure the
-- garment instead. Both absences are asserted in
-- services/edge-functions/src/tests/vintage-tee-content_test.ts.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00579') on conflict do nothing;
