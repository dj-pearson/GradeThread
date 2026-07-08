-- US-1719: Nike & Jordan brand knowledge (second reference brand).
--
-- Adds Nike + Jordan content to the 00389 KB tables. KEY POINT: the Nike style
-- number is a DIFFERENT format (6-char + dash + 3-digit colorway, CW1234-001) and
-- its decoder is seeded as PURE DATA (a brand_style_codes regex + fieldMap, NO
-- new transform) — proving the US-1712 engine generalizes to a new brand format
-- via data alone. Jordan (by Nike) shares the format. Line fingerprints (Tech
-- Fleece bonded double-knit vs Club Fleece brushed cotton) disambiguate the
-- common Nike mis-ID. Every fact source_url+confidence+verified. Data-only,
-- idempotent; tables + Nike size charts exist from 00389.

-- ── Enrich brand_knowledge: Nike + Jordan ───────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('nike', 'Nike', ARRAY['nike']::text[], ARRAY['athletic','activewear','sportswear','running','basketball']::text[], $j$[{"era":"style-number","years":"all","description":"Nike style number = 6-char style code + \"-\" + 3-digit colorway code (CW1234-001)."}]$j$::jsonb, $j$[{"tell":"Style number","detail":"6-char style code + \"-\" + 3-digit colorway on the woven/care tag; a precise product+colorway key (the same code returns the same product). Colorway first digit ≈ base color family (0 black, 1 white, 4 blue, 6 red, 9 multi)."},{"tell":"Line vs brand","detail":"Dri-FIT / Tech Fleece / Therma-FIT / ACG are technology/line LABELS, not the brand — put them in style, never brand."}]$j$::jsonb, 'Line/technology (Tech Fleece vs Club Fleece, Dri-FIT vs cotton) + construction disambiguate; the style number is a precise product key. Colorways are per-product numeric codes, not reused named colors.', 'https://theresaledoctor.com/nike-style-number/', 0.88, true, 'migration:00391')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('jordan', 'Jordan', ARRAY['jordan','airjordan']::text[], ARRAY['basketball','streetwear','athletic']::text[], $j$[{"era":"style-number","years":"all","description":"Nike style number = 6-char style code + \"-\" + 3-digit colorway code (CW1234-001)."}]$j$::jsonb, $j$[{"tell":"Jumpman","detail":"The Jumpman (MJ silhouette) marks Jordan; Jordan apparel is made by Nike and shares the Nike style-number format."}]$j$::jsonb, 'Jordan (by Nike) — Jumpman branding; shares the Nike style-number format.', 'https://theresaledoctor.com/nike-style-number/', 0.88, true, 'migration:00391')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Nike lines (Tech vs Club fleece) + Jordan ─────────────────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('nike', 'Tech Fleece', 'Unisex', 'top', 'Sportswear', 'Bonded lightweight double-knit fleece with a smooth face, articulated seams, zip pockets and a fitted silhouette; often "TECH FLEECE" printed. NOT plain brushed fleece.', ARRAY['Tech Fleece']::text[], ARRAY['tech fleece','hoodie','joggers']::text[], 'https://shoestringforum.com/nike-tech-fleece-vs-club-fleece-get-to-know-which-is-right-for-you/', 0.85, true, 'migration:00391'),
  ('nike', 'Club Fleece', 'Unisex', 'top', 'Sportswear', 'Heavier classic brushed-back cotton-blend fleece; relaxed casual hoodie/crew with no bonded panels.', ARRAY['Club Fleece']::text[], ARRAY['club fleece','hoodie','crew']::text[], 'https://shoestringforum.com/nike-tech-fleece-vs-club-fleece-get-to-know-which-is-right-for-you/', 0.85, true, 'migration:00391'),
  ('nike', 'Therma-FIT', 'Unisex', 'top', 'Sportswear', 'Thermal training fleece with Therma-FIT branding and a brushed interior for warmth retention.', ARRAY['Therma-FIT']::text[], ARRAY['therma','thermafit','training']::text[], 'https://trussarchive.com/guides/how-to-identify-nike-clothing', 0.85, true, 'migration:00391'),
  ('nike', 'Dri-FIT', 'Unisex', 'top', 'Sportswear', 'Moisture-wicking performance tee/polo with Dri-FIT branding and a smooth technical knit.', ARRAY['Dri-FIT']::text[], ARRAY['dri-fit','tee','performance']::text[], 'https://trussarchive.com/guides/how-to-identify-nike-clothing', 0.85, true, 'migration:00391'),
  ('nike', 'Windrunner', 'Unisex', 'jacket', 'Sportswear', 'Chevron color-block front panel, hooded lightweight running jacket.', ARRAY[]::text[], ARRAY['windrunner','jacket']::text[], 'https://trussarchive.com/guides/how-to-identify-nike-clothing', 0.85, true, 'migration:00391'),
  ('nike', 'ACG', 'Unisex', 'jacket', 'ACG', 'All Conditions Gear technical outerwear: ACG logo, utility pockets, weather-ready shell.', ARRAY[]::text[], ARRAY['acg','outdoor','jacket']::text[], 'https://trussarchive.com/guides/how-to-identify-nike-clothing', 0.85, true, 'migration:00391'),
  ('jordan', 'Jumpman Fleece', 'Unisex', 'top', 'Jordan', 'Jumpman-logo fleece hoodie/crew with Flight/Jordan branding; streetwear weight.', ARRAY[]::text[], ARRAY['jordan','jumpman','fleece']::text[], 'https://trussarchive.com/guides/how-to-identify-nike-clothing', 0.85, true, 'migration:00391'),
  ('jordan', 'Jordan Flight', 'Unisex', 'top', 'Jordan', 'Flight-branded tee/fleece with the Jumpman silhouette.', ARRAY[]::text[], ARRAY['jordan','flight']::text[], 'https://trussarchive.com/guides/how-to-identify-nike-clothing', 0.85, true, 'migration:00391')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Nike style-number decoder (PURE DATA — no new transform) ──
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('nike', 'style_number', 'Nike style number: 6-char style code + "-" + 3-digit colorway code (e.g. CW1234-001)', '^(?<style>[A-Z0-9]{6})-(?<colorway>[0-9]{3})$', $j${"fieldMap":{"style":"styleCode","colorway":"colorway"},"confidence":0.85}$j$::jsonb, $j$[{"code":"CW1234-001","expected":{"styleCode":"CW1234","colorway":"001"}}]$j$::jsonb, 'https://theresaledoctor.com/nike-style-number/', 0.85, true, 'migration:00391'),
  ('jordan', 'style_number', 'Nike style number: 6-char style code + "-" + 3-digit colorway code (e.g. CW1234-001)', '^(?<style>[A-Z0-9]{6})-(?<colorway>[0-9]{3})$', $j${"fieldMap":{"style":"styleCode","colorway":"colorway"},"confidence":0.85}$j$::jsonb, $j$[{"code":"CW1234-001","expected":{"styleCode":"CW1234","colorway":"001"}}]$j$::jsonb, 'https://theresaledoctor.com/nike-style-number/', 0.85, true, 'migration:00391')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00391') on conflict do nothing;
