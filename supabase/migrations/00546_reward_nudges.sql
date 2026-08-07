-- US-1859: re-engagement nudges — streak-at-risk, near-miss, quests, and
-- reward-available alerts, with the ledger that lets us measure whether they
-- actually work.
--
-- Two things this adds, and the second is the one that matters.
--
--   1. A DEDICATED CONSENT CATEGORY. `reward_nudges` is a new notification
--      preference key, not a reuse of an existing one. Every other category's
--      copy names what it sends — "when a listing goes live", "a reward, streak,
--      or redemption event". A re-engagement nudge is a different thing: it fires
--      because the user has been QUIET, which is the one trigger nobody has
--      agreed to yet. Folding it under `buyer_rewards` or `selling_activity`
--      would make a sentence somebody already read retroactively false, which is
--      the same rule the telemetry-consent contract states.
--
--   2. A SEND LEDGER WITH A HOLDOUT. `reward_nudge_sends` records every nudge —
--      including the ones deliberately NOT sent, to a deterministic holdout
--      slice of eligible users. Without the holdout there is no lift, only a
--      conversion rate: "62% of nudged users came back" says nothing until you
--      know what the un-nudged ones did. The holdout row costs one insert and is
--      the only thing that makes AC3 answerable.
--
-- The ledger is also the frequency cap and the idempotency guarantee: UNIQUE
-- (user_id, nudge_type, subject_key, period_key) means one nudge per subject per
-- window forever, and the recent-rows read is what enforces "at most N per week".

-- ── The in-app notification type ────────────────────────────────────────────
-- ALTER TYPE ... ADD VALUE is transactional in PG 12+ (see 00008/00545). The
-- value is only ADDED here and never referenced later in this migration.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'reward_nudge';

-- ── The send ledger ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reward_nudge_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Which nudge. Mirrors NUDGE_TYPES in lib/rewards-nudges.ts; the CHECK is the
  -- real guard, the TS union is the one that gives a readable error.
  nudge_type    text NOT NULL CHECK (nudge_type IN (
    'streak_at_risk',
    'badge_near_miss',
    'quest_new',
    'quest_expiring',
    'reward_available'
  )),
  -- WHAT the nudge was about: a badge key, a quest key, a milestone key, or
  -- 'streak'. Together with period_key this is what "once" means.
  subject_key   text NOT NULL,
  -- The window the nudge belongs to (a Monday-anchored week key, a quest period
  -- key, or 'once' for a subject that can only ever be nudged a single time).
  period_key    text NOT NULL,
  -- The attribution slug carried on the deep link (?nudge=<id>&utm_campaign=…),
  -- so a click can be traced back to the exact send without a second store.
  campaign      text NOT NULL DEFAULT 'reward_nudge',
  -- TRUE = this user was in the holdout slice and received NOTHING. The row
  -- exists precisely so the counterfactual is measurable.
  holdout       boolean NOT NULL DEFAULT false,
  -- Channels the notification actually reached ('in_app', 'push'). Empty for a
  -- holdout row, and empty is meaningful — it is not a failed send.
  channels      text[] NOT NULL DEFAULT '{}',
  sent_at       timestamptz NOT NULL DEFAULT now(),
  -- Stamped by POST /api/rewards/nudges/:id/click when the deep link is opened.
  clicked_at    timestamptz,
  -- Stamped by the cron's attribution pass: the user performed a rewardable act
  -- inside the attribution window. Holdout rows are scored by the SAME rule, so
  -- the two rates are comparable.
  converted_at  timestamptz,
  conversion_kind text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One nudge per (user, type, subject, window). This is the idempotency
-- guarantee AND what stops a daily cron re-sending the same reminder every day.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reward_nudge_sends_subject
  ON public.reward_nudge_sends(user_id, nudge_type, subject_key, period_key);

-- The frequency-cap read: this user's recent sends, newest first.
CREATE INDEX IF NOT EXISTS idx_reward_nudge_sends_user_recent
  ON public.reward_nudge_sends(user_id, sent_at DESC);

-- The attribution pass: unconverted sends inside the window.
CREATE INDEX IF NOT EXISTS idx_reward_nudge_sends_unconverted
  ON public.reward_nudge_sends(sent_at DESC)
  WHERE converted_at IS NULL;

-- The lift report: sent-vs-holdout conversion per type over a period.
CREATE INDEX IF NOT EXISTS idx_reward_nudge_sends_type_sent
  ON public.reward_nudge_sends(nudge_type, sent_at DESC);

COMMENT ON TABLE public.reward_nudge_sends IS
  'US-1859: one row per re-engagement nudge decision, INCLUDING the deterministic holdout slice that is deliberately not sent (holdout=true, channels={}). UNIQUE (user_id, nudge_type, subject_key, period_key) is both the idempotency guarantee and the per-subject frequency cap. Service-role only (deny-all RLS): it is an attribution ledger, the same posture as user_events — the user sees the notification, not the experiment.';

-- Service-role only. This is measurement, not user-facing content: the nudge
-- itself lands in `notifications`, which the user reads normally. A readable
-- ledger would tell someone whether they are in the holdout, which is exactly
-- the thing that must not influence their behaviour.
ALTER TABLE public.reward_nudge_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reward_nudge_sends FROM anon, authenticated;

-- ── New default preference set ──────────────────────────────────────────────
-- Mirrors DEFAULT_NOTIFICATION_PREFERENCES in src/lib/notification-preferences.ts.
-- `reward_nudges` follows the product-wide opt-OUT model (absence ⇒ enabled) and
-- is ADDITIONALLY gated by the `marketing` umbrella in the engine, because a
-- nudge is re-engagement messaging rather than an account event.
ALTER TABLE public.users
  ALTER COLUMN notification_preferences SET DEFAULT '{
    "grade_complete": {"email": true, "in_app": true, "push": true},
    "dispute_updates": {"email": true, "in_app": true},
    "billing_alerts": {"email": true, "in_app": true},
    "product_updates": {"email": true},
    "marketing": {"email": true},
    "weekly_newsletter": {"email": true},
    "selling_activity": {"email": true, "in_app": true, "push": true},
    "offers": {"email": true, "in_app": true, "push": true},
    "returns": {"email": true, "in_app": true, "push": true},
    "payouts": {"email": true, "in_app": true, "push": true},
    "buyer_alerts": {"email": true, "in_app": true, "push": true},
    "buyer_rewards": {"email": true, "in_app": true, "push": true},
    "buyer_guarantee": {"email": true, "in_app": true, "push": true},
    "buyer_portfolio": {"email": true, "in_app": true, "push": true},
    "reward_nudges": {"in_app": true, "push": true}
  }'::jsonb;

-- ── Nudge policy config ─────────────────────────────────────────────────────
-- value_type must be one of number|bool|string|json (00208 check constraint).
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'reward_nudges_config',
  '{"enabled": true, "types": {"streak_at_risk": true, "badge_near_miss": true, "quest_new": true, "quest_expiring": true, "reward_available": true}, "max_per_week": 2, "min_hours_between": 48, "holdout_pct": 10, "near_miss_max_remaining": 3, "streak_risk_days_left": 3, "quest_new_within_hours": 36, "quest_expiring_within_hours": 48, "reward_expiring_within_days": 10, "attribution_window_days": 7}'::jsonb,
  'json',
  '{"enabled": true, "types": {"streak_at_risk": true, "badge_near_miss": true, "quest_new": true, "quest_expiring": true, "reward_available": true}, "max_per_week": 2, "min_hours_between": 48, "holdout_pct": 10, "near_miss_max_remaining": 3, "streak_risk_days_left": 3, "quest_new_within_hours": 36, "quest_expiring_within_hours": 48, "reward_expiring_within_days": 10, "attribution_window_days": 7}'::jsonb,
  'rewards',
  'US-1859: re-engagement nudge policy. `enabled` is the kill-switch; `types` is '
  'the per-nudge switch. max_per_week + min_hours_between are the frequency cap '
  '(a nudge that arrives more often than that is a notification people turn off, '
  'and the toggle is one-way). holdout_pct is the share of eligible users who get '
  'NOTHING so re-engagement lift is measurable rather than assumed — set it to 0 '
  'only once the effect is established. near_miss_max_remaining is how close to a '
  'badge counts as near. streak_risk_days_left only nudges inside the last N days '
  'of the week, and only when the chain has no banked freeze to spend. '
  'attribution_window_days is how long after a nudge a rewardable action still '
  'counts as a conversion — for the holdout rows too, or the comparison is not one.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00546')
ON CONFLICT (version) DO NOTHING;
