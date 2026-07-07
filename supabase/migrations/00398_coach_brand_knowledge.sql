-- US-1726: Coach brand knowledge (LUXURY — never auto-authenticate).
--
-- Mostly bags/accessories. Value hinges on boutique-vs-outlet (F-prefix style
-- number = factory/outlet) + line (Signature canvas vs full-grain leather). The
-- creed/serial is an INFORMATIONAL tell only — the brand_knowledge tells state
-- explicitly that a code proves nothing and the KB must NEVER label a Coach item
-- authentic. Data-only, idempotent.

-- ── Enrich brand_knowledge: Coach (luxury — never auto-authenticate) ────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('coach', 'Coach', ARRAY['coach']::text[],
  ARRAY['handbags','accessories','leather']::text[],
  $j$[{"era":"creed","years":"all","description":"Inside creed patch / fabric tag carries a style number. Vintage creeds show \"No. NNNN-NNN\"; modern is F12345 (factory) or 12345 (boutique)."}]$j$::jsonb, $j$[{"tell":"Boutique vs outlet","detail":"An F-prefix style number (F12345), \"MFF\" (made-for-factory), or a matte dot-pattern lining signals a FACTORY/OUTLET item — typically lower value than a full-line boutique piece. INFORMATIONAL: a code alone does not authenticate."},{"tell":"NEVER auto-authenticate","detail":"A creed/serial proves NOTHING about authenticity on its own. Genuine determination needs construction, hardware weight, stitching and creed-font analysis. NEVER label a Coach item authentic — flag anything inconsistent in condition notes only."},{"tell":"Line","detail":"Signature = coated-canvas monogram (CC) print; full-grain / Glovetanned leather = higher-end, no monogram."}]$j$::jsonb,
  'Mostly bags/accessories. Value hinges on boutique-vs-outlet (F-prefix) + line (Signature canvas vs full-grain leather). NEVER auto-authenticate — surface tells only.',
  'https://www.yoogiscloset.com/authenticate/coach', 0.88, true, 'migration:00398')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Coach lines / bags ───────────────────────────────────────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('coach', 'Signature Canvas', 'Unisex', 'bag', 'Signature Canvas', 'Coated-canvas with the repeating CC / Signature monogram print; often jacquard.', ARRAY[]::text[], ARRAY['signature','canvas','monogram','cc']::text[], 'https://www.coach.com/', 0.85, true, 'migration:00398'),
  ('coach', 'Glovetanned Leather', 'Unisex', 'bag', 'Glovetanned Leather', 'Full-grain / pebbled Glovetanned leather, no monogram; higher-end full-line.', ARRAY[]::text[], ARRAY['leather','glovetanned','full grain']::text[], 'https://www.coach.com/', 0.85, true, 'migration:00398'),
  ('coach', 'Willis', 'Unisex', 'bag', 'Willis', 'Structured flap crossbody with a turnlock closure; heritage 1970s design.', ARRAY[]::text[], ARRAY['willis','flap','turnlock']::text[], 'https://www.coach.com/', 0.85, true, 'migration:00398'),
  ('coach', 'Rogue', 'Unisex', 'bag', 'Rogue', 'Structured satchel with rolled handles and a hangtag; premium modern line.', ARRAY[]::text[], ARRAY['rogue','satchel']::text[], 'https://www.coach.com/', 0.85, true, 'migration:00398'),
  ('coach', 'Tabby', 'Unisex', 'bag', 'Tabby', 'Shoulder bag with the archival turnlock; pillow-soft variants.', ARRAY[]::text[], ARRAY['tabby','shoulder','turnlock']::text[], 'https://www.coach.com/', 0.85, true, 'migration:00398')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Coach style-number decoder (boutique vs F-prefix outlet) ──
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('coach', 'style_number', 'Coach style number: F + digits = factory/outlet, bare digits = boutique (e.g. F12345, 12345)', '^(?<style>F?[0-9]{4,6})$', $j${"fieldMap":{"style":"styleCode"},"confidence":0.7}$j$::jsonb, $j$[{"code":"F12345","expected":{"styleCode":"F12345"}}]$j$::jsonb, 'https://www.yoogiscloset.com/authenticate/coach', 0.70, true, 'migration:00398')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00398') on conflict do nothing;
