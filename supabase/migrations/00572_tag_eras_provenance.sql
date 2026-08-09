-- US-2212 AC5: a dating claim must be citable before it can be sold.
--
-- Era IS the price on a vintage piece, which makes tag_eras the
-- highest-liability content in the brand knowledge base. Until now
-- brand_knowledge carried source_url / confidence / verified on the ROW, so an
-- unsourced era sitting inside an otherwise-verified brand was
-- indistinguishable from a cited one. The registered-number work already took
-- the position this follows: an RN we cannot cite is invention (00457/00458),
-- and so is a decade.
--
-- ── WHY A FUNCTION AND NOT AN INLINE CHECK ──────────────────────────────────
-- The predicate has to walk a jsonb ARRAY, and Postgres refuses a subquery in a
-- CHECK constraint (0A000) — jsonb_array_elements in a NOT EXISTS is one. The
-- first draft of this file did exactly that and the `db` verify lane caught it
-- on a from-zero re-apply, which is the lane earning its keep. A CHECK may call
-- a function, so the walk lives in an IMMUTABLE one.
--
-- ── WHY THIS IS A CONSTRAINT AND NOT A COLUMN ───────────────────────────────
-- tag_eras is jsonb, so per-entry `source_url` and `confidence` need no schema
-- change to WRITE. What needed one is the rule that they must be there. Without
-- it the split shipped in lib/tag-era.ts is a convention, and a convention is
-- what produced ~220 uncited entries in the first place.
--
-- ── NOT VALID IS THE WHOLE DESIGN, NOT A SHORTCUT ───────────────────────────
-- Every one of the ~220 seeded entries predates this and carries no provenance.
-- A plain CHECK would refuse to apply against them, so the only ways to ship it
-- would be to fabricate sources (the thing this exists to prevent) or to delete
-- curated knowledge that is useful as PROMPT REFERENCE even when it cannot be
-- published.
--
-- NOT VALID enforces on every INSERT and UPDATE from now on while leaving the
-- existing rows alone: new content cannot arrive uncited, and the legacy rows
-- stay readable and stay honestly marked. Once they are backfilled, run
--   ALTER TABLE public.brand_knowledge VALIDATE CONSTRAINT brand_knowledge_tag_eras_sourced;
-- which scans and then enforces retroactively. That command is the definition
-- of done for the backfill, and it is deliberately NOT run here.
--
-- ── WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
-- Only DATABLE entries. The column carries two kinds of fact: generations that
-- date a garment, and format notes whose `years` is 'all' / 'current' /
-- 'ongoing' describing a code shape that never changed. A format note is not a
-- dating claim and has nothing to cite, so requiring a source on one would push
-- an author to invent a URL for a true statement. The year-or-decade test here
-- mirrors YEAR_LIKE in services/edge-functions/src/lib/tag-era.ts.

CREATE OR REPLACE FUNCTION public.tag_eras_all_sourced(eras jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT eras IS NULL
    OR jsonb_typeof(eras) <> 'array'
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(eras) AS e
      -- Datable: `years` names a four-digit year or a decade.
      WHERE COALESCE(e ->> 'years', '') ~ '(\d{4}|\d0s)'
        AND (
          COALESCE(e ->> 'source_url', '') = ''
          OR jsonb_typeof(e -> 'confidence') IS DISTINCT FROM 'number'
        )
    );
$$;

COMMENT ON FUNCTION public.tag_eras_all_sourced(jsonb) IS
  'US-2212 AC5: true when every DATABLE tag_eras entry carries source_url and a numeric '
  'confidence. Format-note entries (years = all/current/ongoing) are exempt — they make no '
  'dating claim and have nothing to cite. Backs brand_knowledge_tag_eras_sourced.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brand_knowledge_tag_eras_sourced'
  ) THEN
    ALTER TABLE public.brand_knowledge
      ADD CONSTRAINT brand_knowledge_tag_eras_sourced
      CHECK (public.tag_eras_all_sourced(tag_eras))
      NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.brand_knowledge.tag_eras IS
  'US-2212: seeded tag generations, [{era, years, description, source_url, confidence}]. '
  'A DATABLE entry (years naming a year or decade) must carry source_url and a numeric '
  'confidence — enforced by brand_knowledge_tag_eras_sourced, added NOT VALID so the ~220 '
  'pre-US-2212 entries stay readable. Entries whose years is all/current/ongoing are FORMAT '
  'NOTES, not dating claims, and are exempt. An uncited era may be rendered as prompt '
  'reference but must never be published — see claimableEras() in lib/tag-era.ts.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00572') on conflict do nothing;
