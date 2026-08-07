-- US-1848 (epic spine): the TANGIBLE half of GradeThread Rewards.
--
-- The cosmetic half already exists (reputation_events as the XP ledger, 00443;
-- user_reward_state; user_badges, 00444) and is free + unlimited by design. This
-- adds the other half the epic requires: real value (grade credits, subscription
-- discounts, discounted grading) granted on crossing an XP milestone, capped so
-- it cannot eat the unit-economics margin, and idempotent so no retry, replay or
-- concurrent grant path can ever pay a milestone twice.
--
-- Design notes that matter here:
--   • XP is NEVER debited. A milestone is a THRESHOLD, not a purchase — crossing
--     it claims a row here; the XP total is untouched and only ever accrues.
--   • UNIQUE (user_id, milestone_key) IS the idempotency guarantee. The engine
--     CLAIMS the row before moving any value (the referral_milestone_grants
--     precedent, 00235), so two concurrent grant paths cannot double-pay.
--   • cost_usd is the platform's marginal cost of the grant, recorded on the row
--     so the budget ceiling can be evaluated from this table alone.

CREATE TABLE IF NOT EXISTS public.reward_tangible_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Catalog key of the milestone that unlocked this grant (rewards-tangible.ts).
  milestone_key text NOT NULL,
  reward_type   text NOT NULL CHECK (
    reward_type IN ('free_grade_credits', 'subscription_discount', 'per_grade_discount')
  ),
  -- Credits (integer count) or discount percent, per reward_type.
  reward_value  numeric(10, 2) NOT NULL CHECK (reward_value > 0),
  -- Marginal cost to GradeThread of honouring this grant, in USD.
  cost_usd      numeric(10, 2) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  -- 'claimed' = the slot is reserved, value not yet moved; 'granted' = delivered.
  status        text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'granted')),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  granted_at    timestamptz,
  UNIQUE (user_id, milestone_key)
);

CREATE INDEX IF NOT EXISTS idx_reward_tangible_grants_user
  ON public.reward_tangible_grants(user_id);
-- The global monthly budget window scans by time over delivered grants only.
CREATE INDEX IF NOT EXISTS idx_reward_tangible_grants_granted_at
  ON public.reward_tangible_grants(granted_at DESC)
  WHERE status = 'granted';

ALTER TABLE public.reward_tangible_grants ENABLE ROW LEVEL SECURITY;

-- Users see their own rewards; only the service role writes them.
DROP POLICY IF EXISTS "Users read own tangible reward grants" ON public.reward_tangible_grants;
CREATE POLICY "Users read own tangible reward grants"
  ON public.reward_tangible_grants FOR SELECT
  -- US-1927: (select auth.uid()) so the planner hoists it to one InitPlan
  -- instead of re-evaluating it per row.
  USING ((select auth.uid()) = user_id);

-- ── Kill-switch ─────────────────────────────────────────────────────────────
-- Seeded OFF. Tangible rewards move real money, so this is one of the few flags
-- that must be switched ON deliberately rather than fail-open: the engine reads
-- it with defaultEnabled=false, so a missing row or a DB blip pays nobody.
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'rewards_tangible',
  false,
  'US-1848: master switch for TANGIBLE reward payouts (free grade credits, '
  'subscription discounts, discounted grading). Off = XP, levels, badges and '
  'streaks keep accruing normally and nothing of real value is granted. Read '
  'fail-CLOSED, so an outage suspends payouts rather than opening them.'
)
ON CONFLICT (key) DO NOTHING;

-- ── Budget ceiling ──────────────────────────────────────────────────────────
-- value_type must be one of number|bool|string|json (00208 check constraint).
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'rewards_tangible_budget',
  '{"monthly_usd_cap": 500, "per_user_monthly_usd_cap": 15, "per_user_lifetime_usd_cap": 60}'::jsonb,
  'json',
  '{"monthly_usd_cap": 500, "per_user_monthly_usd_cap": 15, "per_user_lifetime_usd_cap": 60}'::jsonb,
  'rewards',
  'US-1848: ceiling on TANGIBLE reward spend, in USD of marginal cost. Three '
  'limits, because they fail differently: the global monthly cap protects the '
  'margin floor, the per-user monthly cap bounds a single account''s burn rate, '
  'and the per-user lifetime cap bounds a farmed account''s total take. A grant '
  'that would breach any of them is refused, not deferred.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00538')
ON CONFLICT (version) DO NOTHING;
