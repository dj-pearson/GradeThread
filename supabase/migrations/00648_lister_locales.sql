-- US-2777: which country domain a seller's marketplace account lives on.
--
-- Vinted runs 22 country domains behind one app. US-2479 built locale support
-- the whole way down - ListerPayload.locale, newListingUrlForLocale, the
-- bundled 22-domain map, a fail-loud path naming the covered locales - and
-- nothing ever supplied the input. A French seller silently got vinted.com.
--
-- KEYED BY PLATFORM, not a `vinted_locale` column. Exactly one platform has
-- country domains today, so a single text column would be simpler and would
-- also guarantee that the second one repeats this story: a new column, a new
-- migration, and a fresh wiring pass through every client. A jsonb map means
-- the next multi-domain platform is a key.
--
-- The VALUE is a locale KEY ("vinted.fr"), never a URL. The extension looks the
-- key up in its own bundled config to get a navigation target - that is the
-- US-1876 rule, and it is why a column holding a host is safe while a column
-- holding a URL would not be.
--
-- NULL / absent key means the platform's stated default, which is what every
-- existing row gets and what every seller has today. No backfill: we do not
-- know anyone's country, and guessing one would send a US seller to a domain
-- their account does not exist on - the exact failure this fixes, inverted.
--
-- flipdesk_settings is per-user with RLS scoped to user_id (00134), so the SPA
-- reads and writes this directly, the same upsert-on-user_id path
-- cross_post_channels (00644) uses. The edge reads it with the service-role
-- client to stamp queued jobs.

ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS lister_locales jsonb;

COMMENT ON COLUMN public.flipdesk_settings.lister_locales IS
  'US-2777: platform -> locale key, e.g. {"vinted": "vinted.fr"}. The value is '
  'a KEY the extension resolves against its bundled domain map, never a URL. '
  'NULL or a missing key means that platform''s default domain.';

insert into public.applied_migrations (version) values ('00648') on conflict do nothing;
