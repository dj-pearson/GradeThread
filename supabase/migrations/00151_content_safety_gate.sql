-- US-486: Gate content auto-publish behind a safety/claims check.
--
-- The scheduler's auto-publish path previously took AI drafts live with only
-- sanitizeHtml between generation and the public site. This migration adds:
--   1. A kill-switch (publishing_paused) that halts ALL scheduler-driven
--      publishing (auto-publish AND scheduled-draft promotion).
--   2. A hard weekly rate ceiling on autonomous publishes, independent of the
--      per-day cadence settings (guards against cadence misconfiguration).
--   3. Per-post safety-review state so a held post is visibly held (with the
--      reviewer's reasons) rather than silently stuck in 'draft'.
--
-- Human-initiated publishes (dashboard publish button, admin-scheduled posts)
-- are NOT gated — a human in the loop IS the approval state. Only the fully
-- autonomous tick path runs the safety check.

-- ── Safety review state ────────────────────────────────────
-- 'unchecked': never reviewed (default; all human-authored + pre-existing rows)
-- 'passed':    reviewed by the safety check and cleared for auto-publish
-- 'held':      reviewed and HELD — stays in draft until a human edits/publishes
CREATE TYPE public.content_safety_status AS ENUM ('unchecked', 'passed', 'held');

ALTER TABLE public.blog_posts
  ADD COLUMN safety_status      public.content_safety_status NOT NULL DEFAULT 'unchecked',
  ADD COLUMN safety_notes       text,
  ADD COLUMN safety_checked_at  timestamptz;

ALTER TABLE public.social_posts
  ADD COLUMN safety_status      public.content_safety_status NOT NULL DEFAULT 'unchecked',
  ADD COLUMN safety_notes       text,
  ADD COLUMN safety_checked_at  timestamptz;

-- ── Kill-switch + weekly ceiling ───────────────────────────
ALTER TABLE public.content_settings
  ADD COLUMN publishing_paused           boolean NOT NULL DEFAULT false,
  ADD COLUMN max_auto_publishes_per_week integer NOT NULL DEFAULT 10
    CHECK (max_auto_publishes_per_week >= 0);
