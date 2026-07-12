-- US-1940: index the two unindexed FKs added in 00008.
--
-- payout_imports.sale_id and flipdesk_grading_submissions.submission_id are both
-- FKs with ON DELETE SET NULL but no supporting index. Reconciliation joins on
-- sale_id, and every delete of a parent sales / submissions row triggers a
-- sequential scan of the child table to null the reference. Partial indexes
-- (WHERE col IS NOT NULL) keep them small since most rows have a NULL FK.

create index if not exists idx_payout_imports_sale_id
  on public.payout_imports(sale_id) where sale_id is not null;

create index if not exists idx_flipdesk_grading_submissions_submission_id
  on public.flipdesk_grading_submissions(submission_id) where submission_id is not null;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00439') ON CONFLICT DO NOTHING;
