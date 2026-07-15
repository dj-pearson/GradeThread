-- US-1731: Alo Yoga brand knowledge (activewear — style + fabric line + colorway).
--
-- Alo's resale identity is FABRIC LINE, not a printed style code: Airlift (light,
-- slight sheen, firm athletic compression, zero-slip high-rise waistband) vs
-- Airbrush (thicker, MATTE, cotton-esque, sculpting all-over compression) is the
-- single most-confused pair, and "7/8 High-Waist" is a LENGTH offered in both.
-- No deterministic tag-code decoder (unlike Lululemon's size dot) — identity is
-- read from the fabric hand + waistband + care tag (RN 87370 = Color Image
-- Apparel, Alo's parent). Data-only, idempotent. Facts are sourced + confidence-
-- scored; verified=false until the US-1715 admin queue confirms them.

-- ── brand_knowledge: Alo Yoga ───────────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, registered_numbers, country_patterns, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('aloyoga', 'Alo Yoga', ARRAY['alo','aloyoga','aloyogausa']::text[],
  ARRAY['activewear','yoga','athleisure','leggings']::text[],
  ARRAY['RN 87370']::text[],
  $j$[{"pattern":"Imported","note":"Care tag reads RN 87370 (Color Image Apparel). Fabric is typically milled in Asia and cut-and-sewn in Vietnam; the label says 'Imported' or 'Made in Vietnam'."}]$j$::jsonb,
  $j$[{"tell":"RN 87370","detail":"The care-tag RN 87370 identifies Color Image Apparel, Alo's parent company. An RN alone NEVER proves authenticity — it can be copied — but a WRONG/absent RN is a red flag."},{"tell":"Fabric hand identifies the line","detail":"Airlift = lightweight with a subtle SHEEN and firm athletic compression; Airbrush = thicker, MATTE, cotton-esque and sculpting. The finish (sheen vs matte) is the fastest disambiguator."},{"tell":"Minimalist branding","detail":"Lowercase 'alo' wordmark; small, clean waistband/care-label branding. Bulky or misaligned logos are suspect. NEVER assert authenticity — flag inconsistencies in condition_notes only."}]$j$::jsonb,
  'Alo identity = fabric LINE (Airlift vs Airbrush vs Alosoft) + length (7/8 vs full). No printed style-code decoder; read the fabric hand + waistband + RN 87370 care tag.',
  'https://www.aloyoga.com/pages/size-chart', 0.80, false, 'migration:00447')
on conflict (brand_key) do update set
  canonical_brand = excluded.canonical_brand, aliases = excluded.aliases,
  category_focus = excluded.category_focus, registered_numbers = excluded.registered_numbers,
  country_patterns = excluded.country_patterns, authentication_tells = excluded.authentication_tells,
  notes = excluded.notes, source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Alo's top resale lines ────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, aliases, department, category, product_line, visual_fingerprint, fabric_tech, msrp_band, keywords, source_url, confidence, verified, updated_by) values
  ('aloyoga', 'Airlift Legging', ARRAY['airlift']::text[], 'Women', 'legging', 'Airlift',
   'Lightweight performance knit with a subtle SHEEN; firm, locked-in athletic compression and a wide zero-slip HIGH-RISE waistband. Lighter and shinier than Airbrush.',
   ARRAY['Airlift']::text[], '$78-$148', ARRAY['airlift','legging','high waist','7/8']::text[],
   'https://www.apartstyle.com/post/alo-yoga-airlift-vs-airbrush', 0.80, false, 'migration:00447'),
  ('aloyoga', 'Airbrush Legging', ARRAY['airbrush']::text[], 'Women', 'legging', 'Airbrush',
   'Thicker, MATTE, cotton-esque hand with sculpting all-over compression that smooths the silhouette; more durable and heavier than Airlift. Often the base for Moto and printed styles.',
   ARRAY['Airbrush']::text[], '$88-$138', ARRAY['airbrush','legging','moto','matte']::text[],
   'https://www.apartstyle.com/post/alo-yoga-airbrush-vs-airlift-leggings', 0.80, false, 'migration:00447'),
  ('aloyoga', '7/8 High-Waist Legging', ARRAY['7/8','seven eighths']::text[], 'Women', 'legging', 'Airlift',
   'A LENGTH descriptor (ankle-grazing 7/8) in a high-rise cut, offered in both Airlift and Airbrush fabrics — not a fabric of its own. Confirm the fabric line from the hand/finish.',
   ARRAY['Airlift','Airbrush']::text[], '$88-$118', ARRAY['7/8','high waist','ankle','legging']::text[],
   'https://www.aloyoga.com/collections/womens-leggings', 0.70, false, 'migration:00447'),
  ('aloyoga', 'Accolade Hoodie', ARRAY['accolade']::text[], 'Women', 'hoodie', 'Accolade',
   'Boxy oversized pullover hoodie in brushed peached fleece; drops to the hip, kangaroo pocket, chunky drawcord. Sold in a matching set with the Muse sweatpant.',
   ARRAY['Accolade fleece']::text[], '$118-$138', ARRAY['accolade','hoodie','fleece','set']::text[],
   'https://www.aloyoga.com/', 0.70, false, 'migration:00447'),
  ('aloyoga', 'Muse Sweatpant', ARRAY['muse']::text[], 'Women', 'sweatpant', 'Muse',
   'Tapered high-waisted jogger in brushed peached fleece with cuffed ankles; the matching bottom to the Accolade hoodie.',
   ARRAY['Accolade fleece']::text[], '$108-$128', ARRAY['muse','sweatpant','jogger','fleece']::text[],
   'https://www.aloyoga.com/', 0.70, false, 'migration:00447')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_colorways: Alo reuses named colors season to season ────────────────
-- The NAME is the match value; hex is left null where a canonical value can't be
-- cited (only clear cases carry hex). years null — Alo doesn't season-code colors.
insert into public.brand_colorways
  (brand_key, color_name, aliases, hex, years, source_url, confidence, verified, updated_by) values
  ('aloyoga', 'Black', ARRAY['black']::text[], '#000000', null, 'https://www.aloyoga.com/', 0.80, false, 'migration:00447'),
  ('aloyoga', 'Anthracite', ARRAY['anthracite']::text[], null, null, 'https://www.aloyoga.com/', 0.60, false, 'migration:00447'),
  ('aloyoga', 'Espresso', ARRAY['espresso']::text[], null, null, 'https://www.aloyoga.com/', 0.60, false, 'migration:00447'),
  ('aloyoga', 'Bone', ARRAY['bone']::text[], null, null, 'https://www.aloyoga.com/', 0.60, false, 'migration:00447'),
  ('aloyoga', 'Dark Grey Heather', ARRAY['dark grey heather','dark heather grey']::text[], null, null, 'https://www.aloyoga.com/', 0.60, false, 'migration:00447')
on conflict (brand_key, color_name) do nothing;

-- ── brand_size_charts: Alo women's (sourced) + men's (standard-alpha approx) ──
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('aloyoga', 'Alo Yoga', ARRAY['alo yoga','aloyoga','alo']::text[], 'Women', 'Bottoms (leggings / pants)', ARRAY['bottom','legging','pant','short','tight','jogger','sweatpant']::text[],
   $json$[{"size":"XS","measurements":{"waist":"25-26.5","hip":"34.5-36"}},{"size":"S","measurements":{"waist":"27-28.5","hip":"36.5-38"}},{"size":"M","measurements":{"waist":"29-30.5","hip":"38.5-40"}},{"size":"L","measurements":{"waist":"31-33","hip":"40.5-42"}}]$json$::jsonb,
   'Alo women''s bottoms run alpha; waist is the primary signal, hip secondary. Chart covers XS-L (published guide); Alo also offers XXS (~1.5in below XS) and XL (~2in above L). High-rise waistbands lie flat — measure flat and double the waistband.',
   'https://www.aloyoga.com/pages/size-chart', 0.70, false, 'migration:00447'),
  ('aloyoga', 'Alo Yoga', ARRAY['alo yoga','aloyoga','alo']::text[], 'Women', 'Tops', ARRAY['top','tank','tee','shirt','bra','hoodie','jacket','long sleeve']::text[],
   $json$[{"size":"XS","measurements":{"bust":"32-34"}},{"size":"S","measurements":{"bust":"34-36"}},{"size":"M","measurements":{"bust":"36-38"}},{"size":"L","measurements":{"bust":"38-40"}}]$json$::jsonb,
   'Alo women''s tops run alpha (XS-L published; XXS/XL extend ~2in each way); bust is the primary signal.',
   'https://www.aloyoga.com/pages/size-chart', 0.70, false, 'migration:00447'),
  ('aloyoga', 'Alo Yoga', ARRAY['alo yoga','aloyoga','alo']::text[], 'Men', 'Tops', ARRAY['top','tee','shirt','polo','hoodie','jacket','long sleeve']::text[],
   $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$json$::jsonb,
   'Alo men''s tops run alpha; chest is the primary signal. Approximation aligned to standard US men''s activewear alpha (lower confidence) — refine with Alo-specific men''s data.',
   'https://www.aloyoga.com/pages/size-chart', 0.60, false, 'migration:00447')
on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00447') on conflict do nothing;
