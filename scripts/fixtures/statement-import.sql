-- US-2994 -- bank statement matching, against real Postgres.
--
-- Run it with: node scripts/check-statement-import.mjs
--
-- Inside one transaction that ROLLS BACK. What it proves:
--
--   1. RE-IMPORTING AN OVERLAPPING RANGE DOES NOT DUPLICATE. The unique index
--      on (user_id, source_id, row_fingerprint) is the whole of AC3, and
--      widening the export range is the normal thing sellers do.
--   2. Matching finds an expense of the same amount within the date window,
--      and prefers the closer date.
--   3. AN EXPENSE ALREADY MATCHED TO ANOTHER ROW IS NOT OFFERED AGAIN -- one
--      expense cannot satisfy two statement lines, which is exactly the shape
--      of the double payment a bank import exists to catch.
--   4. A row outside the date window is not offered, however well the amount
--      matches.
--   5. The three counts add up.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-00000000ba17', 'bank@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.statement_sources (id, user_id, name, column_map)
values ('51000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-00000000ba17', 'Chase business card',
        '{"date":"Transaction Date","amount":"Amount","description":"Description","sign":"negative_is_spend"}'::jsonb)
on conflict (user_id, name) do nothing;

-- Three expenses the seller already logged.
insert into public.flipdesk_expenses (id, user_id, category, description, amount, spent_on)
values ('e2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000ba17',
        'shipping_supplies', 'Uline order', 124.99, '2026-03-04'),
       -- Same amount, further away in time. Must rank BELOW the closer one.
       ('e2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000ba17',
        'shipping_supplies', 'Uline order', 124.99, '2026-03-12'),
       -- Same amount but far outside the window: must not be offered at all.
       ('e2000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000ba17',
        'shipping_supplies', 'Uline order', 124.99, '2026-01-04')
on conflict (id) do nothing;

-- First import: three rows.
insert into public.statement_rows
  (id, user_id, source_id, posted_on, amount_cents, description, row_fingerprint)
values
 ('52000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000ba17',
  '51000000-0000-0000-0000-000000000001', '2026-03-05', -12499, 'ULINE SHIP SUPPLY',
  '2026-03-05|-12499|uline ship supply'),
 ('52000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000ba17',
  '51000000-0000-0000-0000-000000000001', '2026-03-06', -4783, 'GOODWILL #142',
  '2026-03-06|-4783|goodwill #142'),
 ('52000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000ba17',
  '51000000-0000-0000-0000-000000000001', '2026-03-07', 50000, 'PAYMENT THANK YOU',
  '2026-03-07|50000|payment thank you')
on conflict do nothing;

select 'rows after first import' as q, count(*)::text as a
  from public.statement_rows where source_id = '51000000-0000-0000-0000-000000000001';

-- 1: THE RE-IMPORT. Two of the same rows plus one genuinely new one, exactly
-- as a widened export would arrive. ON CONFLICT DO NOTHING is what the client
-- sends; the unique index is what makes it safe.
insert into public.statement_rows
  (user_id, source_id, posted_on, amount_cents, description, row_fingerprint)
values
 ('a0000000-0000-0000-0000-00000000ba17', '51000000-0000-0000-0000-000000000001',
  '2026-03-06', -4783, 'GOODWILL #142', '2026-03-06|-4783|goodwill #142'),
 ('a0000000-0000-0000-0000-00000000ba17', '51000000-0000-0000-0000-000000000001',
  '2026-03-07', 50000, 'PAYMENT THANK YOU', '2026-03-07|50000|payment thank you'),
 ('a0000000-0000-0000-0000-00000000ba17', '51000000-0000-0000-0000-000000000001',
  '2026-03-11', -999, 'NEW ROW', '2026-03-11|-999|new row')
on conflict (user_id, source_id, row_fingerprint) do nothing;

select 'rows after overlapping re-import' as q, count(*)::text as a
  from public.statement_rows where source_id = '51000000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000ba17","role":"authenticated"}';

-- 2 + 4: candidates for the Uline row, best first.
select 'candidate' as tag, description, spent_on::text, day_gap::text, score::text
  from public.match_statement_row('52000000-0000-0000-0000-000000000001');

-- 3: match the closer expense. The check that matters is the SECOND Uline row
-- below, which must no longer be offered the expense that is now spoken for.
update public.statement_rows
   set matched_expense_id = 'e2000000-0000-0000-0000-000000000001',
       status = 'matched'
 where id = '52000000-0000-0000-0000-000000000001';

-- The Goodwill row has no expense at its amount at all, so this is the
-- no-candidates case rather than the already-taken one.
select 'no candidates' as tag, description, spent_on::text, day_gap::text, score::text
  from public.match_statement_row('52000000-0000-0000-0000-000000000002');

-- THE ONE THAT MATTERS: a second statement row of the SAME amount must not be
-- offered the expense already matched to the first. One expense cannot satisfy
-- two statement lines, and that is exactly the double payment a bank import
-- exists to catch.
insert into public.statement_rows
  (id, user_id, source_id, posted_on, amount_cents, description, row_fingerprint)
values ('52000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-00000000ba17',
        '51000000-0000-0000-0000-000000000001', '2026-03-05', -12499, 'ULINE AGAIN',
        '2026-03-05|-12499|uline again')
on conflict do nothing;

select 'second uline row candidate' as tag, description, spent_on::text, day_gap::text, score::text
  from public.match_statement_row('52000000-0000-0000-0000-000000000004');

select jsonb_pretty(public.statement_import_summary('51000000-0000-0000-0000-000000000001'))
  as summary;

rollback;
