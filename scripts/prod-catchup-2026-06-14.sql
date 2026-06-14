-- ============================================================================
-- Production schema catch-up — 2026-06-14
--
-- Prod (self-hosted api.gradethread.com) had migration DRIFT: a contiguous block
-- (00143–00157) plus the newest 00229 were skipped, and the
-- supabase_migrations.schema_migrations tracker did not exist (so applies were
-- never recorded and gaps went silent). Diagnosis: see memory/prod-migration-drift.md.
--
-- This file contains the TWO pieces that the raw migration files can't be run
-- for safely:
--   1. A guarded rewrite of 00151 (its CREATE TYPE + ADD COLUMN are NOT idempotent).
--   2. The migration tracker + backfill, which restores the US-778 boot guard.
--
-- RUN ORDER (in the Supabase SQL editor):
--   1. Paste + run these migration files VERBATIM, in this order (all idempotent):
--        00143, 00145, 00146, 00147, 00150, 00152, 00154, 00155, 00157, 00229
--      (00146 MUST precede 00157 — numeric order satisfies that.)
--   2. Run THIS file.
--   3. NOTIFY pgrst, 'reload schema';
-- ============================================================================

-- ── 1. Guarded equivalent of 00151_content_safety_gate.sql ──────────────────
-- (the original uses a bare CREATE TYPE + unguarded ADD COLUMN — not re-runnable)

DO $$ BEGIN
  CREATE TYPE public.content_safety_status AS ENUM ('unchecked', 'passed', 'held');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS safety_status     public.content_safety_status NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS safety_notes      text,
  ADD COLUMN IF NOT EXISTS safety_checked_at timestamptz;

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS safety_status     public.content_safety_status NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS safety_notes      text,
  ADD COLUMN IF NOT EXISTS safety_checked_at timestamptz;

ALTER TABLE public.content_settings
  ADD COLUMN IF NOT EXISTS publishing_paused           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_auto_publishes_per_week integer NOT NULL DEFAULT 10
    CHECK (max_auto_publishes_per_week >= 0);

-- ── 2. Migration tracker + backfill (restores US-778 schema-version guard) ───
-- The edge's latest_schema_migration() reads the highest `version` here. Without
-- this table it returned NULL → the boot guard fail-OPENed (warn + serve). After
-- backfilling to the current high-water mark (00229 = EXPECTED_SCHEMA_VERSION),
-- the guard reports "match" again.
--
-- NOTE (operational): once this exists, the US-778 guard becomes ENFORCING in
-- production — an edge build whose EXPECTED_SCHEMA_VERSION is HIGHER than the max
-- row here will refuse to start (crash-loop) until the new migration is applied.
-- That is the intended safety behavior; just keep applying migrations BEFORE
-- deploying edge (DEPLOY.md order: migrations → edge → frontend).

CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version     text PRIMARY KEY,
  inserted_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill 00001..00229. Safe to re-run (ON CONFLICT DO NOTHING). Bump the upper
-- bound to match EXPECTED_SCHEMA_VERSION whenever prod is brought fully current.
INSERT INTO supabase_migrations.schema_migrations (version)
SELECT lpad(g::text, 5, '0')
FROM generate_series(1, 229) AS g
ON CONFLICT (version) DO NOTHING;
