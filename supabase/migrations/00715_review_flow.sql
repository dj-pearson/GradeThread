-- US-9204: the one-screen review flow.
--
-- Two facts the review screen writes and the overview reads back:
--   inventory_items.review_approve_seconds - seconds from the first photo to
--     the Approve press, per item. The overview shows the seller's median.
--   flipdesk_settings.review_flow_enabled - the one-time "Try the new flow"
--     switch. NULL means "decide by account age" (accounts created after the
--     ship date default on); true or false is the seller's own choice.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS review_approve_seconds integer,
  ADD COLUMN IF NOT EXISTS review_approved_at timestamptz;

COMMENT ON COLUMN public.inventory_items.review_approve_seconds IS
  'US-9204: seconds from the first photo to the Approve press on the review screen. NULL when the item never went through it.';
COMMENT ON COLUMN public.inventory_items.review_approved_at IS
  'US-9204: when the review screen''s Approve was pressed for this item.';

ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS review_flow_enabled boolean;

COMMENT ON COLUMN public.flipdesk_settings.review_flow_enabled IS
  'US-9204: the seller''s own choice about the one-screen review flow. NULL means decide by account age (created after the ship date defaults on).';

insert into public.applied_migrations (version) values ('00715') on conflict do nothing;
