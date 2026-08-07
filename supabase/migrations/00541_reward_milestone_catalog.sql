-- US-1853: the milestone-rewards CATALOG, and the two discount reward types.
--
-- US-1848 built the rail (reward_tangible_grants, the budget ceilings, the
-- claim-before-pay idempotency) but hard-coded the ladder in TypeScript and
-- registered a fulfiller for exactly one reward type. This migration finishes it:
--
--   • reward_milestones — the operator-editable catalog. reward_type, a TRIGGER
--     (XP threshold | badge | season goal), a value, and its own monthly +
--     lifetime issue caps. Editing the ladder stops being a deploy.
--   • reward_tangible_grants gains expires_at + consumed_at, which is what the
--     two discount types need and credits do not: a per-grade discount is a
--     time-boxed entitlement, and a subscription coupon is consumed exactly once
--     at the checkout that redeems it.
--
-- The rule the whole epic turns on is unchanged and is why there is no "spend"
-- column anywhere here: XP IS NEVER DEBITED. A milestone is a threshold crossed,
-- not a purchase. Levels and leaderboard rank can therefore never go backwards
-- for redeeming, which is the failure mode the spend-XP design had.
--
-- The caps below are per-MILESTONE and GLOBAL on purpose. A per-user cap would
-- be dead weight — UNIQUE (user_id, milestone_key) already bounds every user to
-- one grant of each milestone — while the number that actually needs bounding is
-- how many of a given reward the platform issues before an operator looks at it
-- again. Per-user spend is bounded separately, in USD, by rewards_tangible_budget.

CREATE TABLE IF NOT EXISTS public.reward_milestones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable catalog key. This IS the idempotency key on the grant row, so it is
  -- immutable once anything has been granted against it (enforced in the route).
  key           text NOT NULL UNIQUE,
  label         text NOT NULL,
  description   text NOT NULL DEFAULT '',

  reward_type   text NOT NULL CHECK (
    reward_type IN ('free_grade_credits', 'subscription_discount', 'per_grade_discount')
  ),
  -- What unlocks it. 'xp_threshold' reads xp_threshold; the other two read
  -- trigger_key (a rewards-badges.ts badge key / a rewards-seasons.ts goal key).
  trigger_type  text NOT NULL DEFAULT 'xp_threshold' CHECK (
    trigger_type IN ('xp_threshold', 'badge', 'season_goal')
  ),
  xp_threshold  integer CHECK (xp_threshold IS NULL OR xp_threshold >= 0),
  trigger_key   text,

  -- Credits (a whole count) or a discount percent, per reward_type.
  reward_value  numeric(10, 2) NOT NULL CHECK (reward_value > 0),
  -- GradeThread's marginal cost of honouring one grant, in USD. The budget
  -- ceilings are denominated in this, so it protects margin rather than list
  -- price. A discount's cost is the revenue given up, entered by the operator.
  cost_usd      numeric(10, 2) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),

  -- How many months a subscription coupon repeats for (NULL = one invoice).
  discount_duration_months integer CHECK (
    discount_duration_months IS NULL OR discount_duration_months BETWEEN 1 AND 12
  ),
  -- How long a per-grade discount stays live after it is granted (NULL = 90d
  -- default in the engine). An entitlement with no end is a permanent price cut.
  discount_valid_days integer CHECK (
    discount_valid_days IS NULL OR discount_valid_days BETWEEN 1 AND 730
  ),

  -- Platform-wide issue caps for THIS milestone. NULL = uncapped (the USD budget
  -- still applies — these narrow it, they never widen it).
  monthly_grant_cap  integer CHECK (monthly_grant_cap IS NULL OR monthly_grant_cap > 0),
  lifetime_grant_cap integer CHECK (lifetime_grant_cap IS NULL OR lifetime_grant_cap > 0),

  enabled       boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 100,
  created_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- An XP milestone without a threshold, or a badge/season one without a key, is
  -- a milestone nothing can ever unlock. Refuse it in the database, not just in
  -- the route, so a hand-written INSERT can't create an unreachable rung.
  CONSTRAINT reward_milestones_trigger_complete CHECK (
    (trigger_type = 'xp_threshold' AND xp_threshold IS NOT NULL)
    OR (trigger_type <> 'xp_threshold' AND trigger_key IS NOT NULL AND trigger_key <> '')
  ),
  -- A percent is a percent. A "150% off" discount is a refund with extra steps.
  CONSTRAINT reward_milestones_percent_band CHECK (
    reward_type = 'free_grade_credits' OR reward_value <= 100
  )
);

CREATE INDEX IF NOT EXISTS idx_reward_milestones_enabled
  ON public.reward_milestones(enabled, sort_order);

ALTER TABLE public.reward_milestones ENABLE ROW LEVEL SECURITY;
-- Deliberately ZERO policies: this is operator config that mints real value. A
-- client-writable reward catalog would be a client-writable money faucet. The
-- SPA reads it only through /api/admin/rewards/milestones (admin-gated) and the
-- engine reads it with the service-role client, which bypasses RLS.
-- Registered in rls-guard_test.ts SERVICE_ROLE_ONLY + SERVICE_ONLY_FORCED.
REVOKE ALL ON public.reward_milestones FROM anon, authenticated;

DROP TRIGGER IF EXISTS set_reward_milestones_updated_at ON public.reward_milestones;
CREATE TRIGGER set_reward_milestones_updated_at
  BEFORE UPDATE ON public.reward_milestones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── The grant ledger learns about time ──────────────────────────────────────
-- expires_at: a per-grade discount is live until this instant, then it simply
-- stops applying. No revocation job, no state to drift.
-- consumed_at: a subscription coupon is redeemable exactly once; the webhook
-- that sees the subscription created stamps this so it can never ride a second
-- checkout. Credits have neither — they land in the ledger and are gone.
ALTER TABLE public.reward_tangible_grants
  ADD COLUMN IF NOT EXISTS expires_at  timestamptz;
ALTER TABLE public.reward_tangible_grants
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

-- The engine's hot read: this user's live, unconsumed discounts.
CREATE INDEX IF NOT EXISTS idx_reward_tangible_grants_user_live
  ON public.reward_tangible_grants(user_id, reward_type, expires_at)
  WHERE status = 'granted' AND consumed_at IS NULL;
-- The per-milestone issue caps count granted rows by milestone.
CREATE INDEX IF NOT EXISTS idx_reward_tangible_grants_milestone
  ON public.reward_tangible_grants(milestone_key, granted_at DESC)
  WHERE status = 'granted';

-- ── Seed: the ladder US-1848 shipped in code ────────────────────────────────
-- Same keys, values and costs, so every grant already in the ledger still maps
-- to its milestone. The engine keeps the compiled ladder as a fallback for a
-- failed/empty read, so this seed changes nothing on day one — it just makes the
-- ladder editable.
INSERT INTO public.reward_milestones
  (key, label, description, reward_type, trigger_type, xp_threshold, reward_value, cost_usd, sort_order)
VALUES
  ('xp_900_credits_1',    '1 free grade',   'Reach 900 XP.',    'free_grade_credits', 'xp_threshold',    900,  1, 0.35, 10),
  ('xp_2500_credits_3',   '3 free grades',  'Reach 2,500 XP.',  'free_grade_credits', 'xp_threshold',  2500,  3, 1.05, 20),
  ('xp_6400_credits_5',   '5 free grades',  'Reach 6,400 XP.',  'free_grade_credits', 'xp_threshold',  6400,  5, 1.75, 30),
  ('xp_14400_credits_10', '10 free grades', 'Reach 14,400 XP.', 'free_grade_credits', 'xp_threshold', 14400, 10, 3.50, 40),
  ('xp_25600_credits_20', '20 free grades', 'Reach 25,600 XP.', 'free_grade_credits', 'xp_threshold', 25600, 20, 7.00, 50)
ON CONFLICT (key) DO NOTHING;

-- ── Seed: the two discount rungs, switched OFF ──────────────────────────────
-- Shipped disabled on purpose. Both mint a real Stripe coupon, and the honest
-- cost_usd of a discount depends on the plan mix an operator can see and this
-- migration cannot. They exist so the shapes are visible in the admin screen;
-- turning one on is a deliberate act with a number attached.
INSERT INTO public.reward_milestones
  (key, label, description, reward_type, trigger_type, trigger_key, reward_value,
   cost_usd, discount_duration_months, discount_valid_days, monthly_grant_cap,
   lifetime_grant_cap, enabled, sort_order)
VALUES
  (
    'badge_century_sub_discount',
    '20% off your next 3 months',
    'Earn the Century badge (100 items graded).',
    'subscription_discount', 'badge', 'grades_100', 20,
    12.00, 3, NULL, 25, 500, false, 60
  ),
  (
    'season_coverage_grade_discount',
    '15% off grading for 90 days',
    'Finish the season''s full-coverage goal.',
    'per_grade_discount', 'season_goal', 'full_coverage', 15,
    3.00, NULL, 90, 100, 2000, false, 70
  )
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00541')
ON CONFLICT (version) DO NOTHING;
