-- US-1914: LOYALTY — tenure tiers, anniversary rewards, never-decay standing.
--
-- The rest of the reward system measures ACTIVITY, and every part of it is
-- time-windowed on purpose: a season is a quarter, a quest is a week, a nudge
-- looks at the last few days. This migration adds the other axis, and the whole
-- point is that it is NOT windowed. Being a customer for three years is a fact
-- about the past that a quiet month cannot revise.
--
-- Three objects, each answering one failure the activity system cannot:
--
--   1. reward_tenure_tiers — the operator-editable tenure ladder. A tier is
--      earned by ACCOUNT AGE plus LIFETIME PAID ENGAGEMENT (paid months, read
--      from the credit ledger), and it carries a credit MULTIPLIER applied to
--      milestone-granted credits. The multiplier has a CHECK floor of 1.00: a
--      "loyalty" multiplier that could go below 1 would be a loyalty penalty,
--      and a config table with no floor is one where a typo becomes one.
--
--   2. user_loyalty_state — the never-decay record. tier_rank_peak is the
--      high-water mark, exactly like user_reward_state.xp_peak (00542): the
--      inputs to a tier can move (an operator raises a threshold, the paid-month
--      read fails, a ledger row is erased) and none of those may demote anyone.
--      Standing is granted, never rented. anniversary_due_at is what makes the
--      sweep a bounded query instead of a scan of every account.
--
--   3. An 'anniversary' trigger type for the US-1853 milestone catalog, so the
--      annual gift rides the SAME rail as every other tangible reward — the same
--      claim-before-pay idempotency, the same USD ceilings, the same US-1858
--      guardrails. A second payout path with its own budget would be a second
--      thing to forget to cap.
--
-- Deliberately NOT here: any notion of decay, lapse, reset, or a "days since
-- last active" column. There is no state this file can hold that would let a
-- later feature take standing away, because the schema is where that promise is
-- either kept or quietly broken. See vault/20-domain/reward-ledger.md.

-- ── 1. The tenure ladder ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reward_tenure_tiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,
  label         text NOT NULL,
  blurb         text NOT NULL DEFAULT '',

  -- Position on the ladder. This is what "never decays" is checked against, so
  -- it is the stored number rather than something re-derived from thresholds —
  -- an operator editing min_months must not be able to move anyone down.
  tier_rank     integer NOT NULL UNIQUE CHECK (tier_rank >= 0),

  -- Whole months since the account was created.
  min_months    integer NOT NULL DEFAULT 0 CHECK (min_months >= 0),
  -- Distinct calendar months in which this account received PAID credits (a
  -- pack purchase or a plan's included grant). Both thresholds must be met: a
  -- three-year free account is long-tenured but not a paying customer, and
  -- saying otherwise would make the ladder mean nothing.
  min_paid_months integer NOT NULL DEFAULT 0 CHECK (min_paid_months >= 0),

  -- Applied to milestone-granted CREDITS (US-1853). Floored at 1.00 so this can
  -- only ever be a reward, and ceilinged at 5.00 so a fat-fingered edit cannot
  -- multiply the platform's whole reward budget away in one grant pass. The USD
  -- ceilings still bind on top of it — the multiplied cost is what they see.
  credit_multiplier numeric(4, 2) NOT NULL DEFAULT 1.00
    CHECK (credit_multiplier >= 1.00 AND credit_multiplier <= 5.00),

  enabled       boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_tenure_tiers_enabled
  ON public.reward_tenure_tiers(enabled, tier_rank);

ALTER TABLE public.reward_tenure_tiers ENABLE ROW LEVEL SECURITY;
-- Deliberately ZERO policies, same posture as reward_milestones (00544): this is
-- operator config that multiplies real value, so a client-writable row would be
-- a client-writable money faucet. Read by the engine with the service-role
-- client and by the SPA only through /api/admin/rewards/tenure-tiers.
-- Registered in rls-guard_test.ts SERVICE_ROLE_ONLY + SERVICE_ONLY_FORCED — it
-- has no owner column, so discovery would otherwise never look at it.
REVOKE ALL ON public.reward_tenure_tiers FROM anon, authenticated;

DROP TRIGGER IF EXISTS set_reward_tenure_tiers_updated_at ON public.reward_tenure_tiers;
CREATE TRIGGER set_reward_tenure_tiers_updated_at
  BEFORE UPDATE ON public.reward_tenure_tiers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The shipped ladder. Rank 0 is everybody's starting standing and multiplies by
-- 1.00 — it exists so "your tenure tier" is always a real answer rather than a
-- null the UI has to apologise for.
INSERT INTO public.reward_tenure_tiers
  (key, label, blurb, tier_rank, min_months, min_paid_months, credit_multiplier, sort_order)
VALUES
  ('newcomer',  'Member',      'Welcome aboard. Your standing starts here and only ever goes up.',
   0,  0,  0, 1.00, 10),
  ('year_one',  'One year in', 'A year with GradeThread. Milestone credits come through 10% larger.',
   1, 12,  3, 1.10, 20),
  ('year_two',  'Two years in','Two years and counting. Milestone credits come through 20% larger.',
   2, 24,  9, 1.20, 30),
  ('veteran',   'Veteran',     'Three years of graded finds. Milestone credits come through 35% larger.',
   3, 36, 18, 1.35, 40)
ON CONFLICT (key) DO NOTHING;

-- ── 2. The never-decay record ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_loyalty_state (
  user_id           uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  -- Copied from users.created_at so the sweep and the "member since" flair read
  -- one row. It is the same fact; duplicating it here is what keeps the
  -- anniversary query an index scan.
  member_since      timestamptz NOT NULL,
  -- HIGH-WATER MARK. Never written downwards — see the CHECK-by-construction in
  -- lib/rewards-loyalty.ts (ascendOnly) and the guard test beside it.
  tier_rank_peak    integer NOT NULL DEFAULT 0 CHECK (tier_rank_peak >= 0),
  tier_key_peak     text    NOT NULL DEFAULT 'newcomer',
  tier_reached_at   timestamptz NOT NULL DEFAULT now(),
  -- The highest completed account-year already celebrated. 0 = none yet.
  last_anniversary_year integer NOT NULL DEFAULT 0 CHECK (last_anniversary_year >= 0),
  -- The next anniversary instant. Bounded sweep: `WHERE anniversary_due_at <= now()`.
  anniversary_due_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_loyalty_state_anniversary
  ON public.user_loyalty_state(anniversary_due_at)
  WHERE anniversary_due_at IS NOT NULL;

ALTER TABLE public.user_loyalty_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own loyalty state" ON public.user_loyalty_state;
CREATE POLICY "Users read own loyalty state"
  ON public.user_loyalty_state FOR SELECT
  -- US-1927: (select auth.uid()) so the planner hoists it to one InitPlan
  -- instead of re-evaluating it per row.
  USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS set_user_loyalty_state_updated_at ON public.user_loyalty_state;
CREATE TRIGGER set_user_loyalty_state_updated_at
  BEFORE UPDATE ON public.user_loyalty_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN public.user_loyalty_state.tier_rank_peak IS
  'US-1914: high-water mark of the tenure tier rank. Tenure standing NEVER '
  'decays — an operator raising a threshold, a failed paid-months read or an '
  'erased ledger row must not demote anyone. Only ever moves up.';

-- Every account gets a row, seeded from its own creation date. A new signup gets
-- one from the trigger below; everybody who already exists gets one here.
INSERT INTO public.user_loyalty_state (user_id, member_since, anniversary_due_at)
SELECT u.id, u.created_at, u.created_at + interval '1 year'
  FROM public.users u
ON CONFLICT (user_id) DO NOTHING;

-- Pull each backfilled row's anniversary forward to the next one still ahead, so
-- a five-year account does not immediately look four anniversaries overdue. The
-- gift is for the NEXT anniversary; back-paying four years of them on deploy day
-- would empty the reward budget on people who were never told to expect it.
UPDATE public.user_loyalty_state s
   SET last_anniversary_year = GREATEST(
         s.last_anniversary_year,
         FLOOR(EXTRACT(EPOCH FROM (now() - s.member_since)) / 31557600)::int
       ),
       anniversary_due_at = s.member_since + make_interval(
         years => FLOOR(EXTRACT(EPOCH FROM (now() - s.member_since)) / 31557600)::int + 1
       )
 WHERE s.anniversary_due_at IS NOT NULL
   AND s.anniversary_due_at <= now();

CREATE OR REPLACE FUNCTION public.seed_user_loyalty_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_loyalty_state (user_id, member_since, anniversary_due_at)
  VALUES (NEW.id, NEW.created_at, NEW.created_at + interval '1 year')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_loyalty_state_on_user ON public.users;
CREATE TRIGGER seed_loyalty_state_on_user
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.seed_user_loyalty_state();

-- ── 3. The anniversary trigger type on the milestone catalog ────────────────
-- Widening a CHECK, not adding a table: the annual gift is a milestone like any
-- other, so it inherits claim-before-pay, the USD ceilings, the velocity limit
-- and the fraud hold for free. The per-year instance key (`<key>:y<N>`) is what
-- makes UNIQUE (user_id, milestone_key) mean "once per anniversary" rather than
-- "once, ever" — see anniversaryInstance() in lib/rewards-loyalty.ts.
ALTER TABLE public.reward_milestones
  DROP CONSTRAINT IF EXISTS reward_milestones_trigger_type_check;
ALTER TABLE public.reward_milestones
  ADD CONSTRAINT reward_milestones_trigger_type_check CHECK (
    trigger_type IN ('xp_threshold', 'badge', 'season_goal', 'anniversary')
  );

INSERT INTO public.reward_milestones
  (key, label, description, reward_type, trigger_type, trigger_key, reward_value,
   cost_usd, monthly_grant_cap, lifetime_grant_cap, enabled, sort_order)
VALUES
  (
    'anniversary_gift',
    'Anniversary free grade',
    'Every year you have been a member, on the day you joined.',
    'free_grade_credits', 'anniversary', 'account', 1,
    0.35, NULL, NULL, true, 80
  )
ON CONFLICT (key) DO NOTHING;

-- ── 4. The comeback nudge ───────────────────────────────────────────────────
-- A fifth nudge type for people who have been away. It is the ONLY nudge that
-- fires on absence with nothing at stake, which is exactly why its copy leads
-- with what is preserved rather than with what is slipping: there is no streak
-- to lose here and the system must never imply there is.
ALTER TABLE public.reward_nudge_sends
  DROP CONSTRAINT IF EXISTS reward_nudge_sends_nudge_type_check;
ALTER TABLE public.reward_nudge_sends
  ADD CONSTRAINT reward_nudge_sends_nudge_type_check CHECK (
    nudge_type IN (
      'streak_at_risk',
      'badge_near_miss',
      'quest_new',
      'quest_expiring',
      'reward_available',
      'comeback'
    )
  );

-- ── 5. Operator switches ────────────────────────────────────────────────────
-- value_type must be one of number|bool|string|json (00208 check constraint).
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'rewards_loyalty_config',
  jsonb_build_object(
    'enabled', true,
    'multiplier_enabled', true,
    'anniversary_enabled', true,
    'anniversary_window_days', 14,
    'comeback_quiet_days', 45
  ),
  'json',
  jsonb_build_object(
    'enabled', true,
    'multiplier_enabled', true,
    'anniversary_enabled', true,
    'anniversary_window_days', 14,
    'comeback_quiet_days', 45
  ),
  'rewards',
  'US-1914: loyalty switches. `multiplier_enabled` turns the tenure credit '
  'multiplier off without editing every tier; `anniversary_enabled` pauses the '
  'annual gift; `anniversary_window_days` is how long after the date a missed '
  'sweep may still deliver it; `comeback_quiet_days` is how long an account must '
  'have been quiet before a comeback nudge is honest. Nothing here can reduce a '
  'tenure tier — there is no decay switch, by design.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00557')
ON CONFLICT (version) DO NOTHING;
