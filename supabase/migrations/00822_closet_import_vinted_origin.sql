-- US-3460: let a Vinted closet import create its run row.
--
-- Same shape as 00775 and the same reason. The route writes
-- `origin: platform`, so 'vinted' has to be a permitted value BEFORE any code
-- that inserts a vinted run reaches main; Grailed shipped the other way round
-- and every Grailed import failed at the insert for months (US-3261).
--
-- Idempotent: the constraint is named, so drop-if-exists then re-add.

ALTER TABLE public.flipdesk_import_runs
  DROP CONSTRAINT IF EXISTS flipdesk_import_runs_origin_check;
ALTER TABLE public.flipdesk_import_runs
  ADD CONSTRAINT flipdesk_import_runs_origin_check
  CHECK (origin IN ('csv', 'sheet', 'paste', 'poshmark', 'mercari', 'grailed', 'vinted'));

COMMENT ON COLUMN public.flipdesk_import_runs.origin IS
  'Where the rows came from: csv/sheet/paste (US-2518) or poshmark/mercari/grailed/vinted, a closet read by the browser extension (US-9201, US-3155, US-3460). Extension origins store the same payload/effects shape and undo the same way. This list must contain every member of CLOSET_IMPORT_PLATFORMS in services/edge-functions/src/lib/closet-import.ts; closet-import-origin_test.ts fails the build when it does not.';

insert into public.applied_migrations (version) values ('00822') on conflict do nothing;
