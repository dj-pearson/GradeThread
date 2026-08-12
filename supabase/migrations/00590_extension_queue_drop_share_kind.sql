-- US-2497: the queue stops accepting a share run, because nothing can run one.
--
-- 00588 gave the queue three verbs. Two of them drain. The third never could:
-- the Poshmark engagement engine only starts against an ACTIVE tab already on
-- the seller's own closet, and the extension holds no Poshmark handle and will
-- not navigate to a URL that arrived in a message (US-1876). A background drain
-- has neither.
--
-- The deciding reason is not that it is hard. It is the fourth sentence of the
-- engagement clickwrap: "GradeThread will stop and hand the tab back to me if
-- Poshmark asks for a human check." A run triggered from a phone has no human at
-- the machine to hand it back to, so the promise cannot be kept. Full reasoning
-- lives in the US-2497 story notes and in
-- vault/30-platform/closing-a-coverage-gap.md.

-- Rows that were queued before this and can never run. Deleting rather than
-- expiring them, because the CHECK below refuses the VALUE regardless of status,
-- and because this table is a work queue rather than an audit log. The drain
-- already completed the ones it saw with ok:false; these are the leftovers on
-- accounts whose desktop never opened.
DELETE FROM public.extension_work_queue WHERE kind = 'share';

-- Narrowed to what the extension can actually drain. Dropped and recreated
-- rather than added, so a re-run of the whole directory converges here instead
-- of leaving 00588's wider check in place.
ALTER TABLE public.extension_work_queue
  DROP CONSTRAINT IF EXISTS extension_work_queue_kind_check;
ALTER TABLE public.extension_work_queue
  ADD CONSTRAINT extension_work_queue_kind_check
  CHECK (kind IN ('list', 'delist'));

COMMENT ON COLUMN public.extension_work_queue.kind IS
  'US-2497: list or delist. A share run needs a present human at the browser, '
  'so it is not queueable work.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00590') on conflict do nothing;
