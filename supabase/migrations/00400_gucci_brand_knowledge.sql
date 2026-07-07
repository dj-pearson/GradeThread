-- US-1728: Gucci brand knowledge (LUXURY — never auto-authenticate).
--
-- Model line = canvas/leather (GG Supreme coated canvas vs Guccissima embossed
-- leather vs Marmont chevron-quilted vs Ophidia Web-stripe). The style-number
-- decoder captures the 6-digit model number (informational only). Heavy
-- counterfeit risk: tells state a serial proves nothing; NEVER label a Gucci item
-- authentic. Data-only, idempotent.

-- ── brand_knowledge: Gucci (LUXURY — never auto-authenticate) ──────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('gucci', 'Gucci', ARRAY['gucci']::text[],
  ARRAY['luxury','handbags','leather']::text[],
  $j$[{"era":"serial","years":"all","description":"Interior leather tab: top row = 6-digit style/model number, bottom row = 4-digit supplier code."}]$j$::jsonb, $j$[{"tell":"Serial (style + supplier)","detail":"Two numbers on the interior tab identify the MODEL (6-digit style) + supplier (4-digit) — NOT authenticity."},{"tell":"NEVER auto-authenticate","detail":"Gucci is heavily counterfeited. A serial, logo, or Web stripe alone NEVER proves authenticity — needs hardware engraving, font, stitching and canvas/leather analysis. NEVER label a Gucci item authentic; flag inconsistencies in condition notes only."},{"tell":"Line identifies the model","detail":"GG Supreme (coated canvas) vs Guccissima (embossed GG leather) vs Marmont (chevron-quilted leather + antique-gold double-G) vs Ophidia (GG canvas + green-red-green Web + round logo)."}]$j$::jsonb,
  'Model line = canvas/leather (GG Supreme vs Guccissima vs Marmont vs Ophidia). The serial identifies the model, not authenticity. Heavy counterfeit risk — NEVER auto-authenticate.',
  'https://www.yoogiscloset.com/authenticate/gucci', 0.88, true, 'migration:00400')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Gucci lines / canvases ───────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('gucci', 'GG Supreme', 'Unisex', 'bag', 'GG Supreme', 'Beige/ebony GG-monogram COATED CANVAS with a subtle diamond pattern.', ARRAY[]::text[], ARRAY['gg supreme','monogram','canvas']::text[], 'https://www.gucci.com/', 0.85, true, 'migration:00400'),
  ('gucci', 'Guccissima', 'Unisex', 'bag', 'Guccissima', 'Embossed GG-monogram LEATHER (tone-on-tone GG pressed into the leather).', ARRAY[]::text[], ARRAY['guccissima','embossed','leather']::text[], 'https://www.gucci.com/', 0.85, true, 'migration:00400'),
  ('gucci', 'Marmont', 'Unisex', 'bag', 'Marmont', 'Matelasse CHEVRON-quilted leather with antique-gold double-G (Marmont) hardware.', ARRAY[]::text[], ARRAY['marmont','chevron','double g']::text[], 'https://www.gucci.com/', 0.85, true, 'migration:00400'),
  ('gucci', 'Ophidia', 'Unisex', 'bag', 'Ophidia', 'GG Supreme canvas with the green-red-green Web stripe + a round interlocking-G logo.', ARRAY[]::text[], ARRAY['ophidia','web stripe','round logo']::text[], 'https://www.gucci.com/', 0.85, true, 'migration:00400'),
  ('gucci', 'Web Stripe', 'Unisex', 'bag', 'Web Stripe', 'The signature green-red-green (or blue-red-blue) Web stripe trim.', ARRAY[]::text[], ARRAY['web','stripe']::text[], 'https://www.gucci.com/', 0.85, true, 'migration:00400')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Gucci style-number decoder (informational only) ──────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('gucci', 'style_number', 'Gucci style/model number: 6 digits on the interior leather tab (supplier code is a separate 4-digit row)', '^(?<style>[0-9]{6})$', $j${"fieldMap":{"style":"styleCode"},"confidence":0.6}$j$::jsonb, $j$[{"code":"123456","expected":{"styleCode":"123456"}}]$j$::jsonb, 'https://www.yoogiscloset.com/authenticate/gucci', 0.60, true, 'migration:00400')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00400') on conflict do nothing;
