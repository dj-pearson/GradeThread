-- US-1723: Patagonia brand knowledge.
--
-- Patagonia MODELS map to fabric technology — reading the insulation/fabric
-- disambiguates lookalike puffers (Nano Puff PrimaLoft synthetic vs Down Sweater
-- 800-fill down vs Micro Puff PlumaFill) and fleeces (Better Sweater vs R1 grid
-- vs Retro-X sherpa). 5-digit style-number decoder + a few persistent colorways.
-- Every fact source_url+confidence+verified. Data-only, idempotent.

-- ── Enrich brand_knowledge: Patagonia ───────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('patagonia', 'Patagonia', ARRAY['patagonia']::text[],
  ARRAY['outdoor','technical','insulation','fleece']::text[],
  $j$[{"era":"style number","years":"all","description":"5-digit style number on the care/hang tag; fabric-technology name (Nano Puff / Down Sweater / Better Sweater) identifies the model."}]$j$::jsonb, $j$[{"tell":"Style number","detail":"5-digit style number on the tag; each model has its own."},{"tell":"Insulation type","detail":"Nano Puff = PrimaLoft synthetic (matte, sewn-through brick baffles); Down Sweater = 800-fill goose DOWN (loftier, shinier, horizontal baffles); Micro Puff = PlumaFill (ultralight). Reading the fill disambiguates lookalike puffers."},{"tell":"Fair Trade / Ironclad","detail":"Fair Trade Certified sewing labels + the Ironclad Guarantee tag are Patagonia hallmarks."}]$j$::jsonb,
  'Model = fabric technology (Nano Puff synthetic vs Down Sweater down vs Better Sweater fleece); reading the insulation/fabric disambiguates lookalike jackets. 5-digit style number on the tag.',
  'https://www.patagonia.com/product-help/', 0.90, true, 'migration:00395')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Patagonia models (fabric-tech disambiguates puffers) ──────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('patagonia', 'Nano Puff', 'Unisex', 'jacket', 'Nano Puff', 'PrimaLoft synthetic-insulated jacket with SEWN-THROUGH rectangular brick baffles and a matte nylon shell; packs into its own chest pocket.', ARRAY['Nano Puff','PrimaLoft']::text[], ARRAY['nano puff','insulated','primaloft']::text[], 'https://www.switchbacktravel.com/reviews/patagonia-nano-puff-jacket', 0.85, true, 'migration:00395'),
  ('patagonia', 'Down Sweater', 'Unisex', 'jacket', 'Down Sweater', '800-fill goose DOWN jacket with horizontal quilted baffles and a slightly shinier shell; loftier/warmer than the Nano Puff.', ARRAY['800-fill down']::text[], ARRAY['down sweater','down','800 fill']::text[], 'https://www.switchbacktravel.com/reviews/patagonia-nano-puff-jacket', 0.85, true, 'migration:00395'),
  ('patagonia', 'Micro Puff', 'Unisex', 'jacket', 'Micro Puff', 'Ultralight PlumaFill synthetic jacket — very thin, quilted, minimal weight.', ARRAY['PlumaFill']::text[], ARRAY['micro puff','ultralight']::text[], 'https://www.switchbacktravel.com/reviews/patagonia-nano-puff-jacket', 0.85, true, 'migration:00395'),
  ('patagonia', 'Better Sweater', 'Unisex', 'top', 'Better Sweater', 'Sweater-knit-face fleece 1/4-zip or full-zip with a heathered look and a stand collar.', ARRAY['fleece']::text[], ARRAY['better sweater','fleece','quarter zip']::text[], 'https://www.patagonia.com/product-help/', 0.85, true, 'migration:00395'),
  ('patagonia', 'Retro-X', 'Unisex', 'jacket', 'Retro-X', 'Deep-pile sherpa/fleece jacket with contrast webbing trim and a windproof lining.', ARRAY['deep pile fleece']::text[], ARRAY['retro-x','sherpa','fleece']::text[], 'https://www.patagonia.com/product-help/', 0.85, true, 'migration:00395'),
  ('patagonia', 'R1', 'Unisex', 'top', 'R1', 'Grid-fleece (Regulator) pullover/hoody with a waffle-textured interior for breathable warmth.', ARRAY['grid fleece','Regulator']::text[], ARRAY['r1','grid fleece','regulator']::text[], 'https://www.patagonia.com/product-help/', 0.85, true, 'migration:00395'),
  ('patagonia', 'Baggies', 'Unisex', 'short', 'Baggies', 'Quick-dry nylon short with a mesh liner and elastic waist (5" or 7" inseam).', ARRAY[]::text[], ARRAY['baggies','short']::text[], 'https://www.patagonia.com/product-help/', 0.85, true, 'migration:00395')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_colorways: a few persistent Patagonia named colors ────────────────
insert into public.brand_colorways
  (brand_key, color_name, hex, source_url, confidence, verified, updated_by) values
  ('patagonia', 'Classic Navy', '#212a3d', 'https://www.patagonia.com/product-help/', 0.5, true, 'migration:00395'),
  ('patagonia', 'Black', '#000000', 'https://www.patagonia.com/product-help/', 0.5, true, 'migration:00395'),
  ('patagonia', 'Forge Grey', '#4a4a48', 'https://www.patagonia.com/product-help/', 0.5, true, 'migration:00395'),
  ('patagonia', 'New Navy', '#1f3350', 'https://www.patagonia.com/product-help/', 0.5, true, 'migration:00395')
on conflict (brand_key, color_name) do nothing;

-- ── brand_style_codes: Patagonia 5-digit style-number decoder ───────────────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('patagonia', 'style_number', 'Patagonia 5-digit style number printed on the care/hang tag (e.g. 84090)', '^(?<style>[0-9]{5})$', $j${"fieldMap":{"style":"styleCode"},"confidence":0.7}$j$::jsonb, $j$[{"code":"84090","expected":{"styleCode":"84090"}}]$j$::jsonb, 'https://www.patagonia.com/product-help/', 0.70, true, 'migration:00395')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00395') on conflict do nothing;
