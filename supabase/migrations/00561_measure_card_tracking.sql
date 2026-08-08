-- US-2231 AC3 (the tracking half): let a mailed MeasureCard carry a tracking
-- number, so the seller's status is "on its way, here it is" instead of a date.
--
-- ONLY THE TRACKING HALF. AC3 also asks for an ETA, and that is deliberately
-- NOT here: quoting "ships in 3-5 days" on a page a paying seller reads is a
-- promise the fulfilment process does not currently make. Rendering a date we
-- cannot honour is worse than rendering nothing. The ETA needs a real SLA
-- first; see the note on US-2231.
--
-- NULLABLE BY DESIGN, both of them. Cards are mailed by hand, and plenty go out
-- as an untracked letter. NOT NULL would either block the operator from marking
-- those shipped at all, or push them to type a placeholder — and a placeholder
-- tracking number is worse than an empty one, because the seller clicks it.
--
-- PLAINTEXT, unlike the street address on this same table. US-2417 encrypts
-- ship_name/address_line1/address_line2/city/postal_code because they say where
-- a person lives. A tracking number is a carrier's identifier for a parcel, the
-- operator has to be able to search and paste it, and it is the one field on
-- this row the SELLER is meant to read back. Same reasoning that keeps state
-- and country readable there.

ALTER TABLE public.measure_card_requests
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS tracking_carrier text;

COMMENT ON COLUMN public.measure_card_requests.tracking_number IS
  'US-2231: carrier tracking for a mailed card. NULL = untracked letter, which is normal.';
COMMENT ON COLUMN public.measure_card_requests.tracking_carrier IS
  'US-2231: free text (usps/ups/fedex/...). Not an enum — the operator uses whatever service is cheapest that day, and a rejected value would block marking a card shipped.';

insert into public.applied_migrations (version) values ('00561') on conflict do nothing;
