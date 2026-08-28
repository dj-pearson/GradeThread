-- US-2973: don't show an "arrival" moment for a level someone already knows about.
--
-- user_reward_state.arrival_seen_level (00679) is NULL for everyone right now,
-- and the arrival screen fires on NULL. Left alone, the first seller to open the
-- rewards page after this ships gets a "your work counted, you're a Curator"
-- celebration for a level they have been looking at for weeks.
--
-- This is the same trap detectCelebrations() guards with `if (!prev) return []`:
-- a first read is a BASELINE, not an achievement.
--
-- So baseline the people who already have one. A row with xp_total > 0 belongs
-- to someone who earned through the normal UI and has seen their level there.
-- A row at xp_total = 0 is either brand new or was seeded by 00680 for a seller
-- whose months of listing earned nothing yet — those are exactly the sellers the
-- backfill is about to light up, and they SHOULD get the moment.
--
-- Idempotent: re-running matches nothing, because the first run left no NULLs
-- among the xp_total > 0 rows.
UPDATE public.user_reward_state
SET arrival_seen_level = level
WHERE xp_total > 0
  AND arrival_seen_level IS NULL;

COMMENT ON COLUMN public.user_reward_state.arrival_seen_level IS
  'US-2973: the level whose arrival celebration this seller has acknowledged. '
  'NULL means never shown. Server-side rather than localStorage so the one-time '
  'backfill moment does not re-fire on the seller''s next device.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00681') ON CONFLICT DO NOTHING;
