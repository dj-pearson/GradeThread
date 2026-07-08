-- US-1725: Ralph Lauren brand knowledge (fingerprint + tell ONLY; no decoder).
--
-- RL has no reliable regular code (RN is generic), so the value story is the
-- SUB-LINE read from the label: Purple Label > RRL/Double RL > Polo Ralph Lauren
-- / Polo Sport > Lauren Ralph Lauren > Chaps. Sub-lines seeded as styles with
-- disambiguating fingerprints + the value-tier tell. Demonstrates a brand where
-- the KB helps purely via fingerprints/tells. Data-only, idempotent.

-- ── Enrich brand_knowledge: Ralph Lauren (sub-line taxonomy) ────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('ralphlauren', 'Ralph Lauren', ARRAY['ralphlauren','poloralphlauren']::text[],
  ARRAY['preppy','americana','tailoring','sportswear']::text[],
  $j$[{"era":"label","years":"all","description":"The sub-line is stitched on the label: Purple Label / RRL / Polo Ralph Lauren / Polo Sport / Lauren Ralph Lauren / Chaps. The wording IS the tier."}]$j$::jsonb, $j$[{"tell":"Sub-brand hierarchy","detail":"By label, high→low value: Purple Label > RRL (Double RL) > Polo Ralph Lauren / Polo Sport > Lauren Ralph Lauren > Chaps. The label wording IS the value tier — Chaps is NOT Polo Ralph Lauren."},{"tell":"Pony","detail":"The polo-player pony on the chest: a small pony is standard; a large \"Big Pony\" (often with a number) is a distinct line; multicolor/era ponies vary."},{"tell":"RN","detail":"RL apparel commonly carries RN 41381; the RN alone does not distinguish the sub-line — read the label wording."}]$j$::jsonb,
  'Value hinges on the SUB-LINE read from the label (Purple Label/RRL are high; Chaps is budget). No reliable code — identify the line by label wording + pony.',
  'https://www.heddels.com/2020/06/ralph-lauren-brand-breakdown/', 0.90, true, 'migration:00397')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Ralph Lauren sub-lines (value tier by label) ─────────────
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('ralphlauren', 'Purple Label', 'Unisex', 'top', 'Purple Label', 'Top LUXURY tailored line: "Purple Label" woven label, Italian-made tailoring; the highest tier.', ARRAY[]::text[], ARRAY['purple label','luxury','italy']::text[], 'https://www.heddels.com/2020/06/ralph-lauren-brand-breakdown/', 0.85, true, 'migration:00397'),
  ('ralphlauren', 'RRL (Double RL)', 'Unisex', 'top', 'RRL (Double RL)', 'Vintage-Americana / workwear line: "RRL" or "Double RL" label, distressed heritage denim & workwear; HIGH value / collectible.', ARRAY[]::text[], ARRAY['rrl','double rl','vintage','workwear']::text[], 'https://www.heddels.com/2020/06/ralph-lauren-brand-breakdown/', 0.85, true, 'migration:00397'),
  ('ralphlauren', 'Polo Ralph Lauren', 'Unisex', 'top', 'Polo Ralph Lauren', 'The mainstream line: embroidered polo-player pony + "Polo Ralph Lauren" label; Oxford shirts, mesh polos, chinos.', ARRAY[]::text[], ARRAY['polo','pony']::text[], 'https://www.ralphlauren.com/rl-brands', 0.85, true, 'migration:00397'),
  ('ralphlauren', 'Polo Sport', 'Unisex', 'top', 'Polo Sport', '''90s athletic sub-line: "Polo Sport" + the RL flag/spellout; vintage sportswear, collectible.', ARRAY[]::text[], ARRAY['polo sport','vintage','90s']::text[], 'https://www.heddels.com/2020/06/ralph-lauren-brand-breakdown/', 0.85, true, 'migration:00397'),
  ('ralphlauren', 'Lauren Ralph Lauren', 'Women', 'top', 'Lauren Ralph Lauren', 'Women''s mainstream department-store line: "Lauren Ralph Lauren" label; mid tier.', ARRAY[]::text[], ARRAY['lauren','womens']::text[], 'https://www.ralphlauren.com/rl-brands', 0.85, true, 'migration:00397'),
  ('ralphlauren', 'Chaps', 'Unisex', 'top', 'Chaps', 'Budget diffusion line: "Chaps" label (Ralph Lauren-owned); LOW value — do NOT confuse with Polo Ralph Lauren.', ARRAY[]::text[], ARRAY['chaps','budget']::text[], 'https://www.heddels.com/2020/06/ralph-lauren-brand-breakdown/', 0.85, true, 'migration:00397')
on conflict (brand_key, style_name, department) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00397') on conflict do nothing;
