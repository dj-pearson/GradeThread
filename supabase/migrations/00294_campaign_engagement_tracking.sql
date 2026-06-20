-- US-913: email engagement tracking — open pixel + click redirect.
--
-- The campaign_recipients ledger already had opened_at / clicked_at columns
-- (00102) but nothing ever wrote them, so the growth dashboard's open/click
-- rates were permanently zero. US-913 wires a signed-token open pixel + click
-- redirect (routes/email-engagement.ts at /api/email/{o,c}/:token) that stamps
-- these columns. This migration:
--   1. Adds the engagement detail columns the tracker needs (click_count,
--      last_clicked_url) + a bot-likely-open flag (prefetch/proxy opens are
--      recorded but flagged so they can be discounted later).
--   2. Adds two service-role-only stamping functions so the open (first-open-wins
--      + bot flag via a CASE on the prior value) and the click (idempotent
--      first-click timestamp + a running click_count + last_clicked_url) are each
--      a single atomic UPDATE the edge calls via .rpc().
--   3. Seeds the global no-track toggle into the settings registry (tracking is
--      applied to marketing broadcasts only, never transactional, and an operator
--      can disable it without a deploy).
-- Idempotent throughout (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT).

BEGIN;

-- ── 1. campaign_recipients engagement detail columns ────────────────────────

ALTER TABLE public.campaign_recipients
  ADD COLUMN IF NOT EXISTS click_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.campaign_recipients
  ADD COLUMN IF NOT EXISTS last_clicked_url text;

ALTER TABLE public.campaign_recipients
  ADD COLUMN IF NOT EXISTS open_is_bot boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campaign_recipients.click_count IS
  'US-913: total tracked clicks (clicked_at stays the FIRST click; this counts all).';
COMMENT ON COLUMN public.campaign_recipients.last_clicked_url IS
  'US-913: the most recently clicked (signed) destination URL.';
COMMENT ON COLUMN public.campaign_recipients.open_is_bot IS
  'US-913: the FIRST open looked like a prefetch/proxy bot (flagged, still recorded).';

-- ── 2. service-role stamping functions ──────────────────────────────────────
-- The stamps reference the row's CURRENT value (COALESCE for first-open/click
-- wins, click_count + 1, the bot CASE), which the supabase-js update builder
-- can't express, so they live as SQL functions the edge calls via .rpc().
-- SECURITY INVOKER (default): an anon/authenticated caller hits campaign_recipients
-- RLS (admin-only) and updates nothing; only the service-role edge (RLS-bypassing)
-- actually stamps. Execute is locked to service_role for defense-in-depth.

CREATE OR REPLACE FUNCTION public.record_campaign_email_open(
  p_campaign uuid,
  p_user uuid,
  p_bot boolean
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.campaign_recipients
     SET opened_at   = COALESCE(opened_at, now()),
         open_is_bot = CASE WHEN opened_at IS NULL THEN p_bot ELSE open_is_bot END
   WHERE campaign_id = p_campaign
     AND user_id     = p_user
     AND channel     = 'email';
$$;

CREATE OR REPLACE FUNCTION public.record_campaign_email_click(
  p_campaign uuid,
  p_user uuid,
  p_url text
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.campaign_recipients
     SET clicked_at        = COALESCE(clicked_at, now()),
         opened_at         = COALESCE(opened_at, now()),
         click_count       = click_count + 1,
         last_clicked_url  = p_url
   WHERE campaign_id = p_campaign
     AND user_id     = p_user
     AND channel     = 'email';
$$;

REVOKE ALL ON FUNCTION public.record_campaign_email_open(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_campaign_email_click(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_campaign_email_open(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_campaign_email_click(uuid, uuid, text) TO service_role;

-- ── 3. no-track toggle ──────────────────────────────────────────────────────

INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'marketing_email_tracking_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb,
    'US-913: when true, marketing broadcast emails get a signed open pixel + click-tracking link rewrite at render time. Set false to disable engagement tracking (no-track) without a deploy. Never applied to transactional mail.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00294')
ON CONFLICT (version) DO NOTHING;
