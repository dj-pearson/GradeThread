-- US-9201: closet import through the extension reuses the durable import run.
--
-- flipdesk_import_runs.origin said where the rows came from and allowed three
-- spreadsheet shapes. A closet read from the seller's own Poshmark or Mercari
-- pages is the same durable, reversible run with a fourth and fifth source, so
-- the CHECK widens rather than a parallel table appearing.
--
-- Idempotent: the inline CHECK from 00592 is named by Postgres as
-- flipdesk_import_runs_origin_check; drop-if-exists then re-add.

ALTER TABLE public.flipdesk_import_runs
  DROP CONSTRAINT IF EXISTS flipdesk_import_runs_origin_check;
ALTER TABLE public.flipdesk_import_runs
  ADD CONSTRAINT flipdesk_import_runs_origin_check
  CHECK (origin IN ('csv', 'sheet', 'paste', 'poshmark', 'mercari'));

COMMENT ON COLUMN public.flipdesk_import_runs.origin IS
  'Where the rows came from: csv/sheet/paste (US-2518) or poshmark/mercari, a closet read by the browser extension (US-9201). Extension origins store the same payload/effects shape and undo the same way.';

insert into public.applied_migrations (version) values ('00712') on conflict do nothing;
