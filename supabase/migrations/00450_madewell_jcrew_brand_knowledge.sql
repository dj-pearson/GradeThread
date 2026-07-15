-- US-1730: Madewell & J.Crew brand knowledge (two related banners, one pack).
--
-- Madewell and J.Crew share a corporate parent (J.Crew Group) but ship DISTINCT
-- tags. Resale identity is the NAMED FIT + the tag: Madewell denim by fit name
-- (The Perfect Vintage vs Roadtripper vs the Curvy contour block), J.Crew by its
-- numbered chino/denim fits (484 Slim / 770 Straight / 1040 Athletic / 1450
-- Relaxed) and the Ludlow suiting line. Both print a generic letter+digit item
-- code on the tag (Madewell e.g. NW282, J.Crew e.g. CA123) — captured as an
-- informational tell, NOT a brand-recovering decoder (the format is not unique,
-- so it must never mint a false brand). Data-only, idempotent. Facts sourced +
-- confidence-scored; verified=false until the US-1715 admin queue.

-- ── brand_knowledge: Madewell (new) ─────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('madewell', 'Madewell', ARRAY['madewell']::text[],
  ARRAY['denim','womens','casual','tops']::text[],
  $j$[{"pattern":"Imported","note":"J.Crew Group brand; imported. Care/content label in the side seam carries the RN/CA + the letter+digit style code."}]$j$::jsonb,
  $j$[{"tell":"Fit name IDs the jean","detail":"The Perfect Vintage = 11in high rise, TAPERED leg, curve-enhancing back + signature front Magic Pockets (vintage-inspired). Roadtripper = soft stretch high-rise SKINNY (jegging-like, 9in rise). Curvy = a contoured/narrower waistband + extra hip-thigh room for an hourglass, applied ACROSS fits."},{"tell":"Item code on the tag","detail":"Madewell prints a 1-2 letter + 3-4 digit style code (e.g. NW282, K1877) on the care tag — it identifies the STYLE (informational), not authenticity, and the format is not brand-unique."},{"tell":"Never auto-authenticate","detail":"Flag inconsistent tags/branding in condition_notes only."}]$j$::jsonb,
  'Madewell (J.Crew Group) = denim by FIT name (Perfect Vintage tapered vs Roadtripper skinny vs Curvy contour). Item code identifies the style, not the brand.',
  'https://www.madewell.com/womens/jeans/straight-leg-perfect-vintage/', 0.75, false, 'migration:00450')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_knowledge: J.Crew (enrich the bare 00389 row) ─────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('jcrew', 'J.Crew', ARRAY['jcrew','j crew','j.crew']::text[],
  ARRAY['preppy','chinos','shirting','suiting','denim','mens','womens']::text[],
  $j$[{"pattern":"Imported","note":"J.Crew Group brand; imported. RN/CA + a letter+digit item code on the care label."}]$j$::jsonb,
  $j$[{"tell":"Numbered chino/denim fits","detail":"484 = Slim (slim hip/thigh, tapered); 770 = Straight (between 484 and 1040, moderate taper); 1040 = Athletic (roomy upper+lower leg, semi-tapered); 1450 = Relaxed (roomy throughout). The number IS the fit."},{"tell":"Ludlow = the suiting line","detail":"Ludlow is J.Crew's slim tailored suiting/blazer line — a line name, not a chino fit."},{"tell":"Item code on the tag","detail":"J.Crew prints a letter+digit item code on the care tag (identifies the style, informational; not brand-unique)."},{"tell":"Never auto-authenticate","detail":"Flag inconsistent tags in condition_notes only."}]$j$::jsonb,
  'J.Crew (J.Crew Group) = preppy classics identified by NUMBERED fit (484 Slim / 770 Straight / 1040 Athletic / 1450 Relaxed) + the Ludlow suiting line. Item code identifies the style, not the brand.',
  'https://www.jcrew.com/feature/chino-fit-guide', 0.78, false, 'migration:00450')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Madewell fits + J.Crew fits/lines ─────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('madewell', 'The Perfect Vintage Jean', ARRAY['perfect vintage','the perfect vintage']::text[], 'Women', 'jean', 'The Perfect Vintage',
   '11in HIGH rise, TAPERED leg with a curve-enhancing back yoke and signature front Magic Pockets; vintage-inspired rigid-ish denim. Distinct from the stretchy skinny Roadtripper.',
   ARRAY[]::text[], '$128-$148', ARRAY['perfect vintage','tapered','high rise','magic pockets']::text[],
   'https://www.madewell.com/womens/jeans/straight-leg-perfect-vintage/', 0.80, false, 'migration:00450'),
  ('madewell', 'Roadtripper Jean', ARRAY['roadtripper']::text[], 'Women', 'jean', 'Roadtripper',
   'Soft, stretchy high-rise SKINNY (jegging-like) in supersoft denim; ~9in rise, second-skin fit. The stretchy counterpart to the structured Perfect Vintage.',
   ARRAY[]::text[], '$88-$98', ARRAY['roadtripper','skinny','jegging','stretch']::text[],
   'https://www.madewell.com/p/womens/clothing/jeans/slim-skinny/roadtripper-jeans-in-orson-wash/H5804/', 0.78, false, 'migration:00450'),
  ('madewell', 'Curvy', ARRAY['curvy']::text[], 'Women', 'jean', 'Curvy',
   'A FIT BLOCK (not a single style) — a contoured/narrower waistband with extra hip + thigh room for an hourglass shape; offered across Perfect Vintage, Roadtripper, and skinny fits.',
   ARRAY[]::text[], '$88-$148', ARRAY['curvy','contour waistband','hourglass']::text[],
   'https://www.madewell.com/p/womens/more-sizes/curvy/curvy-roadtripper-authentic-skinny-jeans-in-conroe-wash/NB418/', 0.72, false, 'migration:00450'),
  ('jcrew', '484 Slim', ARRAY['484','484 slim']::text[], 'Men', 'pant', '484',
   'The SLIM chino/denim fit — slim through hip and thigh with a tapered lower leg; sharpest, leanest line of the numbered fits.',
   ARRAY[]::text[], '$79-$98', ARRAY['484','slim','chino','tapered']::text[],
   'https://www.jcrew.com/feature/chino-fit-guide', 0.80, false, 'migration:00450'),
  ('jcrew', '770 Straight', ARRAY['770','770 straight']::text[], 'Men', 'pant', '770',
   'The STRAIGHT fit — sits between 484 and 1040: a touch more thigh room than 484 with a moderate (not aggressive) taper. J.Crew''s most versatile chino fit.',
   ARRAY[]::text[], '$79-$98', ARRAY['770','straight','chino']::text[],
   'https://www.jcrew.com/feature/chino-fit-guide', 0.80, false, 'migration:00450'),
  ('jcrew', '1040 Athletic', ARRAY['1040','1040 athletic']::text[], 'Men', 'pant', '1040',
   'The ATHLETIC fit — roomier through the upper and lower leg for a muscular build, with a semi-tapered leg. Roomier than 770, trimmer than 1450 Relaxed.',
   ARRAY[]::text[], '$79-$98', ARRAY['1040','athletic','chino']::text[],
   'https://www.jcrew.com/feature/chino-fit-guide', 0.78, false, 'migration:00450'),
  ('jcrew', 'Ludlow', ARRAY['ludlow']::text[], 'Men', 'suit', 'Ludlow',
   'J.Crew''s slim tailored SUITING line (blazers, suit trousers) — a line name, not a chino fit. Notch-lapel Italian-fabric suiting is the resale staple.',
   ARRAY[]::text[], '$298-$650', ARRAY['ludlow','suit','blazer','suiting']::text[],
   'https://www.jcrew.com/', 0.70, false, 'migration:00450'),
  ('jcrew', 'Tilly', ARRAY['tilly']::text[], 'Women', 'top', 'Tilly',
   'A women''s tie-neck / relaxed top line (lower-confidence fingerprint — confirm from the tag).',
   ARRAY[]::text[], '$68-$98', ARRAY['tilly','top','tie neck']::text[],
   'https://www.jcrew.com/', 0.55, false, 'migration:00450')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_colorways: neither reuses a broad named-color system (Madewell washes
--    are per-style names) — seed only the stable staple, leave the rest empty. ─
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('jcrew', 'Black', ARRAY['black']::text[], '#000000', null, 'https://www.jcrew.com/', 0.70, false, 'migration:00450'),
  ('madewell', 'Lunar Wash', ARRAY['lunar wash','black rinse']::text[], null, null, 'https://www.madewell.com/', 0.55, false, 'migration:00450')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts: J.Crew men's chinos (numeric) + men's shirts (alpha) ───
-- Madewell women's denim already seeded (00389). AC4 adds the J.Crew side.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('jcrew', 'J.Crew', ARRAY['j.crew','jcrew','j crew']::text[], 'Men', 'Chinos / pants (waist x inseam)', ARRAY['chino','pant','trouser','bottom','short']::text[],
   $json$[{"size":"28","measurements":{"waist":"28"}},{"size":"30","measurements":{"waist":"30"}},{"size":"31","measurements":{"waist":"31"}},{"size":"32","measurements":{"waist":"32"}},{"size":"33","measurements":{"waist":"33"}},{"size":"34","measurements":{"waist":"34"}},{"size":"36","measurements":{"waist":"36"}},{"size":"38","measurements":{"waist":"38"}}]$json$::jsonb,
   'J.Crew men''s chinos/pants are labeled W (waist) x L (inseam) in inches; the numbered FIT (484/770/1040) sets the leg cut, not the size. Measure the flat waistband and double it.',
   'https://www.jcrew.com/feature/chino-fit-guide', 0.65, false, 'migration:00450'),
  ('jcrew', 'J.Crew', ARRAY['j.crew','jcrew','j crew']::text[], 'Men', 'Shirts (alpha)', ARRAY['shirt','tee','polo','oxford','sweater','hoodie']::text[],
   $json$[{"size":"XS","measurements":{"chest":"32-34"}},{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$json$::jsonb,
   'J.Crew men''s shirts run alpha; chest is the primary signal. Dress shirts are also sold by neck x sleeve — read the collar band when present.',
   'https://www.jcrew.com/', 0.60, false, 'migration:00450')
on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00450') on conflict do nothing;
