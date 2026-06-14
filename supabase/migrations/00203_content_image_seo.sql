-- US-876: Image SEO — alt text, ImageObject data, descriptive filenames/captions.
--
-- Image SEO drives Google Images + Discover traffic, and it was missing for the
-- AI-generated hero (US-853) and for inline body images. This migration gives
-- every content image somewhere durable to carry accessible, keyword-aware
-- metadata so it is STORED once (at generate/upload time), not recomputed per
-- render:
--   1. blog_posts hero image fields — alt (a11y + SEO), an optional human
--      caption (rendered as <figcaption>), an optional credit, and the pixel
--      dimensions so the hero ImageObject JSON-LD can declare width/height.
--   2. blog_posts.inline_images — a jsonb array of per-body-image metadata
--      ({ src, alt, caption, width, height }) so in-body <img> tags can be
--      rewritten with real stored alt/caption instead of only a filename guess.
--
-- All columns are nullable / defaulted so existing posts render unchanged. Reads
-- stay admin-only via the existing blog_posts RLS policies — no policy change.

ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS hero_image_alt     text,
  ADD COLUMN IF NOT EXISTS hero_image_caption text,
  ADD COLUMN IF NOT EXISTS hero_image_credit  text,
  ADD COLUMN IF NOT EXISTS hero_image_width   integer,
  ADD COLUMN IF NOT EXISTS hero_image_height  integer,
  ADD COLUMN IF NOT EXISTS inline_images      jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.blog_posts.hero_image_alt IS
  'Concise, descriptive, keyword-aware alt text for the hero image (US-876). '
  'Generated at hero-generation time and stored; the SSR never ships an empty alt.';
COMMENT ON COLUMN public.blog_posts.hero_image_caption IS
  'Optional human caption rendered as <figcaption> under the hero (US-876).';
COMMENT ON COLUMN public.blog_posts.hero_image_credit IS
  'Optional image credit / attribution line for the hero (US-876).';
COMMENT ON COLUMN public.blog_posts.hero_image_width IS
  'Hero image pixel width — feeds the ImageObject JSON-LD width (US-876).';
COMMENT ON COLUMN public.blog_posts.hero_image_height IS
  'Hero image pixel height — feeds the ImageObject JSON-LD height (US-876).';
COMMENT ON COLUMN public.blog_posts.inline_images IS
  'Per-body-image SEO metadata (US-876): jsonb array of '
  '{ src, alt, caption, width, height }. Keyed by the image public URL; the blog '
  'SSR applies the stored alt/caption when rewriting in-body <img> tags.';
