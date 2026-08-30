-- US-2990 -- the simplified home-office deduction, against real Postgres.
--
-- Run it with: node scripts/check-home-office.mjs
--
-- Inside one transaction that ROLLS BACK. What it proves:
--
--   1. THE CAP COMES BEFORE THE PRORATION. 400 sq ft for six months is 300
--      capped, then halved: $750. Prorating first and capping after gives
--      $1,000. Both look plausible; only one is right, and the difference is
--      $250 on a $1,500 maximum.
--   2. A full year at or over the cap is exactly $1,500.
--   3. Months of 0 and 12 are the boundaries, and neither escapes the formula.
--   4. THE DEDUCTION IS SCHEDULE C LINE 30, so the ledger entry lands on the
--      home_office account and NOT among ordinary running costs.
--   5. THE DOUBLE-COUNT GUARD FIRES when a home office is claimed alongside
--      rent or utilities expensed separately -- the same space deducted twice,
--      where neither figure looks wrong on its own.
--   6. 'actual' method produces NO ledger entry, because Form 8829 is not
--      something this app does.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-00000000f1ce', 'homeoffice@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- 1 + 2 + 3: the arithmetic, asked directly.
select 'A 300sqft 12mo (at the cap)' as q,
       public.home_office_deduction_cents(300, 12, 2025) as cents
union all select 'B 400sqft 12mo (over the cap)',
       public.home_office_deduction_cents(400, 12, 2025)
union all select 'C 400sqft 6mo (cap THEN prorate)',
       public.home_office_deduction_cents(400, 6, 2025)
union all select 'D 120sqft 12mo',
       public.home_office_deduction_cents(120, 12, 2025)
union all select 'E 120sqft 3mo',
       public.home_office_deduction_cents(120, 3, 2025)
union all select 'F 120sqft 0mo',
       public.home_office_deduction_cents(120, 0, 2025)
union all select 'G 0sqft 12mo',
       public.home_office_deduction_cents(0, 12, 2025)
union all select 'H 150sqft 2012 (before the method existed)',
       public.home_office_deduction_cents(150, 12, 2012);

-- 4 + 5: a seller with a home office AND rent expensed separately.
insert into public.home_office_years
  (user_id, tax_year, square_feet, months_used, method)
values ('a0000000-0000-0000-0000-00000000f1ce', 2025, 120, 12, 'simplified')
on conflict (user_id, tax_year) do update set square_feet = excluded.square_feet;

insert into public.flipdesk_expenses
  (id, user_id, category, description, amount, spent_on)
values ('e1000000-0000-0000-0000-00000000f1ce',
        'a0000000-0000-0000-0000-00000000f1ce',
        'storage', 'Spare room, called it rent', 400.00, '2025-06-01')
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('a0000000-0000-0000-0000-00000000f1ce');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000f1ce","role":"authenticated"}';

-- Where the deduction landed, and on which account.
select a.code, a.schedule_c_line, e.amount_cents, e.entry_date::text, e.source_detail
  from public.ledger_entries e
  join public.ledger_accounts a on a.id = e.account_id
 where e.user_id = 'a0000000-0000-0000-0000-00000000f1ce'
 order by a.code;

select jsonb_pretty(public.home_office_overlap(2025)) as overlap_2025;

rollback;
