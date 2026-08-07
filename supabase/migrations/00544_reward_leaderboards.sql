-- US-1856: opt-in for the public REWARD LEADERBOARDS (XP, grades, finds, shares).
--
-- Two columns on `users`, edge-written (service role) via /api/rewards/leaderboard
-- — never a client self-update, so the users self-update guard is untouched.
--
-- WHY A THIRD OPT-IN rather than reusing 00195's referral flag or 00423's buyer
-- one. Each existing toggle's copy names what it publishes: the referral board
-- shows an alias plus a granted-referral count, the buyer board an alias plus a
-- confirmation count. The reward boards publish something neither of those
-- sentences covers — XP, graded volume, and reaction counts — and XP in
-- particular is deliberately withheld from the public verified profile
-- (publicLevelFlair drops it, because how much someone grades is their business
-- metric). Folding a new disclosure under an old toggle makes a sentence someone
-- already agreed to retroactively false. New data ⇒ new toggle.
--
-- The ALIAS is nullable on purpose: the resolver falls back to the aliases the
-- user has already chosen (verified display name → referral alias → buyer alias),
-- so opting in is one click for anyone who already runs a public surface. Only
-- the resolved alias and a rank are ever published; no email, real name or user
-- id leaves the boards, which hard-filter to leaderboard_opt_in = true. There is
-- therefore NO public RLS here — the service-role edge is the only reader.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS leaderboard_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS leaderboard_alias  text;

COMMENT ON COLUMN public.users.leaderboard_opt_in IS
  'US-1856: when true, the seller appears on the public reward leaderboards '
  '(XP, grades, finds, share-driven signups). Defaults off — joining a '
  'competitive board is a deliberate opt-in, separate from the referral (00195) '
  'and buyer (00423) boards because it publishes different numbers.';
COMMENT ON COLUMN public.users.leaderboard_alias IS
  'US-1856: PII-free alias shown on the reward leaderboards. NULL falls back to '
  'the verified display name, then the referral alias, then the buyer alias.';

-- Only opted-in rows are ever scanned — index the small public cohort.
CREATE INDEX IF NOT EXISTS idx_users_leaderboard_opt_in
  ON public.users (leaderboard_opt_in)
  WHERE leaderboard_opt_in = true;

-- The finds board counts reactions per showcased find and must exclude the
-- owner's own reaction (see lib/leaderboards-data.ts). That scan reads
-- showcase_reactions by report AND by reactor, so index the reactor side too —
-- 00543 indexed (grade_report_id, created_at) and (user_id, grade_report_id),
-- neither of which serves "who reacted to this set of reports" cheaply.
CREATE INDEX IF NOT EXISTS idx_showcase_reactions_report_user
  ON public.showcase_reactions (grade_report_id, user_id);

-- Weekly boards filter granted referrals by when the reward landed.
CREATE INDEX IF NOT EXISTS idx_referral_events_granted_at
  ON public.referral_events (granted_at DESC)
  WHERE reward_status = 'granted';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00544')
ON CONFLICT (version) DO NOTHING;
