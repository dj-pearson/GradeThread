-- US-916: Product "What's New" changelog feed.
--
-- A structured, durable changelog of shipped features/improvements/fixes so the
-- autonomous newsletter (US-922 assembler) can TRUTHFULLY tell users what's new
-- without a human writing release notes each week. Entries can be:
--   • drafted automatically from signals already in the system (e.g. newly
--     published blog posts) for human-light curation (source='auto', drafts), or
--   • authored/published manually by an operator in the admin console.
--
-- Surfaces:
--   • Admin CRUD ......... /api/admin/changelog (admin JWT + AAL2)
--   • Public feed ........ GET /api/changelog (published entries only; powers a
--                          public /changelog page + an in-app "What's New" panel)
--   • Newsletter ......... the assembler features UNSENT published entries for the
--                          issue's audience, then marks them featured so they are
--                          not repeated next week.
--
-- changelog_entries is an OPERATOR surface (no tenant owner column): RLS enabled,
-- deny-all, read/written ONLY by the edge service-role client. The public feed is
-- served by a service-role edge route hard-filtered to status='published' — never
-- by anon RLS.
--
-- Additive + idempotent.

BEGIN;

-- ── Enums (category / audience / status / source) ────────────────────────────
-- CREATE TYPE has no IF NOT EXISTS; guard each with a duplicate_object catch so
-- the migration is re-runnable.
DO $$ BEGIN
  CREATE TYPE public.changelog_category AS ENUM ('feature', 'improvement', 'fix', 'announcement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.changelog_audience AS ENUM ('all', 'grading', 'flipdesk', 'verified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.changelog_status AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.changelog_source AS ENUM ('manual', 'auto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── changelog_entries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.changelog_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  summary       text,
  body          text,
  category      public.changelog_category NOT NULL DEFAULT 'feature',
  audience      public.changelog_audience NOT NULL DEFAULT 'all',
  image_url     text,
  status        public.changelog_status NOT NULL DEFAULT 'draft',
  published_at  timestamptz,
  source        public.changelog_source NOT NULL DEFAULT 'manual',
  -- Dedup key for the auto-capture path: the originating signal's id (e.g. a
  -- content_history_index row) so the same blog post is never drafted twice.
  source_ref    text,
  -- Newsletter bookkeeping: when an issue featured this entry (so it is not
  -- re-featured next week) and which issue claimed it.
  featured_at        timestamptz,
  featured_issue_id  uuid REFERENCES public.newsletter_issues(id) ON DELETE SET NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Auto-capture idempotency: at most one entry per source signal.
CREATE UNIQUE INDEX IF NOT EXISTS changelog_entries_source_ref_key
  ON public.changelog_entries (source_ref)
  WHERE source_ref IS NOT NULL;

-- Public feed: published entries newest first.
CREATE INDEX IF NOT EXISTS changelog_entries_published_idx
  ON public.changelog_entries (status, published_at DESC);

-- Assembler: unsent (not-featured) published entries.
CREATE INDEX IF NOT EXISTS changelog_entries_unsent_idx
  ON public.changelog_entries (status, featured_at, published_at DESC);

CREATE TRIGGER set_changelog_entries_updated_at
  BEFORE UPDATE ON public.changelog_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Operator surface: deny-all to anon/auth; all access via the service-role client.
ALTER TABLE public.changelog_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.changelog_entries FROM anon, authenticated;

-- ── Settings (registry-backed; operator-tunable) ─────────────────────────────
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'changelog_autocapture_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb,
    'US-916: when true the assembler drafts changelog entries from recently published blog posts (source=auto, status=draft) for human-light curation. Drafts never auto-send; an operator publishes them.',
    'marketing'
  ),
  (
    'changelog_autocapture_lookback_days',
    to_jsonb(30), 'number', to_jsonb(30),
    'US-916: how far back (days) the auto-capture scan looks for newly published blog posts to draft as changelog entries.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00291')
ON CONFLICT (version) DO NOTHING;
