-- US-3060: the seller's switch for the on-marketplace verified badge.
--
-- The extension shows a graded listing's certificate grade on the eBay,
-- Poshmark or Mercari page. That is a seller-visible change to how their own
-- listing looks inside a stranger's browser, so it needs an off switch, and the
-- default has to be a decision rather than an accident.
--
-- DEFAULT false = badges ON. The badge only ever renders for a listing the
-- seller already paid to grade and already published with a public certificate,
-- so showing it surfaces a fact they have already made public rather than
-- disclosing anything new. NOT NULL because a three-state opt-out has no third
-- meaning here: unset and opted-in are the same listing.
--
-- flipdesk_settings is per-user with RLS scoped to user_id (00134), so the SPA
-- reads and writes this directly on the upsert-on-user_id path that
-- cross_post_channels (00644) and lister_locales (00648) use. The public
-- badge route reads it with the service-role client to omit an opted-out
-- seller's listings before they leave the server.

ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS listing_badge_opt_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.flipdesk_settings.listing_badge_opt_out IS
  'US-3060: true when the seller has turned OFF the on-marketplace verified '
  'badge for their graded listings. false (the default) means the extension may '
  'show the certificate grade on their eBay/Poshmark/Mercari pages. Read by the '
  'public listing-certificates route, which omits an opted-out seller''s rows.';

insert into public.applied_migrations (version) values ('00727') on conflict do nothing;
