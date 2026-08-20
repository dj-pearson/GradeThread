-- 00631 — one spelling per Lululemon garment in the learned index (US-2714)
--
-- 00630 made all four spellings of a code DECODE. They still do not share a
-- KEY: the learned index files a code under whatever was transcribed, so
-- W6AMYS, LW6AMYS, W6AMYSP60417 and LW6AMYSP60417 are four rows in
-- style_code_names, style_code_observations and style_code_sweeps. A consensus
-- needs three agreeing titles per key, so splitting one garment four ways can
-- leave every fragment under the threshold and produce no name at all from
-- evidence that would have been enough.
--
-- `canonicalFrom` names the capture groups, IN ORDER, that concatenate to the
-- one spelling a code should be filed under. The engine reads them from the RAW
-- captures — before the transform table turns "W" into "Women", because a
-- canonical CODE has to stay a code — and uppercases the result. All three
-- Lululemon specs name gender + style + colour, which is the six-character
-- style number every source agrees on.
--
-- DATA, not a per-brand branch: a spec that omits canonicalFrom yields no
-- canonical code and behaves exactly as it does today, which is every other
-- brand in the corpus.
--
-- The 2019+ spec's canonical deliberately DROPS the ".SSYY" suffix, so the same
-- style in two seasons shares a key. That is right for NAMING — it is the same
-- product — and it is why the canonical code is built from named groups rather
-- than by trimming the raw string.
--
-- ⚠ decodeTagCode uses these seeded specs INSTEAD of DEFAULT_DECODER_SPECS once
-- a brand has any, so this migration is what makes the feature real in
-- production; the in-code copy is the local fallback.
-- decoder-seed-parity_test.ts fails if the two drift.

update public.brand_style_codes
set extraction_rules = extraction_rules || jsonb_build_object(
      'canonicalFrom', jsonb_build_array('gender', 'style', 'color')
    ),
    updated_by = 'migration:00631'
where brand_key = 'lululemon'
  and decoder_kind in ('style_number', 'style_number_2017', 'style_number_full')
  and not (extraction_rules ? 'canonicalFrom');

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00631') on conflict do nothing;
