-- US-1732: Athleta brand knowledge (activewear — style + fabric line + size markers).
--
-- Athleta (a Gap Inc brand) has NO printed style-code decoder analogous to
-- Lululemon's hidden size dot — identity is read from the FABRIC LINE + care-tag
-- size. The confusable set is its Powervita leggings: Salutation (BRUSHED, buttery,
-- Align-style yoga/lounge) vs Elation (SMOOTH, moisture-wicking, performance) —
-- same fabric family, different finish — vs Ultimate (firmer SuperSonic
-- compression). Woven Brooklyn ankle pant is a cult non-legging. Sizing runs both
-- alpha (XXS-3X) and numeric (0-24). 00389 already seeded Athleta size charts;
-- this refines them (adds hip + numeric mapping) via upsert and adds the missing
-- brand_knowledge + brand_styles + brand_colorways. Data-only, idempotent. Facts
-- sourced + confidence-scored; verified=false until the US-1715 admin queue.

-- ── brand_knowledge: Athleta ────────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('athleta', 'Athleta', ARRAY['athleta']::text[],
  ARRAY['activewear','yoga','athleisure','womens']::text[],
  $j$[{"pattern":"Imported","note":"Athleta is a Gap Inc brand; garments are typically imported (fabric milled + cut-and-sewn in Asia). Care label reads 'Imported' with the assembly country."}]$j$::jsonb,
  $j$[{"tell":"Fabric line IDs the legging","detail":"Salutation = BRUSHED, buttery Powervita (soft, yoga/lounge, Align-competitor); Elation = SMOOTH Powervita (moisture-wicking, performance); Ultimate = firmer SuperSonic (compression, running/training). Finish (brushed vs smooth) separates Salutation from Elation."},{"tell":"Sizing markers","detail":"Athleta labels both alpha (XXS-3X) and numeric (0-24). XXS≈00, XS≈0-2, S≈4-6, M≈8-10, L≈12-14, XL≈16-18. No hidden size-dot decoder — read the printed care-tag size."},{"tell":"Never auto-authenticate","detail":"Gap Inc brand; flag inconsistent tags/logos in condition_notes only, never assert authenticity."}]$j$::jsonb,
  'Athleta identity = fabric LINE (Salutation brushed vs Elation smooth vs Ultimate firm) + printed care-tag size. No style-code decoder. Gap Inc brand, imported.',
  'https://www.apartstyle.com/post/athleta-salutation-vs-elation-leggings', 0.75, false, 'migration:00448')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, country_patterns = excluded.country_patterns,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Athleta's top resale lines ────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('athleta', 'Salutation Tight', ARRAY['salutation','salutation stash']::text[], 'Women', 'legging', 'Salutation',
   'BRUSHED, buttery-soft Powervita with a peached hand; lightly compressive and warm — Athleta''s Align-competitor for yoga/Pilates/lounge. Softer/fuzzier face than the smooth Elation. Stash pocket variants common.',
   ARRAY['Powervita']::text[], '$89-$99', ARRAY['salutation','tight','powervita','yoga','stash']::text[],
   'https://www.apartstyle.com/post/athleta-salutation-vs-elation-leggings', 0.80, false, 'migration:00448'),
  ('athleta', 'Elation Tight', ARRAY['elation']::text[], 'Women', 'legging', 'Elation',
   'SMOOTH, sleek Powervita (not brushed) — moisture-wicking and quick-dry for gym/HIIT/running and everyday. The performance sibling of the softer Salutation; same fabric family, smoother finish.',
   ARRAY['Powervita']::text[], '$89-$99', ARRAY['elation','tight','powervita','performance']::text[],
   'https://styledbyscience.com/lululemon-vs-athleta-leggings-comparison-align-elation-salutation/', 0.80, false, 'migration:00448'),
  ('athleta', 'Ultimate Tight', ARRAY['ultimate']::text[], 'Women', 'legging', 'Ultimate',
   'Firm-support SuperSonic fabric with a smooth matte face and strong compression; built for running/training — noticeably more compressive and structured than the Powervita Salutation/Elation.',
   ARRAY['SuperSonic']::text[], '$89-$109', ARRAY['ultimate','tight','supersonic','compression','running']::text[],
   'https://styledbyscience.com/lululemon-vs-athleta-leggings-comparison-align-elation-salutation/', 0.75, false, 'migration:00448'),
  ('athleta', 'Brooklyn Ankle Pant', ARRAY['brooklyn','brooklyn ankle pant']::text[], 'Women', 'pant', 'Brooklyn',
   'WOVEN Featherweight Stretch (recycled poly) mid-rise ankle trouser with a slim tapered leg and real pockets; work-appropriate and a cult favorite — NOT a legging.',
   ARRAY['Featherweight Stretch']::text[], '$79-$89', ARRAY['brooklyn','ankle pant','trouser','work','woven']::text[],
   'https://athleta.gap.com/browse/product.do?pid=198671182', 0.75, false, 'migration:00448'),
  ('athleta', 'Rainier', ARRAY['rainier','rainier legging','rainier jogger']::text[], 'Women', 'legging', 'Rainier',
   'Soft knit legging/jogger line (lower-confidence fingerprint — confirm the fabric hand + silhouette from the tag).',
   ARRAY[]::text[], '$79-$99', ARRAY['rainier','legging','jogger']::text[],
   'https://athleta.gap.com/browse/bottoms/leggings?cid=1059481', 0.55, false, 'migration:00448')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_colorways: Athleta reuses named colors (hex only where citable) ─────
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('athleta', 'Black', ARRAY['black']::text[], '#000000', null, 'https://athleta.gap.com/', 0.80, false, 'migration:00448'),
  ('athleta', 'Navy', ARRAY['navy','true navy']::text[], null, null, 'https://athleta.gap.com/', 0.60, false, 'migration:00448'),
  ('athleta', 'Tundra', ARRAY['tundra']::text[], null, null, 'https://athleta.gap.com/', 0.55, false, 'migration:00448')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts: refine the 00389 Athleta charts (add hip + numeric map) ─
-- Upsert (do update) supersedes the 00389 alpha rows with the sourced XXS-XL
-- measurements + the numeric (0-18) mapping in the note. 1X-3X exist but their
-- full measurements aren't reliably sourced — the note says how to extend.
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('athleta', 'Athleta', ARRAY['athleta']::text[], 'Women', 'Tops', ARRAY['top','tee','shirt','tank','bra','hoodie','jacket','long sleeve']::text[],
   $json$[{"size":"XXS","measurements":{"bust":"32.5"}},{"size":"XS","measurements":{"bust":"32.5-33.5"}},{"size":"S","measurements":{"bust":"34.5-35.5"}},{"size":"M","measurements":{"bust":"36.5-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41.5-43.5"}}]$json$::jsonb,
   'Athleta women''s tops run alpha (XXS-3X) with a numeric map (XXS≈00, XS≈0-2, S≈4-6, M≈8-10, L≈12-14, XL≈16-18); bust is the primary signal. 1X-3X extend ~+2.5in/step.',
   'https://www.schimiggy.com/athleta-size-guide/', 0.75, false, 'migration:00448'),
  ('athleta', 'Athleta', ARRAY['athleta']::text[], 'Women', 'Bottoms (leggings / pants)', ARRAY['bottom','legging','pant','short','tight','jogger']::text[],
   $json$[{"size":"XXS","measurements":{"waist":"24","hip":"34.5"}},{"size":"XS","measurements":{"waist":"25-26","hip":"35.5-36.5"}},{"size":"S","measurements":{"waist":"27-28","hip":"37.5-38.5"}},{"size":"M","measurements":{"waist":"29-30","hip":"39.5-40.5"}},{"size":"L","measurements":{"waist":"31-32.5","hip":"41.5-43"}},{"size":"XL","measurements":{"waist":"34-36","hip":"44.5-46.5"}}]$json$::jsonb,
   'Athleta women''s bottoms run alpha (XXS-3X) with a numeric map (XXS≈00, XS≈0-2, S≈4-6, M≈8-10, L≈12-14, XL≈16-18); waist is the primary signal, hip secondary. 1X-3X extend ~+2.5in waist/step.',
   'https://www.schimiggy.com/athleta-size-guide/', 0.75, false, 'migration:00448')
on conflict (brand_key, department, garment) do update set
  rows = excluded.rows, note = excluded.note, category_match = excluded.category_match,
  source_url = excluded.source_url, confidence = excluded.confidence,
  brand_match = excluded.brand_match, updated_by = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00448') on conflict do nothing;
