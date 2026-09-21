-- US-2670: prove the disputes INSERT policies check who owns the grade report.
--
-- WHY A FIXTURE AND NOT ONLY THE TENANT-ISOLATION CASE. The suite case goes at
-- PostgREST as user B, which is the right shape and needs the full stack plus a
-- seeded fixture env. Almost nobody runs it. This needs a Postgres carrying the
-- migrations and nothing else, so the security property is checkable from a
-- laptop, from a cloud session, and from CI's db lane alike.
--
-- IT PROVES BOTH DIRECTIONS, and the second is the one a fix breaks. A policy
-- that refuses everything would pass the first assertion on its own.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

-- Two sellers. A owns the submission and its grade report; B owns nothing.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.com')
  on conflict (id) do nothing;
insert into public.submissions
  (id, user_id, garment_type, garment_category, title, status)
  values ('11111111-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'outerwear', 'jacket', 'A jacket', 'completed');
insert into public.grade_reports
  (id, submission_id, overall_score, grade_tier, fabric_condition_score,
   structural_integrity_score, cosmetic_appearance_score,
   functional_elements_score, odor_cleanliness_score, ai_summary,
   confidence_score, model_version)
  values ('22222222-0000-0000-0000-000000000001',
          '11111111-0000-0000-0000-000000000001',
          8.5, 'Excellent', 8.5, 9.0, 8.0, 8.5, 9.0, 'fine', 0.9, 'composite_v2');

-- The privileges a signed-in seller has. Deliberately NARROW: a blanket
-- GRANT ALL is what US-3350 measured destroying every REVOKE in the schema.
grant usage on schema public to authenticated;
grant select, insert on public.disputes to authenticated;
grant select on public.submissions, public.grade_reports, public.users to authenticated;
grant select on public.workspace_members to authenticated;

set local role authenticated;

-- THE HOLE. B files against A's report, naming B's own user_id. Before 00624
-- both INSERT policies gated on the user_id COLUMN alone, so this succeeded.
set local request.jwt.claims =
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}';
savepoint probe;
do $$
begin
  insert into public.disputes (grade_report_id, user_id, reason)
  values ('22222222-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002', 'not mine');
  raise notice 'RESULT foreign_insert=ALLOWED';
exception when others then
  raise notice 'RESULT foreign_insert=REFUSED %', sqlstate;
end $$;
rollback to savepoint probe;

-- THE OTHER DIRECTION, which is what a too-tight fix breaks. A files against
-- A's own report and must still succeed.
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  insert into public.disputes (grade_report_id, user_id, reason)
  values ('22222222-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001', 'wrong grade');
  raise notice 'RESULT own_insert=ALLOWED';
exception when others then
  raise notice 'RESULT own_insert=REFUSED %', sqlstate;
end $$;

rollback;
