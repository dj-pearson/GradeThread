-- US-1724: The North Face brand knowledge.
--
-- TNF MODELS map to fabric technology — down vs synthetic vs fleece disambiguates
-- lookalikes (Nuptse 700-fill down vs ThermoBall synthetic vs Denali Polartec
-- fleece). Summit Series marks the premium technical line (value signal). Modern
-- NF0A style-code decoder (pure data). Every fact source_url+confidence+verified.
-- Data-only, idempotent.

-- ── Enrich brand_knowledge: The North Face ─────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('thenorthface', 'The North Face', ARRAY['northface','thenorthface','tnf']::text[],
  ARRAY['outdoor','technical','insulation','fleece']::text[],
  $j$[{"era":"style code","years":"modern","description":"Modern style code begins \"NF0A\" (e.g. NF0A3XY3) on the woven tag; older items used a shorter style number."}]$j$::jsonb, $j$[{"tell":"Style code","detail":"Modern TNF style code starts with \"NF0A\". A precise product key."},{"tell":"Down vs synthetic","detail":"Nuptse = 700-fill DOWN puffer (horizontal baffles); ThermoBall = synthetic (small round baffles mimicking down); Denali = Polartec FLEECE. Reading the fill/fabric disambiguates lookalikes."},{"tell":"Summit Series vs mainline","detail":"A \"Summit Series\" label = the premium technical (Gore-Tex/pro) line, distinct from mainline lifestyle pieces — a value signal."}]$j$::jsonb,
  'Model = fabric technology (Nuptse down vs ThermoBall synthetic vs Denali fleece); Summit Series marks the premium technical line. Style code begins NF0A.',
  'https://www.thenorthface.com/en-us/help', 0.90, true, 'migration:00396')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: TNF models (down vs synthetic vs fleece) + Summit Series ──
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('thenorthface', 'Nuptse', 'Unisex', 'jacket', 'Nuptse', 'Boxy 700-fill DOWN puffer with horizontal baffles and an elastic hem; the iconic ''96 Retro Nuptse silhouette.', ARRAY['700-fill down']::text[], ARRAY['nuptse','down','700 fill']::text[], 'https://www.switchbacktravel.com/reviews/north-face-nuptse', 0.85, true, 'migration:00396'),
  ('thenorthface', 'Denali', 'Unisex', 'jacket', 'Denali', 'Polartec FLEECE jacket with reinforced nylon overlays on the shoulders, chest and elbows; full zip.', ARRAY['Polartec']::text[], ARRAY['denali','fleece','polartec']::text[], 'https://www.thenorthface.com/en-us/help', 0.85, true, 'migration:00396'),
  ('thenorthface', 'ThermoBall', 'Unisex', 'jacket', 'ThermoBall', 'ThermoBall SYNTHETIC-insulated jacket with small round baffles mimicking down; matte shell.', ARRAY['ThermoBall']::text[], ARRAY['thermoball','synthetic']::text[], 'https://www.thenorthface.com/en-us/help', 0.85, true, 'migration:00396'),
  ('thenorthface', 'Osito', 'Women', 'jacket', 'Osito', 'Soft high-pile fuzzy fleece jacket with a princess-seam fit; women''s staple.', ARRAY[]::text[], ARRAY['osito','fleece','fuzzy']::text[], 'https://www.thenorthface.com/en-us/help', 0.85, true, 'migration:00396'),
  ('thenorthface', 'Apex', 'Unisex', 'jacket', 'Apex', 'Apex softshell: bonded stretch-woven windproof jacket.', ARRAY[]::text[], ARRAY['apex','softshell']::text[], 'https://www.thenorthface.com/en-us/help', 0.85, true, 'migration:00396'),
  ('thenorthface', 'McMurdo Parka', 'Unisex', 'jacket', 'McMurdo Parka', 'Long DOWN parka with a faux-fur-trimmed hood; heavy winter coverage.', ARRAY['down']::text[], ARRAY['mcmurdo','parka']::text[], 'https://www.thenorthface.com/en-us/help', 0.85, true, 'migration:00396'),
  ('thenorthface', 'Summit Series', 'Unisex', 'jacket', 'Summit Series', 'Premium technical line marked "Summit Series" — Gore-Tex/pro fabrics; distinct from mainline lifestyle pieces.', ARRAY['Gore-Tex']::text[], ARRAY['summit series','gore-tex']::text[], 'https://www.thenorthface.com/en-us/help', 0.85, true, 'migration:00396')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: TNF NF0A style-code decoder ─────────────────────────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('thenorthface', 'style_number', 'The North Face style code — NF0A + alphanumeric (e.g. NF0A3XY3)', '^(?<style>NF[0-9A-Z]{6,8})$', $j${"fieldMap":{"style":"styleCode"},"confidence":0.8}$j$::jsonb, $j$[{"code":"NF0A3XY3","expected":{"styleCode":"NF0A3XY3"}}]$j$::jsonb, 'https://www.thenorthface.com/en-us/help', 0.80, true, 'migration:00396')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00396') on conflict do nothing;
