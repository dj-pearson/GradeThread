-- US-2228 AC2: a receipt attached to an operating expense.
--
-- Bookkeeping without the document is a number somebody has to take on trust.
-- The row already records what was spent; this records the proof, so a seller
-- assembling a tax return has the evidence beside the entry instead of in a
-- shoebox.

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS receipt_path text;
ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS receipt_mime text;
ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz;

comment on column public.flipdesk_expenses.receipt_path is
  'US-2228 object key in the PRIVATE expense-receipts bucket, always {user_id}/{expense_id}/receipt_{ts}.{ext}. Never a URL: the object is readable only through a short-lived signed URL issued by the edge after an ownership check.';

-- PRIVATE bucket. public = false is load-bearing, not a default: a receipt
-- carries a card tail, a billing address, sometimes a full name — none of which
-- belongs on a guessable URL. This is deliberately NOT item-photos, the one
-- public bucket, whose contract is seller listing imagery only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts',
  'expense-receipts',
  false,
  10485760, -- 10MB, matching the other private buckets
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- No storage policies, i.e. deny-all to anon and authenticated. Both directions
-- go through the edge service-role client, which bypasses RLS and does the
-- ownership check itself: uploads so the bytes are sniffed and stripped before
-- they land, reads so a signed URL is only ever issued to the row's owner.
-- A per-user-folder policy would ALSO be correct, but it would imply the browser
-- may talk to this bucket directly, and it may not — the validation is the
-- point of the round trip.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00564') on conflict do nothing;
