-- US-873: Automated internal topic-cluster interlinking at publish.
--
-- Topical-authority interlinking is one of the strongest SEO/GEO signals, but
-- today it happens only by hand on the cornerstone pillar pages (US-855). This
-- migration adds the two pieces the publish-time interlinker needs:
--
--   1. blog_posts.pillar — the seo.pillars cluster slug a post ladders to
--      (e.g. 'condition-vocabulary', 'category-grading'). Set at publish from
--      the topic angle / inferred from keywords. Makes "all cluster posts for a
--      pillar" queryable (the cornerstone hub linking DOWN to its spokes) with a
--      plain `WHERE pillar = $1 AND status = 'published'`.
--
--   2. blog_post_links — the hub-and-spoke link graph. One row per outbound
--      editorial link chosen at publish: 'related' (post → related post) and
--      'pillar' (post → its cornerstone pillar page URL). Re-published posts
--      replace their own rows (delete-by-source then insert), so the set stays
--      duplicate-free across edits. Read by the public blog endpoint to surface
--      the curated related block (reconciled with the tag-based fallback).
--
-- Platform-level editorial metadata, not tenant data: writes are service-role
-- only (the publish path uses the service-role client, which bypasses RLS); the
-- link targets feed the PUBLIC blog so SELECT is public, mirroring how the blog
-- itself is read (anon can read published posts via the edge service).

ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS pillar text;

-- Cluster lookup: the cornerstone page for a pillar lists its published spokes.
CREATE INDEX IF NOT EXISTS idx_blog_posts_pillar
  ON public.blog_posts(pillar)
  WHERE pillar IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.blog_post_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id  uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  -- target_post_id is set for relation='related' (an internal post link); NULL
  -- for relation='pillar' (the cornerstone page is a static route, not a post).
  target_post_id  uuid REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  -- target_url is the cornerstone page path for relation='pillar' (e.g.
  -- '/condition-grading'); NULL for relation='related'.
  target_url      text,
  relation        text NOT NULL CHECK (relation IN ('related', 'pillar')),
  pillar          text,
  rank            integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A post never links to the same target twice for the same relation.
  CONSTRAINT blog_post_links_no_self CHECK (source_post_id <> target_post_id)
);

-- Outbound links for a source post, in display order (the reconciliation read).
CREATE INDEX IF NOT EXISTS idx_blog_post_links_source
  ON public.blog_post_links(source_post_id, relation, rank);

-- Inbound links to a post (so "what links here" is queryable, e.g. when a post
-- is archived we can find spokes pointing at it).
CREATE INDEX IF NOT EXISTS idx_blog_post_links_target
  ON public.blog_post_links(target_post_id)
  WHERE target_post_id IS NOT NULL;

ALTER TABLE public.blog_post_links ENABLE ROW LEVEL SECURITY;

-- Public read (these power the public blog's related-links block); writes are
-- service-role only (the publish path bypasses RLS), so no write policy.
CREATE POLICY "public read blog_post_links"
  ON public.blog_post_links FOR SELECT
  USING (true);
