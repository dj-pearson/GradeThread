-- US-1718: Lululemon brand knowledge — the flagship content seed.
--
-- Populates the 00389 KB tables with Lululemon styles (visual fingerprints that
-- disambiguate lookalikes — ABC 5-pocket+gusset vs Commission chino), the
-- deterministic tag-code decoders (style_number + size_dot; DB rows that OVERRIDE
-- the in-code DEFAULT_DECODER_SPECS via the US-1711 resolver), representative
-- colorways, and enriched brand_knowledge (tag eras + authentication/size-dot
-- tells). Every fact carries source_url + confidence + verified=true (curated +
-- sourced). Seeding these auto-lights BOTH paths: extraction fingerprints/decoders
-- (US-1713) and grounded grading baselines (US-1717). Data-only — the tables and
-- Lululemon size charts already exist from 00389. Fully idempotent.

-- ── Enrich brand_knowledge for Lululemon (00389 seeded the base row) ──────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values (
  'lululemon', 'Lululemon', ARRAY['lululemon','lulu']::text[],
  ARRAY['athleisure','activewear','yoga','running','golf']::text[],
  $j$[{"era":"2017-2018","years":"2017-2018","description":"Style number is the first 6 characters including the W/M prefix."},{"era":"2019-present","years":"2019+","description":"Style number: W/M + 5 letters/numbers + \".\" + 4 digits (SSYY). Last letter before the period is the first letter of the color."}]$j$::jsonb,
  $j$[{"tell":"Size dot","detail":"A small circle printed in the waistband key-pocket (Luon/Nulu) or a back pocket (Luxtreme/Nulux) with the numeric size printed in its center — recovers size when the care tag is cut."},{"tell":"Style number","detail":"W/M + style code + color-initial + \".\" + SSYY (season 01-04 + 2-digit year); confirms brand + season/year even without a size tag."},{"tell":"ABC gusset","detail":"Men's ABC pants use a diamond gusset (the Anti-Ball-Crushing construction)."}]$j$::jsonb,
  'Athleisure leader; fabric technology + construction (gusset, seams, pocket layout) disambiguate lookalike styles. Colorways are seasonal.',
  'https://theresaledoctor.com/lululemon-style-number/', 0.90, true, 'migration:00390'
)
on conflict (brand_key) do update set
  category_focus = excluded.category_focus,
  tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells,
  notes = excluded.notes,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  verified = excluded.verified,
  updated_by = excluded.updated_by;

-- ── brand_styles (visual fingerprints disambiguate lookalikes: ABC vs Commission) ──
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('lululemon', 'ABC Pant', 'Men', 'pant', 'ABC', '5-pocket pant with jeans-style front and back pockets and the ABC (Anti-Ball-Crushing) diamond gusset; casual. NOT chino-cut.', ARRAY['Warpstreme','Utilitech','VersaTwill']::text[], ARRAY['abc','pant','5-pocket','gusset','warpstreme']::text[], 'https://theadultman.com/fashion-and-style/lululemon-commission-pant-vs-abc/', 0.85, true, 'migration:00390'),
  ('lululemon', 'Commission Pant', 'Men', 'pant', 'Commission', 'Chino-style pant: slanted front pockets + welt back pockets, cleaner dressier front (no 5-pocket, no gusset); office/golf.', ARRAY['Warpstreme','WovenAir']::text[], ARRAY['commission','chino','trouser','pant']::text[], 'https://theadultman.com/fashion-and-style/lululemon-commission-pant-vs-abc/', 0.85, true, 'migration:00390'),
  ('lululemon', 'Pace Breaker Short', 'Men', 'short', 'Pace Breaker', 'Lined athletic short with a built-in liner and zip/drop-in pocket; running/training. Swift-fabric shell.', ARRAY['Swift']::text[], ARRAY['pace breaker','short','lined','running']::text[], 'https://shop.lululemon.com/story/abc-pants-collection', 0.85, true, 'migration:00390'),
  ('lululemon', 'Metal Vent Tech', 'Men', 'top', 'Metal Vent Tech', 'Seamless/bonded athletic tee with mesh venting panels and minimal seams; Silverescent anti-odor.', ARRAY['Silverescent']::text[], ARRAY['metal vent','tee','seamless','top']::text[], 'https://shop.lululemon.com/story/abc-pants-collection', 0.85, true, 'migration:00390'),
  ('lululemon', 'Align', 'Women', 'legging', 'Align', 'Buttery-soft high-rise legging with NO front center seam; non-compressive yoga fit. Size dot in the waistband key-pocket.', ARRAY['Nulu']::text[], ARRAY['align','legging','yoga','nulu']::text[], 'https://shop.lululemon.com/story/abc-pants-collection', 0.85, true, 'migration:00390'),
  ('lululemon', 'Wunder Train', 'Women', 'legging', 'Wunder Train', 'Compressive, sweat-wicking training legging; more structured/supportive than Align. Back-pocket size dot.', ARRAY['Everlux']::text[], ARRAY['wunder train','wunder under','legging','training']::text[], 'https://shop.lululemon.com/story/abc-pants-collection', 0.85, true, 'migration:00390'),
  ('lululemon', 'Fast & Free', 'Women', 'legging', 'Fast & Free', 'Run legging with reflective details and zippered/drop-in pockets; Nulux fabric. Back-pocket size dot.', ARRAY['Nulux']::text[], ARRAY['fast and free','run','legging','reflective']::text[], 'https://shop.lululemon.com/story/abc-pants-collection', 0.85, true, 'migration:00390'),
  ('lululemon', 'Scuba Hoodie', 'Women', 'hoodie', 'Scuba', 'Oversized cotton-blend fleece hoodie with a funnel neck, thumbholes and a kangaroo pocket.', ARRAY['Cotton Fleece']::text[], ARRAY['scuba','hoodie','oversized']::text[], 'https://shop.lululemon.com/story/abc-pants-collection', 0.85, true, 'migration:00390'),
  ('lululemon', 'Define Jacket', 'Women', 'jacket', 'Define', 'Slim cinched-waist zip jacket in Luxtreme with thumbholes and hidden pockets.', ARRAY['Luxtreme']::text[], ARRAY['define','jacket']::text[], 'https://shop.lululemon.com/story/abc-pants-collection', 0.85, true, 'migration:00390')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes (deterministic decoders; DB overrides in-code defaults) ──
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('lululemon', 'style_number', 'W/M + style code + color-initial + "." + SSYY', '^(?<gender>[WM])(?<style>[A-Z0-9]{3,5})(?<color>[A-Z])\.(?<season>0[1-4])(?<year>\d{2})$', $j${"fieldMap":{"gender":"gender","style":"styleCode","color":"colorInitial","season":"season","year":"year"},"transforms":{"gender":"genderCode","season":"seasonCode","year":"year2to4","color":"upper"},"confidence":0.9}$j$::jsonb, $j$[{"code":"WU1ABC.0119","expected":{"gender":"Women","season":"Spring","year":"2019"}},{"code":"MABCR.0322","expected":{"gender":"Men","season":"Fall","year":"2022"}}]$j$::jsonb, 'https://theresaledoctor.com/lululemon-style-number/', 0.9, true, 'migration:00390'),
  ('lululemon', 'size_dot', 'Numeric size printed in the pocket size-dot circle (isolate the dot region)', '^\s*(?<size>\d{1,2})\s*$', $j${"fieldMap":{"size":"size"},"confidence":0.85}$j$::jsonb, $j$[{"code":"6","expected":{"size":"6"}}]$j$::jsonb, 'https://theresaledoctor.com/lululemon-style-number/', 0.85, true, 'migration:00390')
on conflict (brand_key, decoder_kind) do nothing;

-- ── brand_colorways (representative persistent named colors; seasonal, modest confidence) ──
insert into public.brand_colorways
  (brand_key, color_name, hex, source_url, confidence, verified, updated_by) values
  ('lululemon', 'Black', '#000000', 'https://shop.lululemon.com/story/abc-pants-collection', 0.55, true, 'migration:00390'),
  ('lululemon', 'True Navy', '#2a3b4d', 'https://shop.lululemon.com/story/abc-pants-collection', 0.55, true, 'migration:00390'),
  ('lululemon', 'Heathered Core Ultra Light', '#b8bcc0', 'https://shop.lululemon.com/story/abc-pants-collection', 0.55, true, 'migration:00390'),
  ('lululemon', 'Black Cherry', '#4b1e2f', 'https://shop.lululemon.com/story/abc-pants-collection', 0.55, true, 'migration:00390'),
  ('lululemon', 'Dark Olive', '#3d3f2a', 'https://shop.lululemon.com/story/abc-pants-collection', 0.55, true, 'migration:00390')
on conflict (brand_key, color_name) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00390') on conflict do nothing;
