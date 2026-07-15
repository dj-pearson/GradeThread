-- US-1729: Free People brand knowledge (SUB-LINE identity + size).
--
-- Free People (URBN) resale identity is the SUB-LINE printed on the tag, not a
-- decodable style code. The confusable set is the sub-lines themselves — the same
-- "Free People" umbrella covers boho main-line dresses, We The Free (heritage
-- denim + casual), Intimately (lingerie / slips / loungewear), FP Movement
-- (activewear — its OWN tag, not the boho line), FP One (elevated), and free-est
-- (airy everyday sets / swim; formerly Endless Summer / FP Beach). Reading the
-- sub-line off the tag fixes the most common mislabel (an FP Movement legging or
-- an Intimately slip filed as generic "Free People"). No style-code decoder.
-- Data-only, idempotent. Facts sourced + confidence-scored; verified=false until
-- the US-1715 admin queue.

-- ── brand_knowledge: Free People ────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('freepeople', 'Free People', ARRAY['freepeople','fp','free people']::text[],
  ARRAY['boho','dresses','denim','activewear','intimates','womens']::text[],
  $j$[{"pattern":"Imported","note":"URBN (Urban Outfitters Inc) brand; imported. URBN requires the RN#/CA# on the care/content label, sewn into the wearer's-left side seam (3-4in above the hem on tops/dresses)."}]$j$::jsonb,
  $j$[{"tell":"Sub-line on the tag IS the identity","detail":"We The Free = heritage denim + casual tops/jackets; Intimately = lingerie, slips, bralettes, loungewear; FP Movement = activewear (leggings/sports bras) on its OWN tag; FP One = elevated/premium; free-est (formerly Endless Summer / FP Beach) = airy everyday sets, dresses, swim. The printed sub-line disambiguates a lookalike far better than the silhouette."},{"tell":"FP Movement is NOT the boho line","detail":"An FP Movement legging or bra is athleisure with its own branding — don't file it as a boho Free People dress, and vice-versa."},{"tell":"Never auto-authenticate","detail":"URBN brand; flag inconsistent tags/branding in condition_notes only, never assert authenticity."}]$j$::jsonb,
  'Free People identity = the SUB-LINE printed on the tag (We The Free / Intimately / FP Movement / FP One / free-est). No style-code decoder. URBN brand, imported.',
  'https://www.freepeople.com/brands/', 0.78, false, 'migration:00449')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Free People sub-lines ─────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('freepeople', 'We The Free', ARRAY['we the free','wtf']::text[], 'Women', 'denim', 'We The Free',
   'Heritage-inspired DENIM, jackets, and casual/graphic tops — the everyday casual + denim sub-line. Distressed jeans, utility jackets, washed tees. Tag reads "We The Free" / WTF.',
   ARRAY[]::text[], '$68-$168', ARRAY['we the free','wtf','denim','jeans','casual']::text[],
   'https://www.freepeople.com/brands/', 0.78, false, 'migration:00449'),
  ('freepeople', 'Intimately', ARRAY['intimately','intimately fp']::text[], 'Women', 'intimates', 'Intimately',
   'Lingerie, slip dresses, bralettes, undies, and loungewear — the intimates sub-line. Lace bralettes and bias slip dresses are the resale staples. Tag reads "Intimately".',
   ARRAY[]::text[], '$20-$98', ARRAY['intimately','lingerie','slip','bralette','loungewear']::text[],
   'https://www.freepeople.com/fpmovement/brands/intimately/', 0.78, false, 'migration:00449'),
  ('freepeople', 'FP Movement', ARRAY['fp movement','free people movement']::text[], 'Women', 'activewear', 'FP Movement',
   'Activewear — leggings, sports bras, shorts, and sets for yoga/running/gym. A DISTINCT athleisure sub-line with its own tag (not the boho main line). Popular: Good Karma, Way Home.',
   ARRAY[]::text[], '$38-$128', ARRAY['fp movement','activewear','legging','sports bra','athleisure']::text[],
   'https://www.apartstyle.com/post/free-people-vs-fp-movement', 0.78, false, 'migration:00449'),
  ('freepeople', 'FP One', ARRAY['fp one']::text[], 'Women', 'dress', 'FP One',
   'Elevated/premium sub-line — flowy statement dresses and higher-priced pieces. Tag reads "FP One". (Lower-confidence fingerprint beyond the tag + price tier.)',
   ARRAY[]::text[], '$128-$328', ARRAY['fp one','dress','premium','elevated']::text[],
   'https://www.freepeople.com/brands/', 0.60, false, 'migration:00449'),
  ('freepeople', 'Endless Summer', ARRAY['endless summer','free-est','freeest','fp beach']::text[], 'Women', 'dress', 'Endless Summer',
   'Airy everyday sets, maxi dresses, and swimwear; the beachy sub-line — REBRANDED from "Endless Summer" / "FP Beach" to "free-est". Match the tag to either name.',
   ARRAY[]::text[], '$48-$168', ARRAY['endless summer','free-est','beach','swim','dress','set']::text[],
   'https://www.freepeople.com/brands/', 0.65, false, 'migration:00449')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_colorways: FP reuses a few staples (names; hex only where citable) ──
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('freepeople', 'Black', ARRAY['black']::text[], '#000000', null, 'https://www.freepeople.com/', 0.75, false, 'migration:00449'),
  ('freepeople', 'Ivory', ARRAY['ivory']::text[], null, null, 'https://www.freepeople.com/', 0.55, false, 'migration:00449')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts: FP women's tops/dresses (alpha) + denim (numeric) ──────
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('freepeople', 'Free People', ARRAY['free people','freepeople','fp']::text[], 'Women', 'Tops & dresses (alpha)', ARRAY['top','tee','shirt','blouse','dress','tunic','sweater','hoodie','jacket','tank','bodysuit']::text[],
   $json$[{"size":"XS","measurements":{"bust":"33","waist":"25"}},{"size":"S","measurements":{"bust":"34","waist":"26"}},{"size":"M","measurements":{"bust":"35","waist":"27"}},{"size":"L","measurements":{"bust":"36","waist":"28"}},{"size":"XL","measurements":{"bust":"38","waist":"30"}}]$json$::jsonb,
   'Free People women''s tops/dresses run alpha; bust is the primary signal (waist secondary for fitted dresses). XS-L per the published guide; XL extends ~+2in. FP runs relaxed/oversized — a garment often measures larger than the alpha implies.',
   'https://www.freepeople.com/help/size-chart/', 0.70, false, 'migration:00449'),
  ('freepeople', 'Free People', ARRAY['free people','freepeople','we the free','fp']::text[], 'Women', 'Denim (numeric waist)', ARRAY['jean','denim','pant','bottom']::text[],
   $json$[{"size":"24","measurements":{"waist":"24-24.5"}},{"size":"25","measurements":{"waist":"25-25.5"}},{"size":"26","measurements":{"waist":"26-26.5"}},{"size":"27","measurements":{"waist":"27-27.5"}},{"size":"28","measurements":{"waist":"28-28.5"}},{"size":"29","measurements":{"waist":"29-29.5"}},{"size":"30","measurements":{"waist":"30-31"}},{"size":"31","measurements":{"waist":"31-32"}}]$json$::jsonb,
   'Free People / We The Free denim uses a numeric waist label (24-31) approx = natural waist in inches. Standard denim mapping (moderate confidence) — measure the flat waistband and double it.',
   'https://www.freepeople.com/help/size-chart/', 0.60, false, 'migration:00449')
on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00449') on conflict do nothing;
