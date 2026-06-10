-- US-778: expose the latest applied migration version to the edge service so it
-- can assert the DB schema is current at boot (and refuse to start against a
-- stale DB in production).
--
-- The self-hosted instance records applied migrations in
-- supabase_migrations.schema_migrations(version) — but PostgREST only exposes the
-- `public` schema, so the edge can't read that table directly. This SECURITY
-- DEFINER function in `public` bridges it: it returns the highest applied version
-- (the NNNNN prefix), callable via PostgREST RPC with the service-role key.
--
-- It's deliberately fail-soft: if the migrations table doesn't exist or can't be
-- read (e.g. a prod apply path that doesn't record versions), it returns NULL so
-- the edge fail-OPENS (warns, still boots) rather than crash-looping on a read
-- gap. A CONFIRMED behind-version is what the edge treats as fatal.

CREATE OR REPLACE FUNCTION public.latest_schema_migration()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  -- Dynamic so creation doesn't hard-depend on supabase_migrations existing
  -- (a raw psql apply on a bare DB), and so a missing table is catchable.
  EXECUTE
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1'
    INTO v;
  RETURN v;
EXCEPTION
  WHEN undefined_table OR undefined_object OR insufficient_privilege THEN
    RETURN NULL;
END;
$$;

-- Service-role only (the edge calls it; never anon/authenticated).
REVOKE ALL ON FUNCTION public.latest_schema_migration() FROM PUBLIC;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.latest_schema_migration() FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.latest_schema_migration() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.latest_schema_migration() TO service_role';
EXCEPTION WHEN undefined_object THEN
  -- Roles may not all exist on a bare local Postgres; ignore.
  NULL;
END $$;
