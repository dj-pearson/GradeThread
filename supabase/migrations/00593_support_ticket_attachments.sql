-- US-2525 — image attachments on a support ticket.
--
-- Support is where someone goes when a photo came out wrong, a grade looks
-- wrong, or a screen shows something they cannot describe. The ticket thread
-- took text only, so every one of those conversations started with the user
-- trying to put a picture into words.
--
-- One additive column. The files themselves live in the existing PRIVATE
-- `submission-images` bucket under the user's own folder
-- (`{userId}/support/{ticketId}/…`), which already carries the per-user-folder
-- RLS policy from US-276, so no bucket and no storage policy is added here.
-- This column holds only the paths; the edge hands out short-lived signed URLs.

ALTER TABLE public.support_ticket_messages
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.support_ticket_messages.attachments IS
  'US-2525: image attachments on this message, as [{path, name, content_type, bytes}]. Paths point into the PRIVATE submission-images bucket under {userId}/support/{ticketId}/; the edge returns signed URLs (TTL <= 900s) and never a public URL.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00593') on conflict do nothing;
