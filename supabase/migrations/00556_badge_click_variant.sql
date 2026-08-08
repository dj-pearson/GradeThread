-- 00556_badge_click_variant.sql
--
-- US-1913 AC5: record WHICH FORMAT of embed badge a click came from, so a
-- seller can tell whether putting their standing on the badge earns more
-- click-throughs than the plain one.
--
-- Deliberately a SECOND column rather than a new ?s= source value. `source`
-- answers "where did this arrival come from" (embed / qr / share / buyer) and
-- every historical row means exactly that; folding the format into it would
-- retroactively redefine every pre-existing `embed` row as "plain badge", which
-- is a claim the data does not support. The two questions are independent, so
-- they get two columns.

ALTER TABLE public.badge_click_events
  -- 'plain' is the DEFAULT and the backfill value for every existing row,
  -- because before this story there was no other format a badge could be.
  ADD COLUMN IF NOT EXISTS badge_variant text NOT NULL DEFAULT 'plain';

ALTER TABLE public.badge_click_events
  DROP CONSTRAINT IF EXISTS badge_click_events_badge_variant_check;
ALTER TABLE public.badge_click_events
  ADD CONSTRAINT badge_click_events_badge_variant_check
  CHECK (badge_variant IN ('plain', 'status'));

COMMENT ON COLUMN public.badge_click_events.badge_variant IS
  'US-1913 embed badge format: plain | status. The seller opts in per embed in '
  'Badge Studio; the ?s= source is unchanged so the existing funnel keeps its '
  'meaning.';

-- The seller funnel already reads by (owner_user_id, created_at DESC) and then
-- groups in JS, so no new index is needed: the variant split rides the rows that
-- query already returns.

-- RLS is unchanged: badge_click_events is deny-all (00404), read only by the
-- service-role client through the owner-scoped funnel.

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00556')
ON CONFLICT (version) DO NOTHING;
