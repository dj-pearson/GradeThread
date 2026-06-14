-- Author entities + E-E-A-T author pages (US-874).
--
-- Today the blog author is byline TEXT only (blog_posts.author, US-304) with no
-- entity behind it. Google E-E-A-T and AI answer engines weight author expertise,
-- so this models named authors as real rows with indexable profile pages and
-- Person structured data, and links each post to one via blog_posts.author_id.
--
-- The legacy blog_posts.author text column is KEPT for backfill / graceful
-- fallback: a post with no author_id still renders its byline string, and the
-- SSR prefers the linked entity when present (see content-public.ts /posts/:slug
-- and functions/blog/[[path]].ts).

-- ── content_authors ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_authors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  -- jobTitle in Person JSON-LD, e.g. "Lead Condition Analyst".
  title        text,
  -- Markdown bio rendered on the author page (sanitized at render).
  bio_md       text,
  avatar_url   text,
  -- Credentials / qualifications shown on the page (E-E-A-T expertise signal).
  credentials  text[] NOT NULL DEFAULT '{}',
  -- External profile URLs → Person.sameAs (entity disambiguation).
  same_as      text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_authors IS
  'Named blog authors with bio pages + Person structured data for E-E-A-T (US-874).';
COMMENT ON COLUMN public.content_authors.title IS
  'jobTitle in Person JSON-LD (e.g. "Lead Condition Analyst").';
COMMENT ON COLUMN public.content_authors.same_as IS
  'External profile URLs surfaced as Person.sameAs for entity disambiguation.';

CREATE TRIGGER set_content_authors_updated_at
  BEFORE UPDATE ON public.content_authors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── blog_posts.author_id FK ──────────────────────────────────────
-- Nullable: a post with no linked author falls back to the legacy byline text
-- (and ultimately "GradeThread Team"). ON DELETE SET NULL so deleting an author
-- never deletes posts — they just lose the entity link.
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS author_id uuid
    REFERENCES public.content_authors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_blog_posts_author_id
  ON public.blog_posts(author_id)
  WHERE author_id IS NOT NULL;

COMMENT ON COLUMN public.blog_posts.author_id IS
  'FK to content_authors (US-874). NULL → legacy author byline text fallback.';

-- ── RLS: admin-write / anon-read ─────────────────────────────────
-- Author pages are public, indexable surfaces, so anon may SELECT every row;
-- writes are admin-only (matches the rest of the content module, 00041).
ALTER TABLE public.content_authors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins manage content_authors"
  ON public.content_authors FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "anon read content authors"
  ON public.content_authors FOR SELECT
  TO anon
  USING (true);

-- ── Seed the default house author ────────────────────────────────
-- The blog editor defaults new/legacy posts to this row, and it backs the
-- "GradeThread Team" byline that posts without a named author have always shown.
INSERT INTO public.content_authors (slug, name, title, bio_md, credentials)
VALUES (
  'gradethread-team',
  'GradeThread Team',
  'Condition Grading Experts',
  'The GradeThread editorial team builds and maintains the standard for pre-owned '
    || 'clothing condition grading. We write about condition vocabulary, reseller '
    || 'workflows, and how to grade, list, and sell used clothing with confidence.',
  ARRAY[
    'Built the GradeThread 1.0–10.0 condition grading standard',
    'Authors of the GradeThread Condition Index'
  ]
)
ON CONFLICT (slug) DO NOTHING;
