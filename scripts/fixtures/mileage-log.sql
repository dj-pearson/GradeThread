-- US-2989 -- the mileage log, exercised against real Postgres.
--
-- Run it with: node scripts/check-mileage-log.mjs
--
-- Inside one transaction that ROLLS BACK. What it proves:
--
--   1. THE MID-YEAR RATE CHANGE. Two identical 100-mile trips, one on
--      2022-06-30 and one on 2022-07-01, must be valued differently: 58.5 cents
--      against 62.5. This is the case a constant cannot express and the whole
--      reason the rate is a dated table.
--   2. Rounding happens ONCE on the total, not per trip. 58.5 cents a mile on
--      an odd number of miles is a fraction of a cent, and rounding each trip
--      then summing drifts.
--   3. A trip on a PROVISIONAL rate is still valued, and still counted as
--      provisional so the screen can say so.
--   4. A trip BEFORE any published rate gets no entry at all -- a rate we do not
--      have is not a rate of zero.
--   5. THE LEDGER AND THE SUMMARY AGREE TO THE CENT. Two independent routes to
--      the same deduction, which is the invariant the whole epic runs on.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-000001111330', 'mileage@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.sources (id, user_id, name, source_type)
values ('50000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000001111330', 'Goodwill on 5th', 'thrift')
on conflict (id) do nothing;

-- 1 + 2: the mid-year change. Identical mileage, one day apart.
insert into public.mileage_trips
  (id, user_id, trip_date, miles, purpose, start_location, end_location,
   round_trip, source_id)
values
 ('70000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000001111330',
  '2022-06-30', 100.0, 'Sourcing run', 'Home', 'Goodwill on 5th', true,
  '50000000-0000-0000-0000-000000000001'),
 ('70000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000001111330',
  '2022-07-01', 100.0, 'Sourcing run', 'Home', 'Goodwill on 5th', true,
  '50000000-0000-0000-0000-000000000001'),
 -- An odd mileage on the 58.5 rate: 37.3 * 585 = 21820.5 tenths of a cent,
 -- i.e. 2182.05 cents. Rounding per trip loses the .05; rounding the sum does
 -- not.
 ('70000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000001111330',
  '2022-03-15', 37.3, 'Post office and supply run', 'Home', 'USPS', true, null),
 -- 2b: TWO trips whose per-trip value ends in .4 of a cent. 10.4 miles at 58.5
 -- cents is 608.4 cents each. Rounded per trip that is 608 + 608 = 1216;
 -- rounded once on the sum it is 1216.8 -> 1217. A ONE CENT DIVERGENCE between
 -- the ledger and the summary, from two ordinary short trips. This pair is here
 -- because the first version of mileage_summary rounded once and the ledger
 -- rounds per trip, and the original fixture happened not to expose it.
 ('70000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000001111330',
  '2022-04-02', 10.4, 'Supply run', 'Home', 'Uline', true, null),
 ('70000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000001111330',
  '2022-04-09', 10.4, 'Supply run', 'Home', 'Uline', true, null),
 -- 3: on the provisional 2026 rate.
 ('70000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000001111330',
  '2026-03-01', 42.0, 'Estate sale', 'Home', 'Estate sale', true, null),
 -- 4: before any published rate. No entry, and the screen must say so.
 ('70000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000001111330',
  '2019-05-01', 88.0, 'Old trip predating our rate table', null, null, false, null)
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('a0000000-0000-0000-0000-000001111330');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-000001111330","role":"authenticated"}';

-- The rate lookup either side of the 2022 boundary, and the provisional one.
select 'rate 2022-06-30' as q, public.mileage_rate_on(date '2022-06-30') as a
union all select 'rate 2022-07-01', public.mileage_rate_on(date '2022-07-01')
union all select 'rate 2026-03-01', public.mileage_rate_on(date '2026-03-01')
union all select 'rate 2019-05-01', coalesce(public.mileage_rate_on(date '2019-05-01'), 'null'::jsonb);

-- Per-trip ledger entries, so the two 2022 trips can be compared directly.
select t.trip_date::text, t.miles::text, e.amount_cents
  from public.mileage_trips t
  left join public.ledger_entries e
    on e.source_id = t.id and e.source_detail = 'mileage'
 where t.user_id = 'a0000000-0000-0000-0000-000001111330'
 order by t.trip_date;

-- 5: the two routes to the deduction, for all of 2022.
select jsonb_pretty(public.mileage_summary(date '2022-01-01', date '2023-01-01'))
  as summary_2022;

select 'ledger 2022 mileage cents' as q,
       coalesce(sum(e.amount_cents), 0)::text as a
  from public.ledger_entries e
  join public.ledger_accounts a on a.id = e.account_id
 where e.user_id = 'a0000000-0000-0000-0000-000001111330'
   and a.code = 'vehicle_mileage'
   and e.entry_date >= '2022-01-01' and e.entry_date < '2023-01-01';

select jsonb_pretty(public.mileage_summary(date '2026-01-01', date '2027-01-01'))
  as summary_2026;

select jsonb_pretty(public.mileage_summary(date '2019-01-01', date '2020-01-01'))
  as summary_2019;

rollback;
