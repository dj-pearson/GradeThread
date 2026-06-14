-- US-875: Content freshness loop.
--
-- Content decay quietly loses rankings; Google rewards genuine updates. This
-- migration gives the autonomous engine what it needs to keep high-value posts
-- fresh:
--   1. blog_posts.last_refreshed_at — when the freshness job last MATERIALLY
--      refreshed (or last touched, on a trivial-skip) this post. NULL means
--      "never refreshed since publish", so the staleness selector falls back to
--      published_at. refresh_count is a cheap observability counter.
--   2. A stale-but-important selector index on COALESCE(last_refreshed_at,
--      published_at) restricted to published posts, so "oldest published/refreshed
--      first" is an index scan, not a full-table sort.
--   3. content_settings knobs: a kill-switch + the configurable thrash-guard
--      window (don't refresh a post more than once per cooldown) and the minimum
--      age a post must reach before it's eligible to refresh at all.
--
-- All columns are nullable / defaulted so existing posts render unchanged. The
-- freshness job (POST /api/jobs/content-refresh) is the sole writer; reads stay
-- admin-only via the existing blog_posts RLS policies — no policy change needed.

-- ── blog_posts freshness signals ──────────────────────────────
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS refresh_count     integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.blog_posts.last_refreshed_at IS
  'When the content-refresh job last refreshed (or last evaluated, on a trivial '
  'skip) this post (US-875). NULL = never refreshed; selector falls back to '
  'published_at. Doubles as the thrash-guard cooldown anchor.';
COMMENT ON COLUMN public.blog_posts.refresh_count IS
  'Number of MATERIAL refreshes applied by the content-refresh job (US-875).';

-- Stale-but-important selector: the freshness job orders published posts by the
-- effective freshness anchor (last_refreshed_at when refreshed, else
-- published_at) ascending — oldest first. A partial expression index makes that
-- ordering an index scan.
CREATE INDEX IF NOT EXISTS idx_blog_posts_freshness
  ON public.blog_posts ((COALESCE(last_refreshed_at, published_at)))
  WHERE status = 'published';

-- ── content_settings: freshness knobs ─────────────────────────
ALTER TABLE public.content_settings
  ADD COLUMN IF NOT EXISTS auto_refresh_enabled           boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS content_refresh_cooldown_days   integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS content_refresh_min_stale_days  integer NOT NULL DEFAULT 30;

COMMENT ON COLUMN public.content_settings.auto_refresh_enabled IS
  'Kill-switch for the autonomous content-freshness job (US-875). When false the '
  'job no-ops (records a benign skip).';
COMMENT ON COLUMN public.content_settings.content_refresh_cooldown_days IS
  'Thrash guard (US-875): a post is not refreshed more than once per this many '
  'days. The selector excludes posts whose last_refreshed_at is within the window.';
COMMENT ON COLUMN public.content_settings.content_refresh_min_stale_days IS
  'Minimum age since the freshness anchor before a published post is eligible to '
  'refresh at all (US-875) — keeps brand-new posts out of the refresh pool.';
