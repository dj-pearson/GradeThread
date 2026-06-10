-- US-769: privacy-safe per-certificate view counter.
--
-- A soft engagement signal for sellers ("viewed N times") — NOT a trust score
-- and NOT keyed to any buyer identity. We store only an aggregate integer on the
-- grade report; scan-vs-link attribution lives in PostHog (no PII either).

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.grade_reports.view_count IS
  'US-769: aggregate certificate view count (no buyer PII). Incremented by '
  'increment_certificate_view() from the public cert page, once per session.';

-- Atomic increment so concurrent views can''t lose updates. SECURITY DEFINER so
-- the edge can bump the counter without broad table grants; it only ever touches
-- certified rows and returns nothing (no row data leaks).
CREATE OR REPLACE FUNCTION public.increment_certificate_view(p_certificate_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.grade_reports
     SET view_count = view_count + 1
   WHERE certificate_id = p_certificate_id
     AND certificate_id IS NOT NULL;
$$;

-- Not callable by anon/authenticated directly (they read the public view, never
-- bump the counter themselves); the edge invokes it with the service role.
REVOKE ALL ON FUNCTION public.increment_certificate_view(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.increment_certificate_view(uuid) TO service_role;
