-- US-2282, third tier: six functions that a plain guard could not reach.
--
-- ⚠ THREE CONFIRMED ANSWERING AN ANONYMOUS CALLER in production on 2026-08-17,
-- with nothing but the public anon key:
--
--   POST /rest/v1/rpc/drip_analytics        -> 200, per-step drip flags
--   POST /rest/v1/rpc/newsletter_analytics  -> 200, issue and window stats
--   POST /rest/v1/rpc/data_integrity_scan   -> 200, anomaly counts
--
-- The other three are the same shape — no body guard, and no REVOKE that works:
-- north_star_weekly_counts, north_star_lifetime_counts, and refund_snap, which
-- MUTATES a user's Snap quota.
--
-- ── WHY THESE NEEDED A DIFFERENT FIX FROM 00611 AND 00612 ───────────────────
--
-- All six are LANGUAGE sql. There is no BEGIN block to insert a guard into and
-- no RAISE available, so the one-line insertion that closed the other fifteen
-- simply does not apply. Each is therefore converted to plpgsql with the SAME
-- query inside — signature, volatility, SECURITY DEFINER and search_path all
-- carried through untouched; only the language word changes and a guard is
-- added.
--
-- ── THE PREDICATE SHORTCUT WAS REJECTED, AND THAT IS THE INTERESTING PART ───
--
-- The tempting alternative is to leave them as SQL and bolt the check on as a
-- predicate: `WHERE assert_service_role(...) AND <original>`. It is rejected
-- because SQL does not guarantee evaluation order: if the planner satisfies the
-- other predicates first and the result is empty, the assert never runs and an
-- unauthorised caller gets a SILENT EMPTY RESULT instead of an error.
--
-- An empty result that reads as an answer is worse than the leak it replaces,
-- and it is the exact failure mode a dozen other fixes this week were about.
--
-- ── EQUIVALENCE IS MEASURED, NOT ASSERTED ───────────────────────────────────
--
-- Each function's output was hashed as the owner BEFORE this migration and
-- again after. Same digests for both. That is what makes "the same query
-- inside" a claim rather than a description.
--
-- Every caller is the edge's service-role client:
--   drip_analytics              routes/admin-drip.ts:111
--   newsletter_analytics        routes/admin-newsletter.ts:130
--   (the other four moved to 00611 — see the note further down)
--
-- NOT INCLUDED: peek_workspace_invitation, which is in the same unguarded set
-- and must STAY open. src/pages/accept-invite.tsx calls it from the browser
-- before the user has an account, gated by a capability token
-- (invitation_token) rather than by identity. A role check would break
-- invitation acceptance.

-- ── drip_analytics (LANGUAGE sql → plpgsql, same query) ──────────────
CREATE OR REPLACE FUNCTION public.drip_analytics(p_campaign text DEFAULT 'trial_conversion'::text, p_start timestamp with time zone DEFAULT (now() - '90 days'::interval), p_end timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- US-2282: server-only. Confirmed answering an ANONYMOUS caller in
  -- production before this migration. Allowlist rather than a revoke: a
  -- denied call segfaults this Postgres image (US-2403).
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'drip_analytics: service role required' USING ERRCODE = '42501';
  END IF;
  RETURN (
  with enroll as (
      select *
      from public.drip_enrollments e
      where e.campaign = p_campaign
        and e.enrolled_at >= p_start
        and e.enrolled_at <  p_end
    ),
    sends as (
      select s.*
      from public.drip_sends s
      join enroll e on e.id = s.enrollment_id
    ),
    attr as (
      select a.*, coalesce(e.trial_started_at, e.enrolled_at) as clock_start
      from public.drip_attributions a
      join enroll e on e.id = a.enrollment_id
    ),
    -- Per-step engagement.
    step_eng as (
      select
        s.step,
        min(s.phase)                                   as phase,
        count(*) filter (where s.sent_at is not null)    as sent,
        count(*) filter (where s.opened_at is not null)  as opened,
        count(*) filter (where s.clicked_at is not null) as clicked,
        count(*) filter (where s.unsubscribed)           as unsub
      from sends s
      group by s.step
    ),
    step_conv as (
      select a.step, count(*) as converted, coalesce(sum(a.mrr_cents), 0) as mrr_cents
      from attr a
      where a.step is not null
      group by a.step
    ),
    funnel as (
      select
        se.step,
        se.phase,
        se.sent,
        se.opened,
        se.clicked,
        se.unsub,
        coalesce(sc.converted, 0) as converted,
        coalesce(sc.mrr_cents, 0) as mrr_cents,
        -- drop-off to the next step: who received this step but not the next.
        greatest(se.sent - coalesce(lead(se.sent) over (order by se.step), 0), 0) as drop_to_next
      from step_eng se
      left join step_conv sc on sc.step = se.step
    ),
    -- Overall conversion + MRR + median days-to-convert.
    overall as (
      select
        (select count(*) from enroll)                                  as enrolled,
        (select count(*) from attr)                                    as converted,
        (select coalesce(sum(a.mrr_cents), 0) from attr a)             as mrr_cents,
        (select count(*) filter (where a.stripe_reconciled) from attr a) as reconciled,
        (select percentile_cont(0.5) within group (
                  order by extract(epoch from (a.converted_at - a.clock_start)) / 86400.0)
                from attr a
                where a.converted_at is not null and a.clock_start is not null) as median_days
    ),
    -- in-trial vs win-back contribution.
    phase_split as (
      select a.phase,
             count(*) as converted,
             coalesce(sum(a.mrr_cents), 0) as mrr_cents
      from attr a
      group by a.phase
    ),
    -- incentive-on vs incentive-off lift.
    incentive_split as (
      select
        e.incentive_enabled,
        count(*) as enrolled,
        count(a.id) as converted
      from enroll e
      left join attr a on a.enrollment_id = e.id
      group by e.incentive_enabled
    ),
    -- signup-week cohorts.
    cohort as (
      select
        e.signup_week,
        count(*) as enrolled,
        count(a.id) as converted
      from enroll e
      left join attr a on a.enrollment_id = e.id
      where e.signup_week is not null
      group by e.signup_week
    ),
    -- A/B variant performance.
    variant_perf as (
      select
        coalesce(e.variant, 'default') as variant,
        count(*) as enrolled,
        count(a.id) as converted
      from enroll e
      left join attr a on a.enrollment_id = e.id
      group by coalesce(e.variant, 'default')
    )
    select jsonb_build_object(
      'campaign', p_campaign,
      'window', jsonb_build_object('start', p_start, 'end', p_end),
      'overall', (
        select jsonb_build_object(
          'enrolled', o.enrolled,
          'converted', o.converted,
          'conversionRate', case when o.enrolled > 0
                              then round(o.converted::numeric / o.enrolled, 4) else 0 end,
          'medianDaysToConvert', o.median_days,
          'attributedMrrCents', o.mrr_cents,
          'reconciledCount', o.reconciled,
          'reconciliationRate', case when o.converted > 0
                                  then round(o.reconciled::numeric / o.converted, 4) else null end,
          'reconciliationTolerancePct', 2.0
        ) from overall o
      ),
      'funnel', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'step', f.step,
            'phase', f.phase,
            'sent', f.sent,
            'opened', f.opened,
            'clicked', f.clicked,
            'converted', f.converted,
            'unsub', f.unsub,
            'dropOff', f.drop_to_next,
            'mrrCents', f.mrr_cents
          ) order by f.step
        ), '[]'::jsonb) from funnel f
      ),
      'phaseSplit', (
        select jsonb_build_object(
          'inTrial', jsonb_build_object(
            'converted', coalesce((select converted from phase_split where phase = 'in_trial'), 0),
            'mrrCents',  coalesce((select mrr_cents from phase_split where phase = 'in_trial'), 0)
          ),
          'winBack', jsonb_build_object(
            'converted', coalesce((select converted from phase_split where phase = 'win_back'), 0),
            'mrrCents',  coalesce((select mrr_cents from phase_split where phase = 'win_back'), 0)
          )
        )
      ),
      'incentiveSplit', (
        select jsonb_build_object(
          'on', jsonb_build_object(
            'enrolled', coalesce((select enrolled from incentive_split where incentive_enabled), 0),
            'converted', coalesce((select converted from incentive_split where incentive_enabled), 0),
            'conversionRate', (
              select case when enrolled > 0 then round(converted::numeric / enrolled, 4) else 0 end
              from incentive_split where incentive_enabled
            )
          ),
          'off', jsonb_build_object(
            'enrolled', coalesce((select enrolled from incentive_split where not incentive_enabled), 0),
            'converted', coalesce((select converted from incentive_split where not incentive_enabled), 0),
            'conversionRate', (
              select case when enrolled > 0 then round(converted::numeric / enrolled, 4) else 0 end
              from incentive_split where not incentive_enabled
            )
          ),
          'liftPts', (
            select round(
              coalesce((select case when enrolled > 0 then converted::numeric / enrolled end
                        from incentive_split where incentive_enabled), 0)
              - coalesce((select case when enrolled > 0 then converted::numeric / enrolled end
                          from incentive_split where not incentive_enabled), 0), 4)
          )
        )
      ),
      'cohorts', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'week', c.signup_week,
            'enrolled', c.enrolled,
            'converted', c.converted,
            'conversionRate', case when c.enrolled > 0
                                then round(c.converted::numeric / c.enrolled, 4) else 0 end
          ) order by c.signup_week
        ), '[]'::jsonb) from cohort c
      ),
      'variants', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'variant', v.variant,
            'enrolled', v.enrolled,
            'converted', v.converted,
            'conversionRate', case when v.enrolled > 0
                                then round(v.converted::numeric / v.enrolled, 4) else 0 end
          ) order by case when v.enrolled > 0 then v.converted::numeric / v.enrolled else 0 end desc
        ), '[]'::jsonb) from variant_perf v
      ),
      -- Steps to investigate: high drop-off (>50% of sent didn't advance) or high
      -- unsub (>2% of sent). The frontend surfaces these as attention flags.
      'flags', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'step', f.step,
            'phase', f.phase,
            'reason', case
                        when f.sent > 0 and f.unsub::numeric / f.sent > 0.02 then 'high_unsub'
                        else 'high_dropoff'
                      end,
            'dropOffRate', case when f.sent > 0 then round(f.drop_to_next::numeric / f.sent, 4) else 0 end,
            'unsubRate', case when f.sent > 0 then round(f.unsub::numeric / f.sent, 4) else 0 end
          ) order by f.step
        ), '[]'::jsonb)
        from funnel f
        where f.sent > 0
          and (f.unsub::numeric / f.sent > 0.02 or f.drop_to_next::numeric / f.sent > 0.5)
      )
    )
  );
END;
$function$;

-- ── newsletter_analytics (LANGUAGE sql → plpgsql, same query) ──────────────
CREATE OR REPLACE FUNCTION public.newsletter_analytics(p_period text DEFAULT '30d'::text, p_end timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- US-2282: server-only. Confirmed answering an ANONYMOUS caller in
  -- production before this migration. Allowlist rather than a revoke: a
  -- denied call segfaults this Postgres image (US-2403).
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'newsletter_analytics: service role required' USING ERRCODE = '42501';
  END IF;
  RETURN (
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
    )
  );
END;
$function$;

-- ── FOUR FUNCTIONS WERE REMOVED FROM THIS FILE, and their absence is the point.
--
-- data_integrity_scan, north_star_weekly_counts, north_star_lifetime_counts and
-- refund_snap were converted here too, until 00611_body_checks_for_ineffective_
-- revokes.sql landed on main doing exactly the same conversion to the same four.
-- Two migrations CREATE OR REPLACE-ing one function is not an error, it is worse:
-- whichever applies last silently wins, so the file you read is not necessarily
-- the body that is running.
--
-- 00611 owns those four. This file owns drip_analytics and newsletter_analytics,
-- which 00611 does not touch. The verify block below was trimmed to match, so it
-- asserts only what this file is responsible for.

do $verify_00616$
declare
  unguarded text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into unguarded
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('drip_analytics', 'newsletter_analytics')
    and p.prosrc not like '%auth.role()%';

  if unguarded is not null then
    raise exception
      '00616 did NOT take effect for: %. CREATE OR REPLACE only replaces a matching signature; a different one creates an OVERLOAD and leaves the original live. Compare these against the CREATE statements above.',
      unguarded
      using errcode = 'check_violation';
  end if;
end
$verify_00616$;

insert into public.applied_migrations (version) values ('00616') on conflict do nothing;
