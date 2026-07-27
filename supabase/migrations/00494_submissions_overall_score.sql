-- US-2196: denormalize the active grade onto submissions for server-side sort.
--
-- The submissions list can sort by grade, but overall_score lives in
-- grade_reports, so the old path loaded EVERY matching submission id + score
-- and sorted/paginated in JS (O(n) per sort). This copies the ACTIVE report's
-- score (grade_reports.superseded_at IS NULL — the partial unique index from
-- 00478 guarantees exactly one active report per submission) onto
-- submissions.overall_score and keeps it current with a trigger, so the client
-- can `ORDER BY overall_score ... LIMIT`. It is a COPY of the already-rounded
-- value (numeric(3,1)) — no re-computation, so the weighted-overall rounding
-- lockstep is untouched.

alter table public.submissions
  add column if not exists overall_score numeric(3,1);

-- Recompute one submission's denormalized score from its active grade_report.
create or replace function public.sync_submission_overall_score()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := coalesce(new.submission_id, old.submission_id);
begin
  update public.submissions s
     set overall_score = (
       select gr.overall_score
         from public.grade_reports gr
        where gr.submission_id = sid
          and gr.superseded_at is null
        limit 1
     )
   where s.id = sid;
  return null;
end;
$$;

-- Fire on the events that change which report is active or its score.
drop trigger if exists trg_sync_submission_overall_score on public.grade_reports;
create trigger trg_sync_submission_overall_score
  after insert or delete or update of overall_score, superseded_at
  on public.grade_reports
  for each row
  execute function public.sync_submission_overall_score();

-- Backfill from the current active reports.
update public.submissions s
   set overall_score = gr.overall_score
  from public.grade_reports gr
 where gr.submission_id = s.id
   and gr.superseded_at is null
   and s.overall_score is distinct from gr.overall_score;

-- Sort index (btree serves ASC and DESC; NULLS LAST is handled by the query).
create index if not exists idx_submissions_overall_score
  on public.submissions (overall_score);

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00494') on conflict do nothing;
