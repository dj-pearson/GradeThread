-- US-1852: QUESTS — short, repeating personal goals, and time-boxed community
-- challenges.
--
-- Levels are identity (US-1851) and seasons are the quarter-long clock. Quests
-- are the WEEK: a small, always-fresh reason to open the app, finish one more
-- item properly, and share it. Two tables land here and they are different kinds
-- of thing on purpose:
--
--   1. reward_quests — the CONFIG. Admin-authored definitions (criteria, window,
--      reward) with a per-quest kill-switch. Deny-all RLS: this is operator
--      config, the SPA only ever sees it through /api/rewards/quests, and a
--      client-writable quest definition would be a client-writable XP faucet.
--
--   2. user_quest_progress — the per-user COMPLETION RECORD. Read-own RLS.
--
-- What is deliberately NOT here: a quest event ledger. US-1849's one-ledger rule
-- still holds — quest PROGRESS is derived live from reputation_events, exactly
-- like season progress is. user_quest_progress stores only the snapshot and the
-- completion claim, so it can be dropped and rebuilt from the log at any time.
-- UNIQUE (user_id, quest_id, period_key) is what makes a repeating quest pay
-- once per window rather than once per read.
--
-- The XP a quest awards is admin-configurable, which is a faucet, so it is
-- bounded in two independent places: this CHECK caps xp_reward at 200 (below
-- badge_embedded's 50 × 4, i.e. a quest can never out-earn a real week of moat
-- acts), and the edge clamps it again when scoring the event. The amount is
-- frozen into the reputation_events row at grant time, so editing a quest later
-- never retroactively rewrites what someone already earned.

-- ── The quest_completed event type ──────────────────────────────────────────
-- Re-stated in full (the 00443 precedent) so the allow-list is authoritative and
-- the statement re-runnable.
ALTER TABLE public.reputation_events
  DROP CONSTRAINT IF EXISTS reputation_events_event_type_check;
ALTER TABLE public.reputation_events
  ADD CONSTRAINT reputation_events_event_type_check CHECK (event_type IN (
    -- US-1816 buyer Trust Score types:
    'verified_purchase', 'grade_confirmed', 'dispute_upheld',
    'dispute_overturned', 'chargeback_penalty', 'tenure',
    -- US-1849 reward-only types:
    'coverage_completed', 'badge_embedded', 'aspects_filled',
    'marketplace_connected', 'verified_share',
    -- US-1852: quest completion. Unlike every type above, its XP is VARIABLE —
    -- the awarded amount rides in metadata.quest_xp, clamped by the edge.
    'quest_completed'
  ));

-- ── 1. Quest definitions (operator config) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reward_quests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable slug. Also half the idempotency key on a completion, so renaming a
  -- quest's key starts a fresh quest rather than editing history.
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  quest_type  text NOT NULL DEFAULT 'personal'
    CHECK (quest_type IN ('personal', 'community')),
  -- The reward event type counted, or 'xp' for a raw XP goal. 'quest_completed'
  -- is deliberately absent: a quest that counts quest completions would let a
  -- pair of cheap quests bootstrap each other.
  metric      text NOT NULL CHECK (metric IN (
    'coverage_completed', 'badge_embedded', 'aspects_filled',
    'marketplace_connected', 'verified_share', 'verified_purchase',
    'grade_confirmed', 'xp'
  )),
  target      integer NOT NULL CHECK (target > 0),
  -- 'weekly'/'monthly' repeat forever inside their calendar window; 'fixed' runs
  -- once between starts_at and ends_at.
  cadence     text NOT NULL DEFAULT 'weekly'
    CHECK (cadence IN ('weekly', 'monthly', 'fixed')),
  starts_at   timestamptz,
  ends_at     timestamptz,
  -- XP paid on completion. Capped here AND clamped in the scorer.
  xp_reward   integer NOT NULL DEFAULT 0 CHECK (xp_reward >= 0 AND xp_reward <= 200),
  icon        text NOT NULL DEFAULT 'Target',
  -- Per-quest kill-switch. Flipping this off retires a quest without deleting
  -- the completions people already earned from it.
  enabled     boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 100,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- A community challenge is time-boxed BY DEFINITION ("best thrift find of the
  -- month"): it has to close so its standings can be final. A repeating one
  -- would be a leaderboard, not a challenge.
  CONSTRAINT reward_quests_community_is_fixed CHECK (
    quest_type <> 'community'
    OR (cadence = 'fixed' AND starts_at IS NOT NULL AND ends_at IS NOT NULL)
  ),
  CONSTRAINT reward_quests_fixed_has_window CHECK (
    cadence <> 'fixed' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL)
  ),
  CONSTRAINT reward_quests_window_ordered CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
  )
);

-- The read path loads every live quest on each rewards view.
CREATE INDEX IF NOT EXISTS idx_reward_quests_enabled
  ON public.reward_quests(quest_type, sort_order)
  WHERE enabled = true;

DROP TRIGGER IF EXISTS set_reward_quests_updated_at ON public.reward_quests;
CREATE TRIGGER set_reward_quests_updated_at
  BEFORE UPDATE ON public.reward_quests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Deny-all: RLS on, zero policies. Operator config, service-role only.
ALTER TABLE public.reward_quests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.reward_quests IS
  'US-1852: admin-configured quest/challenge definitions. Deny-all RLS — the SPA '
  'reads them only through /api/rewards/quests and writes them only through '
  '/api/admin/rewards/quests.';

-- ── 2. Per-user progress + completion claim ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_quest_progress (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  quest_id    uuid NOT NULL REFERENCES public.reward_quests(id) ON DELETE CASCADE,
  -- Denormalized so a completion stays readable after the quest is retired.
  quest_key   text NOT NULL,
  -- Which INSTANCE of a repeating quest this row is: '2026-W32', '2026-08', or
  -- 'fixed' for a one-shot. This is what makes a weekly quest pay every week and
  -- only once a week.
  period_key  text NOT NULL,
  progress    integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  target      integer NOT NULL DEFAULT 1 CHECK (target > 0),
  completed_at timestamptz,
  xp_awarded  integer NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, quest_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_user_quest_progress_user
  ON public.user_quest_progress(user_id, updated_at DESC);

DROP TRIGGER IF EXISTS set_user_quest_progress_updated_at ON public.user_quest_progress;
CREATE TRIGGER set_user_quest_progress_updated_at
  BEFORE UPDATE ON public.user_quest_progress
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.user_quest_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own quest progress" ON public.user_quest_progress;
CREATE POLICY "Users read own quest progress"
  ON public.user_quest_progress FOR SELECT
  -- US-1927: (select auth.uid()) so the planner hoists it to one InitPlan
  -- instead of re-evaluating it per row.
  USING ((select auth.uid()) = user_id);

-- ── 3. Global kill-switch ───────────────────────────────────────────────────
-- Seeded ON and read fail-OPEN, unlike rewards_tangible. Quests pay XP, which is
-- free status — an outage that silently stopped everyone's quest progress would
-- do more damage than one that kept paying it. The money rail downstream
-- (rewards-tangible.ts) has its own fail-CLOSED flag and budget, so an XP faucet
-- here still cannot spend a dollar.
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'rewards_quests',
  true,
  'US-1852: master switch for quests and time-boxed community challenges. Off = '
  'no quest progress is evaluated and no quest XP is awarded; levels, seasons '
  'and badges are unaffected. Individual quests also have their own `enabled` '
  'column — use that to retire one quest rather than this to stop them all.'
)
ON CONFLICT (key) DO NOTHING;

-- ── 4. Starter personal quests ──────────────────────────────────────────────
-- The AC's three examples, mapped onto metrics the reward ledger actually emits.
-- "Add measurements to 5 items" becomes item specifics, because that is the
-- listing-quality act the ledger records (`aspects_filled`) — a quest whose
-- metric nothing emits is a quest nobody can finish.
--
-- XP is set well under what the underlying acts already pay, so a quest is a
-- nudge toward work that was already worth doing, never a reason to do the work
-- twice.
INSERT INTO public.reward_quests
  (key, name, description, quest_type, metric, target, cadence, xp_reward, icon, sort_order)
VALUES
  ('week_grade_3', 'Grade three items',
   'Grade 3 items with full photo coverage this week.',
   'personal', 'coverage_completed', 3, 'weekly', 30, 'Camera', 10),
  ('week_share_1', 'Share one find',
   'Share 1 verified grade this week.',
   'personal', 'verified_share', 1, 'weekly', 15, 'Share2', 20),
  ('week_aspects_5', 'Finish five listings',
   'Fill the item specifics on 5 listings this week.',
   'personal', 'aspects_filled', 5, 'weekly', 20, 'ListChecks', 30),
  ('month_badge_1', 'Spread the grade',
   'Get a grade badge embedded off GradeThread this month.',
   'personal', 'badge_embedded', 1, 'monthly', 40, 'Globe', 40)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00543')
ON CONFLICT (version) DO NOTHING;
