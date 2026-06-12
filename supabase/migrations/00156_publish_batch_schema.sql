-- US-559: durable server-side bulk publish.
--
-- Bulk publish used to be a CLIENT loop over POST /listings/push: the browser
-- iterated items, retried 429/5xx itself (compounding the server's own retry),
-- and the whole run died if the tab closed. This migration adds the durable
-- batch/job persistence that lets a single server-side endpoint own the run —
-- mirroring the AutoLister GENERATION batch model (00052) one-for-one:
--
--   1. listing_publish_batches — one row per bulk-publish run, rolling up
--      per-job counts so the queue/cockpit can show progress without scanning.
--   2. listing_publish_jobs    — one row per item; status/attempts/error drive
--      claim, retry-of-failed-only, and resume after a worker restart. The
--      eBay listing id/url are captured on success for per-item reporting.
--
-- Reuses the existing listing_generation_status / listing_generation_job_status
-- enums (identical lifecycle: pending → running → success/failed; batch rolls
-- up to completed/failed/partial).
--
-- All new multi-tenant tables get RLS (own-data, or via parent ownership). The
-- edge service uses the service-role client (bypasses RLS) — handlers MUST
-- still tenant-scope every query (CLAUDE.md US-268).

-- ══════════════════════════════════════════════════════════
-- NEW TABLES
-- ══════════════════════════════════════════════════════════

-- A single bulk-publish run. Rolls up per-job counts so the cockpit can show
-- progress without scanning every job row. A 'running' batch whose updated_at
-- (bumped on every progress roll-up) goes stale is reclaimed by the sweeper.
CREATE TABLE IF NOT EXISTS public.listing_publish_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status          public.listing_generation_status NOT NULL DEFAULT 'pending',
  item_count      integer NOT NULL DEFAULT 0,
  succeeded_count integer NOT NULL DEFAULT 0,
  failed_count    integer NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_publish_batches_user_id
  ON public.listing_publish_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_listing_publish_batches_status
  ON public.listing_publish_batches(status);

DROP TRIGGER IF EXISTS set_listing_publish_batches_updated_at
  ON public.listing_publish_batches;
CREATE TRIGGER set_listing_publish_batches_updated_at
  BEFORE UPDATE ON public.listing_publish_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per item in a publish batch. status/attempts/error drive claim,
-- retry, and progress. listing_id/listing_url are set once the item publishes
-- (success). The claim (pending → running conditional update) plus eBay's own
-- adopt-not-duplicate publish (US-464) make each item idempotent.
CREATE TABLE IF NOT EXISTS public.listing_publish_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES public.listing_publish_batches(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  status            public.listing_generation_job_status NOT NULL DEFAULT 'pending',
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  listing_id        uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  listing_url       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_publish_jobs_batch_id
  ON public.listing_publish_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_listing_publish_jobs_status
  ON public.listing_publish_jobs(status);
CREATE INDEX IF NOT EXISTS idx_listing_publish_jobs_inventory_item_id
  ON public.listing_publish_jobs(inventory_item_id);

DROP TRIGGER IF EXISTS set_listing_publish_jobs_updated_at
  ON public.listing_publish_jobs;
CREATE TRIGGER set_listing_publish_jobs_updated_at
  BEFORE UPDATE ON public.listing_publish_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.listing_publish_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_publish_jobs ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS in Postgres, so each is preceded by a
-- DROP POLICY IF EXISTS to keep this migration safely re-runnable.

-- Batches: own data only
DROP POLICY IF EXISTS "Users can view own publish batches" ON public.listing_publish_batches;
CREATE POLICY "Users can view own publish batches"
  ON public.listing_publish_batches FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create publish batches" ON public.listing_publish_batches;
CREATE POLICY "Users can create publish batches"
  ON public.listing_publish_batches FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own publish batches" ON public.listing_publish_batches;
CREATE POLICY "Users can update own publish batches"
  ON public.listing_publish_batches FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own publish batches" ON public.listing_publish_batches;
CREATE POLICY "Users can delete own publish batches"
  ON public.listing_publish_batches FOR DELETE USING (auth.uid() = user_id);

-- Jobs: via parent batch ownership
DROP POLICY IF EXISTS "Users can view own publish jobs" ON public.listing_publish_jobs;
CREATE POLICY "Users can view own publish jobs"
  ON public.listing_publish_jobs FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.listing_publish_batches b
      WHERE b.id = listing_publish_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "Users can create publish jobs" ON public.listing_publish_jobs;
CREATE POLICY "Users can create publish jobs"
  ON public.listing_publish_jobs FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.listing_publish_batches b
      WHERE b.id = listing_publish_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "Users can update own publish jobs" ON public.listing_publish_jobs;
CREATE POLICY "Users can update own publish jobs"
  ON public.listing_publish_jobs FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.listing_publish_batches b
      WHERE b.id = listing_publish_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "Users can delete own publish jobs" ON public.listing_publish_jobs;
CREATE POLICY "Users can delete own publish jobs"
  ON public.listing_publish_jobs FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.listing_publish_batches b
      WHERE b.id = listing_publish_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );
