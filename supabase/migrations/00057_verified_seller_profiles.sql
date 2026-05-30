-- GradeThread Verified — public seller trust profiles.
--
-- Turns a seller's accumulated grade certificates into a portable, buyer-facing
-- reputation surface at gradethread.com/verified/<handle>. The grade is already
-- a defensible, standardized signal; this lets a reseller claim a public handle
-- and aggregate every certified grade they've earned into a single trust page
-- they can link from eBay / Poshmark / Mercari / Depop / Grailed listings.
--
-- All public reads are served by the edge service (service-role, RLS-bypassing)
-- via /api/content/public/sellers/* — which hard-filters to verified_enabled
-- profiles and certified (public) reports only. We therefore add NO public RLS
-- to the locked-down users table; the new columns stay readable only by the
-- owner (existing "Users can view own profile" policy) and the service role.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS verified_handle       text,
  ADD COLUMN IF NOT EXISTS verified_display_name text,
  ADD COLUMN IF NOT EXISTS verified_bio          text,
  ADD COLUMN IF NOT EXISTS verified_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_since        timestamptz;

COMMENT ON COLUMN public.users.verified_handle IS
  'Public slug for the GradeThread Verified seller profile (/verified/<handle>). '
  'Lowercase a-z, 0-9 and hyphens, 3-30 chars. Unique (case-insensitive).';
COMMENT ON COLUMN public.users.verified_enabled IS
  'When true, the seller profile is publicly visible. Defaults off so claiming a '
  'handle and going public are deliberate, separate steps.';
COMMENT ON COLUMN public.users.verified_since IS
  'First time the profile was made public — drives the "Verified since" badge.';

-- Handle format guard (mirrors the edge + client validation). NULL is allowed
-- (handle not yet claimed); a present handle must match the slug shape.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_verified_handle_format;
ALTER TABLE public.users
  ADD CONSTRAINT users_verified_handle_format
  CHECK (
    verified_handle IS NULL
    OR verified_handle ~ '^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$'
  );

-- Case-insensitive uniqueness. We store handles already-lowercased, but guard
-- with lower() so a future mixed-case write can't slip a duplicate past us.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_verified_handle
  ON public.users (lower(verified_handle))
  WHERE verified_handle IS NOT NULL;

-- A profile is only worth listing/serving when it's public.
CREATE INDEX IF NOT EXISTS idx_users_verified_enabled
  ON public.users (verified_enabled)
  WHERE verified_enabled = true;
