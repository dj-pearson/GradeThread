-- US-3261: the Grailed closet import could never create its run row.
--
-- US-3155 added 'grailed' to CLOSET_IMPORT_PLATFORMS and gave it a photo-host
-- allowlist, but the origin CHECK from 00712 still listed five values. The
-- route writes `origin: platform`, so every Grailed import failed at the insert
-- and the seller was told "Could not start the import."
--
-- Idempotent: the constraint is named, so drop-if-exists then re-add.

ALTER TABLE public.flipdesk_import_runs
  DROP CONSTRAINT IF EXISTS flipdesk_import_runs_origin_check;
ALTER TABLE public.flipdesk_import_runs
  ADD CONSTRAINT flipdesk_import_runs_origin_check
  CHECK (origin IN ('csv', 'sheet', 'paste', 'poshmark', 'mercari', 'grailed'));

COMMENT ON COLUMN public.flipdesk_import_runs.origin IS
  'Where the rows came from: csv/sheet/paste (US-2518) or poshmark/mercari/grailed, a closet read by the browser extension (US-9201, US-3155). Extension origins store the same payload/effects shape and undo the same way. This list must contain every member of CLOSET_IMPORT_PLATFORMS in services/edge-functions/src/lib/closet-import.ts; closet-import-origin_test.ts fails the build when it does not.';

insert into public.applied_migrations (version) values ('00775') on conflict do nothing;
