-- US-9202: the mobile extension queue learns a third verb, revise.
--
-- An edit made on the phone to an item that is live on Poshmark, Mercari or
-- Vinted cannot reach the marketplace from the phone (no write API; the
-- extension runs on the desktop). The US-2481 queue already carries list and
-- delist instructions from the phone to the desktop; revise is the same shape
-- of instruction: a listing id, a platform, and which fields to bring up to
-- date. The values are read off the listing row at drain time.
--
-- Same drop-and-recreate as 00590, so a full directory re-run converges here.

ALTER TABLE public.extension_work_queue
  DROP CONSTRAINT IF EXISTS extension_work_queue_kind_check;
ALTER TABLE public.extension_work_queue
  ADD CONSTRAINT extension_work_queue_kind_check
  CHECK (kind IN ('list', 'delist', 'revise'));

COMMENT ON COLUMN public.extension_work_queue.kind IS
  'list, delist or revise (US-9202). A share run needs a present human at the browser, so it is not queueable work (US-2497).';

insert into public.applied_migrations (version) values ('00713') on conflict do nothing;
