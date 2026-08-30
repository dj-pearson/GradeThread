-- US-2993: snap a receipt and the expense fills itself in.
--
-- The bucket, the magic-byte validation and the EXIF strip already exist
-- (US-2228, migration 00564). What was missing is the part that makes anyone
-- use it: the seller still typed vendor, date, amount and category by hand
-- AFTER attaching the photo.
--
-- WHAT THIS TABLE RECORDS IS PROVENANCE, NOT THE ANSWER. The extracted values
-- land in the ordinary columns (`description`, `amount`, `spent_on`) because a
-- confirmed extraction IS the expense -- there is no second class of
-- machine-entered row. What is kept separately is which prompt produced it, how
-- sure the model was, and whether a human changed it afterwards.
--
-- AC6 is the reason: a bad prompt release has to be traceable to the entries it
-- produced. Without the version on the row, the only way to find them is to
-- guess at dates.

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS extracted_at timestamptz;
ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS extraction_prompt_version text;
-- Per-field confidence as the model reported it, e.g.
-- {"vendor":0.94,"total":0.99,"date":0.61,"tax":0.0}.
-- Stored per field rather than as one number because that is how it is USED:
-- a receipt can have a crisp total and an illegible date, and one aggregate
-- confidence would hide exactly the field the seller needs to check.
ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS extraction_confidence jsonb;
-- What the model proposed, before the seller touched it. Kept so a later reader
-- can tell an extraction that was accepted from one that was corrected -- which
-- is the only way to know whether the prompt is any good.
ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS extraction_proposed jsonb;

comment on column public.flipdesk_expenses.extraction_prompt_version is
  'US-2993 AC6. Which prompt produced this row. A bad prompt release has to be traceable to the entries it made, and without this the only way to find them is to guess at dates.';
comment on column public.flipdesk_expenses.extraction_confidence is
  'US-2993 AC3. PER FIELD, not one number: a receipt can have a crisp total and an illegible date, and an aggregate would hide exactly the field worth checking.';
comment on column public.flipdesk_expenses.extraction_proposed is
  'US-2993 what the model proposed before the seller touched it. Lets a later reader tell an accepted extraction from a corrected one, which is the only way to know whether the prompt is any good.';

CREATE INDEX IF NOT EXISTS idx_flipdesk_expenses_prompt_version
  ON public.flipdesk_expenses(extraction_prompt_version)
  WHERE extraction_prompt_version IS NOT NULL;


-- Duplicate detection (AC4).
--
-- Photographing the same receipt twice is the commonest way a total goes wrong,
-- and it is invisible afterwards: two identical expenses look like two real
-- purchases. This finds them BEFORE the save, on the three fields a person can
-- actually compare.
--
-- Deliberately a FUNCTION and not a unique constraint. Two coffees from the
-- same shop on the same day for the same price is a real thing that happens,
-- and refusing it outright would be wrong. The screen asks; it does not block.
CREATE OR REPLACE FUNCTION public.find_duplicate_expenses(
  p_amount  numeric,
  p_spent_on date,
  p_description text
)
RETURNS TABLE (
  id uuid,
  description text,
  amount numeric,
  spent_on date,
  has_receipt boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT x.id, x.description, x.amount, x.spent_on,
         x.receipt_path IS NOT NULL
    FROM public.flipdesk_expenses x
   WHERE x.amount = p_amount
     -- A day either side: a card statement and a receipt can disagree by one,
     -- and an exact-date-only match would miss the duplicate that matters.
     AND x.spent_on BETWEEN p_spent_on - 1 AND p_spent_on + 1
     AND (
       p_description IS NULL
       OR x.description IS NULL
       OR lower(btrim(x.description)) = lower(btrim(p_description))
     )
   ORDER BY x.spent_on DESC
   LIMIT 5;
$fn$;

grant execute on function public.find_duplicate_expenses(numeric, date, text)
  to authenticated;
grant execute on function public.find_duplicate_expenses(numeric, date, text)
  to service_role;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00700') on conflict do nothing;
