-- US-1720: adidas & Yeezy brand knowledge (third reference brand).
--
-- adidas article number (2 letters + 4 digits, GX1234) is a THIRD decoder format,
-- again seeded as PURE DATA. The Trefoil-vs-3-Bar logo distinction (Originals vs
-- Performance) is captured as an authentication tell + drives line fingerprints
-- (Firebird/Adicolor = Originals-Trefoil vs Tiro/Tango = Performance). Yeezy is
-- logo-free minimalist apparel identified by silhouette/earth-tones (no decoder).
-- Every fact source_url+confidence+verified. Data-only, idempotent.

-- ── Enrich brand_knowledge: adidas + Yeezy ─────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('adidas', 'adidas', ARRAY['adidas']::text[], ARRAY['athletic','sportswear','originals','football','running']::text[], $j$[{"era":"article-number","years":"all","description":"6-char article number (2 letters + 4 digits, e.g. GX1234) on the inside-collar tag, alongside a production date and size code."}]$j$::jsonb, $j$[{"tell":"Article number","detail":"6-char article code (2 letters + 4 digits) on the inside-collar tag — a precise product key."},{"tell":"Trefoil vs 3-Bar","detail":"The Trefoil logo = adidas Originals (lifestyle); the three-slanted-bar Badge of Sport = adidas Performance (sport). The logo identifies the LINE."}]$j$::jsonb, 'The LOGO identifies the line (Trefoil = Originals, 3-bar = Performance); the article number is a precise product key. Colorways are per-product.', 'https://www.sneakerfreaker.com/news/adidas-three-stripe-equipment-trefoil-logo-history', 0.88, true, 'migration:00392')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('yeezy', 'Yeezy', ARRAY['yeezy','yzy','adidasyeezy']::text[], ARRAY['streetwear','minimalist']::text[], $j$[]$j$::jsonb, $j$[{"tell":"Minimalist / no branding","detail":"Yeezy apparel is intentionally logo-free: oversized, muted earth tones (bone, ochre, black), heavy cotton. ID is by aesthetic + fit, not a wordmark."}]$j$::jsonb, 'adidas Yeezy / Yeezy Gap — logo-free minimalist apparel identified by silhouette (oversized, dropped shoulders), muted earth-tone colorways and heavy fabric.', 'https://www.sneakerfreaker.com/news/adidas-three-stripe-equipment-trefoil-logo-history', 0.88, true, 'migration:00392')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: adidas lines (Trefoil vs Performance) + Yeezy ─────────────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('adidas', 'Tiro Track Pant', 'Unisex', 'pant', 'Performance', 'Tapered track pant with ankle zips, 3-stripes down the legs and zip pockets.', ARRAY[]::text[], ARRAY['tiro','track pant','3-stripes']::text[], 'https://theresaledoctor.com/adidas-style-number/', 0.85, true, 'migration:00392'),
  ('adidas', 'Firebird Track Jacket', 'Unisex', 'jacket', 'Originals', 'Originals Trefoil track jacket: 3-stripes on the sleeves, contrast stand collar, full zip.', ARRAY[]::text[], ARRAY['firebird','track jacket','trefoil','originals']::text[], 'https://www.sneakerfreaker.com/news/adidas-three-stripe-equipment-trefoil-logo-history', 0.85, true, 'migration:00392'),
  ('adidas', 'Adicolor Trefoil', 'Unisex', 'top', 'Originals', 'Originals lifestyle tee/hoodie with the Trefoil logo and 3-stripes.', ARRAY[]::text[], ARRAY['adicolor','trefoil','originals']::text[], 'https://www.sneakerfreaker.com/news/adidas-three-stripe-equipment-trefoil-logo-history', 0.85, true, 'migration:00392'),
  ('adidas', 'Tango Track Pant', 'Unisex', 'pant', 'Performance', 'Slim training track pant with 3-stripes; Badge-of-Sport line.', ARRAY[]::text[], ARRAY['tango','track pant']::text[], 'https://theresaledoctor.com/adidas-style-number/', 0.85, true, 'migration:00392'),
  ('yeezy', 'Yeezy Season Basics', 'Unisex', 'top', 'Yeezy', 'Minimalist oversized tee/hoodie in muted earth tones (bone/ochre/black); NO visible logos; heavy cotton.', ARRAY[]::text[], ARRAY['yeezy','season','oversized']::text[], 'https://www.sneakerfreaker.com/news/adidas-three-stripe-equipment-trefoil-logo-history', 0.85, true, 'migration:00392'),
  ('yeezy', 'Yeezy Gap Round Jacket', 'Unisex', 'jacket', 'Yeezy Gap', 'Boxy cropped round puffer with dropped shoulders and no external branding; Yeezy Gap collab.', ARRAY[]::text[], ARRAY['yeezy gap','round jacket']::text[], 'https://www.sneakerfreaker.com/news/adidas-three-stripe-equipment-trefoil-logo-history', 0.85, true, 'migration:00392')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: adidas article-number decoder (PURE DATA) ────────────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('adidas', 'article_number', 'adidas article number: 2 letters + 4 digits on the inside-collar tag (e.g. GX1234)', '^(?<article>[A-Z]{1,2}[0-9]{4,5})$', $j${"fieldMap":{"article":"styleCode"},"confidence":0.8}$j$::jsonb, $j$[{"code":"GX1234","expected":{"styleCode":"GX1234"}}]$j$::jsonb, 'https://theresaledoctor.com/adidas-style-number/', 0.80, true, 'migration:00392')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00392') on conflict do nothing;
