-- US-1757 (AC2): anonymous, opt-in usage counters for the browser extension.
--
-- WHY THIS EXISTS. US-1753 tagged every outbound extension link, so a SIGNUP is
-- traceable to the extension; a store dashboard reports INSTALLS. Between those
-- two ends there was no measurement at all, so "installs convert to accounts"
-- was a question the funnel could not answer.
--
-- PRIVACY IS THE DESIGN, NOT A SETTING — same posture as selector_health_pings
-- (00475). Opt-in in the extension, off by default, and by construction this
-- cannot identify a person or a listing:
--   * NO listing URL, page title, seller, or any scraped content
--   * NO account reference, extension instance id, IP, or user agent
--   * NO client timestamp: the extension TALLIES on the device and sends totals
--     hours later, so there is no event stream and no ordering to reconstruct
-- What lands here is "this many reads / this many click-throughs from surface X
-- happened somewhere, on build v". Keep it that way: a column added here that
-- narrows a row toward one person or one session turns an anonymous tally into
-- tracking, which is precisely what the toggle's copy promises it is not.
--
-- Operator table: deny-all RLS, service-role writes only, never read by the SPA.
-- Registered in SERVICE_ROLE_ONLY in rls-guard_test.ts.

CREATE TABLE IF NOT EXISTS public.extension_usage_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Closed vocabulary, enforced by the endpoint: 'read' | 'click_through'.
  event TEXT NOT NULL,
  -- Where a click came from: 'popup' | 'overlay' | 'flip' | 'onboarding'. This
  -- is the SAME word the link already carries as utm_medium, so a click and the
  -- signup it produces are counted under one name. NULL for events with no
  -- surface (a read).
  surface TEXT,
  -- How many of that event the window accumulated. Saturating on both sides
  -- (client and endpoint) at 999 — past that the exact number changes nothing
  -- we would act on, and an unbounded counter is a channel.
  event_count INTEGER NOT NULL DEFAULT 1
    CONSTRAINT extension_usage_pings_event_count_ck CHECK (event_count > 0 AND event_count <= 999),
  -- Extension version, so a drop in reads-per-install can be pinned to the build
  -- that caused it. The one free-ish field, charset- and length-capped upstream.
  ext_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only query shape: "what happened lately, by event and surface".
CREATE INDEX IF NOT EXISTS idx_extension_usage_pings_event_at
  ON public.extension_usage_pings (event, created_at DESC);

ALTER TABLE public.extension_usage_pings ENABLE ROW LEVEL SECURITY;

-- Deny-all: no policies. The service-role edge client bypasses RLS to insert;
-- anon/authenticated get nothing. An anonymous unauthenticated endpoint writes
-- here, so a readable table would be a free public firehose.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON public.extension_usage_pings FROM anon, authenticated';
EXCEPTION WHEN OTHERS THEN
  NULL; -- roles may not exist on a bare local stack
END
$$;

COMMENT ON TABLE public.extension_usage_pings IS
  'US-1757: anonymous, opt-in extension usage counters (reads + click-throughs). '
  'Totals only — no client timestamp, no URL, no account, no IP, no instance id, '
  'nothing joinable to a person or a session. Deny-all RLS; service-role insert only.';

insert into public.applied_migrations (version) values ('00531') on conflict do nothing;
