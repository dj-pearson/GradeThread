-- US-1858: rewards economics guardrails — budget breaches, margin floor, and the
-- reward-farming lane of the fraud review queue.
--
-- 00538 gave the tangible rail its three USD ceilings and a fail-closed
-- kill-switch. What it did NOT give anyone was memory: a refused grant wrote a
-- console warning and nothing else, so an operator could not tell whether the
-- global cap had been hit once at 3am or was being hit every minute. This adds
-- the ai_budget_breaches counterpart for reward spend, plus the two guardrails
-- that were missing from the refusal set:
--
--   • MARGIN FLOOR. The USD caps are flat numbers; the margin they protect is
--     not. A user on a $0 plan and a user on the $99 plan have very different
--     amounts of headroom before a free grade eats the 40% floor, and the flat
--     per-user cap cannot express that. `rewards_economics_guardrails` holds the
--     floor and the free-tier allowance, and rewards-economics.ts narrows the
--     per-user monthly cap by whatever headroom the account actually has.
--   • VELOCITY. UNIQUE (user_id, milestone_key) already stops a milestone paying
--     twice, so a single account cannot re-farm one rung. It says nothing about
--     an account walking many rungs in an hour, which is what a farmed account
--     does. A daily grant/USD velocity limit rides the shared rate_limit_counters
--     store (00045) and, when it trips, raises a `reward_farming` abuse signal so
--     the existing triage console (US-888, /admin/safety) is where it lands. A
--     new review queue would be a second place to look and a second thing to
--     forget.
--
-- Cosmetic rewards (XP, levels, badges, streaks) are deliberately NOT touched by
-- anything here. They cost nothing marginal, so metering them would buy no margin
-- and would make the engagement loop breakable by a billing outage.

-- ── The reward-farming signal type ──────────────────────────────────────────
-- ALTER TYPE ... ADD VALUE is transactional in PG 12+ (see 00008). The value is
-- only ADDED here and never used in this migration, so it is safe either way.
ALTER TYPE public.abuse_signal_type ADD VALUE IF NOT EXISTS 'reward_farming';

-- ── Budget breaches ─────────────────────────────────────────────────────────
-- One OPEN row per (scope, subject). The engine records a breach the first time
-- a ceiling refuses a grant and stays quiet until an operator resolves it — the
-- same suppression rule ai_budget_breaches uses, and for the same reason: the
-- grant pass runs off the back of every rewardable action, so an unsuppressed
-- breach would alert thousands of times an hour.
CREATE TABLE IF NOT EXISTS public.reward_budget_breaches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which ceiling refused. Mirrors BudgetRefusal + the two added here.
  scope           text NOT NULL CHECK (scope IN (
    'global_monthly',
    'user_monthly',
    'user_lifetime',
    'margin_floor',
    'velocity'
  )),
  -- The account the breach is ABOUT, or NULL for the platform-wide ceiling.
  -- Named subject_user_id (not user_id) for the same reason abuse_signals is:
  -- this is an operator table, and the tenant-isolation guard auto-discovers
  -- `user_id` as user-owned tenant data.
  subject_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  limit_usd       numeric(10, 2) NOT NULL DEFAULT 0 CHECK (limit_usd >= 0),
  spend_usd       numeric(10, 2) NOT NULL DEFAULT 0 CHECK (spend_usd >= 0),
  -- The milestone that was refused, for the operator reading the row cold.
  milestone_key   text,
  -- Whether the guardrail flipped the `rewards_tangible` kill-switch off.
  killed          boolean NOT NULL DEFAULT false,
  -- Whether an ops alert reached at least one channel.
  alerted         boolean NOT NULL DEFAULT false,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One open breach per platform-wide scope…
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reward_budget_breaches_open_global
  ON public.reward_budget_breaches(scope)
  WHERE resolved_at IS NULL AND subject_user_id IS NULL;
-- …and one per (scope, account) for the per-user ones. Two partial indexes
-- rather than one over COALESCE: a NULL subject is a genuinely different kind of
-- breach, not a missing value.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reward_budget_breaches_open_user
  ON public.reward_budget_breaches(scope, subject_user_id)
  WHERE resolved_at IS NULL AND subject_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reward_budget_breaches_open
  ON public.reward_budget_breaches(created_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.reward_budget_breaches IS
  'US-1858: one row per tangible-reward ceiling breach (global/per-user USD, margin floor, velocity). Suppressed while OPEN so the grant pass cannot re-alert every tick. Service-role only (deny-all RLS); read/resolved via /api/admin/rewards/economics. subject_user_id (not user_id) is deliberate so the tenant-isolation guard does not treat this operator table as user-owned data.';

-- Service-role only: this is an operator surface. A user must not be able to
-- read (let alone write) the record of a ceiling that refused them — it would
-- tell a farmer exactly which limit to work around.
ALTER TABLE public.reward_budget_breaches ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.reward_budget_breaches FROM anon, authenticated;

-- ── Guardrail config ────────────────────────────────────────────────────────
-- value_type must be one of number|bool|string|json (00208 check constraint).
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'rewards_economics_guardrails',
  '{"margin_floor_pct": 0.40, "free_tier_monthly_usd_cap": 2, "per_user_daily_grant_cap": 3, "per_user_daily_usd_cap": 5, "auto_kill_on_global_breach": true, "fraud_hold_enabled": true}'::jsonb,
  'json',
  '{"margin_floor_pct": 0.40, "free_tier_monthly_usd_cap": 2, "per_user_daily_grant_cap": 3, "per_user_daily_usd_cap": 5, "auto_kill_on_global_breach": true, "fraud_hold_enabled": true}'::jsonb,
  'rewards',
  'US-1858: the guardrails that narrow rewards_tangible_budget. margin_floor_pct '
  'is the share of a subscriber''s revenue that must survive after their AI cost '
  'and their reward grants — a user''s effective monthly cap is the SMALLER of '
  'the flat cap and that headroom. free_tier_monthly_usd_cap is what an account '
  'with no subscription revenue may still be granted per month. The two daily '
  'numbers are velocity limits (many rungs in an hour is what a farmed account '
  'looks like; one rung twice is already impossible). auto_kill_on_global_breach '
  'flips the rewards_tangible kill-switch off when the platform ceiling is hit. '
  'fraud_hold_enabled refuses tangible grants to an account with an open '
  'high/critical abuse signal.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00548')
ON CONFLICT (version) DO NOTHING;
