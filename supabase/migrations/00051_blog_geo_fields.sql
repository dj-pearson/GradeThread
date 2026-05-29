-- Blog GEO / E-E-A-T enhancements (US-304).
--
-- Adds the structured fields generative search engines reward — an answer-first
-- key-takeaways block, on-page FAQ Q&A (also emitted as FAQPage JSON-LD), and a
-- visible author byline — to blog_posts. The auto table-of-contents, related
-- posts, and visible "Updated <date>" are derived at render time from existing
-- columns (body_html, tags, updated_at) and need no schema change.
--
-- All three columns are nullable / defaulted, so every existing post keeps
-- rendering unchanged (graceful fallback): no author → "GradeThread Team",
-- empty key_takeaways/faqs → those blocks are simply omitted.

ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS author        text,
  ADD COLUMN IF NOT EXISTS key_takeaways text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS faqs          jsonb  NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.blog_posts.author IS
  'Visible byline / E-E-A-T author name (US-304). NULL falls back to "GradeThread Team".';
COMMENT ON COLUMN public.blog_posts.key_takeaways IS
  'Answer-first summary bullets rendered near the top as a GEO key-takeaways block (US-304).';
COMMENT ON COLUMN public.blog_posts.faqs IS
  'Array of {q,a} objects rendered visibly + as FAQPage JSON-LD (US-304).';
