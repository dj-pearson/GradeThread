-- US-2689: Lululemon style numbers from the Jan 2017 - Jan 2019 generation.
--
-- The seeded 'style_number' decoder (00390) requires the ".SSYY" season/year
-- block, which Lululemon only started printing in 2019. Codes from the two
-- years before that are the same W|M + code + colour-initial body with nothing
-- after it (M7A83S, W6AVBS) and decoded to NOTHING, so those garments lost
-- brand confirmation, gender and the raw-code anchor that the learned style
-- index (00503) keys on.
--
-- Seeded as a SECOND decoder_kind rather than by loosening the 2019 pattern:
-- the two are anchored to different lengths, so they cannot compete, and the
-- 2017 spec keeps a lower confidence because it grounds fewer fields (gender
-- and the code, never season or year).

insert into public.brand_style_codes
  (brand_key, decoder_kind, description, pattern, extraction_rules, examples, source_url, confidence, verified, updated_by) values
  ('lululemon', 'style_number_2017', 'Jan 2017 - Jan 2019: W/M + 4 alphanumerics + colour initial, no season/year suffix', '^(?<gender>[WM])(?<style>[A-Z0-9]{4})(?<color>[A-Z])$', $j${"fieldMap":{"gender":"gender","style":"styleCode","color":"colorInitial"},"transforms":{"gender":"genderCode","color":"upper"},"confidence":0.85}$j$::jsonb, $j$[{"code":"M7A83S","expected":{"gender":"Men","styleCode":"7A83","colorInitial":"S"}},{"code":"W6AVBS","expected":{"gender":"Women","styleCode":"6AVB","colorInitial":"S"}}]$j$::jsonb, 'https://theresaledoctor.com/lululemon-style-number/', 0.85, true, 'migration:00626')
on conflict (brand_key, decoder_kind) do update set
  description = excluded.description,
  pattern = excluded.pattern,
  extraction_rules = excluded.extraction_rules,
  examples = excluded.examples,
  source_url = excluded.source_url,
  confidence = excluded.confidence,
  verified = excluded.verified,
  updated_by = excluded.updated_by;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00626') on conflict do nothing;
