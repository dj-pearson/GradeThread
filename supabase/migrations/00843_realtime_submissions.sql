-- US-3533: the "grade complete" live update never fired.
--
-- src/hooks/use-realtime-submission.ts subscribes to postgres_changes on
-- public.submissions (the detail page and the dashboard-wide "Grade Complete"
-- toast), but the only table ever added to the supabase_realtime publication
-- was notifications (00007). So those channels received nothing and the page
-- fell back to polling every 5 seconds. Add submissions, guarded the same way
-- 00007 is, and only when the publication exists (a bare Postgres has none).
-- Realtime delivers postgres_changes through RLS, and submissions RLS is
-- owner / workspace member only, so no seller receives another seller's rows.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'submissions'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.submissions;
  END IF;
END $$;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00843') ON CONFLICT DO NOTHING;
