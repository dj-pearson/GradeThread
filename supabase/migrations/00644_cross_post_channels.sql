-- US-2721: which marketplaces this seller actually sells on.
--
-- A seller who only uses Poshmark and Mercari is offered six channels on every
-- draft, and the Listing Kit generates fields for all of them: six tabs of AI
-- output they will never open, on every item.
--
-- NULL MEANS ALL, and that is the whole design of this column. Every existing
-- row has no value and every new seller starts with none, so the default has to
-- be "you keep what you have today". An empty ARRAY is a different statement -
-- a seller who deliberately turned everything off - but the app treats it as
-- all too, because losing every channel is never what somebody meant by
-- clicking until nothing was left. The setting narrows; it cannot switch the
-- feature off.
--
-- Not an enum and not a foreign key: the platform vocabulary lives in
-- src/lib/constants.ts and moves when a channel is added, and a DB enum would
-- make that a migration every time. The picker only ever writes values it
-- rendered, so the constraint that matters is on the way in.
--
-- flipdesk_settings is per-user with RLS scoped to user_id (00134), so the SPA
-- reads and writes this directly - the same upsert-on-user_id path the
-- auto_end_cross_listings toggle already uses. No edge route.

ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS cross_post_channels text[];

COMMENT ON COLUMN public.flipdesk_settings.cross_post_channels IS
  'US-2721: the marketplaces this seller cross-posts to. NULL means ALL - '
  'the setting narrows the offered channels and can never turn cross-posting '
  'off. An empty array is treated as ALL by the app for the same reason.';

insert into public.applied_migrations (version) values ('00644') on conflict do nothing;
