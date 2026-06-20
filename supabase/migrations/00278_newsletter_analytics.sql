-- US-931: Email program analytics & deliverability — subscriber registry +
-- read-only rollup RPC.
--
-- The newsletter program reuses the Growth/Promote broadcast infrastructure
-- (growth_campaigns + campaign_recipients, migration 00102): each email-channel
-- campaign is an "issue", and campaign_recipients is the per-recipient delivery +
-- engagement ledger (sent/opened/clicked/failed/skipped). This migration adds the
-- confirmed-subscriber registry (email_subscribers) the program needs for list
-- size/growth, and the server-side `newsletter_analytics(period)` rollup that
-- powers the operator deliverability dashboard.
--
-- Definitions (documented so the dashboard numbers are unambiguous and reconcile
-- with the campaign_recipients ledger):
--   • issue            — a growth_campaigns row whose channels include 'email'
--                        and that has been sent (status sent/sending) in-window.
--   • sent             — campaign_recipients rows (channel='email') with
--                        status='sent' for the issue.
--   • opened/clicked   — campaign_recipients with opened_at/clicked_at set
--                        (US-913 open-pixel + click-redirect tracking).
--   • open rate        — opened / sent. CTR — clicked / sent. Click-to-open —
--                        clicked / opened.
--   • failed/skipped   — send-time failures / suppression-skips on the ledger.
--   • bounces/complaints — email_suppressions rows (reason bounce/complaint)
--                        created in-window; the SES feedback loop (US-1057) is the
--                        source. Program bounce/complaint RATE = these / sent.
--   • list size        — confirmed subscribers now. growth — confirmed in-window
--                        minus unsubscribed in-window. unsub rate — unsubscribed
--                        in-window / sent.
--
-- email_subscribers + the rollup are service-role only; the dashboard reads
-- exclusively through the aggregating RPC, never the raw rows.
--
-- Additive + idempotent.

BEGIN;

-- ── Confirmed-subscriber registry ──────────────────────────────────────────
-- One row per email address on the newsletter list. user_id links the row to a
-- platform account when the subscriber is also a user (nullable — standalone
-- leads have none). Status drives list-size/growth: 'confirmed' is the engaged
-- list, 'unsubscribed'/'cleaned' have left it. Service-role only.
CREATE TABLE IF NOT EXISTS public.email_subscribers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,            -- normalized (trimmed, lowercased)
  user_id         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'cleaned')),
  source          text,                            -- where they signed up (footer, modal, import, …)
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_subscribers IS
  'US-931: newsletter confirmed-subscriber registry driving list size/growth + '
  'confirmed-subscriber counts in newsletter_analytics. Service-role only.';

CREATE INDEX IF NOT EXISTS email_subscribers_status_idx
  ON public.email_subscribers (status);
CREATE INDEX IF NOT EXISTS email_subscribers_confirmed_idx
  ON public.email_subscribers (confirmed_at);
CREATE INDEX IF NOT EXISTS email_subscribers_unsubscribed_idx
  ON public.email_subscribers (unsubscribed_at);

-- updated_at maintenance (project-wide trigger convention).
CREATE OR REPLACE FUNCTION public.set_email_subscribers_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_subscribers_updated_at ON public.email_subscribers;
CREATE TRIGGER trg_email_subscribers_updated_at
  BEFORE UPDATE ON public.email_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.set_email_subscribers_updated_at();

-- Service-role only — written by the edge consent/subscriber paths, read only
-- through the aggregating RPC; RLS enabled with zero policies = deny-all.
ALTER TABLE public.email_subscribers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_subscribers FROM anon, authenticated;

-- ── Rollup RPC ──────────────────────────────────────────────────────────────
-- Single jsonb document; payload size is bounded by the in-window issue count
-- (not subscriber/recipient volume). `p_period` is a token ('7d'|'30d'|'90d'|
-- '180d'|'365d'); anything else falls back to 30 days. Window anchors on p_end.
CREATE OR REPLACE FUNCTION public.newsletter_analytics(
  p_period text DEFAULT '30d',
  p_end    timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      p_end AS w_end,
      p_end - (CASE p_period
                 WHEN '7d'   THEN interval '7 days'
                 WHEN '30d'  THEN interval '30 days'
                 WHEN '90d'  THEN interval '90 days'
                 WHEN '180d' THEN interval '180 days'
                 WHEN '365d' THEN interval '365 days'
                 ELSE interval '30 days'
               END) AS w_start
  ),
  -- Email-channel campaigns sent in-window = newsletter "issues".
  issues AS (
    SELECT g.id, g.name, g.subject, g.sent_at
    FROM public.growth_campaigns g, params p
    WHERE 'email' = ANY (g.channels)
      AND g.status IN ('sent', 'sending')
      AND g.sent_at IS NOT NULL
      AND g.sent_at >= p.w_start
      AND g.sent_at <  p.w_end
  ),
  -- Per-recipient email ledger for those issues.
  rcpt AS (
    SELECT r.*
    FROM public.campaign_recipients r
    JOIN issues i ON i.id = r.campaign_id
    WHERE r.channel = 'email'
  ),
  per_issue AS (
    SELECT
      i.id,
      i.name,
      i.subject,
      i.sent_at,
      count(*) FILTER (WHERE r.status = 'sent')         AS sent,
      count(*) FILTER (WHERE r.opened_at IS NOT NULL)   AS opened,
      count(*) FILTER (WHERE r.clicked_at IS NOT NULL)  AS clicked,
      count(*) FILTER (WHERE r.status = 'failed')       AS failed,
      count(*) FILTER (WHERE r.status = 'skipped')      AS skipped
    FROM issues i
    LEFT JOIN rcpt r ON r.campaign_id = i.id
    GROUP BY i.id, i.name, i.subject, i.sent_at
  ),
  totals AS (
    SELECT
      coalesce(count(*), 0)                  AS issues,
      coalesce(sum(sent), 0)                 AS sent,
      coalesce(sum(opened), 0)               AS opened,
      coalesce(sum(clicked), 0)              AS clicked,
      coalesce(sum(failed), 0)               AS failed,
      coalesce(sum(skipped), 0)              AS skipped
    FROM per_issue
  ),
  -- Suppression feedback (US-1057) in-window: hard bounces + complaints.
  supp AS (
    SELECT
      count(*) FILTER (WHERE s.reason = 'bounce')    AS bounces,
      count(*) FILTER (WHERE s.reason = 'complaint') AS complaints
    FROM public.email_suppressions s, params p
    WHERE s.created_at >= p.w_start AND s.created_at < p.w_end
  ),
  -- Closed-loop product outcome (reusing the click signal): newsletter readers
  -- who clicked and then graded a garment after that click, in-window. Bounded by
  -- the (small) set of clickers, so cheap. Distinct users so multiple clicks/
  -- submissions don't double-count.
  closed_loop AS (
    SELECT count(DISTINCT r.user_id) AS clicked_then_graded
    FROM rcpt r
    JOIN public.submissions sub
      ON sub.user_id = r.user_id
     AND sub.created_at >= r.clicked_at
     AND sub.created_at <  (SELECT w_end FROM params)
    WHERE r.clicked_at IS NOT NULL
  ),
  -- Subscriber list: size now + in-window growth.
  subs AS (
    SELECT
      count(*) FILTER (WHERE es.status = 'confirmed')                                   AS confirmed,
      count(*) FILTER (WHERE es.status = 'pending')                                     AS pending,
      count(*) FILTER (WHERE es.confirmed_at >= p.w_start AND es.confirmed_at < p.w_end) AS new_confirmed,
      count(*) FILTER (WHERE es.unsubscribed_at >= p.w_start AND es.unsubscribed_at < p.w_end) AS unsubscribed
    FROM public.email_subscribers es, params p
  )
  SELECT jsonb_build_object(
    'period', p_period,
    'window', (SELECT jsonb_build_object('start', w_start, 'end', w_end) FROM params),
    'program', (
      SELECT jsonb_build_object(
        'issuesSent', t.issues,
        'sent', t.sent,
        'opened', t.opened,
        'clicked', t.clicked,
        'failed', t.failed,
        'skipped', t.skipped,
        'openRate',    CASE WHEN t.sent > 0 THEN round(t.opened::numeric / t.sent, 4) ELSE 0 END,
        'ctr',         CASE WHEN t.sent > 0 THEN round(t.clicked::numeric / t.sent, 4) ELSE 0 END,
        'clickToOpenRate', CASE WHEN t.opened > 0 THEN round(t.clicked::numeric / t.opened, 4) ELSE 0 END,
        'bounces', s.bounces,
        'complaints', s.complaints,
        'bounceRate',    CASE WHEN t.sent > 0 THEN round(s.bounces::numeric / t.sent, 5) ELSE 0 END,
        'complaintRate', CASE WHEN t.sent > 0 THEN round(s.complaints::numeric / t.sent, 5) ELSE 0 END,
        'unsubscribed', sub.unsubscribed,
        'unsubRate',     CASE WHEN t.sent > 0 THEN round(sub.unsubscribed::numeric / t.sent, 5) ELSE 0 END,
        'listSize', sub.confirmed,
        'confirmedSubscribers', sub.confirmed,
        'pendingSubscribers', sub.pending,
        'newSubscribers', sub.new_confirmed,
        'netGrowth', sub.new_confirmed - sub.unsubscribed,
        -- Closed-loop product impact: distinct readers who clicked then graded.
        'clickedThenGraded', cl.clicked_then_graded
      )
      FROM totals t, supp s, subs sub, closed_loop cl
    ),
    'issues', (
      SELECT coalesce(jsonb_agg(
        jsonb_build_object(
          'id', pi.id,
          'name', pi.name,
          'subject', pi.subject,
          'sentAt', pi.sent_at,
          'sent', pi.sent,
          'opened', pi.opened,
          'clicked', pi.clicked,
          'failed', pi.failed,
          'skipped', pi.skipped,
          'openRate', CASE WHEN pi.sent > 0 THEN round(pi.opened::numeric / pi.sent, 4) ELSE 0 END,
          'ctr',      CASE WHEN pi.sent > 0 THEN round(pi.clicked::numeric / pi.sent, 4) ELSE 0 END,
          -- send-time failure proxy (post-send hard bounces aren't linked to an issue).
          'bounceRate', CASE WHEN (pi.sent + pi.failed) > 0
                          THEN round(pi.failed::numeric / (pi.sent + pi.failed), 4) ELSE 0 END
        ) ORDER BY pi.sent_at DESC
      ), '[]'::jsonb)
      FROM per_issue pi
    )
  );
$$;

COMMENT ON FUNCTION public.newsletter_analytics(text, timestamptz) IS
  'US-931: read-only newsletter program rollup (per-issue + program-level open/'
  'CTR/bounce/complaint/unsub rates + list size/growth) from campaign_recipients '
  '+ email_suppressions + email_subscribers. Reconciles with the recipients ledger.';

GRANT EXECUTE ON FUNCTION public.newsletter_analytics(text, timestamptz) TO service_role;

-- ── Seed the deliverability-guard settings into the registry (US-884) ───────
-- `on conflict do nothing` so an operator override applied before a re-run is
-- never clobbered.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'newsletter_complaint_rate_threshold',
    '0.001'::jsonb, 'number', '0.001'::jsonb,
    'US-931: program complaint rate (complaints/sent) above which deliverability is flagged critical (default 0.1%).',
    'marketing'
  ),
  (
    'newsletter_bounce_rate_threshold',
    '0.02'::jsonb, 'number', '0.02'::jsonb,
    'US-931: program bounce rate (bounces/sent) above which deliverability is flagged critical (default 2%).',
    'marketing'
  ),
  (
    'newsletter_auto_pause_enabled',
    'false'::jsonb, 'bool', 'false'::jsonb,
    'US-931: when true, a critical bounce/complaint breach auto-pauses newsletter sends (sets newsletter_send_paused).',
    'marketing'
  ),
  (
    'newsletter_send_paused',
    'false'::jsonb, 'bool', 'false'::jsonb,
    'US-931: kill-switch the newsletter sender checks before dispatch; set true automatically on a critical deliverability breach (when auto-pause is enabled) or manually by an operator.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00278')
ON CONFLICT (version) DO NOTHING;
