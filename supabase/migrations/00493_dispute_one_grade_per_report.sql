-- US-2153: one GRADE dispute per (user, grade report).
--
-- 00001 created public.disputes with no uniqueness, so the advertised
-- "one complaint per grade" rule was enforced only in client UI. A double-tap
-- on a slow connection, a two-device race, or a direct API call could each
-- insert a duplicate that lands in the human review queue.
--
-- Scope note: 00489 added disputes.kind ('grade' | 'authenticity'). The two
-- share the table but have distinct resolution paths and lifecycles — an
-- authenticity appeal is deliberately re-fileable over time (rate-limited by
-- open count in grade.ts). So this is a PARTIAL unique index on kind='grade',
-- NOT the blanket UNIQUE (user_id, grade_report_id) named in the story's AC3
-- (which predates the kind column): a blanket constraint would wrongly block a
-- grade dispute and an authenticity appeal from coexisting on one report.

-- AC5: remove any pre-existing duplicate GRADE disputes BEFORE the unique index
-- is built, so the migration cannot fail on live data. Keep the earliest row
-- per (user_id, grade_report_id); delete the rest. Idempotent — a second run
-- finds no duplicates.
DELETE FROM public.disputes d
USING public.disputes keep
WHERE d.kind = 'grade'
  AND keep.kind = 'grade'
  AND d.user_id = keep.user_id
  AND d.grade_report_id = keep.grade_report_id
  AND (
    d.created_at > keep.created_at
    OR (d.created_at = keep.created_at AND d.id > keep.id)
  );

-- AC3: the constraint. Partial unique index (kind='grade') — race-proof backstop
-- behind the SELECT pre-check in POST /api/grade/dispute.
CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_grade_dispute_per_report
  ON public.disputes (user_id, grade_report_id)
  WHERE kind = 'grade';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00493') on conflict do nothing;
