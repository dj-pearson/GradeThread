-- US-1845: server-side aggregate behind the admin buyer-growth surface.
--
-- One SECURITY DEFINER function, mirroring channel_attribution() (00492) and
-- funnel_metrics() (00229): revoked from public, granted to service_role only,
-- and it returns COUNTS — never a user id, an email or a UTM value tied to a
-- person. The admin route is the only caller.
--
-- Prices deliberately do NOT appear here. MRR is computed by the admin page from
-- BUYER_PLANS (src/lib/constants.ts), so the tier matrix stays written in the two
-- places the parity test already guards rather than gaining a third copy in SQL.
--
-- The acquisition bucket order (first-touch utm_source → affiliate → direct)
-- mirrors buyerAcquisitionProps() in src/lib/buyer-analytics.ts. See
-- vault/20-domain/buyer-platform.md for why first touch is the bucket.

CREATE OR REPLACE FUNCTION public.buyer_growth_metrics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH win AS (
  SELECT
    greatest(1, least(coalesce(p_days, 30), 365)) AS days,
    date_trunc('day', now())
      - ((greatest(1, least(coalesce(p_days, 30), 365)) - 1) || ' days')::interval
      AS since
),
-- Every account that holds (or has ever held) the buyer product. `is_buyer`
-- (00401) is the persisted role flag — account_type is signup metadata, not a
-- column. A seller who got the buyer tier folded in from their FlipDesk plan
-- (US-1887) never sets is_buyer, which is why the subscription columns are also
-- checked: they are a buyer for measurement purposes.
buyer_users AS (
  SELECT u.*
  FROM public.users u
  WHERE u.is_buyer
     OR u.buyer_subscription_status <> 'none'
     OR u.buyer_plan <> 'free'
),
-- Buyers who did at least one buyer thing. "Signed up" is not "activated", and
-- the gap between the two is the number the funnel exists to show.
activated AS (
  SELECT DISTINCT b.id
  FROM buyer_users b
  WHERE EXISTS (SELECT 1 FROM public.saved_searches s WHERE s.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.closet_items c WHERE c.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.ingested_listings i WHERE i.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.buyer_wants w WHERE w.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.grade_outcomes o WHERE o.buyer_user_id = b.id)
),
plans AS (
  SELECT
    b.buyer_plan::text                        AS plan,
    coalesce(b.buyer_interval, 'none')        AS interval,
    b.buyer_subscription_status::text         AS status,
    count(*)                                  AS users
  FROM buyer_users b
  GROUP BY 1, 2, 3
),
-- Daily series. Both sides are pre-seeded from generate_series so a quiet day is
-- a zero rather than a missing point — a gap would let the correlation the route
-- computes silently drop a day off one side and not the other.
days AS (
  SELECT generate_series((SELECT since FROM win), date_trunc('day', now()), '1 day')::date AS d
),
demand AS (
  SELECT d.d AS day, (
      (SELECT count(*) FROM public.ingested_listings i
        WHERE i.created_at >= d.d AND i.created_at < d.d + 1)
    + (SELECT count(*) FROM public.saved_searches s
        WHERE s.created_at >= d.d AND s.created_at < d.d + 1)
    + (SELECT count(*) FROM public.buyer_wants w
        WHERE w.created_at >= d.d AND w.created_at < d.d + 1)
  ) AS n
  FROM days d
),
grades AS (
  SELECT d.d AS day, (
    SELECT count(*) FROM public.submissions s
     WHERE s.created_at >= d.d AND s.created_at < d.d + 1
  ) AS n
  FROM days d
),
-- Acquisition bucket per buyer, resolved once and reused by the revenue rollup.
attributed AS (
  SELECT
    b.id,
    -- Aliased buyer_plan, never bare `plan`: `users.plan` is the frozen legacy
    -- column (US-2398) and a `plan <> 'free'` in a migration is what the
    -- legacy-user-plan-readers guard is looking for.
    b.buyer_plan::text                 AS buyer_plan,
    b.buyer_interval                   AS interval,
    b.buyer_subscription_status::text  AS status,
    coalesce(
      b.utm_first_touch ->> 'utm_source',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.affiliate_clicks ac WHERE ac.converted_user_id = b.id
      ) THEN 'affiliate' END,
      'direct'
    )                                  AS source,
    b.utm_first_touch ->> 'utm_medium'   AS medium,
    b.utm_first_touch ->> 'utm_campaign' AS campaign
  FROM buyer_users b
),
attribution AS (
  SELECT
    a.source,
    a.medium,
    a.campaign,
    count(*)                                                              AS buyers,
    count(*) FILTER (
      WHERE a.buyer_plan <> 'free' AND a.status IN ('active', 'trialing')
    )                                                                     AS paid_buyers,
    -- Plan × interval, not plan and interval separately: MRR needs the CROSS
    -- (a yearly Guard bills a twelfth of the yearly price), and two marginal
    -- counts cannot be recombined into it without assuming they are independent.
    count(*) FILTER (
      WHERE a.buyer_plan = 'guard' AND a.interval = 'monthly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS guard_monthly,
    count(*) FILTER (
      WHERE a.buyer_plan = 'guard' AND a.interval = 'yearly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS guard_yearly,
    count(*) FILTER (
      WHERE a.buyer_plan = 'connoisseur' AND a.interval = 'monthly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS connoisseur_monthly,
    count(*) FILTER (
      WHERE a.buyer_plan = 'connoisseur' AND a.interval = 'yearly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS connoisseur_yearly,
    coalesce(sum(
      coalesce((m.usage ->> 'extension_checks')::int, 0)
      + coalesce((m.usage ->> 'authenticity_credits')::int, 0)
      + coalesce((m.usage ->> 'video_grades')::int, 0)
    ), 0)                                                                 AS metered_units
  FROM attributed a
  LEFT JOIN public.buyer_meter_usage m ON m.user_id = a.id
  GROUP BY 1, 2, 3
)
SELECT jsonb_build_object(
  'window_days', (SELECT days FROM win),
  'since',       (SELECT since FROM win),
  'funnel', jsonb_build_object(
    'buyer_accounts', (SELECT count(*) FROM buyer_users),
    'new_accounts',   (SELECT count(*) FROM buyer_users b
                        WHERE b.created_at >= (SELECT since FROM win)),
    'activated',      (SELECT count(*) FROM activated),
    'paid',           (SELECT count(*) FROM buyer_users b
                        WHERE b.buyer_plan <> 'free'
                          AND b.buyer_subscription_status IN ('active', 'trialing')),
    'active_recent',  (SELECT count(*) FROM buyer_users b
                        WHERE b.last_active_at >= (SELECT since FROM win))
  ),
  'plans', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'plan', p.plan, 'interval', p.interval, 'status', p.status, 'users', p.users
    ) ORDER BY p.plan, p.interval)
    FROM plans p
  ), '[]'::jsonb),
  'adoption', jsonb_build_object(
    'extension_check', (SELECT jsonb_build_object(
        'users', count(DISTINCT i.user_id), 'events', count(*))
      FROM public.ingested_listings i WHERE i.created_at >= (SELECT since FROM win)),
    'alerts', (SELECT jsonb_build_object(
        'users', count(DISTINCT s.user_id), 'events', count(*))
      FROM public.saved_searches s WHERE s.created_at >= (SELECT since FROM win)),
    'confirmations', (SELECT jsonb_build_object(
        'users', count(DISTINCT o.buyer_user_id), 'events', count(*))
      FROM public.grade_outcomes o
      WHERE o.buyer_user_id IS NOT NULL AND o.created_at >= (SELECT since FROM win)),
    'guarantee_claims', (SELECT jsonb_build_object(
        'users', count(DISTINCT g.user_id), 'events', count(*))
      FROM public.buyer_guarantee_claims g WHERE g.created_at >= (SELECT since FROM win)),
    'portfolio', (SELECT jsonb_build_object(
        'users', count(DISTINCT c.user_id), 'events', count(*))
      FROM public.closet_items c WHERE c.created_at >= (SELECT since FROM win)),
    'wants', (SELECT jsonb_build_object(
        'users', count(DISTINCT w.user_id), 'events', count(*))
      FROM public.buyer_wants w WHERE w.created_at >= (SELECT since FROM win)),
    -- Authenticity has no table of its own: the meter counter IS the record.
    -- Current billing period, not the window — say so rather than pretend.
    'authenticity', (SELECT jsonb_build_object(
        'users', count(*) FILTER (WHERE coalesce((m.usage ->> 'authenticity_credits')::int, 0) > 0),
        'events', coalesce(sum(coalesce((m.usage ->> 'authenticity_credits')::int, 0)), 0))
      FROM public.buyer_meter_usage m),
    'video_grade', (SELECT jsonb_build_object(
        'users', count(DISTINCT s.user_id), 'events', count(*))
      FROM public.submissions s
      WHERE s.buyer_video_grade = true AND s.created_at >= (SELECT since FROM win))
  ),
  'flywheel', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'date', to_char(d.day, 'YYYY-MM-DD'),
      'buyer_demand', d.n,
      'seller_grades', g.n
    ) ORDER BY d.day)
    FROM demand d JOIN grades g ON g.day = d.day
  ), '[]'::jsonb),
  'attribution', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'source', a.source,
      'medium', a.medium,
      'campaign', a.campaign,
      'buyers', a.buyers,
      'paid_buyers', a.paid_buyers,
      'guard_monthly', a.guard_monthly,
      'guard_yearly', a.guard_yearly,
      'connoisseur_monthly', a.connoisseur_monthly,
      'connoisseur_yearly', a.connoisseur_yearly,
      'metered_units', a.metered_units
    ) ORDER BY a.buyers DESC, a.source)
    FROM attribution a
  ), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public.buyer_growth_metrics(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.buyer_growth_metrics(integer) TO service_role;

COMMENT ON FUNCTION public.buyer_growth_metrics(integer) IS
  'US-1845: buyer funnel / plan mix / feature adoption / flywheel / acquisition rollup for the admin buyer-growth surface. Counts only — never a user identifier.';

-- US-1108: self-record so the edge schema-version guard stays truthful
-- regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00537')
ON CONFLICT (version) DO NOTHING;
