-- US-1880 (AC3): anonymous selector-failure telemetry for the research surface.
--
-- WHY THIS EXISTS. selectors.js has claimed since it was written that broken
-- adapters "can be corrected from telemetry without shipping a new build" — but
-- no telemetry existed anywhere, so a marketplace could silently change its DOM
-- and the only signal was a shopper seeing "couldn't read this listing's photos"
-- and never mentioning it. This table is that missing signal.
--
-- PRIVACY IS THE WHOLE DESIGN, NOT A SETTING. This is opt-in in the extension
-- and deliberately cannot identify a person or a listing:
--   • NO listing URL, page title, brand, price, or any scraped content
--   • NO account reference, extension instance id, IP, or user agent
--   • NOTHING that can be joined back to a user — by construction, not policy
-- What lands here is "adapter <k> at config <v> found nothing with its <list>
-- selectors". That is enough to fix a selector and nothing more. Keep it that
-- way: any column added here that narrows the row toward one person or one
-- listing turns an anonymous counter into tracking.
--
-- Operator table: deny-all RLS, service-role writes only, never read by the SPA.
-- Registered in SERVICE_ROLE_ONLY in rls-guard_test.ts.

CREATE TABLE IF NOT EXISTS public.selector_health_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Adapter key from the shipped config (ebay, poshmark, grailed, ...).
  adapter TEXT NOT NULL,
  -- Which selector LISTS came up empty: gallery / title / brand / price /
  -- condition. 'gallery-no-urls' is the distinct, more interesting failure —
  -- the gallery selectors DID match elements, but no usable image URL came out
  -- of them, which points at imageAttrs or the urlUpgrade rule rather than at
  -- the gallery selector itself.
  empty_selectors TEXT[] NOT NULL DEFAULT '{}',
  -- Version of the selector config in force when the miss happened, so a fix
  -- can be confirmed to have actually landed (bundled or hosted).
  config_version TEXT,
  -- Extension version, to spot a regression that shipped in one build.
  ext_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only query shape: "what is failing lately, by adapter".
CREATE INDEX IF NOT EXISTS idx_selector_health_pings_adapter_at
  ON public.selector_health_pings (adapter, created_at DESC);

ALTER TABLE public.selector_health_pings ENABLE ROW LEVEL SECURITY;

-- Deny-all: no policies. The service-role edge client bypasses RLS to insert;
-- anon/authenticated get nothing. An anonymous unauthenticated endpoint writes
-- here, so a readable table would be a free public firehose.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON public.selector_health_pings FROM anon, authenticated';
EXCEPTION WHEN OTHERS THEN
  NULL; -- roles may not exist on a bare local stack
END
$$;

COMMENT ON TABLE public.selector_health_pings IS
  'US-1880: anonymous, opt-in adapter selector-failure counters. No URL, no '
  'account, no IP, no instance id — nothing joinable to a person or a listing. '
  'Deny-all RLS; service-role insert only.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00475') ON CONFLICT DO NOTHING;
