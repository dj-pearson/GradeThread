-- US-1700: ad click-id attribution store.
--
-- Captures Google click ids (gclid / gbraid / wbraid) — and later Apple Search
-- Ads — on inbound visits and links them to the resulting signup + downstream
-- conversion (with value), so the ads analysis engine (US-1701) and the offline
-- conversion import (US-1704) can optimize toward real value (signups, subs,
-- paid grades, FlipDesk activation) instead of raw clicks.
--
-- OPERATOR table: written server-side (the /api/ads/attribution route + the
-- offline import), read only by operator analysis — the SPA never reads it.
-- Deny-all RLS, rls-guard registered. The converted user is `owner_user_id`
-- (operator naming, NOT a tenant key `user_id`) so the tenant-isolation guard
-- doesn't misclassify this as user-owned data; nullable until a conversion links.
-- Click ids are NOT PII (opaque Google/Apple identifiers).

CREATE TABLE IF NOT EXISTS public.ad_click_attributions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  click_id         text NOT NULL,
  -- 'gclid' | 'gbraid' | 'wbraid' (the URL param it arrived as)
  click_id_type    text NOT NULL,
  -- 'google_ads' | 'apple_search_ads'
  platform         text NOT NULL,
  landing_at       timestamptz NOT NULL DEFAULT now(),
  -- The converted user (operator column name, nullable until a conversion links).
  owner_user_id    uuid,
  converted_at     timestamptz,
  conversion_type  text,
  value            numeric,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per click id (upsert on re-landing or when the conversion links).
CREATE UNIQUE INDEX IF NOT EXISTS ad_click_attributions_click_id_idx
  ON public.ad_click_attributions (click_id);
CREATE INDEX IF NOT EXISTS ad_click_attributions_owner_idx
  ON public.ad_click_attributions (owner_user_id);
-- The analysis/import read path filters on conversions in a window.
CREATE INDEX IF NOT EXISTS ad_click_attributions_converted_idx
  ON public.ad_click_attributions (platform, converted_at);

ALTER TABLE public.ad_click_attributions ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_ad_click_attributions_updated_at ON public.ad_click_attributions;
CREATE TRIGGER set_ad_click_attributions_updated_at
  BEFORE UPDATE ON public.ad_click_attributions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00382') on conflict do nothing;
