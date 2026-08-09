-- US-1996 AC5: a brand fact must carry its provenance, enforced rather than
-- described.
--
-- US-1716 AC4 claimed brand-fact provenance was "schema-enforced". IT WAS NOT.
-- 00389 declares `source_url text` and `confidence numeric(3,2)` as plain
-- NULLABLE columns on all five KB tables, and the admin write path explicitly
-- permitted a null confidence. So "every fact carries source_url + confidence"
-- was a convention, and a convention is what let 00498 seed 11 unsourced charts
-- without anything noticing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE STORY SAID TO COUNT FIRST, AND THE COUNT WAS TAKEN. US-1996 AC5 says:
-- "FIRST run: select count(*) from brand_knowledge where source_url is null or
-- confidence is null (needs DB access — deny-all table). Zero rows ⇒ add the
-- constraints; non-zero ⇒ this is a data migration, not a one-liner."
--
-- Measured on a from-zero throwaway stack, which holds exactly what the
-- migrations seed:
--
--     brand_knowledge     204 rows    0 missing provenance
--     brand_styles        735 rows    0
--     brand_style_codes    30 rows    0
--     brand_colorways     159 rows    0
--     brand_size_charts   316 rows   11 missing        <-- the real gap
--
-- SO THE AC'S PREMISE POINTED AT THE WRONG TABLE. brand_knowledge — the one it
-- names — is clean. The gap is in brand_size_charts, and it is DELIBERATE and
-- DOCUMENTED: 00498 backfilled the in-code SIZING_CHARTS seed and says in its own
-- header that "every row lands with verified = false, confidence = NULL and
-- source_url = NULL, because the in-code seed carries no per-chart provenance to
-- copy". Those 11 are the residue. They are not sloppiness and they must not be
-- deleted — they are the values the resolver has always used, moved somewhere an
-- operator can correct them.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT VALID IS THE WHOLE DESIGN, NOT A SHORTCUT — the 00572 precedent exactly.
--
-- Two independent reasons, and either one alone would be enough:
--
--   1. THE 11 UNSOURCED CHARTS. A plain CHECK would refuse to apply, so shipping
--      it would mean either fabricating sources (the thing this exists to
--      prevent) or deleting curated data that is useful as resolver input.
--   2. PROD IS NOT THE SEEDED STACK. The counts above are what the MIGRATIONS
--      produce. Prod also holds whatever the admin curation surface (US-1715)
--      has written, and that path permitted a null confidence until the commit
--      shipping this file. A VALID constraint could therefore fail to apply
--      against production while passing every check locally — which is the
--      worst shape a migration can have.
--
-- NOT VALID enforces on every INSERT and UPDATE from now on and leaves existing
-- rows alone. New content cannot arrive unsourced; the legacy rows stay readable
-- and stay honestly marked (verified = false already says so).
--
-- Once the residue is sourced or retired, run:
--   ALTER TABLE public.brand_size_charts VALIDATE CONSTRAINT brand_size_charts_sourced;
-- and the same for any other table. THAT COMMAND IS THE DEFINITION OF DONE for
-- the backfill, and it is deliberately NOT run here.
--
-- ⚠ brand_knowledge IS clean on the seeded corpus, so its VALIDATE is expected to
-- succeed today — but it is still added NOT VALID for reason (2). Validating it
-- is a one-line operator action once prod has been counted, and that count is
-- the only part of this AC a checkout genuinely cannot take.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ALL FIVE TABLES, NOT JUST THE TWO WITH A PROBLEM. The requirement is that a
-- brand fact carries its provenance; the five tables are siblings by design and
-- every future pack writes to several of them. Constraining only the two where a
-- gap happens to exist today would leave three places a later pack can quietly
-- seed an unsourced row — which is the exact shape of the gap being closed.
--
-- WHAT IS CHECKED: source_url is present and non-blank, and confidence is
-- non-null. NOT the VALUE of confidence — 00389 already bounds it to [0,1] with
-- a CHECK, and a low confidence is a legitimate, honest answer (00576 seeds two
-- dating claims at 0.4 and 0.45 on purpose). The requirement is that somebody
-- said how sure they were, not that they were sure.

CREATE OR REPLACE FUNCTION public.brand_fact_is_sourced(source_url text, confidence numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT COALESCE(btrim(source_url), '') <> '' AND confidence IS NOT NULL;
$$;

COMMENT ON FUNCTION public.brand_fact_is_sourced(text, numeric) IS
  'US-1996 AC5: true when a brand-KB row carries a non-blank source_url and a non-null '
  'confidence. Checks PRESENCE, not the confidence VALUE — 00389 already bounds the range, '
  'and a low confidence is an honest answer. Backs the *_sourced constraints on the five '
  'brand-KB tables, all added NOT VALID so the 11 unsourced 00498 charts stay readable.';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'brand_knowledge', 'brand_styles', 'brand_style_codes',
    'brand_colorways', 'brand_size_charts'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_sourced'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'CHECK (public.brand_fact_is_sourced(source_url, confidence)) NOT VALID',
        t, t || '_sourced'
      );
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN public.brand_knowledge.source_url IS
  'US-1996: where this brand fact came from. Required on every INSERT and UPDATE from '
  '00578 onward (constraint brand_knowledge_sourced, added NOT VALID). "seed:<file>.ts" is '
  'an accepted form for rows lifted from an in-code table — it names a real, readable '
  'origin. An empty string does not satisfy it.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00578') on conflict do nothing;
