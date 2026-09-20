-- Phone capture, several items on one code (US-3185).
--
-- US-3161 bound a scanned code to ONE item, which is right for the composer
-- and wrong for a bin of twenty garments: the seller walked back to the
-- computer between every one. This adds the group boundary the phone marks
-- with a "Next item" control, so one code carries a whole bin.
--
-- TWO COLUMNS, and the split is the point. The SESSION's group_index is the
-- item the phone is shooting RIGHT NOW; a PHOTO's group_index is the item it
-- was taken on, copied from the session at insert and never rewritten. The
-- phone never sends an index, so there is nothing for a tampered page to
-- scatter: the only thing it can ask for is "advance", and the server decides
-- whether that is allowed.
--
-- THE THIRD TARGET KIND. AutoLister photo intake has no
-- listing_generation_batches row to bind to -- that row is created when
-- generation STARTS, which is after the photos exist and have been grouped
-- into items. So a capture started from the intake page binds to 'staging' and
-- its target_id is the seller's own AutoLister session id. Nothing is written
-- to the target for any kind: the desktop polls its own session under an owner
-- filter and stages what it finds, so the target is what the code is FOR, not
-- something the token can write through.
--
-- Idempotent: both ADD COLUMNs are IF NOT EXISTS, and the CHECK is dropped
-- before it is recreated, so re-running changes nothing.

ALTER TABLE public.phone_capture_sessions
  ADD COLUMN IF NOT EXISTS group_index integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.phone_capture_sessions.group_index IS
  'US-3185: the item the phone is shooting now. Advanced only by POST /s/:token/next-item.';

ALTER TABLE public.phone_capture_photos
  ADD COLUMN IF NOT EXISTS group_index integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.phone_capture_photos.group_index IS
  'US-3185: the item this shot was taken on, copied from the session at insert.';

-- 'staging' joins the vocabulary. The constraint is dropped first because an
-- existing CHECK cannot be widened in place.
ALTER TABLE public.phone_capture_sessions
  DROP CONSTRAINT IF EXISTS phone_capture_sessions_target_kind_check;
ALTER TABLE public.phone_capture_sessions
  ADD CONSTRAINT phone_capture_sessions_target_kind_check
  CHECK (target_kind IN ('item', 'batch', 'staging'));

-- The desktop reads a session's photos in item order, then in shooting order
-- within an item, which is exactly the grid it builds from them.
CREATE INDEX IF NOT EXISTS idx_phone_capture_photos_session_group
  ON public.phone_capture_photos(session_id, group_index, created_at);

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00805') on conflict do nothing;
