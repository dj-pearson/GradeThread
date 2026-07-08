-- US-1727: Louis Vuitton brand knowledge (LUXURY — never auto-authenticate).
--
-- Model line = canvas pattern (Monogram vs Damier Ebene vs Azur vs Empreinte vs
-- Epi). The date-code decoder CONFIRMS the 2-letter+4-digit format + captures it
-- but identifies factory/era ONLY (gone since March 2021 -> microchip). EXTREME
-- counterfeit risk: brand_knowledge tells state a code proves nothing and the KB
-- must NEVER label an LV item authentic. New brand_knowledge row. Data-only.

-- ── brand_knowledge: Louis Vuitton (LUXURY — never auto-authenticate) ───────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('louisvuitton', 'Louis Vuitton', ARRAY['louisvuitton','lv','vuitton']::text[],
  ARRAY['luxury','handbags','leather']::text[],
  $j$[{"era":"date code","years":"pre-2021","description":"2-letter + 4-digit date code inside the bag (factory letters + week/year; the digit meaning changed across eras)."},{"era":"microchip","years":"2021-present","description":"From March 2021 the printed date code was replaced by an embedded RFID MICROCHIP — no visible code on newer items."}]$j$::jsonb, $j$[{"tell":"Date code / microchip","detail":"A pre-2021 date code identifies FACTORY + ERA only, NOT the model, and proves NOTHING about authenticity. Post-March-2021 items use a hidden microchip (no printed code) — absence of a date code on a newer bag is normal."},{"tell":"NEVER auto-authenticate","detail":"LV has extreme counterfeit volume. A date code, heat stamp, or logo alone NEVER proves authenticity — determination needs construction, hardware, canvas/pattern alignment, stitch count and (post-2021) chip verification. NEVER label an LV item authentic; flag inconsistencies in condition notes only."},{"tell":"Canvas identifies the line","detail":"Monogram (brown LV + floral) vs Damier Ebene (dark checkerboard) vs Damier Azur (light blue/white check) vs Empreinte (embossed-monogram leather) vs Epi (ridged leather)."}]$j$::jsonb,
  'Model line = canvas pattern; the date code confirms factory/era only (gone since March 2021 -> microchip). EXTREME counterfeit risk — NEVER auto-authenticate; a code proves nothing.',
  'https://www.yoogiscloset.com/authenticate/louis-vuitton', 0.88, true, 'migration:00399')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: LV canvases / lines ──────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('louisvuitton', 'Monogram', 'Unisex', 'bag', 'Monogram', 'The classic LV Monogram coated canvas: repeating LV initials + flower/quatrefoil motifs in brown.', ARRAY[]::text[], ARRAY['monogram','canvas','lv']::text[], 'https://us.louisvuitton.com/', 0.85, true, 'migration:00399'),
  ('louisvuitton', 'Damier Ebene', 'Unisex', 'bag', 'Damier Ebene', 'Dark brown & black checkerboard coated canvas.', ARRAY[]::text[], ARRAY['damier','ebene','checkerboard']::text[], 'https://us.louisvuitton.com/', 0.85, true, 'migration:00399'),
  ('louisvuitton', 'Damier Azur', 'Unisex', 'bag', 'Damier Azur', 'Light blue & white checkerboard coated canvas.', ARRAY[]::text[], ARRAY['damier azur','checkerboard','azur']::text[], 'https://us.louisvuitton.com/', 0.85, true, 'migration:00399'),
  ('louisvuitton', 'Empreinte', 'Unisex', 'bag', 'Empreinte', 'Embossed-monogram supple calfskin leather (the monogram is pressed into the leather).', ARRAY[]::text[], ARRAY['empreinte','leather','embossed']::text[], 'https://us.louisvuitton.com/', 0.85, true, 'migration:00399'),
  ('louisvuitton', 'Epi', 'Unisex', 'bag', 'Epi', 'Textured/ridged Epi leather, no printed monogram; LV embossed at the base.', ARRAY[]::text[], ARRAY['epi','leather','textured']::text[], 'https://us.louisvuitton.com/', 0.85, true, 'migration:00399')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: LV date-code FORMAT decoder (informational only) ─────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('louisvuitton', 'date_code', 'Louis Vuitton date code: 2 factory letters + 4 digits (pre-March-2021; e.g. SD1160)', '^(?<code>[A-Z]{2}[0-9]{4})$', $j${"fieldMap":{"code":"styleCode"},"confidence":0.6}$j$::jsonb, $j$[{"code":"SD1160","expected":{"styleCode":"SD1160"}}]$j$::jsonb, 'https://www.yoogiscloset.com/authenticate/louis-vuitton', 0.60, true, 'migration:00399')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00399') on conflict do nothing;
