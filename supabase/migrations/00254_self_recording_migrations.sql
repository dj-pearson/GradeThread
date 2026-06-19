-- US-1108: make migrations self-tracking so the edge schema-version guard (US-778)
-- never goes stale from the apply method.
--
-- THE RECURRING BUG: the prod apply path (raw `psql -f` AND pasting into the
-- Studio SQL editor) runs the DDL but does NOT write a row to
-- supabase_migrations.schema_migrations — only the Supabase CLI does. So
-- latest_schema_migration() lagged the real schema every release and the edge
-- refused to boot until a hand-written prod-catchup-*.sql backfilled the rows.
--
-- THE FIX: a tiny ops table that ONLY our migrations write to, plus a footer on
-- every future migration that records its own version into it. Because the
-- Supabase CLI never touches this table, a self-recording footer can't collide
-- with the CLI's own bookkeeping on `supabase db reset` (the local verify:db
-- lane). latest_schema_migration() now returns the MAX across BOTH the CLI table
-- and this one, so whichever path applied a migration, the guard sees it.
--
-- AFTER THIS: every NEW migration (00255+) ends with the footer documented in
-- MIGRATIONS.md. Apply it however you like — paste, psql, CLI — and it records
-- itself. No more catchup files. A CI guard (schema-version_test.ts) fails the
-- build if a new migration omits the footer.

BEGIN;

-- ── The ops table we own (CLI never writes here → collision-free) ──
CREATE TABLE IF NOT EXISTS public.applied_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.applied_migrations IS
  'US-1108: self-recorded migration versions (NNNNN). Written by each migration''s '
  'footer so the edge schema-version guard stays in sync regardless of apply method. '
  'Read (with supabase_migrations.schema_migrations) by latest_schema_migration().';

-- Ops metadata only — never client-readable. RLS on + no policy denies anon/
-- authenticated via PostgREST; the SECURITY DEFINER reader + service_role still
-- see it. Belt-and-suspenders REVOKE in case the table pre-existed without RLS.
ALTER TABLE public.applied_migrations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON public.applied_migrations FROM anon';
  EXECUTE 'REVOKE ALL ON public.applied_migrations FROM authenticated';
  EXECUTE 'GRANT ALL ON public.applied_migrations TO service_role';
EXCEPTION WHEN undefined_object THEN
  NULL; -- roles may not all exist on a bare local Postgres
END $$;

-- ── latest_schema_migration(): MAX across both trackers ──
-- Supersedes 00126. Still SECURITY DEFINER + fail-soft (returns NULL when
-- nothing is readable so the edge fail-OPENS rather than crash-loops).
CREATE OR REPLACE FUNCTION public.latest_schema_migration()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cli  text;
  v_self text;
BEGIN
  -- CLI tracker (may not exist on a bare psql-applied DB).
  BEGIN
    EXECUTE 'SELECT max(version) FROM supabase_migrations.schema_migrations'
      INTO v_cli;
  EXCEPTION WHEN undefined_table OR undefined_object OR insufficient_privilege THEN
    v_cli := NULL;
  END;
  -- Our self-record tracker.
  BEGIN
    SELECT max(version) INTO v_self FROM public.applied_migrations;
  EXCEPTION WHEN undefined_table THEN
    v_self := NULL;
  END;
  -- Lexical max mirrors the guard's comparison + the prod apply order; '' guards
  -- the all-NULL case back to NULL (→ edge treats as unknown → fail-open).
  RETURN NULLIF(GREATEST(COALESCE(v_cli, ''), COALESCE(v_self, '')), '');
END;
$$;

REVOKE ALL ON FUNCTION public.latest_schema_migration() FROM PUBLIC;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.latest_schema_migration() FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.latest_schema_migration() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.latest_schema_migration() TO service_role';
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

-- ── One-time seed of the new tracker ──
-- 1) Copy everything the CLI tracker already knows (the trusted baseline).
DO $$ BEGIN
  EXECUTE
    'INSERT INTO public.applied_migrations (version) '
    'SELECT version FROM supabase_migrations.schema_migrations '
    'ON CONFLICT (version) DO NOTHING';
EXCEPTION WHEN undefined_table OR undefined_object THEN
  NULL;
END $$;

-- 2) Record the migrations that predate this self-recording convention and were
--    applied by hand without a tracker row (00252/00253), plus this one. Safe by
--    the forward-only, in-order rule: reaching 00254 means 00250..00253 ran.
INSERT INTO public.applied_migrations (version)
VALUES ('00252'), ('00253'), ('00254')
ON CONFLICT (version) DO NOTHING;

COMMIT;
