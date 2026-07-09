-- US-1803: buyer notification & delivery layer.
--
-- The shared delivery layer the buyer feature epics call (alerts US-1809,
-- rewards US-1814, guarantee US-1821, portfolio US-1827) via notifyBuyer() —
-- fanning out to in-app (the existing public.notifications feed), push (the
-- existing APNs/FCM fan-out), and email. This migration adds:
--   1. Four buyer categories to the notification_type enum (in-app feed).
--   2. buyer_notification_log — the idempotency ledger (north-star 00170
--      pattern: a UNIQUE (user_id, dedupe_key) claim dedupes repeat/racy sends
--      and, for digest cadence, marks queued-vs-sent).
--   3. Cadence + quiet-hours columns on buyer_preferences (US-1803 AC1/AC3).
-- Per-category CHANNEL preferences reuse users.notification_preferences (JSONB,
-- code-defaulted) — no schema change there.

-- 1. In-app notification categories (ADD VALUE is idempotent; a new value can't
--    be USED in the same tx, but the notify inserts run at runtime — safe).
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'buyer_condition_alert';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'buyer_reward';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'buyer_guarantee';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'buyer_portfolio';

-- 2. Idempotency ledger. One row per (user, unit-of-work); the UNIQUE constraint
--    is the dedupe key. sent_at NULL = queued for a later digest flush (US-1803
--    phase B); non-null = delivered. channels records what actually went out.
CREATE TABLE IF NOT EXISTS public.buyer_notification_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category      text NOT NULL,
  dedupe_key    text NOT NULL,
  channels      text[] NOT NULL DEFAULT '{}',
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_buyer_notification_log_user_created
  ON public.buyer_notification_log (user_id, created_at DESC);
-- Partial index for the digest cron to sweep queued (unsent) rows cheaply.
CREATE INDEX IF NOT EXISTS idx_buyer_notification_log_queued
  ON public.buyer_notification_log (user_id) WHERE sent_at IS NULL;

ALTER TABLE public.buyer_notification_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own buyer notification log" ON public.buyer_notification_log;
CREATE POLICY "Users read own buyer notification log"
  ON public.buyer_notification_log FOR SELECT USING (auth.uid() = user_id);

-- 3. Cadence + quiet hours on buyer_preferences (owner-managed, US-1803).
ALTER TABLE public.buyer_preferences
  ADD COLUMN IF NOT EXISTS digest_frequency text NOT NULL DEFAULT 'immediate'
    CHECK (digest_frequency IN ('immediate', 'daily', 'weekly')),
  ADD COLUMN IF NOT EXISTS quiet_hours_start smallint
    CHECK (quiet_hours_start IS NULL OR (quiet_hours_start BETWEEN 0 AND 23)),
  ADD COLUMN IF NOT EXISTS quiet_hours_end smallint
    CHECK (quiet_hours_end IS NULL OR (quiet_hours_end BETWEEN 0 AND 23));

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00412')
ON CONFLICT (version) DO NOTHING;
