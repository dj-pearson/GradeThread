-- 00630 — the whole string on a Lululemon size dot, not just the style number
-- (US-2714)
--
-- The dot carries more than the six-character style number. Sources reconcile
-- to: [L] + the six characters beginning at the W or M + a colour letter + a
-- 5-6 digit manufacture date. LW6AMYSP60417 = L + W6AMYS + P + 60417.
--
-- Both seeded decoders anchored to the six characters alone, so the reading a
-- model actually produces — the extract prompt says to transcribe a style code
-- VERBATIM — matched nothing. The most complete transcription available was the
-- one that grounded no fields at all.
--
-- Three changes, all widening what is ACCEPTED and none changing what is
-- DERIVED:
--   1. style_number      gains an optional leading L
--   2. style_number_2017 gains an optional leading L
--   3. style_number_full is new: the whole printed string
--
-- Anchored at BOTH ends throughout. brand-kb-decoder-bar.md's third test is
-- brand-uniqueness of FORMAT, and an unanchored search for the six-character
-- body inside arbitrary text would fire on ordinary words and on other brands'
-- codes. The full form requires the colour letter AND the date block, which is
-- what keeps it a format rather than a substring hunt.
--
-- The trailing block is deliberately unmapped: sources disagree about whether
-- the sixth character belongs to the style or the colour, and those digits are
-- a MANUFACTURE date rather than the season/year the 2019+ suffix carries. The
-- extra characters buy a MATCH, not more information, so style_number_full
-- grounds exactly what style_number_2017 grounds, at the same confidence.
--
-- DEFAULT_DECODER_SPECS in brand-decoders.ts carries the same three specs.
-- decodeTagCode ignores the in-code defaults entirely whenever DB specs exist
-- for a brand, so seeding only one side leaves the fix dependent on which path
-- ran (the US-2689 lesson).

insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('lululemon', 'style_number', 'Optional L + W/M + 5 alphanumerics + "." + SSYY (2019-present)', '^L?(?<gender>[WM])(?<style>[A-Z0-9]{3,5})(?<color>[A-Z])\.(?<season>0[1-4])(?<year>\d{2})$', $j${"fieldMap":{"gender":"gender","style":"styleCode","color":"colorInitial","season":"season","year":"year"},"transforms":{"gender":"genderCode","season":"seasonCode","year":"year2to4","color":"upper"},"confidence":0.9}$j$::jsonb, $j$[{"code":"WU1ABC.0119","expected":{"gender":"Women","season":"Spring","year":"2019"}},{"code":"LWA1234B.0322","expected":{"gender":"Women","styleCode":"A1234","year":"2022"}}]$j$::jsonb, 'https://theresaledoctor.com/lululemon-style-number/', 0.9, true, 'migration:00630'),
  ('lululemon', 'style_number_2017', 'Optional L + W/M + 4 alphanumerics + colour initial, no season suffix (Jan 2017 - Jan 2019)', '^L?(?<gender>[WM])(?<style>[A-Z0-9]{4})(?<color>[A-Z])$', $j${"fieldMap":{"gender":"gender","style":"styleCode","color":"colorInitial"},"transforms":{"gender":"genderCode","color":"upper"},"confidence":0.85}$j$::jsonb, $j$[{"code":"M7A83S","expected":{"gender":"Men","styleCode":"7A83","colorInitial":"S"}},{"code":"LW6AMYS","expected":{"gender":"Women","styleCode":"6AMY","colorInitial":"S"}}]$j$::jsonb, 'https://theresaledoctor.com/lululemon-style-number/', 0.85, true, 'migration:00630'),
  ('lululemon', 'style_number_full', 'The whole printed size-dot string: optional L + style number + colour letter + 5-6 digit manufacture date', '^L?(?<gender>[WM])(?<style>[A-Z0-9]{4})(?<color>[A-Z])[A-Z]\d{5,6}$', $j${"fieldMap":{"gender":"gender","style":"styleCode","color":"colorInitial"},"transforms":{"gender":"genderCode","color":"upper"},"confidence":0.85}$j$::jsonb, $j$[{"code":"LW6AMYSP60417","expected":{"gender":"Women","styleCode":"6AMY","colorInitial":"S"}},{"code":"W6AMYSP60417","expected":{"gender":"Women","styleCode":"6AMY"}}]$j$::jsonb, 'https://theresaledoctor.com/lululemon-style-number/', 0.85, true, 'migration:00630')
on conflict (brand_key, decoder_kind) do update set
  description = excluded.description,
  pattern = excluded.pattern,
  extraction_rules = excluded.extraction_rules,
  examples = excluded.examples,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  verified = excluded.verified,
  updated_by = excluded.updated_by;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00630') on conflict do nothing;
