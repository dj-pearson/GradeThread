-- US-1536: peer-norm sanity check — supporting indexes.
--
-- The post-composite check scans recent grade_reports for the SAME
-- garment_category (via the submissions join) and joins the latest
-- human_reviews per report. Both access paths get plain btree indexes so the
-- bounded 400-row scan stays cheap as tables grow. The percentile math runs in
-- TypeScript over that bounded cohort (lib/peer-norm.ts) — deliberately no
-- bespoke SQL RPC on the grading path.

CREATE INDEX IF NOT EXISTS idx_submissions_garment_category
  ON public.submissions (garment_category);

CREATE INDEX IF NOT EXISTS idx_human_reviews_grade_report_id
  ON public.human_reviews (grade_report_id);

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00342') on conflict do nothing;
