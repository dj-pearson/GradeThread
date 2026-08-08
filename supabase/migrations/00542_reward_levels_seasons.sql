-- US-1851: named levels, quarterly SEASONS, and a monotonic level floor.
--
-- Three things land here, and each exists because of a specific failure mode:
--
--   1. user_reward_state.xp_peak — the HIGH-WATER MARK of lifetime XP. Level is
--      derived from this, not from xp_total, so a level can never decrease. XP is
--      never debited today (US-1848 made milestones thresholds, not purchases),
--      but a recompute reads the reputation_events log, and a log can shrink:
--      a fraud reversal unverifies an event, a GDPR erasure drops rows, a source
--      table cascades. Any of those would silently demote a seller's identity.
--      The peak makes that structurally impossible rather than merely unlikely.
--
--   2. user_season_recaps — the finalized record of a COMPLETED quarterly season.
--      Season progress itself is derived live from reputation_events (no new
--      ledger — US-1849's one-ledger rule holds), but a season that has ended
--      must stop being derivable-and-changing: this is the frozen recap, written
--      once per (user, season) and never rewritten. UNIQUE(user_id, season_key)
--      IS the idempotency guarantee for the lazy rollover.
--
--   3. rewards_season_timezone — seasons are a SHARED calendar, not a per-user
--      one. Everyone's Q3 starts and ends at the same instant, so recaps and
--      season standings compare like with like. The zone makes that boundary a
--      real wall-clock quarter rather than a naive UTC one.
--
-- Deliberately NOT here: a streak table. US-1851 replaced seller streaks with
-- seasons on purpose — a slow sourcing month is normal for a reseller and must
-- not destroy accumulated status. Calendar streaks survive only on the buyer
-- confirmation surface, where a genuinely weekly rhythm exists, and they are
-- computed client-side from the buyer's own grade_outcomes rows.

-- ── 1. Monotonic level floor ────────────────────────────────────────────────
ALTER TABLE public.user_reward_state
  ADD COLUMN IF NOT EXISTS xp_peak bigint NOT NULL DEFAULT 0;

-- Backfill: existing rows have only ever accrued, so their current total IS
-- their peak. Idempotent (the GREATEST + WHERE make a re-run a no-op).
UPDATE public.user_reward_state
   SET xp_peak = GREATEST(xp_peak, xp_total)
 WHERE xp_peak < xp_total;

COMMENT ON COLUMN public.user_reward_state.xp_peak IS
  'US-1851: high-water mark of xp_total. Levels derive from THIS, so a level '
  'never decreases even if the underlying event log shrinks (erasure, fraud '
  'reversal, cascade). Only ever moves up.';

-- ── 2. Season recaps ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_season_recaps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Canonical season identity, e.g. '2026-Q2'. Stable across timezones because
  -- the boundary zone is a single system setting, not a per-user preference.
  season_key        text NOT NULL,
  season_label      text NOT NULL,
  season_started_at timestamptz NOT NULL,
  season_ended_at   timestamptz NOT NULL,
  -- XP earned INSIDE the season window. Lifetime XP is untouched by a rollover:
  -- the season resets, the identity does not.
  xp_earned         bigint  NOT NULL DEFAULT 0 CHECK (xp_earned >= 0),
  goals_completed   integer NOT NULL DEFAULT 0 CHECK (goals_completed >= 0),
  goals_total       integer NOT NULL DEFAULT 0 CHECK (goals_total >= 0),
  -- Where the seller stood when the season closed — the recap's headline.
  level_at_end      integer NOT NULL DEFAULT 0 CHECK (level_at_end >= 0),
  tier_at_end       text    NOT NULL DEFAULT 'thrifter',
  -- Per-goal detail + the cosmetic rewards the season awarded, for the recap UI.
  highlights        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, season_key)
);

CREATE INDEX IF NOT EXISTS idx_user_season_recaps_user
  ON public.user_season_recaps(user_id, season_ended_at DESC);

ALTER TABLE public.user_season_recaps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own season recaps" ON public.user_season_recaps;
CREATE POLICY "Users read own season recaps"
  ON public.user_season_recaps FOR SELECT
  -- US-1927: (select auth.uid()) so the planner hoists it to one InitPlan
  -- instead of re-evaluating it per row.
  USING ((select auth.uid()) = user_id);

-- ── 3. Season boundary timezone ─────────────────────────────────────────────
-- value_type must be one of number|bool|string|json (00208 check constraint).
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'rewards_season_timezone',
  to_jsonb('America/Chicago'::text), 'string', to_jsonb('America/Chicago'::text), 'rewards',
  'US-1851: IANA timezone the quarterly reward SEASON boundary is resolved in. '
  'One shared zone for everyone, so a season is the same window for every '
  'seller and recaps compare like with like. DST-aware; an invalid zone falls '
  'back to UTC rather than throwing.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00542')
ON CONFLICT (version) DO NOTHING;
