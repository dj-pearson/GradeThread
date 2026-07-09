-- US-1790: B2B batch grading — durable-jobs queue tables.
--
-- POST /api/v1/grades:batch enqueues N garments as one batch (one grading_batches
-- row) + one grading_batch_jobs row per garment. A background worker
-- (grading-batch.ts, mirroring flipdesk-autolister's processBatch) claims jobs
-- atomically, grades each via the SAME path as a single API grade (submission +
-- runPaymentPrecedence + processSubmission), and the batch status is DERIVED from
-- its job rows (finalize-from-rows), so a container death / redeploy never strands
-- work — a reclaim cron resumes stale jobs. TENANT-SCOPED (user_id + RLS); the API
-- reads via the service-role client explicitly scoped by the key's user.
--
-- status columns are text + CHECK (not a new enum) so the migration never has to
-- USE a freshly-added enum value in the same transaction.

CREATE TABLE IF NOT EXISTS public.grading_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  api_key_id       uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial')),
  item_count       integer NOT NULL DEFAULT 0,
  succeeded_count  integer NOT NULL DEFAULT 0,
  failed_count     integer NOT NULL DEFAULT 0,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grading_batches_user_id ON public.grading_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_grading_batches_status ON public.grading_batches(status);

DROP TRIGGER IF EXISTS set_grading_batches_updated_at ON public.grading_batches;
CREATE TRIGGER set_grading_batches_updated_at
  BEFORE UPDATE ON public.grading_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per garment in a batch. payload holds the submitted garment (title,
-- type, category, brand, description, images); submission_id is set once the
-- garment's submission is created; status/attempts/error drive retry + progress.
CREATE TABLE IF NOT EXISTS public.grading_batch_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES public.grading_batches(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts       integer NOT NULL DEFAULT 0,
  error          text,
  submission_id  uuid REFERENCES public.submissions(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grading_batch_jobs_batch_id ON public.grading_batch_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_grading_batch_jobs_status ON public.grading_batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_grading_batch_jobs_user_id ON public.grading_batch_jobs(user_id);

DROP TRIGGER IF EXISTS set_grading_batch_jobs_updated_at ON public.grading_batch_jobs;
CREATE TRIGGER set_grading_batch_jobs_updated_at
  BEFORE UPDATE ON public.grading_batch_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: owner-only. The API reads/writes via the service-role client explicitly
-- scoped by the key's user; a policy lets the owner read their own batches from
-- the SPA too (tenant isolation, US-268).
ALTER TABLE public.grading_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grading_batch_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own grading batches" ON public.grading_batches;
CREATE POLICY "Users read own grading batches"
  ON public.grading_batches FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own grading batch jobs" ON public.grading_batch_jobs;
CREATE POLICY "Users read own grading batch jobs"
  ON public.grading_batch_jobs FOR SELECT USING (auth.uid() = user_id);

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00410') on conflict do nothing;
