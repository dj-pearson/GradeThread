-- US-1721: Levi's brand knowledge (fingerprint + era-dating heavy).
--
-- Levi's is identified by the FIT number on the back patch (501 button-fly vs 505
-- zip-fly vs 511 slim) + the red-tab ERA (Big E = pre-1971 vintage) + the WxL
-- patch. Fits are seeded as brand_styles with disambiguating fingerprints; the
-- decoder is a brand-scoped 5NN fit-number lookup (modest confidence — a fit
-- number, brand already known). Era/authentication live in brand_knowledge
-- tells. Every fact source_url+confidence+verified. Data-only, idempotent.

-- ── Enrich brand_knowledge: Levi's ─────────────────────────────────────────
insert into public.brand_knowledge
  (brand_key, canonical_brand, aliases, category_focus, tag_eras, authentication_tells, notes, source_url, confidence, verified, updated_by)
values ('levis', 'Levi''s', ARRAY['levi','levis','levistrauss','levistraussco']::text[],
  ARRAY['denim','americana','jeans','workwear']::text[],
  $j$[{"era":"Big E","years":"pre-1971","description":"Red tab reads LEVI'S with a CAPITAL E (\"Big E\") — made before 1971; higher vintage value."},{"era":"small e","years":"1971-present","description":"Red tab reads LeVI'S (only the L capitalized, \"small e\") — 1971 onward."},{"era":"patch","years":"all","description":"The back-waist patch shows the FIT number (501/505/511…) and the WxL size; leather patch = older, jacron/paper = newer."}]$j$::jsonb, $j$[{"tell":"Red tab","detail":"Big E (all-caps LEVI'S) = pre-1971 vintage; small e = 1971+. A key dating + value signal."},{"tell":"Back patch","detail":"Fit number + WxL size on the back-waist patch; leather patch is older than the jacron/paper patch."},{"tell":"Selvedge","detail":"A clean self-finished (selvedge) outseam with a colored line indicates premium/vintage denim (LVC)."}]$j$::jsonb,
  'Fit is identified by the 5NN number on the back patch; vintage value hinges on the red-tab era (Big E) + patch/selvedge. WxL is on the patch.',
  'https://www.heddels.com/dictionary/big-e/', 0.90, true, 'migration:00393')
on conflict (brand_key) do update set
  category_focus = excluded.category_focus, tag_eras = excluded.tag_eras,
  authentication_tells = excluded.authentication_tells, notes = excluded.notes,
  source_url = excluded.source_url, confidence = excluded.confidence,
  verified = excluded.verified, updated_by = excluded.updated_by;

-- ── brand_styles: Levi's fits (button-fly 501 vs zip-fly 505 vs slim 511) + Trucker ──
insert into public.brand_styles
  (brand_key, style_name, department, category, product_line, visual_fingerprint, fabric_tech, keywords, source_url, confidence, verified, updated_by) values
  ('levis', '501', 'Men', 'jeans', 'Red Tab', 'Original Straight: BUTTON FLY, higher rise, straight leg; the iconic 5-pocket reference fit.', ARRAY[]::text[], ARRAY['501','original','button fly','straight']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393'),
  ('levis', '505', 'Men', 'jeans', 'Red Tab', 'Regular Straight: ZIP FLY, mid rise, straight with MORE thigh room than the 501.', ARRAY[]::text[], ARRAY['505','regular','zip fly','straight']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393'),
  ('levis', '511', 'Men', 'jeans', 'Red Tab', 'Slim: zip fly, slim through hip and thigh with a smaller leg opening than the 501.', ARRAY[]::text[], ARRAY['511','slim']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393'),
  ('levis', '512', 'Men', 'jeans', 'Red Tab', 'Slim Taper: slim through the thigh, tapered from knee to ankle.', ARRAY[]::text[], ARRAY['512','slim taper']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393'),
  ('levis', '541', 'Men', 'jeans', 'Red Tab', 'Athletic Taper: roomy seat and thigh, tapered leg — cut for muscular builds.', ARRAY[]::text[], ARRAY['541','athletic','taper']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393'),
  ('levis', '550', 'Men', 'jeans', 'Red Tab', 'Relaxed: roomy through the seat and thigh, straight leg.', ARRAY[]::text[], ARRAY['550','relaxed']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393'),
  ('levis', '569', 'Men', 'jeans', 'Red Tab', 'Loose Straight: loose through the thigh with a straight, wide leg opening.', ARRAY[]::text[], ARRAY['569','loose','straight']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393'),
  ('levis', 'Trucker Jacket', 'Unisex', 'jacket', 'Red Tab', 'Type III denim trucker: pointed-flap chest pockets, tapered waist, button front, pointed yoke.', ARRAY[]::text[], ARRAY['trucker','type iii','denim jacket']::text[], 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.85, true, 'migration:00393')
on conflict (brand_key, style_name, department) do nothing;

-- ── brand_style_codes: Levi's fit-number decoder (brand-scoped 5NN) ─────────
insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('levis', 'lot_number', 'Levi''s fit/lot number (5NN) on the back-waist patch — identifies the fit', '^(?<fit>5[0-9]{2})$', $j${"fieldMap":{"fit":"styleCode"},"confidence":0.7}$j$::jsonb, $j$[{"code":"501","expected":{"styleCode":"501"}}]$j$::jsonb, 'https://www.fashionbeans.com/article/levis-501-vs-505-vs-511-vs-514/', 0.70, true, 'migration:00393')
on conflict (brand_key, decoder_kind) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00393') on conflict do nothing;
