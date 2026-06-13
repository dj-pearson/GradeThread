-- US-830: admin-managed knowledge base — the ONLY system-side corpus the AI
-- Support Assistant may speak from (EPIC: AI Support Assistant). The engine
-- (US-834) and prompt (US-835) forbid answering product questions from anything
-- but published KB hits; the KB retrieval tool (US-833) keyword-searches the
-- GIN-indexed tsvector here. Two tables:
--
--   support_kb_articles   — the live, versioned, publishable corpus.
--   support_kb_revisions  — append-only edit history; one row per saved version.
--
-- SECURITY MODEL (mirrors support_assistant_schema 00181):
--   * RLS is enabled on both tables.
--   * Published articles are readable by the matching audience: 'public'
--     articles by anyone (incl. anon), 'subscriber' articles by any
--     authenticated user. Drafts (is_published = false) and ALL revision
--     history are admin/service-role only — never client-readable.
--   * There is NO client INSERT/UPDATE/DELETE policy on either table. Authoring
--     (US-840) is performed by the service-role edge client / admins, so the
--     corpus can never be tampered with from the SPA.
--
-- The category/audience value sets are modeled as text + CHECK (the dominant
-- recent pattern documented in 00181) so the sets can evolve without ALTER TYPE
-- gymnastics. Idempotent via IF NOT EXISTS so a re-run on a partial apply is a
-- no-op.

CREATE TABLE IF NOT EXISTS public.support_kb_articles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  title        text NOT NULL,
  body_md      text NOT NULL DEFAULT '',
  category     text NOT NULL
    CHECK (category IN (
      'grading', 'pricing', 'plans', 'photos', 'disputes',
      'flipdesk', 'billing', 'account', 'getting_started'
    )),
  audience     text NOT NULL DEFAULT 'public'
    CHECK (audience IN ('public', 'subscriber')),
  -- Bumped by the trigger below on every content edit; starts at 1.
  version      integer NOT NULL DEFAULT 1,
  is_published boolean NOT NULL DEFAULT false,
  -- Weighted FTS vector maintained automatically as a generated column
  -- (title = A, body_md = B). to_tsvector(regconfig, text) is IMMUTABLE, so it
  -- is valid in a GENERATED ALWAYS ... STORED expression.
  search_tsv   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_md, '')), 'B')
  ) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only revision history. No updated_at: rows are immutable snapshots.
CREATE TABLE IF NOT EXISTS public.support_kb_revisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL
    REFERENCES public.support_kb_articles(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  title      text NOT NULL,
  body_md    text NOT NULL,
  -- The admin who saved this version; null for service-role/system writes.
  edited_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version)
);

-- GIN index backing keyword retrieval (US-833).
CREATE INDEX IF NOT EXISTS idx_support_kb_articles_search_tsv
  ON public.support_kb_articles USING GIN (search_tsv);

-- The retrieval tool only ever reads published rows, filtered by audience.
CREATE INDEX IF NOT EXISTS idx_support_kb_articles_published
  ON public.support_kb_articles(audience, category)
  WHERE is_published;

CREATE INDEX IF NOT EXISTS idx_support_kb_revisions_article
  ON public.support_kb_revisions(article_id, version DESC);

-- updated_at maintained by the standard trigger (00001).
DROP TRIGGER IF EXISTS set_support_kb_articles_updated_at
  ON public.support_kb_articles;
CREATE TRIGGER set_support_kb_articles_updated_at
  BEFORE UPDATE ON public.support_kb_articles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Versioning + revision history ──────────────────────────────────────────
-- On a content edit (title or body_md change) bump version BEFORE write. The
-- AFTER trigger then snapshots every distinct version into the append-only
-- history (the initial INSERT records version 1; each content edit records the
-- bumped version). Non-content updates (e.g. toggling is_published) neither
-- bump the version nor write a revision.
CREATE OR REPLACE FUNCTION public.support_kb_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.body_md IS DISTINCT FROM OLD.body_md THEN
    NEW.version := OLD.version + 1;
  ELSE
    -- Preserve the existing version on non-content edits.
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_kb_bump_version ON public.support_kb_articles;
CREATE TRIGGER support_kb_bump_version
  BEFORE UPDATE ON public.support_kb_articles
  FOR EACH ROW EXECUTE FUNCTION public.support_kb_bump_version();

CREATE OR REPLACE FUNCTION public.support_kb_write_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT always records the initial version; UPDATE records only when the
  -- version actually advanced (i.e. a content edit happened).
  IF TG_OP = 'INSERT' OR NEW.version IS DISTINCT FROM OLD.version THEN
    INSERT INTO public.support_kb_revisions
      (article_id, version, title, body_md, edited_by)
    VALUES (NEW.id, NEW.version, NEW.title, NEW.body_md, auth.uid())
    ON CONFLICT (article_id, version) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_kb_write_revision ON public.support_kb_articles;
CREATE TRIGGER support_kb_write_revision
  AFTER INSERT OR UPDATE ON public.support_kb_articles
  FOR EACH ROW EXECUTE FUNCTION public.support_kb_write_revision();

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.support_kb_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_kb_revisions ENABLE ROW LEVEL SECURITY;

-- Anyone (including anonymous visitors) may read PUBLISHED, PUBLIC articles.
CREATE POLICY "Public reads published public KB articles"
  ON public.support_kb_articles FOR SELECT
  USING (is_published AND audience = 'public');

-- Authenticated users additionally read PUBLISHED, SUBSCRIBER articles.
CREATE POLICY "Subscribers read published subscriber KB articles"
  ON public.support_kb_articles FOR SELECT
  USING (is_published AND audience = 'subscriber' AND auth.uid() IS NOT NULL);

-- Admins read everything, including unpublished drafts (US-840 authoring).
CREATE POLICY "Admins read all KB articles"
  ON public.support_kb_articles FOR SELECT
  USING (public.is_admin());

-- Revision history is admin-only; no client write/read of drafts' history.
CREATE POLICY "Admins read KB revisions"
  ON public.support_kb_revisions FOR SELECT
  USING (public.is_admin());

-- No INSERT/UPDATE/DELETE policies on either table: all writes are
-- service-role only (which bypasses RLS), mirroring 00181.
