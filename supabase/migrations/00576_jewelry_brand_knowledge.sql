-- US-2221: Jewelry brand knowledge (4 brands) — Pandora, Tiffany & Co.,
-- David Yurman, James Avery. All four absent from the KB, like 00574 and 00575.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE THIRD TIME THE SAME REFUSAL HAS APPEARED, WHICH MAKES IT A PATTERN AND
-- NOT AN INCIDENT.
--
--   A MARK CAN BE STAMPED, PERFECTLY REGULAR, AND IDENTIFY NOBODY.
--
--   00575 (eyewear): the size triplet `58□14 135` — lens/bridge/temple in
--                    millimetres, printed by every maker on earth.
--   00576 (here):    the METAL PURITY HALLMARK — `925`, `585`, `750`, `950`.
--
-- A purity stamp is a legal/trade statement about the ALLOY. It is struck into
-- almost every piece of fine jewelry ever sold, so a pattern over it would mint
-- a brand from the one mark that is guaranteed to be present and guaranteed to
-- be meaningless as attribution. It is the cleanest possible failure of
-- brand-unique-in-format, and it goes in authentication_tells where a fact about
-- the metal belongs.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO DECODERS IN THIS PACK, AND THE REASON IS STRUCTURAL RATHER THAN
-- RESEARCH-LIMITED.
--
-- Jewelry marks are MAKER'S MARKS: `ALE`, `T&CO.`, `D.Y.`, `JAMES AVERY`. Every
-- one is genuinely brand-unique and genuinely struck into the metal — `ALE` is
-- Pandora's own documented hallmark, the initials of Algot Enevoldsen. So why no
-- decoder?
--
--   BECAUSE decodeTagCode RUNS INSIDE AN ALREADY-RESOLVED PACK. A decoder's job
--   is to pull a STYLE, SIZE or COLORWAY out of a code once the brand is known.
--   A maker's mark carries the brand and nothing else — by the time the spec
--   could run, its entire payload is already the thing that selected the pack.
--
-- These marks are seeded as authentication_tells, which is where a fact that
-- identifies the MAKER rather than the MODEL belongs. And the item numbers that
-- WOULD name a model — Pandora's `594594C00`, for instance — appear only in the
-- catalogue and on the box, never struck into the piece. That is 00467's rule:
-- SHAPE IS NOT PROVENANCE. A code read off a URL is a listing parser, not a
-- thing you can read off an object in your hand.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ THE SAFETY RULE THAT GOVERNS THIS ENTIRE PACK: **NEVER AUTO-AUTHENTICATE.**
--
-- Established for Canada Goose in 00460 — "the holographic disc is reproduced by
-- fakes... never emit an authentic/fake verdict" — and jewelry is where it
-- matters most, because A HALLMARK IS THE FIRST THING A COUNTERFEITER COPIES. It
-- is a few characters struck into soft metal. Every source consulted for this
-- pack says the same thing in its own words: judge the mark WITH the
-- construction, the weight and the finishing, never alone.
--
-- So every tell below is phrased as NECESSARY AND NOT SUFFICIENT. A missing or
-- wrong mark is real evidence AGAINST; a correct-looking mark is not evidence
-- FOR. That asymmetry is the whole of what can honestly be said, and stating it
-- as a rule is worth more than any individual mark in the rows.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO SIZE CHARTS, AND IT IS THE EYEWEAR ANSWER AGAIN. A ring is sold in US ring
-- sizes and a bracelet in centimetres — both are STANDARDS, not a brand's labels,
-- so there is nothing brand-specific to look up and a chart would be invented.
-- Third data point for the rule in vault/20-domain/brands/brand-kb-sizing-units.md:
-- the dividing question is not the category, it is whether the number on the item
-- is a MEASUREMENT or a brand's NAME for one. Headwear is the only one of the
-- three where it is a name.

-- ── brand_knowledge ─────────────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras,
   authentication_tells, notes, source_url, confidence, verified, updated_by)
values
  (
    'pandora', 'Pandora',
    ARRAY['pandora','pandorajewelry','pandorajewellery']::text[],
    ARRAY['jewelry','charms','bracelets','sterling silver']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"ALE is the maker's mark and it is brand-unique","detail":"Pandora documents its own hallmarks: S925 for sterling (S for silver, 925 parts per thousand), G585 for 14k gold, and ALE — the initials of Algot Enevoldsen, father of founder Per Enevoldsen. Where a gold detail is too small to mark, the S925 G585 ALE hallmark is struck on the silver part instead. NECESSARY, NOT SUFFICIENT: this is exactly the mark counterfeiters reproduce."},
      {"tell":"S925 alone says nothing about the brand","detail":"A purity stamp is a statement about the alloy and appears on almost all fine jewelry. It is evidence about the METAL and never about the maker. Read it for the material, not for attribution."},
      {"tell":"The item number is on the box, not on the piece","detail":"Pandora catalogue numbers (594594C00 and the like) live in the catalogue and on packaging. They are excellent for a listing and useless for identifying a loose charm, because they are not struck into it."}
    ]$json$::jsonb,
    'Danish jewelry house; charms and the bracelets that carry them. NO DECODER — the marks it strikes are MAKER''S marks (ALE, S925), which carry the brand and no model, and decodeTagCode runs inside an already-resolved pack where the brand is the one thing already known. ⚠ Never auto-authenticate off a hallmark.',
    'https://uk.pandora.net/en/discover/pandora-world/craftsmanship/engravings-and-hallmarks/', 0.75, true, 'migration:00576'
  ),
  (
    'tiffanyco', 'Tiffany & Co.',
    ARRAY['tiffany','tiffanyco','tiffanyandco']::text[],
    ARRAY['jewelry','luxury','sterling silver','engagement']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"The full name or T&CO., always with a purity mark","detail":"Pieces carry TIFFANY & CO. or the abbreviated T&CO. alongside 925 (sterling), 750 (18k gold) or 950 (platinum). The short form is used where space is tight — ring bands, small pendants, clasps, chain tags. Struck sharply and evenly. NECESSARY, NOT SUFFICIENT."},
      {"tell":"Look on the clasp, the band and the tag","detail":"The mark appears inside ring bands, on clasps, on pendant backs, or on a small tag attached to a chain. A photograph of the front of a piece carries none of it, so a listing without a mark shot is not a listing that has shown its evidence."},
      {"tell":"Tiffany Blue is a colour, not a mark","detail":"The box and pouch are trade dress and are sold loose on the resale market. Packaging is not evidence about the piece inside it — the same reasoning that refuses New Era''s visor sticker in 00574."}
    ]$json$::jsonb,
    'American luxury jeweler. Sized in US ring sizes and standard chain lengths, so NO chart is seeded. NO DECODER — TIFFANY & CO. / T&CO. is a maker''s mark carrying the brand and no model. ⚠ Never auto-authenticate off a hallmark; a correct-looking stamp is not evidence FOR.',
    'https://press.tiffany.com/our-story/a-legacy-of-sterling-silver/', 0.70, true, 'migration:00576'
  ),
  (
    'davidyurman', 'David Yurman',
    ARRAY['davidyurman','yurman']::text[],
    ARRAY['jewelry','designer','sterling silver','cable']::text[],
    $json$[]$json$::jsonb,
    $json$[
      {"tell":"D.Y. or D. Yurman with a copyright symbol, near the end caps","detail":"The mark sits on the inside of a cuff, usually close to one of the open ends or just inside the end caps, alongside 925. A crisp copyright symbol normally accompanies the signature. NECESSARY, NOT SUFFICIENT — but note the asymmetry: a MISSING period in D.Y., shallow or uneven striking, a wrong font or a misspelling is real evidence AGAINST."},
      {"tell":"The cable is the model, and it is where fakes fail","detail":"The twisted cable is the house''s signature construction. Uneven twists, rough finishing and wrong proportions are the reported tells, and they are CONSTRUCTION facts rather than mark facts — which is why the mark is never read alone."}
    ]$json$::jsonb,
    'American designer jeweler defined by the twisted cable. NO DECODER — the stamp is a signature, not a style code. ⚠ Never auto-authenticate; judge the mark WITH the cable, the weight and the finishing.',
    'https://www.davidyurman.com/', 0.60, true, 'migration:00576'
  ),
  (
    'jamesavery', 'James Avery',
    ARRAY['jamesavery','jamesaverycraftsman']::text[],
    ARRAY['jewelry','sterling silver','charms','american']::text[],
    $json$[
      {"era":"Marked \"sterling\" rather than 925","years":"pre-2004","description":"Reported that pieces before about 2004 were stamped 'sterling' where later ones carry '925'. A word-marked piece therefore reads older than a numeral-marked one. Recorded at LOW confidence: the sourcing is collector and buyer-guide material, not the maker''s own statement, and a dating claim is the highest-liability content in this KB.","source_url":"https://howtobuyvintagejewelry.com/vintage-james-avery-jewelry-buying-guide","confidence":0.45},
      {"era":"JAMES AVERY CRAFTSMAN / JA monogram","years":"1960s-1970s","description":"Reported that the earliest pieces carry a JA monogram or a JAMES AVERY CRAFTSMAN stamp, with the plain JAMES AVERY block stamp used later. LOW confidence for the same reason as above.","source_url":"https://www.whatisthismark.com/jewelry/makers/james-avery","confidence":0.4}
    ]$json$::jsonb,
    $json$[
      {"tell":"JAMES AVERY in block letters, with a purity mark","detail":"The full name in clear block capitals beside 925 / STER for sterling or 14K for gold, struck inside rings, bracelets and pendants. NECESSARY, NOT SUFFICIENT."},
      {"tell":"A candelabra flanked by J and A","detail":"Reported as a maker''s device on some pieces. Treat as corroboration, never as a verdict — a device is as reproducible as a word."}
    ]$json$::jsonb,
    'Texas jewelry house, sterling and gold, charms and crosses. NO DECODER. ⚠ The two dating claims here are seeded at LOW confidence on purpose: both come from buyer guides rather than the maker, and per US-2212 an era we cannot cite properly is not something to publish. Render them as prompt reference, not as a listing claim.',
    'https://www.jamesavery.com/jewelry-information/jewelry-metals-information.html', 0.55, true, 'migration:00576'
  )
on conflict (brand_key) do nothing;

-- ── brand_styles ────────────────────────────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, product_line, department, category,
   visual_fingerprint, era, keywords, source_url, confidence, verified, updated_by)
values
  ('pandora', 'Pandora Moments', ARRAY['moments','moments bracelet']::text[], 'Charms & bracelets', 'Women', 'jewelry',
   'The charm-carrying system: a snake-chain or heart-clasp bracelet in sterling that the Moments charms and clips thread onto. THE CHARMS ARE THE VALUE — a Moments bracelet resells on what is on it, so the charms belong in the title and the count belongs in the description.',
   null, ARRAY['moments','charm bracelet','snake chain']::text[],
   'https://us.pandora.net/en/collections/pandora-moments/', 0.70, true, 'migration:00576'),
  ('tiffanyco', 'Return to Tiffany', ARRAY['return to tiffany','rtt']::text[], 'Jewelry', 'Women', 'jewelry',
   'Heart tags and pendants carrying the "Please Return to Tiffany & Co." engraving, taken from an archival key ring. The engraved tag is the model.',
   null, ARRAY['return to tiffany','heart tag']::text[],
   'https://www.tiffany.com/designers-collections/elsa-peretti-open-heart/', 0.65, true, 'migration:00576'),
  ('tiffanyco', 'Elsa Peretti Open Heart', ARRAY['open heart','elsa peretti']::text[], 'Jewelry', 'Women', 'jewelry',
   'Sculptural open heart, designed by Elsa Peretti and debuted in 1974; sold as pendants, earrings and rings, in silver and gold, some diamond-accented.',
   '1974-present', ARRAY['open heart','elsa peretti','pendant']::text[],
   'https://www.tiffany.com/designers-collections/elsa-peretti-open-heart/', 0.70, true, 'migration:00576'),
  ('davidyurman', 'Cable Classic', ARRAY['cable','cable classic','cable bracelet']::text[], 'Jewelry', 'Unisex', 'jewelry',
   'The twisted sterling cable with capped ends, frequently with 14k gold end caps and a set stone. The cable is the house signature and the place a counterfeit shows itself.',
   null, ARRAY['cable','yurman cable','cuff']::text[],
   'https://www.davidyurman.com/', 0.60, true, 'migration:00576'),
  ('jamesavery', 'Charm bracelet', ARRAY['charm bracelet']::text[], 'Charms & bracelets', 'Women', 'jewelry',
   'Sterling charm bracelets carrying the house''s cast charms. Like Pandora Moments, the value is in the charms rather than the chain.',
   null, ARRAY['charm bracelet','sterling']::text[],
   'https://www.jamesavery.com/jewelry-information/jewelry-metals-information.html', 0.50, true, 'migration:00576')
on conflict (brand_key, style_name, department) do nothing;

-- NO brand_style_codes AND NO brand_size_charts, both deliberately. See the
-- header: a maker's mark carries the brand and no model, and a ring size is a US
-- standard rather than a brand's label. Both absences are asserted by
-- services/edge-functions/src/tests/jewelry-content_test.ts so neither reads as
-- an omission.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00576') on conflict do nothing;
