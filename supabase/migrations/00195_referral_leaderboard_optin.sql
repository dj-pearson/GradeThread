-- US-864: opt-in public "top referrers" leaderboard.
--
-- Closes the referral reward loop with a little public competition. Two new
-- columns on users:
--   • referral_leaderboard_enabled — opt-in flag (default off, like the verified
--     seller profile: appearing publicly is a deliberate choice).
--   • referral_display_name — a PII-free alias shown on the board. The leaderboard
--     renders ONLY this alias + a granted-referral count; no email/real name/id
--     ever leaves the public feed.
--
-- Public reads are served by the edge service (service-role, RLS-bypassing) via
-- /api/content/public/referral-leaderboard.json, which hard-filters to
-- referral_leaderboard_enabled = true. We therefore add NO public RLS to the
-- locked-down users table; the new columns stay readable only by the owner
-- (existing "Users can view own profile" policy) and the service role.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS referral_leaderboard_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS referral_display_name        text;

COMMENT ON COLUMN public.users.referral_leaderboard_enabled IS
  'When true, the user appears on the public top-referrers leaderboard (US-864). '
  'Defaults off so joining the board is a deliberate opt-in.';
COMMENT ON COLUMN public.users.referral_display_name IS
  'PII-free public alias shown on the referral leaderboard. The only identity '
  'surfaced there — required before the profile can go public.';

-- Only opted-in rows are ever listed/served — index the small public cohort.
CREATE INDEX IF NOT EXISTS idx_users_referral_leaderboard_enabled
  ON public.users (referral_leaderboard_enabled)
  WHERE referral_leaderboard_enabled = true;
