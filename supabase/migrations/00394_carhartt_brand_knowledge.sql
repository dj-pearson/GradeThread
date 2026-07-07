-- US-1722: Carhartt & Carhartt WIP brand knowledge.
--
-- Carhartt is disambiguated by SILHOUETTE (Detroit fitted+corduroy-collar vs Chore
-- longer+button-front vs Active Jac hooded) and the mainline-vs-WIP split (Carhartt
-- WIP = pricier European streetwear line, distinct brand_knowledge row). Classic
-- style code (letter+digits, B01/J140/K87) decoder seeded as pure data; modern
-- 6-digit codes noted in tells. Every fact source_url+confidence+verified.
-- Data-only, idempotent.

-- ── Enrich brand_knowledge: Carhartt + Carhartt WIP ───────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('carhartt', 'Carhartt', ARRAY['carhartt']::text[], ARRAY['workwear','duck','americana','outerwear']::text[], $j$[{"era":"style code","years":"all","description":"Style number on/near the care label — classic letter+digit (B01, J140, K87) or modern 6-digit (e.g. 103828)."},{"era":"union label","years":"vintage","description":"Vintage Carhartt carries a union-made tag; the \"Carhartt\" script + \"Est. 1889\" evolves across eras."}]$j$::jsonb, $j$[{"tell":"Style code","detail":"Classic letter+digit (B01 dungaree, J140/J97 Detroit, K87 tee) or modern 6-digit (103828) style number."},{"tell":"Carhartt vs Carhartt WIP","detail":"Mainline = boxy/stiff duck, function-first, \"Carhartt\" script logo. Carhartt WIP (European Work In Progress) = tailored/narrower fit, refined fabrics, square \"C\" label, 2-3x price — a DISTINCT, pricier line."},{"tell":"Duck canvas","detail":"Stiff dry duck canvas (mainline) breaks in over years; brass hardware."}]$j$::jsonb, 'Silhouette disambiguates (Detroit fitted+corduroy-collar vs Chore longer+button-front vs Active Jac hooded); the WIP-vs-mainline distinction is a major value split. Style code on the care tag.', 'https://edwinvonholy.com/2024/11/14/carhartt-detroit-jacket-vs-carhartt-chore-coat-key-differences-explained/', 0.88, true, 'migration:00394')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('carharttwip', 'Carhartt WIP', ARRAY['carharttwip','carhartt wip','wip']::text[], ARRAY['streetwear','workwear-inspired']::text[], $j$[]$j$::jsonb, $j$[{"tell":"Square C label","detail":"Carhartt WIP uses a small square \"C\" woven label + \"Carhartt WIP\" wordmark; tailored streetwear fit, refined fabrics, priced 2-3x mainline."}]$j$::jsonb, 'European streetwear reinterpretation of Carhartt workwear — distinct, pricier line (2-3x mainline); tailored fit, square "C" label.', 'https://takoutny.com/blogs/article/carhartt-vs-carhartt-wip-what-is-the-real-difference', 0.88, true, 'migration:00394')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Carhartt silhouettes (Detroit vs Chore vs Active Jac) ─────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('carhartt', 'Detroit Jacket', 'Unisex', 'jacket', 'Workwear', 'Shorter, fitted blanket-lined duck jacket with a CORDUROY collar and front zip; mobility-focused, sits at the waist. (J97/J001)', ARRAY[]::text[], ARRAY['detroit','jacket','blanket lined','corduroy collar']::text[], 'https://edwinvonholy.com/2024/11/14/carhartt-detroit-jacket-vs-carhartt-chore-coat-key-differences-explained/', 0.85, true, 'migration:00394'),
  ('carhartt', 'Chore Coat', 'Unisex', 'jacket', 'Workwear', 'Longer duck chore coat (mid-thigh), BUTTON front, three front pockets — more coverage than the Detroit. (Michigan)', ARRAY[]::text[], ARRAY['chore','coat','michigan','button front']::text[], 'https://edwinvonholy.com/2024/11/14/carhartt-detroit-jacket-vs-carhartt-chore-coat-key-differences-explained/', 0.85, true, 'migration:00394'),
  ('carhartt', 'Active Jac', 'Unisex', 'jacket', 'Workwear', 'HOODED firm-duck jacket with a kangaroo pocket, heavy-duty zipper and quilt/sherpa lining; Carhartt''s best-seller. (J130/J131)', ARRAY[]::text[], ARRAY['active jac','hooded','duck','sherpa']::text[], 'https://edwinvonholy.com/2024/11/14/carhartt-detroit-jacket-vs-carhartt-chore-coat-key-differences-explained/', 0.85, true, 'migration:00394'),
  ('carhartt', 'Duck Bib Overall', 'Unisex', 'overall', 'Workwear', 'Duck bib overalls with adjustable straps, a hammer loop and multiple utility pockets. (R01)', ARRAY[]::text[], ARRAY['bib','overall','duck']::text[], 'https://companygear.carhartt.com/ProductSafetyView?storeId=10201', 0.85, true, 'migration:00394'),
  ('carhartt', 'Loose Fit Heavyweight T-Shirt', 'Unisex', 'top', 'Workwear', 'Heavyweight workwear pocket tee with a chest pocket and the Carhartt logo tag. (K87)', ARRAY[]::text[], ARRAY['k87','tee','pocket']::text[], 'https://companygear.carhartt.com/ProductSafetyView?storeId=10201', 0.85, true, 'migration:00394'),
  ('carhartt', 'Washed Duck Work Dungaree', 'Unisex', 'pant', 'Workwear', 'Double-knee duck work pant with utility/hammer pockets. (B01/B136)', ARRAY[]::text[], ARRAY['b01','dungaree','double knee']::text[], 'https://companygear.carhartt.com/ProductSafetyView?storeId=10201', 0.85, true, 'migration:00394')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Carhartt classic style-code decoder ─────────────────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('carhartt', 'style_number', 'Carhartt classic style code: letter(s) + 2-3 digits (B01, J140, K87)', '^(?<style>[A-Z]{1,2}[0-9]{2,3})$', $j${"fieldMap":{"style":"styleCode"},"confidence":0.75}$j$::jsonb, $j$[{"code":"J140","expected":{"styleCode":"J140"}}]$j$::jsonb, 'https://companygear.carhartt.com/ProductSafetyView?storeId=10201', 0.75, true, 'migration:00394')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00394') on conflict do nothing;
