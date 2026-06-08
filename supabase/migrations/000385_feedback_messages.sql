-- User-submitted feedback from the iOS app + web (US-199). One row per
-- send. Routed to support@pearson-media.com via the edge handler's
-- email send; the row is the system-of-record copy so feedback is
-- searchable + re-sendable without re-asking the user.

CREATE TABLE IF NOT EXISTS public.feedback_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Free-text body. Cap soft via the iOS form (2000 chars); no hard
  -- limit at the DB layer so future channels (longer email threads)
  -- can reuse the table.
  message       text NOT NULL,
  -- Lightweight context fields the iOS app collects automatically so
  -- support doesn't have to ask 'what device?' on every reply.
  source        text NOT NULL DEFAULT 'ios',
  app_version   text,
  os_version    text,
  device_model  text,
  -- Last ~10 telemetry breadcrumbs (Sentry-shaped) so triage starts
  -- with the user's actual sequence of taps. JSON array.
  breadcrumbs   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Lifecycle.
  status        text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'triaged', 'responded', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_messages_user
  ON public.feedback_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_messages_status
  ON public.feedback_messages(status)
  WHERE status <> 'closed';

CREATE TRIGGER set_feedback_messages_updated_at
  BEFORE UPDATE ON public.feedback_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.feedback_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own feedback"
  ON public.feedback_messages FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own feedback"
  ON public.feedback_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Admins read everything for triage. The is_admin() helper is defined
-- in 00003_admin_tables.sql.
CREATE POLICY "Admins read all feedback"
  ON public.feedback_messages FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins update feedback status"
  ON public.feedback_messages FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
