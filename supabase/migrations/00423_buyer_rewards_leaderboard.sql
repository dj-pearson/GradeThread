-- US-1814: buyer rewards leaderboard opt-in (mirrors the referral leaderboard,
-- migration 00195).
--
-- Two columns on `users`, both edge-written (service role) via the buyer rewards
-- opt-in route — never client self-update, so the users self-update guard is
-- untouched:
--   • rewards_leaderboard_enabled — opt-in flag (default off; joining the board
--     is a deliberate opt-in).
--   • rewards_display_name — a PII-free alias shown on the board. The confirmer
--     leaderboard renders ONLY this alias + the buyer's confirmation count — no
--     email, real name, or user id ever leaves the feed, which hard-filters to
--     rewards_leaderboard_enabled = true. We therefore add NO public RLS here.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS rewards_leaderboard_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rewards_display_name        text;

COMMENT ON COLUMN public.users.rewards_leaderboard_enabled IS
  'When true, the buyer appears on the confirmer rewards leaderboard (US-1814). '
  'Defaults off so joining the board is a deliberate opt-in.';
COMMENT ON COLUMN public.users.rewards_display_name IS
  'PII-free alias shown on the rewards leaderboard (US-1814). Never an email/real name.';

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00423')
ON CONFLICT (version) DO NOTHING;
