-- ════════════════════════════════════════════════════════════
-- US-870: Per-platform social variants
-- ════════════════════════════════════════════════════════════
-- Until now a social_posts row carried a single long_body (LinkedIn/Facebook)
-- and short_body (X/Threads). Different networks have different length, tone,
-- hashtag, and link conventions, so we model one tailored variant PER platform
-- as a child table. The parent social_posts row stays the editorial anchor
-- (keeps long_body/short_body for backward compatibility + history/stats); the
-- child rows are what the publish webhook fan-out (US-854) dispatches per
-- platform so a Make.com router can branch on `platform`.

-- ── social_platform_variants ──────────────────────────────
CREATE TABLE public.social_platform_variants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id  uuid NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  -- The six networks the content engine fans out to. Constrained so a typo
  -- can't create an undispatchable variant.
  platform        text NOT NULL CHECK (
    platform IN ('x', 'linkedin', 'facebook', 'threads', 'pinterest', 'instagram')
  ),
  body            text NOT NULL DEFAULT '',
  hashtags        text[] NOT NULL DEFAULT '{}',
  -- Which branded social-card aspect this platform should use. Forward-looking
  -- label consumed by the auto card generation (US-871/US-872); e.g.
  -- 'card_landscape' (1.91:1), 'card_square' (1:1), 'pin_vertical' (2:3).
  image_field     text,
  -- The platform's hard character ceiling, snapshotted onto the row so the
  -- editor + downstream consumers don't have to re-derive it.
  char_limit      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One variant per platform per post.
  UNIQUE (social_post_id, platform)
);

CREATE INDEX idx_social_platform_variants_post
  ON public.social_platform_variants(social_post_id);

CREATE TRIGGER set_social_platform_variants_updated_at
  BEFORE UPDATE ON public.social_platform_variants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── content_settings: per-platform enable list ────────────
-- Owner controls fan-out from the admin UI. Default: all six on.
ALTER TABLE public.content_settings
  ADD COLUMN IF NOT EXISTS social_platforms text[] NOT NULL
    DEFAULT ARRAY['x', 'linkedin', 'facebook', 'threads', 'pinterest', 'instagram']::text[];

-- A single shared "router" webhook for the platform-aware fan-out. When set,
-- every per-platform social.published event is delivered here (and a Make.com
-- router branches on the `platform` field). When NULL, the dispatcher falls
-- back to the legacy make_webhook_social_long / _short mapping so existing
-- deployments keep delivering with no config change.
ALTER TABLE public.content_settings
  ADD COLUMN IF NOT EXISTS make_webhook_social text;

-- ── Row Level Security ────────────────────────────────────
-- Mirrors social_posts: admins manage everything; anon may read variants whose
-- parent post is published (so a public/SSR reader could surface them later).
ALTER TABLE public.social_platform_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins manage social_platform_variants"
  ON public.social_platform_variants FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "anon read variants of published posts"
  ON public.social_platform_variants FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.social_posts
      WHERE social_posts.id = social_platform_variants.social_post_id
        AND social_posts.status = 'published'
    )
  );
