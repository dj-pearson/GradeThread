-- US-2101: first-/last-touch UTM attribution on the user row.
--
-- The client already captures utm_source/medium/campaign/term/content into
-- first-party storage on landing (ad-attribution.ts captureUtms, consent-gated).
-- What was missing was the persist target: unlike the gclid path (which has the
-- ad_click_attributions operator table), UTMs are a bounded per-user set — one
-- first-touch and one last-touch — so they belong ON the user row. The edge
-- writes first-touch once (immutable) and last-touch on every authenticated
-- sync, and the admin channel view aggregates over these two columns.
--
-- jsonb (not five+five columns): the shape is {utm_source, utm_medium,
-- utm_campaign, utm_term, utm_content, landingAt}, all optional except landingAt,
-- and storing the whole UtmSet keeps client and server in one shape.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS utm_first_touch jsonb,
  ADD COLUMN IF NOT EXISTS utm_last_touch  jsonb;

-- Partial indexes back the admin channel-attribution aggregation (group by
-- source/medium/campaign over rows that actually carry a UTM); most users have
-- none, so the partial keeps them tiny.
CREATE INDEX IF NOT EXISTS idx_users_utm_first_touch
  ON public.users ((utm_first_touch ->> 'utm_source'))
  WHERE utm_first_touch IS NOT NULL;

-- AC5: server-side channel aggregation for the admin analytics surface, mirroring
-- funnel_metrics / retention_cohorts (00229). SECURITY DEFINER + revoked from
-- public so only the service-role edge (admin-gated) can call it; it never
-- exposes a user id, only counts per first-touch channel.
CREATE OR REPLACE FUNCTION public.channel_attribution()
RETURNS TABLE (
  utm_source text,
  utm_medium text,
  utm_campaign text,
  users bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    utm_first_touch ->> 'utm_source'   AS utm_source,
    utm_first_touch ->> 'utm_medium'   AS utm_medium,
    utm_first_touch ->> 'utm_campaign' AS utm_campaign,
    count(*)                           AS users
  FROM public.users
  WHERE utm_first_touch IS NOT NULL
  GROUP BY 1, 2, 3
  ORDER BY users DESC
$$;

REVOKE ALL ON FUNCTION public.channel_attribution() FROM public;
GRANT EXECUTE ON FUNCTION public.channel_attribution() TO service_role;

-- US-1108: self-record so the edge schema-version guard stays truthful
-- regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00492')
ON CONFLICT (version) DO NOTHING;
