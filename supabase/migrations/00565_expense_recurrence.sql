-- US-2228 AC3: an expense that repeats every month.
--
-- Rent on a storage unit, a listing subscription, a phone line. The seller logs
-- it once and the system keeps the books current instead of asking them to
-- retype the same number twelve times a year and to remember the month they
-- forgot.

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS recurs_monthly boolean NOT NULL DEFAULT false;

-- Provenance, and the thing the uniqueness guard keys on.
--
-- ON DELETE SET NULL, deliberately NOT CASCADE. Deleting the template must mean
-- "stop repeating this", not "erase the months it already covered" — those are
-- real expenses that were really paid, and a cascade would silently rewrite a
-- year of books from a single Delete click. The generated rows survive; they
-- just lose the link back, which is the correct amount of damage.
ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS recurrence_source_id uuid
    REFERENCES public.flipdesk_expenses(id) ON DELETE SET NULL;

comment on column public.flipdesk_expenses.recurs_monthly is
  'US-2228 true on the TEMPLATE row only. The cron copies it forward one entry per month; the copies are ordinary expenses and never repeat themselves.';
comment on column public.flipdesk_expenses.recurrence_source_id is
  'US-2228 the template this row was generated from. NULL on a hand-logged expense and on the template itself.';

-- THE IDEMPOTENCY GUARD, and the reason the cron needs no bookkeeping column.
--
-- One generated entry per template per month, enforced by the database rather
-- than by the job remembering where it got to. A "next_occurrence_on" column
-- would have to be advanced in a second write, and a crash between the insert
-- and that write duplicates the month — the exact failure that makes a seller
-- distrust their own totals. With this index the job can re-run as often as it
-- likes, catch up after an outage, and race a second instance, and the worst
-- outcome is a rejected insert.
CREATE UNIQUE INDEX IF NOT EXISTS flipdesk_expenses_recurrence_slot_idx
  ON public.flipdesk_expenses (recurrence_source_id, spent_on)
  WHERE recurrence_source_id IS NOT NULL;

-- The cron's scan. Partial, so it stays small no matter how many expenses the
-- table holds: only templates are ever scanned.
CREATE INDEX IF NOT EXISTS flipdesk_expenses_recurring_templates_idx
  ON public.flipdesk_expenses (spent_on)
  WHERE recurs_monthly AND recurrence_source_id IS NULL;

-- A generated copy may never itself be a template. Without this, a bug that set
-- the flag on a copy would give the next run a second series to extend, and the
-- month after that four, and the table grows without anyone doing anything.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flipdesk_expenses_no_nested_recurrence'
  ) THEN
    ALTER TABLE public.flipdesk_expenses
      ADD CONSTRAINT flipdesk_expenses_no_nested_recurrence
      CHECK (NOT (recurs_monthly AND recurrence_source_id IS NOT NULL));
  END IF;
END $$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00565') on conflict do nothing;
