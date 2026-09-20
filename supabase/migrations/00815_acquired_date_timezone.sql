-- US-3314: record the zone that named an acquisition day, from here forward.
--
-- THE DEFECT THIS DOES NOT REPAIR, and that is the decision rather than an
-- omission. Until US-3310, both iOS writers of inventory_items.acquired_date
-- named the day in UTC from a moment carrying the seller's local wall-clock
-- time, so any row written when the device's local day differed from the UTC
-- day is off by one -- later for sellers west of UTC, earlier for those east.
-- The stored value carries no record of the zone it was named in and there is
-- no per-user timezone column to reconstruct one from, so a blanket shift
-- would corrupt every row that was already right, and most of them were. The
-- owner's decision on 2026-09-20 was to correct FORWARD: leave the old rows,
-- start recording the zone, and say plainly which rows are trustworthy.
--
-- WHAT THE COLUMN MEANS. The IANA zone the WRITER was in when the day was
-- named, e.g. "America/Chicago". NULL means unrecorded, which is every row
-- written before this migration and every row a CSV import creates, since an
-- import carries the file's day rather than a device's.
--
-- WHERE IT IS LOAD-BEARING: only where the day was DERIVED from a moment,
-- which is the iOS catalogue path. Where the seller typed a date into a date
-- field -- the composer, intake, bulk intake and snap catalogue on the web --
-- the day is the seller's own choice and no zone can correct it. The column is
-- still written there, because a future repair needs to know which rows it may
-- touch, and a row with no zone is one it must not.

alter table public.inventory_items
  add column if not exists acquired_date_tz text;

comment on column public.inventory_items.acquired_date_tz is
  'US-3314: the IANA zone the writer was in when acquired_date was named. NULL '
  'means unrecorded -- every row before 2026-09-20, and every CSV import. Only '
  'load-bearing where the day was derived from a moment (the iOS catalogue '
  'path); where the seller typed the date it is context, not a correction key. '
  'acquired_date is trustworthy without it only from that date forward.';

insert into public.applied_migrations (version) values ('00815') on conflict do nothing;
