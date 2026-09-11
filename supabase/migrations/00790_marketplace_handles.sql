-- US-3369: the seller's own username on marketplaces whose "my listings" page
-- lives under it.
--
-- Poshmark has no handle-free URL for your own closet. /closet, /closet/me and
-- /my-closet all 404 (checked 2026-09-11); the page is /closet/{username}. So
-- the "open your active listings" link a seller needs when a delist has to be
-- done by hand, and the page the extension searches when it holds no link to
-- the listing itself, both need that one word.
--
-- KEYED BY PLATFORM, same reasoning as lister_locales (00648): one platform
-- needs it today and a jsonb map means the next one is a key, not a migration.
--
-- The VALUE is a bare username, never a URL. The web and the extension each
-- validate it against a strict character set and substitute it into a URL
-- template they own (US-1876), so a stored value can never choose a host.
--
-- flipdesk_settings is per-user with RLS scoped to user_id (00134); the SPA
-- upserts this directly the way it does lister_locales. The edge reads it with
-- the service-role client to put the handle on a queued delist.

ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS marketplace_handles jsonb;

COMMENT ON COLUMN public.flipdesk_settings.marketplace_handles IS
  'US-3369: platform -> the seller''s username there, e.g. {"poshmark": "jane_closet"}. '
  'A bare username, never a URL. NULL or a missing key means we do not know it.';

insert into public.applied_migrations (version) values ('00790') on conflict do nothing;
