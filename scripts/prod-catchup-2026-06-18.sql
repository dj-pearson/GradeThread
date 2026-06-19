-- prod-catchup-2026-06-18.sql
--
-- WHY: the edge boot guard (US-778, lib/schema-version.ts) refused to start:
--   [schema-version] DB is STALE: applied=00231, this build expects 00249.
--
-- The DDL for 00232..00249 WAS applied to prod by hand (raw `psql -f`), so the
-- actual tables/columns/views exist. But a raw psql apply does NOT record rows
-- in supabase_migrations.schema_migrations (only the Supabase CLI does — see
-- MIGRATIONS.md "PROD APPLY NOTE"). So latest_schema_migration() still returns
-- 00231 and the guard sees the DB as stale even though the schema is current.
--
-- FIX: backfill the tracker rows for the migrations whose DDL is already applied.
-- This mirrors scripts/prod-catchup-2026-06-14.sql. Safe to re-run.
--
-- ⚠️ ONLY run this once you've confirmed the 00232..00249 DDL really is applied.
-- Spot-check the highest migration (00249 appended two columns to items_full):
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='items_full'
--     AND column_name IN ('color','listing_platform');
--   -- expect BOTH rows. If missing, apply supabase/migrations/00249_*.sql first.
--
-- If any migration in the range is NOT applied, apply that file before
-- backfilling its row — otherwise this masks a real gap and the edge will hit
-- "column does not exist" at runtime instead of failing loudly at boot.

CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version     text PRIMARY KEY,
  inserted_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill 00232..00249 (the range applied by hand without tracker rows).
-- Bump the upper bound to match EXPECTED_SCHEMA_VERSION on the next catch-up.
INSERT INTO supabase_migrations.schema_migrations (version)
SELECT lpad(g::text, 5, '0')
FROM generate_series(232, 249) AS g
ON CONFLICT (version) DO NOTHING;

-- PostgREST may still be serving a stale schema cache for the columns/views the
-- manual applies added — nudge it to reload so the API exposes them.
NOTIFY pgrst, 'reload schema';

-- Verify: should now report 00249.
SELECT max(version) AS latest_tracked FROM supabase_migrations.schema_migrations;
