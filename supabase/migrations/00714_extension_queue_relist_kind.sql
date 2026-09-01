-- US-9203: the mobile extension queue learns a fourth verb, relist.
--
-- A relist on Poshmark or Mercari copies the live listing into a fresh one
-- and, once the copy is live, ends the old one. From a phone (and from the
-- automation engine, which has no browser) that is an instruction for the
-- desktop extension: the old listing's URL, the new draft row's id, and the
-- values the copy should carry. Same drop-and-recreate as 00590 and 00713.

ALTER TABLE public.extension_work_queue
  DROP CONSTRAINT IF EXISTS extension_work_queue_kind_check;
ALTER TABLE public.extension_work_queue
  ADD CONSTRAINT extension_work_queue_kind_check
  CHECK (kind IN ('list', 'delist', 'revise', 'relist'));

COMMENT ON COLUMN public.extension_work_queue.kind IS
  'list, delist, revise (US-9202) or relist (US-9203). A share run needs a present human at the browser, so it is not queueable work (US-2497).';

insert into public.applied_migrations (version) values ('00714') on conflict do nothing;
